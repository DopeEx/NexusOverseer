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
    observer({ tabId: 42, method: 'GET', statusCode: 200, url: 'https://s0.nexuslegacy.space/api/fleet/missions' });
    return { ok: true, data: { missions: [] } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  await listener({ type: 'GET_MISSIONS' });
  await settle();
  assert.equal(sends, 1);
});

test('Xeno sector zone lookup uses the scheduler-backed galaxy catalog', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await restoreGalaxyCache();
  let release;
  let path;
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    path = message.path;
    return new Promise(resolve => { release = resolve; });
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const pending = listener({ type: 'GET_SECTOR_SYSTEMS', sectorId: 98765, priority: 'bulk', source: 'xeno-search' });
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.equal(path, '/api/galaxy/sectors/98765/systems');
  assert.equal((await listener({ type: 'GET_API_STATUS', path })).request.reason, 'running');
  release({ ok: true, data: { systems: [{ id: 2, securityZone: 'open' }] } });
  assert.deepEqual((await pending).systems, [{ id: 2, securityZone: 'open' }]);
});

test('Xeno account overview uses the scheduler-backed game API transport', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const paths = [];
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    paths.push(message.path);
    return { ok: true, data: { hasResearch: true, reports: [] } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const result = await listener({ type: 'GET_XENO_OVERVIEW', source: 'xeno' });
  assert.deepEqual(paths, ['/api/xeno']);
  assert.deepEqual(result, { hasResearch: true, reports: [] });
  const saved = await globalThis.browser.storage.local.get('xeno_totals');
  assert.equal(saved.xeno_totals.digs, 0);
});

test('Xeno overview archives reports in its original universe after the selected server changes', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await import(`../nexus-addon/server-storage.js?xeno=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/overview' }];
  globalThis.browser.tabs.sendMessage = async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return { ok: true, data: { hasResearch: true, reports: [{
      id: 900103, missionId: 900203, createdAt: '2030-01-21T14:00:00.000Z',
      outcome: 'success', zone: 'sentinel', excavatorsSent: 3, excavatorsLost: 0,
      report: { shipsLost: [], delivered: { resources: { silicates: 10454 }, artifactTier: 'rare' } },
    }] } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const read = listener({ type: 'GET_XENO_OVERVIEW', source: 'xeno' });
  await ready;
  await storage.setActiveServer('beta');
  release();
  const result = await read;
  assert.equal(result.reports.length, 1);
  const original = await storage.forServer('s0').get(['xeno_totals', 'xeno_archive_2030-01']);
  const selected = await storage.forServer('beta').get('xeno_totals');
  assert.equal(original.xeno_totals.digs, 1);
  assert.equal(original.xeno_totals.silicates, 10454);
  assert.equal(original['xeno_archive_2030-01'][0].report.id, 900103);
  assert.equal(selected.xeno_totals, undefined);
  assert.equal((await storage.getSelectedServer()).key, 'beta');
});

test('Xeno overview reports archive failures explicitly instead of returning unpersisted success', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async () => ({ ok: true, data: { hasResearch: true, reports: [] } });
  await loadBackground();
  const originalSet = globalThis.browser.storage.local.set;
  globalThis.browser.storage.local.set = async patch => {
    if (patch.xeno_totals) throw new Error('Storage full');
    return originalSet(patch);
  };
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const result = await listener({ type: 'GET_XENO_OVERVIEW', source: 'xeno' });
  assert.match(result.error, /Could not archive Xeno reports: Storage full/);
  assert.equal((await globalThis.browser.storage.local.get('last_error')).last_error, 'Storage full');
});

test('observed cached Xeno overview is re-fetched through the scheduler and archived in the game tab universe', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await import(`../nexus-addon/server-storage.js?xeno-observed=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  let observed;
  globalThis.browser.webRequest.onCompleted.addListener = (listener, filter) => {
    if (filter.urls.includes('https://*.nexuslegacy.space/api/xeno')) observed = listener;
  };
  const requests = [];
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://beta.nexuslegacy.space/overview' }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    requests.push(message);
    return { ok: true, data: { hasResearch: true, reports: [{
      id: 99, missionId: 199, createdAt: '2030-01-21T14:00:00.000Z',
      outcome: 'success', report: { shipsLost: [], delivered: { resources: { silicates: 123 } } },
    }] } };
  };
  await loadBackground();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  observed({ method: 'GET', tabId: 42, statusCode: 304, url: 'https://beta.nexuslegacy.space/api/xeno' });
  let totals;
  for (let i = 0; i < 100 && !totals; i++) {
    await settle();
    totals = (await storage.forServer('beta').get('xeno_totals')).xeno_totals;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'GAME_FETCH');
  assert.equal(requests[0].path, '/api/xeno');
  assert.equal(totals.digs, 1);
  assert.equal(totals.silicates, 123);
  assert.equal((await storage.forServer('s0').get('xeno_totals')).xeno_totals, undefined);
});

test('Xeno leadership data uses the scheduler-backed game API transport', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const paths = [];
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    paths.push(message.path);
    return { ok: true, data: { vessel: { status: 'ready' }, combatStats: { maxHull: 2050 } } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const result = await listener({ type: 'GET_XENO_LEADERSHIP', source: 'xeno' });
  assert.deepEqual(paths, ['/api/leadership']);
  assert.equal(result.combatStats.maxHull, 2050);
});

test('Xeno survey dispatch checks full ship availability and fresh missions without bypassing the scheduler', async () => {
  makeBrowserStub();
  const browser = globalThis.browser;
  await import(`../nexus-addon/server-storage.js?xeno-survey=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  browser.alarms.get = async () => null;
  browser.tabs.query = async () => [{ id: 42 }];
  const survey = id => ({ id, missionType: 'xeno_survey', status: id === 4 ? 'returning' : 'exploring' });
  let missions = [
    ...Array.from({ length: 4 }, (_, i) => survey(i + 1)),
    { id: 20, missionType: 'xeno_dig', status: 'returning' },
    { id: 21, missionType: 'patrol', status: 'patrolling' },
  ];
  let invalid = null;
  let holdRead = false;
  let release;
  let rateLimited = false;
  let inventory = { fleet: [
    { shipDefId: 2, quantity: 5 }, { shipDefId: 16, quantity: 5 },
    { shipDefId: 8, quantity: 4, damagedQuantity: 1 },
  ] };
  const sent = [];
  browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message);
    if (message.path === '/api/planets/1/fleet') return { ok: true, data: structuredClone(inventory) };
    if (message.path === '/api/fleet/missions') {
      if (holdRead) return new Promise(resolve => { release = resolve; });
      return { ok: true, data: invalid || { missions: structuredClone(missions) } };
    }
    assert.equal(message.path, '/api/fleet/xeno-survey');
    if (rateLimited) return { status: 429, error: 'Rate limited', retryAfter: '1' };
    missions.push(survey(5));
    return { ok: true, status: 200, data: { missionId: 5 } };
  };
  await loadBackground();
  const listener = browser.runtime.onMessage.listeners.at(-1);
  const request = { type: 'SEND_XENO_SURVEY', source: 'xeno', serverKey: 's0',
    sourcePlanetId: 1, targetMoonId: 10,
    ships: [{ shipDefId: 2, quantity: 2 }, { shipDefId: 16, quantity: 1 }, { shipDefId: 8, quantity: 3 }] };
  assert.match((await listener({ ...request, serverKey: 'beta' })).error, /server changed/i);
  assert.equal(sent.length, 0);
  for (const missing of [2, 16, 'both']) {
    const ships = request.ships.filter(ship => missing === 'both'
      ? ![2, 16].includes(ship.shipDefId) : ship.shipDefId !== missing);
    const rejected = await listener({ ...request, ships });
    assert.match(rejected.error, /requires at least 1 Spy Probe and 1 Hacker Ship/);
    assert.equal(sent.length, 0, 'missing required ship types fail before any game request');
  }
  const completeInventory = inventory;
  for (const stock of [
    { fleet: [{ shipDefId: 2, quantity: 5 }, { shipDefId: 16, quantity: 5 },
      { shipDefId: 8, quantity: 3, damagedQuantity: 1 }] },
    { fleet: [{ shipDefId: 2, quantity: 1 }, { shipDefId: 16, quantity: 5 }, { shipDefId: 8, quantity: 3 }] },
    { fleet: null },
  ]) {
    inventory = stock;
    const rejected = await listener(request);
    assert.match(rejected.error, /Full survey template unavailable|Invalid planet fleet response/);
    assert.equal(sent.some(message => message.method === 'POST'), false, 'fresh ship shortages and unknown inventory prevent sending');
  }
  inventory = completeInventory;
  sent.length = 0;
  assert.equal((await listener(request)).ok, true, 'four surveys allow the fifth despite other fleet types');
  assert.deepEqual(sent.map(message => [message.method, message.path]), [
    ['GET', '/api/planets/1/fleet'], ['GET', '/api/fleet/missions'], ['POST', '/api/fleet/xeno-survey'],
  ]);
  assert.deepEqual(sent[2].body, { sourcePlanetId: 1, targetMoonId: 10, ships: request.ships, hangarAssignments: {} },
    'all requested quantities are preserved, including optional escorts and more than one required ship');
  const blocked = await listener(request);
  assert.match(blocked.error, /5 \/ 5.*including returning fleets/);
  assert.equal(blocked.surveyLimitReached, true);
  assert.deepEqual(blocked.missionSnapshot.missions, missions);
  assert.equal(sent.filter(message => message.method === 'POST').length, 1, 'the fresh check prevents a sixth fleet');
  for (const response of [{}, { missions: [{}] }, { missions: [null] }]) {
    invalid = response;
    const failed = await listener(request);
    assert.match(failed.error, /Could not check active surveys/);
    assert.equal(failed.missionCheckFailed, true);
    assert.equal(sent.filter(message => message.method === 'POST').length, 1, 'unknown fleet types are not assumed to be non-surveys');
  }

  invalid = null;
  missions = missions.filter(mission => mission.id !== 5);
  holdRead = true;
  rateLimited = true;
  const pending = listener(request);
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.ok(release, 'the dispatch waits for its fresh mission read');
  const reads = sent.length;
  assert.match((await listener(request)).error, /already in progress/);
  assert.equal(sent.length, reads, 'concurrent views cannot bypass the dispatch lock');
  release({ ok: true, data: { missions: structuredClone(missions) } });
  assert.equal((await pending).status, 429);
  assert.equal(sent.filter(message => message.method === 'POST').length, 2, 'rate-limited sends are not retried with stale capacity');
});

test('Xeno dig launch is scheduled once, locks concurrent sends and rejects a different server', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const sent = [];
  let release;
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    sent.push(message);
    return new Promise(resolve => { release = resolve; });
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const request = { type: 'SEND_XENO_DIG', serverKey: 's0', chainId: 5, comparisonAt: 123, sourcePlanetId: 1,
    ships: [{ shipDefId: 12, quantity: 41 }, { shipDefId: 29, quantity: 3 }],
    attachLeader: true, mode: 'careful', entrance: 'spire' };
  assert.match((await listener({ ...request, serverKey: 'beta' })).error, /server changed/i);
  const pending = listener(request);
  for (let i = 0; i < 100 && !release; i++) await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/xeno/dig');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].body, { sourcePlanetId: 1, ships: request.ships, attachLeader: true,
    hangarAssignments: {}, mode: 'careful', entrance: 'spire', hall: false });
  assert.equal((await listener({ type: 'GET_API_STATUS', path: '/api/xeno/dig' })).request.reason, 'running');
  assert.match((await listener(request)).error, /already in progress/);
  release({ status: 429, error: 'Rate limited', retryAfter: '1' });
  assert.equal((await pending).status, 429);
  await settle();
  assert.match((await listener(request)).error, /already been used/);
  await loadBackground();
  const restartedListener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  assert.match((await restartedListener(request)).error, /already been used/);
  assert.equal(sent.length, 1);
});

test('Xeno launch archives its selected simulation by mission independently of later comparisons', async t => {
  makeBrowserStub();
  await import(`../nexus-addon/server-storage.js?xeno-archive=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  const calls = [];
  let missionId = 900203;
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    calls.push(message);
    return { ok: true, status: 200, data: { missionId, arrivesAt: '2030-01-21T15:00:00.000Z' } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const ships = [{ shipDefId: 12, quantity: 41 }, { shipDefId: 29, quantity: 3 }];
  const simulation = { entranceId: 'spire', mode: 'fast', candidate: { fleet: ships },
    result: { outcome: 'attacker_won', excavators: 3, destroyed: 1, damaged: 0 } };
  const storage = globalThis.nexusStorage.forServer('s0');
  await storage.set({ xeno_dig_comparison: { at: 123, serverKey: 's0', siteMoonId: 900401,
    leadership: true, launchSimulation: simulation } });
  const response = await listener({ type: 'SEND_XENO_DIG', serverKey: 's0', chainId: 900601,
    comparisonAt: 123, sourcePlanetId: 900501, ships, attachLeader: true, mode: 'fast', entrance: 'spire' });
  assert.equal(response.ok, true);
  await storage.set({ xeno_dig_comparison: { at: 456 } });
  const archive = (await storage.get('xeno_dig_missions')).xeno_dig_missions;
  assert.deepEqual(archive[900203], { simulation, comparisonAt: 123,
    chainId: 900601, siteMoonId: 900401, leadership: true });
  assert.equal((await globalThis.nexusStorage.forServer('beta').get('xeno_dig_missions')).xeno_dig_missions, undefined);

  missionId = 900204;
  const mainSimulation = { ...simulation, entranceId: 'main', mode: 'careful',
    result: { outcome: 'attacker_won', excavators: 3, destroyed: 5, damaged: 2 } };
  await storage.set({ xeno_dig_comparison: { at: 456, serverKey: 's0', siteMoonId: 900402,
    leadership: true, launchSimulation: mainSimulation } });
  const mainResponse = await listener({ type: 'SEND_XENO_DIG', serverKey: 's0', chainId: 900602,
    comparisonAt: 456, sourcePlanetId: 900501, ships, attachLeader: true, mode: 'careful', entrance: 'main' });
  assert.equal(mainResponse.ok, true);
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).path, '/api/xeno/dig');
  assert.deepEqual(calls.at(-1).body, { sourcePlanetId: 900501, ships, attachLeader: true,
    hangarAssignments: {}, mode: 'careful', entrance: 'main', hall: false });
  const mainArchive = (await storage.get('xeno_dig_missions')).xeno_dig_missions;
  assert.deepEqual(mainArchive[900204], { simulation: mainSimulation, comparisonAt: 456,
    chainId: 900602, siteMoonId: 900402, leadership: true });
  assert.deepEqual(mainArchive[900203], archive[900203], 'the side-entrance archive remains unchanged');

  missionId = 900203;
  await storage.set({ xeno_dig_comparison: { at: 789, serverKey: 's0',
    launchSimulation: simulation } });
  const originalStorage = globalThis.nexusStorage;
  t.after(() => { globalThis.nexusStorage = originalStorage; });
  globalThis.nexusStorage = { ...originalStorage, forServer: () => ({
    get: keys => storage.get(keys),
    set: async value => {
      if (value.xeno_dig_missions) throw new Error('Archive write failed');
      return storage.set(value);
    },
  }) };
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const failedArchive = await listener({ type: 'SEND_XENO_DIG', serverKey: 's0', chainId: 553,
    comparisonAt: 789, sourcePlanetId: 900501, ships, attachLeader: true, mode: 'fast', entrance: 'spire' });
  assert.equal(failedArchive.ok, true);
  assert.equal(failedArchive.data.missionId, 900203);
  assert.equal(failedArchive.archiveError, 'Archive write failed');
  assert.equal(errors.length, 1);
});

test('Xeno moon detail uses the scheduler-backed game API transport and validates IDs', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const paths = [];
  globalThis.browser.tabs.query = async () => [{ id: 42 }];
  globalThis.browser.tabs.sendMessage = async (_id, message) => {
    paths.push(message.path);
    return { ok: true, data: { moonId: 900401, cooldownRemainingSeconds: 120 } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const result = await listener({ type: 'GET_XENO_MOON', moonId: 900401, source: 'xeno' });
  assert.deepEqual(paths, ['/api/xeno/moons/900401']);
  assert.deepEqual(result, { moonId: 900401, cooldownRemainingSeconds: 120 });
  assert.deepEqual(await listener({ type: 'GET_XENO_MOON', moonId: '900401/other' }), { error: 'Invalid Xeno moon ID.' });
  assert.deepEqual(paths, ['/api/xeno/moons/900401']);
});

test('successful POST actions do not trigger realtime GET follow-ups', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  let observer;
  let tabQueries = 0;
  globalThis.browser.webRequest.onCompleted.addListener = listener => { observer = listener; };
  globalThis.browser.tabs.query = async () => {
    tabQueries++;
    return [];
  };
  globalThis.nexusStorage = {
    serverFromUrl: () => ({ key: 's0', origin: 'https://s0.nexuslegacy.space' }),
    getActiveServer: async () => ({ key: 's0', origin: 'https://s0.nexuslegacy.space' }),
  };
  await loadBackground();
  observer({
    tabId: 42,
    method: 'POST',
    statusCode: 200,
    url: 'https://s0.nexuslegacy.space/api/fleet/reports/read-all',
  });
  await settle();
  assert.equal(tabQueries, 0);
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
