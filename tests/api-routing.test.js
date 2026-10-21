import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import 'fake-indexeddb/auto';
import { restoreGalaxyCache, saveSystem, saveCatalog } from '../nexus-addon/galaxy-cache.js';
import { readDiagnosticLogs, clearDiagnosticLogs } from '../nexus-addon/diagnostics-store.js';
import { makeBrowserStub, loadBackground } from './helpers.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('asteroid detail reads remain behind the shared system budget and resume after release', async t => {
  makeBrowserStub();
  const { browser } = globalThis;
  browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  const sent = [];
  browser.tabs.query = async () => [{ id: 42 }];
  browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message.path);
    return { ok: true, data: { asteroidFields: [] } };
  };
  const background = await loadBackground();
  const listener = browser.runtime.onMessage.listeners.at(-1);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  for (let i = 0; i < 30; i++) {
    await background.apiFetch(`/api/galaxy/systems/${i + 1}/planets`, { serverOrigin: 'https://s0.nexuslegacy.space' });
  }
  const pending = listener({ type: 'GET_SYSTEM_PLANETS', systemId: 31, purpose: 'dynamic',
    priority: 'bulk', source: 'asteroid-search' });
  let status;
  for (let i = 0; i < 100; i++) {
    await settle();
    status = await listener({ type: 'GET_API_STATUS', path: '/api/galaxy/systems/31/planets' });
    if (status.queued) break;
  }
  assert.equal(status.queued, 1);
  assert.equal(status.request.reason, 'budget');
  assert.equal(status.request.scope, 'system-details');
  assert.equal(sent.length, 30);
  t.mock.timers.tick(10099);
  await settle();
  assert.equal(sent.length, 30);
  t.mock.timers.tick(1);
  assert.deepEqual((await pending).asteroidFields, []);
  assert.equal(sent.length, 31);
});

test('asteroid live scan defaults to 10 and shares fresh dynamic observations with manual scans', async () => {
  const store = makeBrowserStub({ live_search: { enabled: true, planetId: 1 } });
  const { browser } = globalThis;
  browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  const systems = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, sectorId: 1, x: i, y: 0, visibility: 'full',
    name: `System ${i + 1}`, securityZone: 'open', planetCount: 1,
  }));
  await saveCatalog('s0', '/api/galaxy/map', { systems });
  await saveCatalog('s0', '/api/galaxy/sectors/1/systems', { systems });
  const fields = id => ({
    visibility: 'full', included: { planets: true, moons: true, fields: true },
    planets: [], moons: [],
    asteroidFields: [{ id, fieldType: 'ore', richness: 2, remainingResources: 100, totalResources: 200 }],
  });
  for (let id = 2; id <= 11; id++) {
    await saveSystem('s0', id, fields(id), Date.now() - (id === 4 ? 16 : 1) * 60000);
  }
  const sent = [];
  browser.tabs.query = async () => [{ id: 42 }];
  browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message.path);
    if (message.path === '/api/planets') return { ok: true, data: { planets: [{ id: 1, systemId: 1 }] } };
    if (message.path === '/api/fleet/missions') return { ok: true, data: { missions: [] } };
    assert.equal(message.path, '/api/galaxy/systems/4/planets');
    return { ok: true, data: fields(4) };
  };
  await loadBackground();
  const alarm = browser.alarms.onAlarm.listeners.at(-1);
  await alarm({ name: 'nexus-livesearch' });
  assert.equal(store.live_search_status.state, 'idle');
  assert.equal(store.live_search_status.scanned, 10);
  assert.equal(store.live_search_status.target, 10);
  assert.equal(store.live_search_status.targetProgress, 10);
  assert.equal(store.live_search_status.typeFiltered, false);
  assert.equal(store.live_search_status.matchingFields, 10);
  assert.equal(store.live_search_last_matches.length, 10);
  assert.deepEqual(sent, ['/api/planets', '/api/fleet/missions', '/api/galaxy/systems/4/planets']);
  await alarm({ name: 'nexus-livesearch' });
  assert.deepEqual(sent, ['/api/planets', '/api/fleet/missions', '/api/galaxy/systems/4/planets', '/api/planets', '/api/fleet/missions']);
});

for (const failureStatus of [429, 401]) {
  test(`asteroid live scan retains matches and stops after HTTP ${failureStatus} recovery is exhausted`, async t => {
    const store = makeBrowserStub({ live_search: { enabled: true, planetId: 1, near: 3 } });
    const { browser } = globalThis;
    browser.alarms.get = async () => null;
    t.mock.method(console, 'warn', () => {});
    await restoreGalaxyCache();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const systems = [1, 2, 3, 4].map(id => ({
      id, sectorId: 1, x: id, y: 0, visibility: 'full', planetCount: 1, securityZone: 'open',
    }));
    await saveCatalog('s0', '/api/galaxy/map', { systems });
    await saveCatalog('s0', '/api/galaxy/sectors/1/systems', { systems });
    await saveSystem('s0', 2, { asteroidFields: [{ id: 22, fieldType: 'ore', remainingResources: 10 }] });
    const sent = [];
    browser.tabs.query = async () => [{ id: 42 }];
    browser.tabs.sendMessage = async (_id, message) => {
      sent.push(message.path);
      if (message.path === '/api/planets') return { ok: true, data: { planets: [{ id: 1, systemId: 1 }] } };
      if (message.path === '/api/fleet/missions') return { ok: true, data: { missions: [] } };
      assert.equal(message.path, '/api/galaxy/systems/3/planets');
      return { status: failureStatus, rateLimitScope: 'system-details', retryAfter: '1', error: 'Refused' };
    };
    await loadBackground();
    const scanning = browser.alarms.onAlarm.listeners.at(-1)({ name: 'nexus-livesearch' });
    for (let i = 0; i < 100 && sent.length < 3; i++) await settle();
    assert.equal(sent.length, 3);
    if (failureStatus === 429) {
      assert.equal(store.live_search_status.apiPath, '/api/galaxy/systems/3/planets');
      for (let attempt = 0; attempt < 3; attempt++) {
        t.mock.timers.tick(5000);
        for (let i = 0; i < 100 && sent.length < attempt + 4; i++) await settle();
        assert.equal(sent.length, attempt + 4);
      }
    }
    await scanning;
    assert.equal(store.live_search_status.state, 'error');
    assert.match(store.live_search_status.error, failureStatus === 429 ? /API rate limit \(429\)/ : /Please log in/);
    assert.equal(store.live_search_status.found, 1);
    assert.deepEqual(store.live_search_last_matches.map(match => match.id), [22]);
    assert.equal(store.live_search_status.apiPath, undefined);
    assert.equal(sent.length, failureStatus === 429 ? 6 : 3);
  });
}

async function liveHarness(config = { enabled: true, planetId: 1, near: 2 }) {
  const store = makeBrowserStub({ live_search: config });
  const { browser } = globalThis;
  browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  const systems = [1, 2, 3].map(id => ({
    id, sectorId: 1, x: id, y: 0, visibility: 'full', planetCount: 1, securityZone: 'open',
  }));
  await saveCatalog('s0', '/api/galaxy/map', { systems });
  await saveCatalog('s0', '/api/galaxy/sectors/1/systems', { systems });
  let missions = [];
  let details = async () => ({ asteroidFields: [], included: { fields: true } });
  const sent = [];
  browser.tabs.query = async () => [{ id: 42 }];
  browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message.path);
    if (message.path === '/api/planets') return { ok: true, data: { planets: [{ id: 1, systemId: 1 }] } };
    if (message.path === '/api/fleet/missions') return { ok: true, data: { missions } };
    return { ok: true, data: await details(message.path) };
  };
  await loadBackground();
  return { store, sent, setMissions: value => { missions = value; }, setDetails: value => { details = value; },
    scan: () => browser.alarms.onAlarm.listeners.at(-1)({ name: 'nexus-livesearch' }),
    message: message => browser.runtime.onMessage.listeners.at(-1)(message),
  };
}

test('live refresh replaces stale matches and keeps only active mission exceptions without ghost resources', async () => {
  const h = await liveHarness({ enabled: true, planetId: 1, near: 1, leftMin: 50 });
  const field = (id, remainingResources = 80) => ({
    id, fieldType: 'ore', richness: 2, totalResources: 100, remainingResources,
  });
  h.setMissions([{ missionType: 'mine', targetFieldId: 22 }]);
  await saveSystem('s0', 2, { asteroidFields: [field(21), field(22), field(23)], included: { fields: true } });
  await h.scan();
  assert.deepEqual(h.store.live_search_last_matches.map(f => f.id), [21, 22, 23]);
  await saveSystem('s0', 2, { asteroidFields: [field(21, 20)], included: { fields: true } });
  await h.scan();
  assert.deepEqual(h.store.live_search_last_matches.map(f => f.id), [22]);
  const missing = h.store.live_search_last_matches[0];
  assert.equal(missing.missing, true);
  assert.equal(missing.ownMission, true);
  assert.equal(missing.remaining, null);
  assert.equal(missing.leftPct, null);
  h.setMissions([]);
  await h.scan();
  assert.deepEqual(h.store.live_search_last_matches, []);
  assert.ok(h.store.asteroid_scan_results.fields.every(f => !f.missing));
});

test('stopping a live pass waiting on a reply prevents more reads and late result publication', async () => {
  const h = await liveHarness();
  let release;
  h.setDetails(() => new Promise(resolve => { release = resolve; }));
  const pass = h.scan();
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.ok(release);
  await h.message({ type: 'STOP_LIVE_SEARCH' });
  release({ asteroidFields: [{ id: 21, fieldType: 'ore' }], included: { fields: true } });
  await pass;
  assert.equal(h.store.live_search.enabled, false);
  assert.equal(h.store.live_search_status.state, 'stopped');
  assert.equal(h.store.live_search_last_matches, undefined);
  assert.equal(h.store.asteroid_scan_results, undefined);
  assert.equal(h.sent.filter(path => path.includes('/systems/')).length, 1);
});

test('live partial snapshots preserve pending hits until checked, without retaining them after the pass', async () => {
  const h = await liveHarness({ enabled: true, planetId: 1, near: 2 });
  const { browser } = globalThis;
  await browser.storage.local.set({ asteroid_scan_results: { planetId: 1, fields: [
    { fieldId: 21, systemId: 2, type: 'ore' }, { fieldId: 31, systemId: 3, type: 'ore' },
    { fieldId: 99, systemId: 99, type: 'ore' },
  ] } });
  await saveSystem('s0', 2, { asteroidFields: [{ id: 21, fieldType: 'ore' }], included: { fields: true } });
  let release;
  h.setDetails(() => new Promise(resolve => { release = resolve; }));
  const pass = h.scan();
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.ok(release);
  assert.equal(h.store.asteroid_scan_results.updating, true);
  assert.deepEqual(h.store.asteroid_scan_results.fields.map(f => f.fieldId), [21, 31, 99]);
  release({ asteroidFields: [], included: { fields: true } });
  await pass;
  assert.equal(h.store.asteroid_scan_results.updating, false);
  assert.deepEqual(h.store.asteroid_scan_results.fields.map(f => f.fieldId), [21]);
});

test('live pass rechecks own fields outside its candidate range and distinguishes unknown from missing', async () => {
  const h = await liveHarness({ enabled: true, planetId: 1, near: 1, leftMin: 50 });
  h.setMissions([{ missionType: 'mine', targetFieldId: 99 }]);
  await globalThis.browser.storage.local.set({ asteroid_scan_results: { fields: [
    { fieldId: 99, systemId: 99, type: 'ore', zone: 'open', remaining: 80, total: 100 },
  ] } });
  h.setDetails(path => path.includes('/99/')
    ? { asteroidFields: [{ id: 99, fieldType: 'ore', remainingResources: 10, totalResources: 100 }], included: { fields: true } }
    : { asteroidFields: [], included: { fields: true } });
  await h.scan();
  assert.ok(h.sent.includes('/api/galaxy/systems/99/planets'));
  assert.equal(h.store.live_search_last_matches[0].remaining, 10);
  assert.equal(h.store.live_search_last_matches[0].outsideFilters, true);
  const unknownHarness = await liveHarness({ enabled: true, planetId: 1, near: 1, leftMin: 50 });
  unknownHarness.setMissions([{ missionType: 'mine', targetFieldId: 99 }]);
  await globalThis.browser.storage.local.set({ asteroid_scan_results: h.store.asteroid_scan_results });
  unknownHarness.setDetails(() => ({ planets: [], asteroidFields: [], included: { fields: false } }));
  await unknownHarness.scan();
  const unknown = unknownHarness.store.live_search_last_matches[0];
  assert.equal(unknown.unconfirmed, true);
  assert.equal(unknown.missing, false);
  assert.equal(unknown.remaining, null);
  assert.equal(unknownHarness.store.asteroid_scan_results.incomplete, true);
  assert.equal(unknownHarness.store.live_search_status.state, 'error');
});

test('changing live filters during a pass discards the old pass and publishes only the latest search', async () => {
  const h = await liveHarness({ enabled: true, planetId: 1, near: 1, types: ['ore'] });
  let release;
  h.setDetails(() => new Promise(resolve => { release = resolve; }));
  await saveSystem('s0', 3, { asteroidFields: [{ id: 31, fieldType: 'gas' }], included: { fields: true } });
  const pass = h.scan();
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.ok(release);
  await h.message({ type: 'SET_LIVE_SEARCH', config: { enabled: true, planetId: 1, near: 1, types: ['gas'] } });
  release({ asteroidFields: [{ id: 21, fieldType: 'ore' }], included: { fields: true } });
  await pass;
  assert.deepEqual(h.store.live_search_last_matches.map(f => f.id), [31]);
  assert.deepEqual(h.store.asteroid_scan_results.config.types, ['gas']);
  assert.equal(h.store.live_search_status.targetProgress, 1);
  assert.equal(h.store.live_search_status.target, 1);
  assert.equal(h.store.live_search_status.typeFiltered, true);
});

test('live pass retains its universe after the selected server changes during a read', async () => {
  const h = await liveHarness({ enabled: true, planetId: 1, near: 1 });
  await import(`../nexus-addon/server-storage.js?live-pin=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  let release;
  h.setDetails(() => new Promise(resolve => { release = resolve; }));
  globalThis.browser.tabs.query = async query => {
    assert.equal(query.url, 'https://s0.nexuslegacy.space/*');
    return [{ id: 42 }];
  };
  const pass = h.scan();
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.ok(release);
  await storage.setActiveServer('beta');
  release({ asteroidFields: [{ id: 21, fieldType: 'ore' }], included: { fields: true } });
  await pass;
  const original = await storage.forServer('s0').get(['asteroid_scan_results', 'live_search_last_matches']);
  assert.deepEqual(original.live_search_last_matches.map(f => f.id), [21]);
  assert.equal(original.asteroid_scan_results.planetId, 1);
  assert.deepEqual(await storage.forServer('beta').get('asteroid_scan_results'), {});
});

test('wait recording is independent of body recording and keeps source labels through the galaxy cache', async () => {
  makeBrowserStub({ nexus_settings: { 'developer.apiWaitRecording': true, 'developer.recording': false } });
  globalThis.browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  await clearDiagnosticLogs('s0');
  await import(`../nexus-addon/server-storage.js?telemetry=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async () => ({
    ok: true, status: 200, data: { planets: [{ id: 99, planetType: 'terra' }] },
  });
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  await listener({ type: 'GET_SYSTEM_PLANETS', systemId: 9, purpose: 'static', group: 'planets',
    source: 'galaxy-search' });
  let logs = [];
  for (let i = 0; i < 100; i++) {
    logs = await readDiagnosticLogs('s0');
    if (logs.some(entry => entry.data.event === 'response')) break;
    await settle();
  }
  assert.equal(logs.filter(entry => entry.kind === 'api').length, 0);
  assert.equal(logs.find(entry => entry.data.event === 'dispatch').data.source, 'galaxy-search');
  assert.equal(logs.find(entry => entry.data.event === 'response').data.status, 200);
  const { loadSettings } = await import('../nexus-addon/settings.js');
  await globalThis.nexusStorage.setSettings({ 'developer.apiWaitRecording': false });
  await loadSettings();
  const count = logs.length;
  await listener({ type: 'API_REQUEST', method: 'GET', requestId: 'disabled', path: '/api/planets' });
  await settle();
  assert.equal((await readDiagnosticLogs('s0')).length, count);
  assert.deepEqual(await listener({ type: 'DIAGNOSTICS_CLEAR', kind: 'scheduling', serverKey: 's0' },
    { url: globalThis.browser.runtime.getURL('dashboard.html') }), { ok: true });
  assert.equal((await readDiagnosticLogs('s0')).length, 0);
});

test('saved galaxy scans bypass a held network storage scope without mixing universes', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  await saveSystem('s0', 1, { planets: [{ id: 11, planetType: 'terra' }] });
  await saveSystem('beta', 2, { planets: [{ id: 22, planetType: 'ice' }] });
  await import(`../nexus-addon/server-storage.js?scans=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  await loadBackground();
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const scope = storage.withServer('beta', async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  let response;
  const read = listener({ type: 'GET_GALAXY_SCANS' }).then(result => { response = result; });
  try {
    for (let i = 0; i < 100 && !response; i++) await settle();
    assert.ok(response, 'local search preparation must not wait behind a network operation');
    assert.deepEqual(Object.keys(response.scans), ['1']);
    const status = await listener({ type: 'GET_API_STATUS', path: '/api/galaxy/systems/1/planets' });
    assert.equal(status.origin, 'https://s0.nexuslegacy.space');
    assert.equal(status.running, 0);
    assert.equal(status.queued, 0);
    assert.deepEqual(await listener({ type: 'GET_API_STATUS', path: 'https://example.com/api/' }),
      { error: 'Invalid API status path.' });
    assert.equal((await storage.getActiveServer()).key, 'beta');
  } finally {
    release();
    await Promise.all([scope, read]);
  }
});

test('actions and their ship reads bypass a held storage scope and retain their sender universe', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await import(`../nexus-addon/server-storage.js?routing=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const scope = storage.withServer('beta', async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  const sent = [];
  globalThis.browser.tabs.query = async query => {
    assert.equal(query.url, 'https://s0.nexuslegacy.space/*');
    return [{ id: 42 }];
  };
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message);
    return { ok: true, data: { fleet: [{ shipDefId: 1, quantity: 10 }] } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  try {
    const ships = await listener({ type: 'GET_PLANET_SHIPS', planetId: 1, priority: 'action' });
    assert.deepEqual(ships.available, { 1: 10 });
    await listener({ type: 'SEND_EXPEDITION', sourcePlanetId: 1, ships: [{ shipDefId: 1, quantity: 1 }] });
    const overlay = await listener({ type: 'API_REQUEST', requestId: 'overlay', method: 'GET',
      path: '/api/planets/1' }, { tab: { id: 42, url: 'https://s0.nexuslegacy.space/' } });
    assert.equal(overlay.ok, true);
    assert.equal(sent.length, 3);
    assert.equal((await storage.getActiveServer()).key, 'beta');
  } finally {
    release();
    await scope;
  }
});

test('fuel retries pass the short-window gate again and keep their original origin', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const sent = [];
  globalThis.browser.tabs.query = async query => {
    assert.equal(query.url, 'https://s0.nexuslegacy.space/*');
    return [{ id: 42 }];
  };
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    sent.push({ path: message.path, at: Date.now() });
    return sent.length === 40
      ? { status: 429, rateLimitScope: 'fuel-estimate', retryAfter: '1', error: 'Limited' }
      : { ok: true, data: {} };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  for (let i = 0; i < 39; i++) {
    await listener({ type: 'GET_FUEL_ESTIMATE', body: {} });
  }
  const retry = listener({ type: 'GET_FUEL_ESTIMATE', body: {} });
  await settle();
  assert.equal(sent.length, 40);
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(sent.length, 40);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(sent.length, 40);
  t.mock.timers.tick(100);
  await retry;
  assert.equal(sent.length, 41);
  assert.equal(sent.at(-1).at, 110100);
});

test('central transport is the only authenticated game API fetch surface', async () => {
  for (const file of ['empire-view.js', 'logistics-view.js', 'building-upgrade.js',
    'tech-upgrade.js', 'ship-upgrade.js', 'upgrade-queue.js']) {
    const source = await readFile(new URL(`../nexus-addon/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
    assert.match(source, /nexusGameApi/, file);
  }
  const files = JSON.parse(await readFile(new URL('../tools/windows-updater/addon-files.json', import.meta.url), 'utf8'));
  for (const file of ['api-scheduler.js', 'game-api-client.js', 'api-status.js']) assert.ok(files.includes(file));
  const manifest = JSON.parse(await readFile(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.content_scripts.some(entry => entry.run_at === 'document_start' &&
    entry.js.includes('game-api-client.js') && entry.world !== 'MAIN'));
});

test('captured system-details 429 headers pause only that scope until its advertised reset', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  const sent = [];
  let limited = false;
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    sent.push({ path: message.path, at: Date.now() });
    if (message.path.includes('/galaxy/systems/') && !limited) {
      limited = true;
      return { status: 429, error: 'Too many system detail requests, slow down',
        rateLimitScope: 'system-details', rateLimitLimit: '30', rateLimitPolicy: '30;w=10',
        rateLimitRemaining: '0', rateLimitReset: '1', retryAfter: '1' };
    }
    return { ok: true, data: {} };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const sender = { tab: { id: 42, url: 'https://s0.nexuslegacy.space/' } };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = listener({ type: 'API_REQUEST', requestId: 'system', method: 'GET',
    path: '/api/galaxy/systems/3493/planets' }, sender);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal((await listener({ type: 'API_REQUEST', requestId: 'planet', method: 'GET',
    path: '/api/planets/1' }, sender)).ok, true);
  t.mock.timers.tick(1099);
  await settle();
  assert.equal(sent.length, 2);
  t.mock.timers.tick(1);
  assert.equal((await pending).ok, true);
  assert.equal(sent[2].at, 101100);
});

test('content client forwards requests and only allowlisted native budget metadata', async () => {
  const sent = [];
  const listeners = [];
  const posts = [];
  const context = vm.createContext({
    crypto, location: { origin: 'https://s0.nexuslegacy.space' }, console,
    browser: { runtime: { sendMessage: async message => {
      sent.push(message);
      return { ok: true, data: { planets: [] } };
    } } },
    addEventListener: (_name, listener) => listeners.push(listener),
    postMessage: message => posts.push(message),
  });
  context.window = context;
  vm.runInContext(await readFile(new URL('../nexus-addon/game-api-client.js', import.meta.url), 'utf8'), context);
  const result = await context.nexusGameApi('/api/planets');
  assert.deepEqual(result, { planets: [] });
  assert.equal(sent[0].type, 'API_REQUEST');
  assert.equal(sent[0].priority, 'interactive');
  assert.equal(posts[0].__nxApiTrafficReady, true);
  vm.runInContext(`globalThis.event = {source:window, origin:location.origin, data:{__nxApiTraffic:{
    path:"/api/planets", response:{status:304, rateLimitRemaining:"270", cookie:"secret", deviceFingerprint:"secret"}
  }}}`, context);
  listeners[0](context.event);
  await settle();
  assert.equal(sent[1].type, 'API_TRAFFIC');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].response)), { status: 304, rateLimitRemaining: '270' });
});

test('successful add-on transport does not trigger its own realtime follow-up', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  let observer;
  let sends = 0;
  globalThis.browser.webRequest.onCompleted.addListener = listener => { observer = listener; };
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async () => {
    sends++;
    observer({ tabId: 42, statusCode: 200, url: 'https://s0.nexuslegacy.space/api/fleet/missions' });
    return { ok: true, data: { missions: [] } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  await listener({ type: 'GET_MISSIONS' });
  await settle();
  assert.equal(sends, 1);
});

test('manual and automatic dispatches both use action headroom', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await import(`../nexus-addon/server-storage.js?priorities=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  const sent = [];
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    sent.push({ message, at: Date.now() });
    return { ok: true, data: {} };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  await listener({ type: 'API_TRAFFIC', path: '/api/planets', response: {
    status: 200, rateLimitLimit: '400', rateLimitRemaining: '2', rateLimitReset: '60',
  } }, { tab: { id: 42, url: 'https://s0.nexuslegacy.space/' } });
  for (const automatic of [false, true]) {
    const result = await listener({ type: 'SEND_EXPEDITION', automatic, sourcePlanetId: 1,
      ships: [{ shipDefId: 1, quantity: 1 }] });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(sent.map(value => value.at), [100000, 100000]);
});

test('stale traffic relays detach with one reload notice', async () => {
  let listener;
  let removed;
  const notices = [];
  const context = vm.createContext({
    crypto, location: { origin: 'https://s0.nexuslegacy.space' },
    console: { info: message => notices.push(message), error: () => assert.fail('unexpected error log') },
    browser: { runtime: { id: 'test', sendMessage: () => { throw new Error('Extension context invalidated.'); } } },
    addEventListener: (_name, value) => { listener = value; },
    removeEventListener: (_name, value) => { removed = value; },
    postMessage() {},
  });
  context.window = context;
  vm.runInContext(await readFile(new URL('../nexus-addon/game-api-client.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`globalThis.event = {source:window, origin:location.origin,
    data:{__nxApiTraffic:{path:"/api/planets", started:true}}}`, context);
  await listener(context.event);
  assert.equal(removed, listener);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Reload this game tab/);
});

test('exhausted simulator recovery cooldown survives a background worker restart', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  let session = {};
  globalThis.browser.storage.session = {
    get: async () => structuredClone(session),
    set: async value => { session = structuredClone(value); },
  };
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  let calls = 0;
  globalThis.browser.tabs.sendMessage = async () => ++calls <= 4
    ? { status: 429, retryAfter: '1', error: 'Limited' }
    : { ok: true, data: { report: {} } };
  await loadBackground();
  const message = { type: 'SIM_RUN',
    attacker: { fleet: [{ shipDefId: 1, quantity: 1 }] },
    defender: { fleet: [{ shipDefId: 2, quantity: 1 }] } };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const first = globalThis.browser.runtime.onMessage.listeners.at(-1)(message);
  await settle();
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.tick(5000);
    await settle();
  }
  assert.equal((await first).status, 429);
  assert.equal(calls, 4);
  await loadBackground();
  const restarted = globalThis.browser.runtime.onMessage.listeners.at(-1)(message);
  await settle();
  t.mock.timers.tick(29999);
  await settle();
  assert.equal(calls, 4);
  t.mock.timers.tick(1);
  assert.equal((await restarted).ok, true);
  assert.equal(calls, 5);
});
