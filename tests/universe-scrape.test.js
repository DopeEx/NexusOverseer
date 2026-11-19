import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowserStub } from './helpers.js';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { saveCatalog } from '../nexus-addon/galaxy-cache.js';

const uniqueImport = (spec) => import(`${spec}?ts=${crypto.randomUUID()}`);

test('a same-version reload syncs without a full backup and leaves scheduled backups due', async t => {
  const { store, downloads, onInstalled, onAlarm } = await setupBackupScrape(t);

  await onInstalled({ reason: 'update', previousVersion: '2.5.0' });
  assert.ok(store.last_scrape, 'the reload still syncs reports');
  assert.deepEqual(downloads, []);
  assert.equal(store.last_backup, undefined);
  assert.equal(store.whatsnew_pending, undefined);

  await onAlarm({ name: 'nexus-scrape' });
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].filename, /nexus-overseer-auto-/);
  assert.ok(store.last_backup);
});

test('a version change backs up extension storage before syncing without reading the full galaxy database', async t => {
  const { store, downloads, onInstalled, onMessage } = await setupBackupScrape(t);
  const path = '/api/galaxy/map';
  await saveCatalog('beta', path, { systems: [{ id: 42 }] });
  const getAll = IDBObjectStore.prototype.getAll;
  let galaxyExports = 0;
  t.mock.method(IDBObjectStore.prototype, 'getAll', function (...args) {
    if (!args.length) galaxyExports++;
    return getAll.apply(this, args);
  });

  await onInstalled({ reason: 'update', previousVersion: '2.4.0' });
  assert.equal(store.whatsnew_pending, '2.5.0');
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].filename, /nexus-overseer-pre-update-2\.4\.0-/);
  const payload = readBackup(downloads[0]);
  assert.equal(payload.nexus_overseer_backup, 2);
  assert.ok(!Object.hasOwn(payload, 'galaxyCache'));
  assert.deepEqual(payload.data['nexus_server:beta:archived_reports'], [{ id: 1 }]);
  assert.equal(payload.data.last_scrape, undefined);
  assert.equal(store.last_backup, undefined, 'a partial snapshot does not count as a full backup');
  assert.equal(galaxyExports, 0);
  assert.ok(store.last_scrape);

  assert.deepEqual(await onMessage({ type: 'BACKUP_NOW', reason: 'pre-import', preserveGalaxy: true }), { ok: true });
  assert.ok(!Object.hasOwn(readBackup(downloads[1]), 'galaxyCache'));
  assert.equal(galaxyExports, 0);

  assert.deepEqual(await onMessage({ type: 'BACKUP_NOW', reason: 'manual' }), { ok: true });
  const full = readBackup(downloads[2]);
  assert.equal(full.nexus_overseer_backup, 1);
  assert.ok(full.galaxyCache.entries.some(entry => entry.serverKey === 'beta' && entry.key === path));
  assert.ok(store.last_backup);
});

function readBackup({ url }) {
  return JSON.parse(decodeURIComponent(url.slice(url.indexOf(',') + 1)));
}

async function setupBackupScrape(t) {
  const store = makeBrowserStub({
    schema_version: 10,
    planet_id: 1,
    'nexus_server:beta:archived_reports': [{ id: 1 }],
  });
  const downloads = [];
  const { browser } = globalThis;
  browser.runtime.getManifest = () => ({ version: '2.5.0' });
  browser.alarms.get = async () => ({ name: 'nexus-scrape' });
  browser.tabs.query = async () => [{ id: 1, url: 'https://s0.nexuslegacy.space/' }];
  browser.tabs.sendMessage = async () => ({ ok: true, data: {} });
  browser.downloads.download = async options => downloads.push(options);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [{ key: 's0', name: 'S0' }],
  }));
  await uniqueImport('../nexus-addon/background.js');
  return {
    store, downloads,
    onInstalled: browser.runtime.onInstalled.listeners[0],
    onAlarm: browser.alarms.onAlarm.listeners[0],
    onMessage: browser.runtime.onMessage.listeners[0],
  };
}

test('scrape visits every catalog universe with an open game tab', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };
  await uniqueImport('../nexus-addon/server-storage.js');

  const gameTabs = [
    { id: 1, url: 'https://s0.nexuslegacy.space/' },
    { id: 2, url: 'https://beta.nexuslegacy.space/' },
  ];
  const requests = [];
  globalThis.browser.tabs.query = async query => {
    if (query?.url === '*://*.nexuslegacy.space/*') return gameTabs;
    const tab = gameTabs.find(candidate => query?.url === `${new URL(candidate.url).origin}/*`);
    return tab ? [tab] : [];
  };
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    const tab = gameTabs.find(candidate => candidate.id === tabId);
    requests.push({ host: new URL(tab.url).hostname, path: message.path });
    return { ok: true, data: { planets: [] } };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://nexuslegacy.space/api/universes');
    return {
      ok: true,
      json: async () => [
        { key: 's0', name: 'S0' },
        { key: 'beta', name: 'Beta' },
      ],
    };
  };

  try {
    await uniqueImport('../nexus-addon/background.js');
    const listener = globalThis.browser.runtime.onMessage.listeners[0];
    const result = await listener({ type: 'SCRAPE_NOW' });

    assert.equal(result.ok, false);
    assert.match(result.error, /Some universe scrapes failed/);
    assert.deepEqual(
      requests.filter(request => request.path === '/api/planets').map(request => request.host).sort(),
      ['beta.nexuslegacy.space', 's0.nexuslegacy.space'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
