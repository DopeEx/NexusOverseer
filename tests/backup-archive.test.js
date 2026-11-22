import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import 'fake-indexeddb/auto';
import { createBackupArchive, stageBackupArchive } from '../nexus-addon/backup-archive.js';
import { prepareBackupFile } from '../nexus-addon/backup-host.js';
import { backupGalaxyEntries, clearBackupImportStage, clearBackupStorageStage, commitBackupImportRows,
  restoreGalaxyCache, saveCatalog, saveGalaxyDelta, savePublicGalaxy, saveSystem,
  stageBackupStorage } from '../nexus-addon/galaxy-cache.js';
import { emptyPublicGalaxy } from '../nexus-addon/galaxy-public.js';
import { normalizeXenoReport, xenoTotals } from '../nexus-addon/xeno-reports.js';
import { xenoDigReports } from './helpers.js';

const exportedAt = new Date().toISOString();
const options = { exportedAt, reason: 'manual', includeGalaxy: true };

test('the download URL serves the temporary file as gzip without changing its bytes', async t => {
  const bytes = gzipSync('backup');
  const file = new File([bytes], 'nexus-backup-download.tmp', { type: 'text/plain' });
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const worker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => ({ getFileHandle: async () => ({ getFile: async () => file }) }) },
  });
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      postMessage() { this.onmessage({ data: { result: file.size } }); }
      terminate() {}
    },
  });
  t.after(() => {
    if (storage) Object.defineProperty(navigator, 'storage', storage);
    else delete navigator.storage;
    if (worker) Object.defineProperty(globalThis, 'Worker', worker);
    else delete globalThis.Worker;
  });
  const url = await prepareBackupFile(options, { signal: new AbortController().signal });
  t.after(() => URL.revokeObjectURL(url));
  const response = await fetch(url);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

async function galaxySnapshot() {
  const entries = [];
  for await (const entry of backupGalaxyEntries()) entries.push(entry);
  return entries;
}

test('a compressed full backup restores multiple universes, public data, deltas and individual ownership times', async t => {
  t.after(async () => {
    await clearBackupStorageStage();
    await clearBackupImportStage();
    await restoreGalaxyCache();
  });
  const at = Date.now() - 3000;
  for (let id = 1; id <= 24; id++) {
    await saveSystem('s0', id, { planets: [{ id, userId: 7, name: 'Étoile' }] }, at);
  }
  await saveSystem('s0', 1, { planets: [{ id: 1, userId: 7 }, { id: 31, userId: 9 }] }, at + 100);
  await saveSystem('s0', 1, {
    planets: [{ id: 1, ownershipKnown: false }, { id: 31, userId: 9 }],
    _galaxyCache: { ownership: { planets: at + 50 } },
  }, at + 200);
  await saveGalaxyDelta('s0', { type: 'colonized', systemId: 1, hasColonies: true }, at);
  await saveCatalog('beta', '/api/galaxy/map', { systems: [{ id: 90 }] }, at);
  const publicData = emptyPublicGalaxy('beta');
  publicData.systems = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, name: `Système ${i + 1} 🌌` }));
  await savePublicGalaxy('beta', publicData, 'a'.repeat(64), at);
  const reports = Array.from({ length: 3000 }, (_, id) => ({ id, text: `Étoile 🌌\n${id}` }));
  const digs = xenoDigReports().map(normalizeXenoReport);
  const storage = {
    records_cap: Infinity, 'nexus_server:beta:archived_reports': reports,
    'nexus_server:s0:xeno_archive_2030-01': digs,
    'nexus_server:s0:xeno_seen_ids': digs.map(report => report.id),
    'nexus_server:s0:archive_index': { xeno: { months: ['2030-01'], count: digs.length } },
    'nexus_server:s0:xeno_totals': xenoTotals(digs),
  };
  await stageBackupStorage(storage);

  const original = await galaxySnapshot();
  const first = original.find(entry => entry.serverKey === 's0' && entry.key === 'system:1');
  assert.deepEqual(first.data._galaxyCache.bodyOwnership.planets, { 1: at + 100, 31: at + 50 });
  const archive = await new Response(createBackupArchive(options)).blob();
  await restoreGalaxyCache();

  const parsed = await stageBackupArchive(archive);
  assert.deepEqual(parsed, { data: { ...storage, records_cap: 0 }, preserveGalaxy: false, exportedAt });
  assert.deepEqual(await galaxySnapshot(), [], 'validation does not change the live database');
  await commitBackupImportRows();
  assert.deepEqual(await galaxySnapshot(), original);
});

test('truncated or invalid gzip backups cannot overwrite existing galaxy data', async t => {
  t.after(async () => {
    await clearBackupStorageStage();
    await clearBackupImportStage();
    await restoreGalaxyCache();
  });
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{ id: 90 }] });
  const original = await galaxySnapshot();
  const archive = await new Response(createBackupArchive(options)).blob();
  await assert.rejects(stageBackupArchive(archive.slice(0, -4)));
  const records = [
    { type: 'header', nexus_overseer_backup: 3, ...options },
    ...Array.from({ length: 17 }, (_, i) => ({
      type: 'galaxy', entry: { ...original[0], key: `system:${i + 1}`, data: { planets: [{ id: i + 1 }] } },
    })),
    { type: 'end', storage: 0, galaxy: 100 },
  ];
  await assert.rejects(stageBackupArchive(new Blob([gzipSync(records.map(record => JSON.stringify(record)).join('\n') + '\n')])),
    /entry count/);
  assert.deepEqual(await galaxySnapshot(), original);
  await commitBackupImportRows();
  assert.deepEqual(await galaxySnapshot(), [], 'failed validation discards all staged rows');
});

test('legacy full and storage-only JSON backups keep their previous restore behavior', async t => {
  t.after(async () => {
    await clearBackupImportStage();
    await restoreGalaxyCache();
  });
  const data = { records_cap: 0 };
  const entry = { serverKey: 's0', key: '/api/galaxy/map', at: Date.now(), data: { systems: [{ id: 42 }] } };
  const makeFile = payload => new Blob([JSON.stringify(payload)]);
  const full = await stageBackupArchive(makeFile({ nexus_accounting_backup: 1, data, galaxyCache: { version: 1, entries: [entry] } }));
  assert.equal(full.preserveGalaxy, false);
  await commitBackupImportRows();
  const partial = await stageBackupArchive(makeFile({ nexus_overseer_backup: 2, data }));
  assert.deepEqual(partial, { data, preserveGalaxy: true, exportedAt: undefined });
  assert.deepEqual(await galaxySnapshot(), [entry]);
  await assert.rejects(stageBackupArchive(makeFile({ nexus_overseer_backup: 2, data, galaxyCache: null })), /must not contain/);
});
