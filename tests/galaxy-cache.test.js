import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import 'fake-indexeddb/auto';
import {
  createGalaxyCache, saveSystem, readSystem, readScans, restoreGalaxyCache,
  exportGalaxyCache, saveCatalog, systemCacheFresh, OWNERSHIP_TTL, DYNAMIC_TTL,
  saveGalaxyDelta, readGalaxyDeltas,
} from '../nexus-addon/galaxy-cache.js';
import { getSystemPlanets } from '../nexus-addon/galaxy-client.js';
import { makeBrowserStub, loadBackground } from './helpers.js';

const contents = (userId = null) => ({
  visibility: 'full',
  planets: [{ id: 11, name: 'Planet', planetType: 'terra', size: 200, temperature: 24, userId,
    ...(userId ? { ownerName: 'Former owner', ownerAllianceTag: 'OLD', colonizedAt: '2026-01-01' } : {}) }],
  moons: [{ id: 12, planetId: 11, moonType: 'ancient', size: 40, userId }],
  asteroidFields: [{ id: 13, remainingResources: 100 }],
});

function service(fetcher, legacy = {}) {
  const storage = {
    async get() { return legacy; },
    async remove() { delete legacy.planet_scan_cache; },
  };
  return createGalaxyCache({ fetcher, storage });
}

beforeEach(async () => { await restoreGalaxyCache(); });

test('station catalogs persist per universe, coalesce, expire, replace abandoned owners and survive backup', async () => {
  const path = '/api/galaxy/station-index';
  const station = { stationId: 1, stationName: 'Station', systemId: 2, systemName: 'System',
    systemX: 20, systemY: 30, ownedByViewerAlliance: true, ownerAllianceId: 10,
    ownerAllianceName: 'Team', ownerAllianceTag: 'TEAM', capturingAllianceTag: null };
  let calls = 0;
  const cache = service(async () => { calls++; return { stations: [{ ...station }] }; });
  await Promise.all([cache.catalog('s0', path), cache.catalog('s0', path)]);
  assert.equal(calls, 1);
  assert.equal((await cache.catalog('s0', path)).stations[0].stationId, 1);
  assert.equal(calls, 1);
  await cache.catalog('beta', path);
  assert.equal(calls, 2);
  const stale = Date.now() - 16 * 60000;
  await restoreGalaxyCache({ version: 1, entries: [{ serverKey: 's0', key: path,
    at: stale, data: { stations: [station] } }] });
  await cache.catalog('s0', path);
  assert.equal(calls, 3);
  const abandoned = { ...station, ownedByViewerAlliance: false, ownerAllianceId: null,
    ownerAllianceName: null, ownerAllianceTag: null, capturingAllianceTag: 'OTHER' };
  const observedAt = Date.now();
  const expected = { ...abandoned, _observedAt: observedAt };
  await saveCatalog('s0', path, { stations: [abandoned] }, observedAt);
  await saveCatalog('s0', path, { stations: [station] }, stale);
  assert.deepEqual((await cache.catalog('s0', path)).stations, [expected]);
  await saveCatalog('s0', path, { stations: [] });
  assert.deepEqual((await cache.catalog('s0', path)).stations, [expected], 'omission does not delete knowledge or renew station observation');
  assert.deepEqual((await service(async () => ({ stations: [] })).catalog('s0', path, { force: true })).stations, [expected],
    'fresh responses materialize retained knowledge too');
  const backup = await exportGalaxyCache();
  await restoreGalaxyCache(backup);
  assert.deepEqual((await service(() => assert.fail('restored station data is fresh')).catalog('s0', path)).stations, [expected]);
  await cache.clear('s0');
  assert.ok(!(await exportGalaxyCache()).entries.some(entry => entry.key === path));
  assert.throws(() => saveCatalog('s0', path, { stations: [{ ...station, systemX: NaN }] }), /Invalid station/);
  assert.throws(() => restoreGalaxyCache({ version: 1, entries: [{
    serverKey: 's0', key: path, at: observedAt, data: { stations: [{ ...station, _observedAt: observedAt + 1 }] },
  }] }), /Invalid station observation/);
});

test('galaxy deltas persist separately, preserve all body data and ownership clocks, and require no API request', async () => {
  const at = Date.now() - 10000;
  await saveSystem('s0', 1, contents(123), at);
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{ id: 1, hasColonies: false }, { id: 2 }] }, at);
  const before = await readSystem('s0', 1);
  const delta = { type: 'colonized', systemId: 1, hasColonies: true };
  assert.equal((await saveGalaxyDelta('s0', delta, at + 10)).changed, true);
  assert.equal((await saveGalaxyDelta('s0', delta, at + 10)).changed, false);
  assert.equal((await saveGalaxyDelta('s0', delta, at + 5)).changed, false);
  await saveGalaxyDelta('s0', { ...delta, systemId: 99 }, at + 20);
  assert.deepEqual(await readSystem('s0', 1), before);
  assert.equal(await readSystem('s0', 99), null, 'a delta must not fabricate complete system contents');
  assert.deepEqual(await readGalaxyDeltas('beta'), []);
  const cache = service(() => assert.fail('Live deltas must not trigger requests'));
  const map = await cache.catalog('s0', '/api/galaxy/map');
  assert.equal(map.systems[0].hasColonies, true);
  assert.equal(map.systems[0].colonyStateObservedAt, at + 10);
  assert.equal(map.systems[1].hasColonies, undefined);
  assert.equal(map.systems.length, 2, 'unknown systems must not be invented from deltas');
  const snapshot = await exportGalaxyCache();
  await restoreGalaxyCache(snapshot);
  assert.equal((await service(() => assert.fail()).catalog('s0', '/api/galaxy/map')).systems[0].hasColonies, true);
  await cache.clear('s0');
  assert.deepEqual(await readGalaxyDeltas('s0'), []);
});

test('new explicit catalog flags override older colony hints, omitted flags retain them, and catalog TTL is unchanged', async () => {
  const at = Date.now() - 1000;
  const path = '/api/galaxy/map';
  await saveGalaxyDelta('s0', { type: 'colonized', systemId: 1, hasColonies: true }, at);
  const cache = service(() => assert.fail('Unexpected API request'));
  await saveCatalog('s0', path, { systems: [{ id: 1, hasColonies: false }] }, at + 1);
  assert.equal((await cache.catalog('s0', path)).systems[0].hasColonies, false);
  await saveCatalog('s0', path, { systems: [{ id: 1 }] }, at + 2);
  assert.equal((await cache.catalog('s0', path)).systems[0].hasColonies, true);
  await saveCatalog('s0', '/api/galaxy/sectors/1/systems', { systems: [{ id: 1 }] }, at + 2);
  assert.equal((await cache.catalog('s0', '/api/galaxy/sectors/1/systems')).systems[0].hasColonies, true);
  await saveCatalog('s0', path, { systems: [{ id: 1, hasColonies: false }] }, Date.now() - 1000000);
  const raw = (await exportGalaxyCache()).entries.find(entry => entry.key === path);
  assert.equal(raw.at, at + 2, 'deltas do not renew catalog age');
  for (const data of [
    { type: 'abandoned', systemId: 1, hasColonies: false },
    { type: 'colonized', systemId: -1, hasColonies: true },
    { type: 'colonized', systemId: 1, hasColonies: false },
  ]) assert.throws(() => saveGalaxyDelta('s0', data, at), /Invalid|Unsupported/);
  assert.throws(() => saveGalaxyDelta('s0', { type: 'colonized', systemId: 1, hasColonies: true }, NaN), /Invalid/);
});

test('galaxy delta runtime ingestion is scoped to the sending game tab and never fetches unknown systems', async () => {
  makeBrowserStub();
  await import(`../nexus-addon/server-storage.js?galaxyDelta=${crypto.randomUUID()}`);
  globalThis.browser.alarms.get = async () => null;
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const message = { type: 'GALAXY_DELTA', data: { type: 'colonized', systemId: 1, hasColonies: true }, at: Date.now() };
  assert.match((await listener(message)).error, /game-tab origin/);
  const sender = { tab: { url: 'https://beta.nexuslegacy.space/galaxy' } };
  let requests = 0;
  globalThis.browser.tabs.sendMessage = async () => { requests++; throw new Error('Unexpected game request'); };
  assert.equal((await listener(message, sender)).ok, true);
  assert.equal((await readGalaxyDeltas('beta')).length, 1);
  assert.equal((await readGalaxyDeltas('s0')).length, 0);
  const response = await listener({ type: 'GET_GALAXY_DELTAS' }, sender);
  assert.equal(response.deltas[0].systemId, 1);
  assert.equal(requests, 0);
  assert.match((await listener({ ...message, at: undefined }, sender)).error, /Invalid/);
});

test('delta refresh only requests known systems whose latest recorded visibility is full', async () => {
  const at = Date.now() - 10000;
  await saveCatalog('s0', '/api/galaxy/map', { systems: [
    { id: 1, visibility: 'full' }, { id: 2, visibility: 'outline' }, { id: 3, visibility: 'fog' }, { id: 4 },
  ] }, at);
  await saveSystem('s0', 2, contents(), at - 10);
  await saveSystem('s0', 5, contents(), at);
  await saveSystem('s0', 6, { ...contents(), visibility: 'fog', included: [] }, at);
  const paths = [];
  const cache = service(async path => { paths.push(path); return contents(456); });
  for (const id of [2, 3, 4, 6, 99]) {
    assert.equal((await cache.refreshFromDelta('s0', id, at + 1)).refreshed, false);
  }
  assert.equal((await cache.refreshFromDelta('beta', 1, at + 1)).refreshed, false);
  assert.deepEqual(paths, []);
  assert.equal((await cache.refreshFromDelta('s0', 1, at + 1)).refreshed, true);
  assert.equal((await cache.refreshFromDelta('s0', 5, at + 1)).refreshed, true);
  assert.deepEqual(paths, ['/api/galaxy/systems/1/planets', '/api/galaxy/systems/5/planets']);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, 456);
  assert.equal((await readSystem('s0', 5)).data.moons[0].userId, 456);
  await saveCatalog('s0', '/api/galaxy/sectors/1/systems', { systems: [{ id: 1, visibility: 'fog' }] });
  assert.equal((await cache.refreshFromDelta('s0', 1, Date.now() + 1)).refreshed, false);
});

test('delta refresh bypasses ownership TTL, coalesces concurrent hints and skips already covered hints', async () => {
  const at = Date.now() - 10000;
  await saveSystem('s0', 1, contents(123), at);
  let release;
  let requests = 0;
  const cache = service(async () => {
    requests++;
    return new Promise(resolve => { release = resolve; });
  });
  const first = cache.refreshFromDelta('s0', 1, at + 1);
  const second = cache.refreshFromDelta('s0', 1, at + 2);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  release(contents());
  assert.equal((await first).refreshed, true);
  assert.equal((await second).refreshed, true);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, null, 'HTTP can confirm abandonment');
  assert.ok(!(await readSystem('s0', 1)).data.planets[0].ownerName);
  assert.equal((await cache.refreshFromDelta('s0', 1, at + 2)).refreshed, false);
  assert.equal(requests, 1);
});

test('failed delta refresh preserves known contents, rejects with status and allows a later hint to retry', async () => {
  const at = Date.now() - 10000;
  await saveSystem('s0', 1, contents(123), at);
  const before = await readSystem('s0', 1);
  let failure = true;
  const cache = service(async () => {
    if (failure) throw Object.assign(new Error('Too many requests'), { status: 429 });
    return contents(456);
  });
  await assert.rejects(cache.refreshFromDelta('s0', 1, at + 1), error => error.status === 429);
  assert.deepEqual(await readSystem('s0', 1), before);
  failure = false;
  assert.equal((await cache.refreshFromDelta('s0', 1, at + 2)).refreshed, true);
});

test('runtime galaxy hints force an eligible HTTP refresh in the sender universe and notify saved-data consumers', async () => {
  const store = makeBrowserStub();
  await import(`../nexus-addon/server-storage.js?galaxyRefresh=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  globalThis.browser.alarms.get = async () => null;
  const at = Date.now() - 10000;
  await saveSystem('beta', 1, contents(123), at);
  await saveSystem('s0', 1, contents(789), at);
  const queries = [], requests = [];
  globalThis.browser.tabs.query = async query => { queries.push(query); return [{ id: 7, url: 'https://beta.nexuslegacy.space/' }]; };
  globalThis.browser.tabs.sendMessage = async (tab, message) => {
    requests.push({ tab, message });
    return { ok: true, data: contents(456) };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const message = { type: 'GALAXY_DELTA', data: { type: 'colonized', systemId: 1, hasColonies: true }, at: at + 1 };
  const sender = { tab: { url: 'https://beta.nexuslegacy.space/galaxy' } };
  assert.equal((await listener(message, sender)).refreshed, true);
  assert.equal((await listener(message, sender)).refreshed, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message.path, '/api/galaxy/systems/1/planets');
  assert.equal(queries.at(-1).url, 'https://beta.nexuslegacy.space/*');
  assert.equal((await readSystem('beta', 1)).data.planets[0].userId, 456);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, 789);
  assert.equal(store['nexus_server:beta:galaxy_system_revision'].systemId, 1);
  assert.equal(store.nexus_active_server, 's0');
});

test('static data survives expiration and worker recreation without another API request', async () => {
  const at = Date.now() - 30 * 86400000;
  await saveSystem('s0', 1, contents(), at);
  let requests = 0;
  const cache = service(async () => { requests++; return contents(); });
  const result = await cache.system('s0', 1, { purpose: 'static' });
  assert.equal(result.planets[0].size, 200);
  const restarted = service(async () => { requests++; return contents(); });
  await restarted.system('s0', 1, { purpose: 'static' });
  assert.equal(requests, 0);
  assert.equal(systemCacheFresh(await readSystem('s0', 1)), false);
});

test('ownership refresh handles colonization, abandonment and recolonization', async () => {
  await saveSystem('s0', 1, contents(123), Date.now() - OWNERSHIP_TTL - 1);
  let requests = 0;
  let response = contents();
  const cache = service(async () => { requests++; return response; });
  const abandoned = await cache.system('s0', 1);
  assert.equal(abandoned.planets[0].userId, null);
  assert.ok(!abandoned.planets[0].ownerName);
  assert.ok(!abandoned.planets[0].ownerAllianceTag);
  assert.ok(!abandoned.planets[0].colonizedAt);
  assert.equal(abandoned.planets[0].ownershipKnown, true);
  response = contents(456);
  await cache.system('s0', 1);
  assert.equal(requests, 1);
  const recolonized = await cache.system('s0', 1, { force: true });
  assert.equal(recolonized.planets[0].userId, 456);
  assert.equal(requests, 2);
});

test('unknown ownership is not interpreted as an abandoned colony', async () => {
  const data = contents();
  delete data.planets[0].userId;
  await saveSystem('s0', 1, data);
  const entry = await readSystem('s0', 1);
  assert.equal(entry.data.planets[0].ownershipKnown, false);
  assert.equal(systemCacheFresh(entry, 'ownership'), false);
  assert.equal(systemCacheFresh(entry, 'static'), true);
});

test('dynamic freshness is independent of permanent planet data and empty fields are authoritative', async () => {
  await saveSystem('s0', 1, contents(), Date.now() - DYNAMIC_TTL - 1);
  let requests = 0;
  const cache = service(async () => {
    requests++;
    return { asteroidFields: [], included: { asteroidFields: true } };
  });
  await cache.system('s0', 1, { purpose: 'static' });
  assert.equal(requests, 0);
  const data = await cache.system('s0', 1, { purpose: 'dynamic' });
  assert.deepEqual(data.asteroidFields, []);
  assert.equal(data.planets[0].size, 200);
  assert.equal(requests, 1);
  assert.equal(systemCacheFresh(await readSystem('s0', 1), 'dynamic'), true);
});

test('omitted and unresolved groups never erase previously known bodies or refresh their clocks', async () => {
  const at = Date.now() - 50000;
  await saveSystem('s0', 1, contents(123), at);
  await saveSystem('s0', 1, {
    planets: [], moons: [], asteroidFields: [], included: { planets: false, moons: false, asteroidFields: true },
  });
  const row = await readSystem('s0', 1);
  assert.equal(row.data.planets.length, 1);
  assert.equal(row.data.planets[0].userId, 123);
  assert.equal(row.data._galaxyCache.times.planets, at);
  assert.deepEqual(row.data.asteroidFields, []);
  const snapshot = await exportGalaxyCache();
  await restoreGalaxyCache(snapshot);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, 123);
  assert.equal((await readSystem('s0', 1)).data._galaxyCache.times.planets, at);
});

test('an unresolved ownership refresh cannot silently return a stale owner', async () => {
  await saveSystem('s0', 1, contents(123), Date.now() - OWNERSHIP_TTL - 1);
  const cache = service(async () => ({ asteroidFields: [] }));
  await assert.rejects(cache.system('s0', 1, { group: 'planets' }), /did not resolve requested ownership/);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, 123);
});

test('planet-only searches do not require moon or asteroid intelligence', async () => {
  let requests = 0;
  const cache = service(async () => { requests++; return { planets: contents().planets }; });
  await cache.system('s0', 1, { purpose: 'static', group: 'planets' });
  await cache.system('s0', 1, { purpose: 'static', group: 'planets' });
  assert.equal(requests, 1);
  await assert.rejects(cache.system('s0', 1, { group: 'moons' }), /did not resolve/);
});

test('static requests accept merged saved planets when a fresh response resolves only moons', async () => {
  await saveSystem('s0', 1, { planets: contents().planets });
  let requests = 0;
  const cache = service(async () => { requests++; return { moons: contents().moons }; });
  const data = await cache.system('s0', 1, { purpose: 'static', group: 'both' });
  assert.equal(data.planets.length, 1);
  assert.equal(data.moons.length, 1);
  assert.equal(requests, 1);
  await cache.system('s0', 1, { purpose: 'static', group: 'moons' });
  assert.equal(requests, 1);
});

test('unavailable static groups pause repeated requests, retain unknown data and accept passive resolution', async () => {
  await saveSystem('s0', 1, { planets: contents().planets });
  let requests = 0;
  const cache = service(async () => { requests++; return { planets: contents().planets }; });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(cache.system('s0', 1, { purpose: 'static', group: 'moons' }), error =>
      error.code === 'GALAXY_DATA_UNAVAILABLE' && error.groups.join() === 'moons');
  }
  assert.equal(requests, 1);
  assert.equal((await readSystem('s0', 1)).data.moons, undefined);
  await saveSystem('s0', 1, { moons: [] });
  assert.deepEqual((await cache.system('s0', 1, { purpose: 'static', group: 'moons' })).moons, []);
  assert.equal(requests, 1);
});

test('unavailable-data pause expires and is separate per universe; force may retry immediately', async () => {
  let requests = 0;
  const cache = service(async () => { requests++; return { planets: [] }; });
  const missing = server => cache.system(server, 1, { purpose: 'static', group: 'moons' });
  await assert.rejects(missing('s0'), /moons unavailable/);
  await assert.rejects(missing('beta'), /moons unavailable/);
  assert.equal(requests, 2);
  await assert.rejects(cache.system('s0', 1, { purpose: 'static', group: 'moons', force: true }), /moons unavailable/);
  assert.equal(requests, 3);
  const now = Date.now;
  const later = now() + 15 * 60 * 1000 + 1;
  Date.now = () => later;
  try { await assert.rejects(missing('s0'), /moons unavailable/); }
  finally { Date.now = now; }
  assert.equal(requests, 4);
  await cache.clear('s0');
  await assert.rejects(missing('s0'), /moons unavailable/);
  assert.equal(requests, 5);
});

test('client preserves unavailable group details from the background', async () => {
  makeBrowserStub();
  globalThis.browser.runtime.sendMessage = async () => ({
    error: 'Moon details unavailable', code: 'GALAXY_DATA_UNAVAILABLE', groups: ['moons'],
  });
  await assert.rejects(getSystemPlanets(1, {}, { purpose: 'static', group: 'moons' }),
    error => error.code === 'GALAXY_DATA_UNAVAILABLE' && error.groups.join() === 'moons');
});

test('unresolved fog responses do not create false knowledge or unrestorable backup entries', async () => {
  await saveSystem('s0', 1, { visibility: 'fog', planets: [], moons: [], asteroidFields: [] });
  assert.equal(await readSystem('s0', 1), null);
  assert.deepEqual(await readScans('s0'), {});
  await restoreGalaxyCache(await exportGalaxyCache());
});

test('older observations cannot replace fresher ownership or properties', async () => {
  const at = Date.now();
  await saveSystem('s0', 1, contents(456), at);
  const older = contents(123);
  older.planets[0].size = 100;
  await saveSystem('s0', 1, older, at - 10000);
  const row = await readSystem('s0', 1);
  assert.equal(row.data.planets[0].userId, 456);
  assert.equal(row.data.planets[0].size, 200);
});

test('legacy migration retains more than 800 systems and does not refresh old ownership', async () => {
  const at = Date.now() - 2 * OWNERSHIP_TTL;
  const legacy = { planet_scan_cache: Object.fromEntries(
    Array.from({ length: 805 }, (_, index) => [index + 1, { at, data: contents() }])) };
  const cache = service(() => assert.fail('migration must not fetch'), legacy);
  const scans = await cache.scans('s0');
  assert.equal(Object.keys(scans).length, 805);
  assert.equal(legacy.planet_scan_cache, undefined);
  assert.equal(systemCacheFresh(scans[1], 'ownership'), false);
  assert.equal(systemCacheFresh(scans[1], 'static'), true);
});

test('catalogs and contents stay separate for each universe and concurrent misses are coalesced', async () => {
  let requests = 0;
  const cache = service(async path => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 1));
    return path.endsWith('/map') ? { systems: [{ id: 1 }] } : contents();
  });
  await Promise.all([cache.system('s0', 1), cache.system('s0', 1)]);
  assert.equal(requests, 1);
  await cache.system('beta', 1);
  assert.equal(requests, 2);
  await Promise.all([cache.catalog('s0', '/api/galaxy/map'), cache.catalog('s0', '/api/galaxy/map')]);
  assert.equal(requests, 3);
  await cache.catalog('s0', '/api/galaxy/map');
  assert.equal(requests, 3);
  await cache.catalog('beta', '/api/galaxy/map');
  assert.equal(requests, 4);
  await cache.clear('beta');
  assert.equal(await readSystem('beta', 1), null);
  assert.ok(await readSystem('s0', 1));
});

test('failed refreshes are explicit, preserve known data, and can be retried', async () => {
  await saveSystem('s0', 1, contents(123), Date.now() - OWNERSHIP_TTL - 1);
  let fail = true;
  const cache = service(async () => {
    if (fail) throw new Error('API unavailable');
    return contents();
  });
  await assert.rejects(cache.system('s0', 1), /API unavailable/);
  assert.equal((await readSystem('s0', 1)).data.planets[0].userId, 123);
  fail = false;
  assert.equal((await cache.system('s0', 1)).planets[0].userId, null);
});

test('regular backups preserve universes, catalogs and independent timestamps', async () => {
  const at = Date.now() - 2 * OWNERSHIP_TTL;
  await saveSystem('s0', 1, contents(123), at);
  await saveSystem('s0', 1, { asteroidFields: [] });
  await saveSystem('beta', 2, contents());
  await saveCatalog('s0', '/api/galaxy/map', { systems: [{ id: 1 }] });
  const snapshot = await exportGalaxyCache();
  await restoreGalaxyCache();
  await restoreGalaxyCache(snapshot);
  assert.equal(Object.keys(await readScans('s0')).length, 1);
  assert.equal((await readSystem('beta', 2)).data.planets[0].size, 200);
  assert.equal((await readSystem('s0', 1)).data._galaxyCache.ownership.planets, at);
  const cache = service(() => assert.fail('restored catalog must not fetch'));
  assert.equal((await cache.catalog('s0', '/api/galaxy/map')).systems.length, 1);
  assert.throws(() => restoreGalaxyCache({ version: 1, entries: [{ key: 'invalid' }] }), /Invalid/);
  assert.equal(Object.keys(await readScans('s0')).length, 1);
});

test('800 cached client lookups need zero runtime/API calls and finish without per-system waits', async () => {
  makeBrowserStub();
  let messages = 0;
  globalThis.browser.runtime.sendMessage = async () => { messages++; assert.fail('unexpected request'); };
  await saveSystem('s0', 1, contents(), Date.now() - 30 * 86400000);
  const entry = await readSystem('s0', 1);
  const scans = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [i + 1, entry]));
  const start = performance.now();
  for (let id = 1; id <= 800; id++) await getSystemPlanets(id, scans, { purpose: 'static' });
  assert.equal(messages, 0);
  assert.ok(performance.now() - start < 1000, 'cached lookup budget is 1 second, not the former 64-second wait');
});

test('background galaxy routes share catalogs and consume passive observations without extra fetches', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 1, url: 'https://s0.nexuslegacy.space/' }];
  let requests = 0;
  globalThis.browser.tabs.sendMessage = async () => { requests++; return { ok: true, data: { systems: [{ id: 1 }] } }; };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  assert.equal((await listener({ type: 'GET_GALAXY_MAP' })).systems.length, 1);
  await listener({ type: 'GET_GALAXY_MAP' });
  assert.equal(requests, 1);
  await listener({ type: 'GALAXY_OBSERVED', path: '/api/galaxy/systems/1/planets', data: contents(), at: Date.now() });
  assert.equal((await listener({ type: 'GET_SYSTEM_PLANETS', systemId: 1 })).planets[0].size, 200);
  assert.equal(requests, 1);
  const invalid = await listener({ type: 'GET_SYSTEM_PLANETS', systemId: -1 });
  assert.match(invalid.error, /Invalid/);
  await listener({ type: 'GALAXY_OBSERVED', path: '/api/galaxy/station-index',
    data: { stations: [] }, at: Date.now() });
  assert.deepEqual((await listener({ type: 'GET_STATION_INDEX' })).stations, []);
  assert.equal(requests, 1, 'passively observed station index is reused');
});

test('exhausted bridge 429 remains HTTP 429 through background cache and client, never missing static data', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 1, url: 'https://s0.nexuslegacy.space/' }];
  let requests = 0;
  globalThis.browser.tabs.sendMessage = async () => {
    requests++;
    return { status: 429, error: 'Too many requests', retryAfter: '1' };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  globalThis.browser.runtime.sendMessage = message => listener(message);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let error;
  const request = getSystemPlanets(2889, {}, { purpose: 'static', group: 'planets' }).catch(value => { error = value; });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100 && !requests; i++) await settle();
  assert.equal(requests, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.tick(5000);
    for (let i = 0; i < 20; i++) await settle();
  }
  await request;
  assert.equal(requests, 4);
  assert.equal(error.status, 429);
  assert.equal(error.code, undefined);
  assert.doesNotMatch(error.message, /did not resolve/);
  assert.equal(await readSystem('s0', 2889), null);
});

test('passive galaxy hook captures successful same-origin GETs, replays early responses and preserves field relay', async () => {
  const posts = [];
  const listeners = [];
  let status = 200;
  let parses = 0;
  const context = vm.createContext({
    URL, Date, console,
    JSON: { parse: text => { parses++; return JSON.parse(text); }, stringify: JSON.stringify },
    location: { origin: 'https://s0.nexuslegacy.space' },
    addEventListener: (name, listener) => listeners.push(listener),
    postMessage: message => posts.push(JSON.parse(JSON.stringify(message))),
    fetch: async () => ({ ok: status === 200, clone: () => ({ text: async () => JSON.stringify(contents()) }) }),
    XMLHttpRequest: class {
      open() {}
      send() {}
      addEventListener(name, listener) { this.onLoad = listener; }
    },
  });
  context.window = context;
  vm.runInContext(await readFile(new URL('../nexus-addon/galaxy-fetch-hook.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await context.fetch('/api/galaxy/systems/1/planets');
  await settle();
  assert.equal(posts.filter(post => post.__nxGalaxyObservation).length, 1);
  assert.equal(posts.filter(post => post.__nxFields).length, 1);
  assert.equal(parses, 1, 'system data is parsed once for both observation and field consumers');
  const original = posts[0].__nxGalaxyObservation.at;
  vm.runInContext('globalThis.replay = {source:window,origin:location.origin,data:{__nxRequestGalaxy:true}}', context);
  for (const listener of listeners) listener(context.replay);
  assert.equal(posts.filter(post => post.__nxGalaxyObservation).length, 2);
  assert.equal(posts.at(-1).__nxGalaxyObservation.at, original);
  await context.fetch('https://other.example/api/galaxy/map');
  await context.fetch('/api/galaxy/map', { method: 'POST' });
  status = 500;
  await context.fetch('/api/galaxy/map');
  await settle();
  assert.equal(posts.filter(post => post.__nxGalaxyObservation).length, 2);
  status = 200;
  await context.fetch(new URL('https://s0.nexuslegacy.space/api/galaxy/map'));
  await settle();
  assert.equal(posts.at(-1).__nxGalaxyObservation.path, '/api/galaxy/map');
  await context.fetch('/api/galaxy/station-index');
  await settle();
  assert.equal(posts.at(-1).__nxGalaxyObservation.path, '/api/galaxy/station-index');
  assert.equal(parses, 3, 'foreign, failed and non-GET requests must not be parsed');
  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', '/api/galaxy/systems/2/planets');
  Object.assign(xhr, { status: 200, responseType: 'json', response: contents() });
  xhr.send();
  xhr.onLoad();
  assert.equal(parses, 4, 'XHR system data also feeds both consumers from a single parse');
  assert.equal(posts.filter(post => post.__nxFields).length, 2);
});

test('galaxy relay works independently of diagnostic recording and reports storage failures', async () => {
  const sent = [], errors = [], posts = [], listeners = [];
  let failure = false;
  const context = vm.createContext({
    location: { origin: 'https://s0.nexuslegacy.space' },
    browser: { runtime: { async sendMessage(message) {
      sent.push(message);
      return failure ? { error: 'Database unavailable' } : { ok: true };
    } } },
    console: { error: (...args) => errors.push(args), info() {} },
    addEventListener: (name, listener) => listeners.push(listener),
    removeEventListener() {},
    postMessage: message => posts.push(message),
  });
  context.window = context;
  vm.runInContext(await readFile(new URL('../nexus-addon/galaxy-cache-relay.js', import.meta.url), 'utf8'), context);
  assert.equal(posts[0].__nxRequestGalaxy, true);
  vm.runInContext(`globalThis.observed = {source:window,origin:location.origin,data:{
    __nxGalaxyObservation:{path:'/api/galaxy/map',at:10,data:{systems:[]}}}}`, context);
  await listeners[0](context.observed);
  await listeners[0](context.observed);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'GALAXY_OBSERVED');
  context.observed.data.__nxGalaxyObservation.at = 20;
  failure = true;
  await listeners[0](context.observed);
  assert.equal(errors.length, 1);
  await listeners[0](context.observed);
  assert.equal(sent.length, 3, 'failed observations can be retried');
  failure = false;
  vm.runInContext(`globalThis.delta = {source:window,origin:location.origin,data:{
    __nxGalaxyDelta:{data:{type:'colonized',systemId:1,hasColonies:true},at:30}}}`, context);
  await listeners[0](context.delta);
  await listeners[0](context.delta);
  assert.equal(sent.length, 4);
  assert.equal(sent.at(-1).type, 'GALAXY_DELTA');
  context.delta.data.__nxGalaxyDelta.data.systemId = 2;
  await listeners[0](context.delta);
  assert.equal(sent.length, 5, 'same-millisecond deltas for different systems must survive');
  context.delta.data.__nxGalaxyDelta.data.hasColonies = false;
  await listeners[0](context.delta);
  context.delta.source = {};
  context.delta.data.__nxGalaxyDelta.data.hasColonies = true;
  context.delta.data.__nxGalaxyDelta.at = 40;
  await listeners[0](context.delta);
  assert.equal(sent.length, 5, 'unsupported payloads and foreign sources are not relayed');
});

test('galaxy cache modules and passive relay are included in release packages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  const files = JSON.parse(await readFile(new URL('../tools/windows-updater/addon-files.json', import.meta.url), 'utf8'));
  for (const name of ['galaxy-cache.js', 'galaxy-client.js', 'galaxy-cache-relay.js', 'galaxy-directory.js', 'galaxy-images.js']) assert.ok(files.includes(name));
  assert.ok(manifest.content_scripts.some(script => script.js.includes('galaxy-cache-relay.js') && script.run_at === 'document_start'));
});
