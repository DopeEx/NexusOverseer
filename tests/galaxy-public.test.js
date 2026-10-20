import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import 'fake-indexeddb/auto';
import { IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { emptyPublicGalaxy, validatePublicGalaxy, validatePublicManifest, mergePublicGalaxies, overlayPublicCatalog } from '../nexus-addon/galaxy-public.js';
import { savePublicGalaxy, readPublicGalaxy, readSystem, readScans, saveSystem, saveCatalog,
  exportPublicGalaxy, exportGalaxyCache, restoreGalaxyCache, clearGalaxyCache,
  systemCacheFresh, createGalaxyCache, readSavedCatalog } from '../nexus-addon/galaxy-cache.js';
import { createGalaxySharing, galaxySha256, PUBLIC_GALAXY_URL, PUBLIC_CHECK_INTERVAL } from '../nexus-addon/galaxy-sharing.js';
import { mergeContribution, validateRepository, guidedContribution } from '../tools/galaxy-data.js';
import { makeBrowserStub, loadBackground } from './helpers.js';

const hash = 'a'.repeat(64);
const example = (serverKey = 's0') => ({
  ...emptyPublicGalaxy(serverKey),
  systems: [{ id: 1, name: 'System', x: 10, y: 20, armId: 1, sectorId: 1,
    starType: 'yellow', securityZone: 'open',
    planets: [{ id: 11, planetType: 'terra', size: 200, temperature: 20, position: 1 }],
    moons: [{ id: 12, planetId: 11, moonType: 'icy', size: 20 }] }],
  stations: [{ stationId: 3, stationName: 'Station', systemId: 1, systemName: 'System', systemX: 10, systemY: 20 }],
  hubs: [{ id: 1, systemId: 1, name: 'Exchange', systemX: 10, systemY: 20 }],
  arms: [{ id: 1, name: 'Arm', sectorCount: 50 }],
});

beforeEach(async () => { await restoreGalaxyCache(); });

test('public exports whitelist structure, zones and station names and exclude every mutable/private field', async () => {
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{
    ...example().systems[0], visibility: 'full', hasColonies: true, ownerName: 'SECRET',
  }] });
  await saveCatalog('s0', '/api/galaxy/station-index', { stations: [{
    ...example().stations[0], ownedByViewerAlliance: true, ownerAllianceId: 1,
    ownerAllianceName: 'SECRET', ownerAllianceTag: 'SECRET', capturingAllianceTag: 'SECRET',
  }] });
  await saveSystem('s0', 1, { visibility: 'full', planets: [{
    ...example().systems[0].planets[0], userId: 99, name: 'SECRET', maxBuildingSlots: 999,
    buildingSlots: 999, usedBuildingSlots: 99, ownerName: 'SECRET', resources: { ore: 123 },
    buildings: [{ level: 100 }], isHomeworld: true, isColonizable: false,
  }], moons: [{ ...example().systems[0].moons[0], userId: 99, buildingSlots: 999, name: 'SECRET' }] });
  await saveSystem('beta', 1, { planets: [{ id: 99, planetType: 'volcanic' }] });
  const data = await exportPublicGalaxy('s0');
  validatePublicGalaxy(data);
  assert.equal(data.systems[0].securityZone, 'open');
  assert.equal(data.stations[0].stationName, 'Station');
  const json = JSON.stringify(data);
  for (const field of ['SECRET', 'userId', 'owner', 'buildingSlots', 'maxBuildingSlots', 'usedBuildingSlots',
    'resources', 'buildings', 'visibility', 'hasColonies', 'isHomeworld', 'isColonizable', 'beta']) assert.ok(!json.includes(field), field);
  assert.equal(data.systems[0].planets[0].id, 11);
  assert.equal(data.systems[0].moons[0].planetId, 11);
});

test('public validator rejects forbidden fields at every level, wrong universes, duplicate IDs and invalid numbers', () => {
  for (const modify of [
    data => { data.token = 'secret'; },
    data => { data.systems[0].visibility = 'full'; },
    data => { data.systems[0].planets[0].userId = null; },
    data => { data.systems[0].moons[0].buildingSlots = 10; },
    data => { data.stations[0].ownerAllianceTag = 'TEAM'; },
    data => { data.systems.push(data.systems[0]); },
    data => { data.systems[0].x = Infinity; },
    data => { data.systems[0].x = 1e308; },
    data => { delete data.systems[0].moons[0].planetId; },
  ]) {
    const data = example();
    modify(data);
    assert.throws(() => validatePublicGalaxy(data));
  }
  assert.throws(() => validatePublicGalaxy(example('beta'), 's0'), /universe/);
});

test('maintainer and downloader share strict manifest validation, including malformed entries', () => {
  const manifest = { schemaVersion: 1, servers: { s0: { file: 's0.json', sha256: hash } } };
  assert.equal(validatePublicManifest(manifest), manifest);
  assert.deepEqual(validatePublicManifest({ schemaVersion: 1, servers: {} }).servers, {});
  for (const invalid of [null, [], {}, { schemaVersion: 1, servers: [] },
    { schemaVersion: 1, servers: 's0' }, { schemaVersion: 1, servers: { s0: null } },
    { schemaVersion: 1, servers: { s0: { file: '../s0.json', sha256: hash } } },
    { schemaVersion: 1, servers: { s0: { file: 's0.json', sha256: 'bad' } } },
    { schemaVersion: 1, servers: { '../s0': { file: '../s0.json', sha256: hash } } },
  ]) assert.throws(() => validatePublicManifest(invalid), /Invalid public galaxy manifest/);
});

test('public export reads only the requested universe and migrates without materializing unrelated scans', async () => {
  await saveSystem('beta', 1, { planets: [{ id: 99, planetType: 'volcanic' }] });
  const cache = createGalaxyCache({
    fetcher: () => assert.fail('Export must not make game requests'),
    storage: { get: async () => ({ planet_scan_cache: { 1: { at: Date.now(), data: {
      planets: [{ id: 11, planetType: 'terra', size: 200 }], moons: [],
    } } } }), remove: async () => {} },
  });
  const indexReads = [], storeReads = [];
  const indexAll = IDBIndex.prototype.getAll, storeAll = IDBObjectStore.prototype.getAll;
  IDBIndex.prototype.getAll = function (...args) { indexReads.push(args[0]); return indexAll.apply(this, args); };
  IDBObjectStore.prototype.getAll = function (...args) { storeReads.push(args[0]); return storeAll.apply(this, args); };
  try {
    const exported = await cache.exportPublic('s0');
    assert.equal(exported.systems[0].planets[0].id, 11);
    assert.ok(!JSON.stringify(exported).includes('volcanic'));
    assert.deepEqual(indexReads, ['s0'], 'one scoped read, not an extra full scan for migration');
    assert.deepEqual(storeReads, [], 'do not load other universes through an all-server backup');
  } finally {
    IDBIndex.prototype.getAll = indexAll;
    IDBObjectStore.prototype.getAll = storeAll;
  }
});

test('public cache supplies static search data without inventing ownership, timestamps or visibility', async () => {
  await savePublicGalaxy('s0', example(), hash);
  const entry = await readSystem('s0', 1);
  assert.equal(entry.data.visibility, 'unknown');
  assert.deepEqual(entry.data._galaxyCache.times, {});
  assert.deepEqual(entry.data._galaxyCache.ownership, {});
  assert.equal(entry.data.planets[0].ownershipKnown, false);
  assert.ok(!Object.hasOwn(entry.data.planets[0], 'userId'));
  assert.ok(systemCacheFresh(entry, 'static'));
  assert.ok(!systemCacheFresh(entry, 'ownership'));
  assert.ok(!systemCacheFresh(entry, 'dynamic'));
  const cache = createGalaxyCache({ fetcher: () => assert.fail('Static public search must not fetch'), storage: { get: async () => ({}) } });
  assert.equal((await cache.system('s0', 1, { purpose: 'static' })).planets[0].size, 200);
  assert.deepEqual(await cache.refreshFromDelta('s0', 1, Date.now()), { refreshed: false },
    'public positions never authorize a background scan');
  assert.ok((await readScans('s0'))[1].data._galaxyCache.publicSource);
  assert.equal(await readSystem('beta', 1), null);
});

test('game observations win over public base data including abandoned owners and authoritative empty groups', async () => {
  await savePublicGalaxy('s0', example(), hash);
  const at = Date.now() - 1000;
  await saveSystem('s0', 1, { visibility: 'full', planets: [{ id: 11, size: 250, name: 'Colony', userId: null }],
    moons: [] }, at);
  const entry = await readSystem('s0', 1);
  assert.equal(entry.data.planets[0].size, 250);
  assert.equal(entry.data.planets[0].planetType, 'terra');
  assert.equal(entry.data.planets[0].userId, null);
  assert.equal(entry.data.planets[0].ownershipKnown, true);
  assert.deepEqual(entry.data.moons, []);
  assert.equal(entry.data._galaxyCache.times.planets, at);
  const publicMap = overlayPublicCatalog({ systems: [{ id: 1, visibility: 'fog', securityZone: 'dead' }] },
    '/api/galaxy/map', example());
  assert.equal(publicMap.systems[0].visibility, 'fog');
  assert.equal(publicMap.systems[0].securityZone, 'dead');
  const stations = overlayPublicCatalog({ stations: [] }, '/api/galaxy/station-index', example()).stations;
  assert.ok(!Object.hasOwn(stations[0], 'ownedByViewerAlliance'));
});

test('saved catalogs apply new public versions without treating the previous public version as a game observation', async () => {
  await savePublicGalaxy('s0', example(), hash);
  assert.equal((await readSavedCatalog('s0', '/api/galaxy/map')).systems[0].securityZone, 'open');
  const changed = example();
  changed.systems[0].securityZone = 'sentinel';
  await savePublicGalaxy('s0', changed, 'b'.repeat(64));
  const map = await readSavedCatalog('s0', '/api/galaxy/map');
  assert.equal(map.systems[0].securityZone, 'sentinel');
  assert.equal(map._galaxyCatalogAt, 0, 'public data has no HTTP observation timestamp');
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{ id: 1, securityZone: 'dead', visibility: 'fog', x: null }] });
  const observed = (await readSavedCatalog('s0', '/api/galaxy/map')).systems[0];
  assert.equal(observed.securityZone, 'dead');
  assert.equal(observed.x, 10, 'missing coordinates are supplemented');
});

test('re-exports prioritize observations over installed public versions regardless of IndexedDB key order', async () => {
  await savePublicGalaxy('s0', example(), hash);
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{ id: 1, securityZone: 'dead', name: 'Observed' }] });
  await saveSystem('s0', 1, { planets: [{ id: 11, size: 250, userId: null }] });
  const data = await exportPublicGalaxy('s0');
  assert.equal(data.systems[0].securityZone, 'dead');
  assert.equal(data.systems[0].name, 'Observed');
  assert.equal(data.systems[0].planets[0].size, 250);
  assert.equal(data.systems[0].planets[0].planetType, 'terra', 'public fields still fill missing observed base properties');
  assert.ok(!JSON.stringify(data).includes('userId'));
});

test('public imports are backed up, restored, re-exported safely and cleared per universe', async () => {
  await savePublicGalaxy('s0', example(), hash);
  await savePublicGalaxy('beta', example('beta'), hash);
  const backup = await exportGalaxyCache();
  await restoreGalaxyCache(backup);
  assert.deepEqual(await exportPublicGalaxy('s0'), example());
  await clearGalaxyCache('s0');
  assert.equal(await readPublicGalaxy('s0'), null);
  assert.ok(await readPublicGalaxy('beta'));
});

test('contribution merging adds missing structure, retains established values and reports conflicts', () => {
  const initial = example();
  delete initial.systems[0].securityZone;
  const incoming = example();
  incoming.systems[0].x = 999;
  incoming.systems[0].planets.push({ id: 13, planetType: 'ice' });
  const result = mergePublicGalaxies(initial, incoming);
  assert.equal(result.data.systems[0].securityZone, 'open');
  assert.equal(result.data.systems[0].x, 10);
  assert.equal(result.data.systems[0].planets.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0], /systems\/1\/x/);
  assert.equal(result.added, 1);
  assert.equal(result.filled, 1);
  assert.deepEqual(initial.systems[0].planets.length, 1);
});

function sharingHarness() {
  let clock = Date.now();
  const values = {}, installed = new Map(), requests = [];
  const content = JSON.stringify(example());
  let manifest, responseStatus = 200, corrupt = false;
  const initialize = async () => { manifest = { schemaVersion: 1, servers: { s0: {
    file: 's0.json', sha256: await galaxySha256(content),
  } } }; };
  const sharing = createGalaxySharing({
    storage: { get: async key => ({ [key]: values[key] }), set: async data => Object.assign(values, data) },
    read: async server => installed.get(server),
    write: async (server, data, sha256) => installed.set(server, { data, sha256, at: clock }),
    now: () => clock,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : corrupt ? '{}' : content,
        { status: responseStatus });
    },
  });
  return { sharing, values, installed, requests, initialize,
    advance: duration => { clock += duration; },
    setManifest: value => { manifest = value; }, fail: () => { responseStatus = 503; },
    corrupt: () => { corrupt = true; } };
}

test('download checks coalesce, use only credential-free GETs and honor daily/30-second limits', async () => {
  const h = sharingHarness();
  await h.initialize();
  await Promise.all([h.sharing.update('s0'), h.sharing.update('s0')]);
  assert.equal(h.requests.length, 2);
  assert.ok(h.installed.has('s0'));
  await h.sharing.update('s0');
  await h.sharing.update('s0', { force: true });
  assert.equal(h.requests.length, 2);
  h.advance(30001);
  await h.sharing.update('s0', { force: true });
  assert.equal(h.requests.length, 3, 'same checksum only fetches manifest');
  h.advance(PUBLIC_CHECK_INTERVAL);
  await h.sharing.update('s0');
  assert.equal(h.requests.length, 4);
  for (const { url, options } of h.requests) {
    assert.ok(url.startsWith(PUBLIC_GALAXY_URL));
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(!options.body);
    assert.ok(!url.includes('?'));
  }
});

test('disabled automatic downloads make no requests while manual update remains available', async () => {
  const h = sharingHarness();
  await h.initialize();
  await h.sharing.update('s0', { enabled: false });
  assert.deepEqual(h.requests, []);
  await h.sharing.update('s0', { force: true, enabled: false });
  assert.equal(h.requests.length, 2);
});

test('absent universes, bad paths/checksums and network errors are explicit without discarding local data', async () => {
  const h = sharingHarness();
  await h.initialize();
  await h.sharing.update('s0');
  const original = h.installed.get('s0');
  h.advance(PUBLIC_CHECK_INTERVAL);
  h.setManifest({ schemaVersion: 1, servers: {} });
  assert.match((await h.sharing.update('s0')).message, /No public dataset/);
  assert.equal(h.installed.get('s0'), original);
  h.advance(PUBLIC_CHECK_INTERVAL);
  h.setManifest({ schemaVersion: 1, servers: { s0: { file: '../private.json', sha256: hash } } });
  assert.match((await h.sharing.update('s0')).error, /manifest entry/);
  h.advance(PUBLIC_CHECK_INTERVAL);
  h.setManifest({ schemaVersion: 1, servers: { s0: { file: 's0.json', sha256: hash } } });
  h.corrupt();
  assert.match((await h.sharing.update('s0')).error, /checksum/);
  assert.equal(h.installed.get('s0'), original);
  h.advance(PUBLIC_CHECK_INTERVAL);
  h.fail();
  assert.match((await h.sharing.update('s0')).error, /HTTP 503/);
  const count = h.requests.length;
  await h.sharing.update('s0');
  assert.equal(h.requests.length, count, 'failed attempts are throttled too');
  assert.equal(h.installed.get('s0'), original);
});

test('clearing during a download prevents late installation or status resurrection', async () => {
  let release;
  const sharing = createGalaxySharing({
    storage: { get: async () => ({}), set: async () => {} },
    read: async () => null, write: async () => assert.fail('Cancelled data must not install'),
    fetcher: () => new Promise(resolve => { release = resolve; }),
  });
  const pending = sharing.update('s0');
  await new Promise(resolve => setImmediate(resolve));
  sharing.cancel('s0');
  release(new Response(JSON.stringify({ schemaVersion: 1, servers: {} })));
  await assert.rejects(pending, /cancelled/);
});

test('oversized streamed downloads are stopped before parsing or installation even without a length header', async () => {
  const values = {};
  let cancelled = false;
  const sharing = createGalaxySharing({
    storage: { get: async key => ({ [key]: values[key] }), set: async data => Object.assign(values, data) },
    read: async () => null,
    write: async () => assert.fail('Oversized data must not install'),
    fetcher: async url => url.endsWith('manifest.json')
      ? new Response(JSON.stringify({ schemaVersion: 1, servers: { s0: { file: 's0.json', sha256: hash } } }))
      : new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      })),
  });
  const result = await sharing.update('s0');
  assert.match(result.error, /exceeds 25 MB/);
  assert.equal(cancelled, true);
  assert.equal(result.installed, null);
});

test('maintainer preview never writes, merge publishes checksums and conflicts leave repository files unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-galaxy-test-'));
  try {
    const contribution = join(directory, 'contribution.json');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, servers: {} }));
    await writeFile(contribution, JSON.stringify(example()));
    assert.ok((await mergeContribution(contribution, directory, true)).added > 0);
    await assert.rejects(readFile(join(directory, 's0.json')), { code: 'ENOENT' });
    await mergeContribution(contribution, directory);
    await validateRepository(directory);
    const before = await readFile(join(directory, 's0.json'), 'utf8');
    const changed = example();
    changed.systems[0].x = 999;
    await writeFile(contribution, JSON.stringify(changed));
    assert.equal((await mergeContribution(contribution, directory)).conflicts.length, 1);
    assert.equal(await readFile(join(directory, 's0.json'), 'utf8'), before);
    await writeFile(join(directory, 's0.json'), '{}');
    await assert.rejects(validateRepository(directory));
  } finally { await rm(directory, { recursive: true }); }
});

test('repository publication datasets match their manifest checksums', async () => {
  await validateRepository();
});

test('guided import cancels safely, requires exact confirmation, handles spaces and validates successful publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-guided import-'));
  const manifest = join(directory, 'manifest.json');
  const input = join(directory, 'export with spaces (1).json');
  const output = [];
  try {
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, servers: {} }));
    await writeFile(input, JSON.stringify(example()));
    for (const answer of ['', 'yes', 'merge']) {
      const result = await guidedContribution(input, { directory, confirm: async () => answer, log: text => output.push(text) });
      assert.equal(result.applied, false);
      await assert.rejects(readFile(join(directory, 's0.json')), { code: 'ENOENT' });
    }
    assert.ok(output.some(line => line.includes('Universe: s0')));
    assert.ok(output.some(line => line.includes('1 systems, 1 planets, 1 moons')));
    assert.ok(output.some(line => line.includes('Nothing was changed')));
    const result = await guidedContribution(input, { directory, confirm: async () => 'MERGE', log: text => output.push(text) });
    assert.equal(result.applied, true);
    await validateRepository(directory);
    assert.ok(output.some(line => line.includes('Dataset and checksums are valid')));
    const unchanged = await guidedContribution(input, { directory,
      confirm: () => assert.fail('Identical data needs no confirmation'), log: () => {} });
    assert.equal(unchanged.applied, false);
    const published = await readFile(join(directory, 's0.json'), 'utf8');
    const conflict = example();
    conflict.systems[0].x = 999;
    await writeFile(input, JSON.stringify(conflict));
    await assert.rejects(guidedContribution(input, { directory,
      confirm: () => assert.fail('Conflicts must not reach confirmation'), log: () => {} }), /Conflicts found/);
    assert.equal(await readFile(join(directory, 's0.json'), 'utf8'), published);
  } finally { await rm(directory, { recursive: true }); }
});

test('guided import rejects files changed after preview before writing any dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-guided-changed-'));
  try {
    const input = join(directory, 'export.json');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, servers: {} }));
    await writeFile(input, JSON.stringify(example()));
    await assert.rejects(guidedContribution(input, { directory, log: () => {}, confirm: async () => {
      await writeFile(input, JSON.stringify(example('beta')));
      return 'MERGE';
    } }), /changed during confirmation/);
    await assert.rejects(readFile(join(directory, 's0.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, 'beta.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});

test('Windows starter launches the colocated picker with STA and preserves a readable result window', async () => {
  const batch = await readFile(new URL('../tools/Import-Galaxy-Data.bat', import.meta.url), 'utf8');
  const picker = await readFile(new URL('../tools/Import-Galaxy-Data.ps1', import.meta.url), 'utf8');
  assert.match(batch, /-STA -ExecutionPolicy Bypass -File "%~dp0Import-Galaxy-Data\.ps1"/);
  assert.match(batch, /pause/);
  assert.match(batch, /exit \/b %result%/);
  assert.match(picker, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(picker, /CheckFileExists = \$true/);
  assert.match(picker, /& node \$tool guided \$inputFile/);
  assert.match(picker, /Set-Location -LiteralPath \$root/);
});

test('Windows PowerShell executes the actual starter version check without losing argument quotes',
  { skip: process.platform !== 'win32' }, async () => {
    const picker = await readFile(new URL('../tools/Import-Galaxy-Data.ps1', import.meta.url), 'utf8');
    const start = picker.indexOf('    if (-not (Get-Command node');
    const end = picker.indexOf("    Write-Host 'Nexus Overseer");
    assert.ok(start > 0 && end > start);
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'\n${picker.slice(start, end)}\nWrite-Output 'Version check passed'`],
    { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Version check passed/);
  });

test('missing contribution files explain that an actual manually downloaded export is required', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-missing-contribution-'));
  try {
    await assert.rejects(mergeContribution(join(directory, 'missing export.json')), error =>
      /Contribution file not found:/.test(error.message) &&
      /Export public data from Options > Data first/.test(error.message) &&
      /actual downloaded JSON path/.test(error.message) && error.cause.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true }); }
});

test('public galaxy auto-update uses the same switch styling as other options', async () => {
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /<input class="m-switch" type="checkbox" data-setting="data\.publicGalaxyAutoUpdate"/);
});

test('background routes export and install public data without using the authenticated game bridge', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.sendMessage = () => assert.fail('Public sharing must not contact the game bridge');
  const nativeFetch = globalThis.fetch;
  const data = JSON.stringify(example());
  const sha256 = await galaxySha256(data);
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    return new Response(url.endsWith('manifest.json')
      ? JSON.stringify({ schemaVersion: 1, servers: { s0: { file: 's0.json', sha256 } } }) : data);
  };
  try {
    await loadBackground();
    const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
    const status = await listener({ type: 'UPDATE_PUBLIC_GALAXY', force: true });
    assert.equal(status.installed, sha256);
    assert.equal((await listener({ type: 'GET_PUBLIC_GALAXY_STATUS' })).installed, sha256);
    const exported = await listener({ type: 'EXPORT_PUBLIC_GALAXY' });
    assert.deepEqual(exported.data, example());
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.startsWith(PUBLIC_GALAXY_URL)));
  } finally { globalThis.fetch = nativeFetch; }
});
