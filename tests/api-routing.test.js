import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import 'fake-indexeddb/auto';
import { restoreGalaxyCache, saveSystem } from '../nexus-addon/galaxy-cache.js';
import { readDiagnosticLogs, clearDiagnosticLogs } from '../nexus-addon/diagnostics-store.js';
import { makeBrowserStub, loadBackground } from './helpers.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

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
