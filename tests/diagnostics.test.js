import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import 'fake-indexeddb/auto';
import { readDiagnosticLogs, writeDiagnosticLogs, clearDiagnosticLogs } from '../nexus-addon/diagnostics-store.js';
import { analyticsEntries, analyticsBuckets, appendDiagnostics, LOG_KEY, STREAM_LIMIT, STORAGE_LIMIT } from '../nexus-addon/diagnostics.js';
import { makeBrowserStub, loadBackground } from './helpers.js';

const source = name => readFile(new URL(`../nexus-addon/${name}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

async function relayHarness(sendMessage) {
  const posts = [];
  const warnings = [];
  const notices = [];
  const errors = [];
  const listeners = new Set();
  const settingsListeners = [];
  const runtime = { id: 'test-extension', sendMessage, getURL: path => path };
  let timer;
  const context = vm.createContext({
    URL, browser: { runtime },
    location: { origin: 'https://s0.nexuslegacy.space' },
    nexusDiagnostics: globalThis.nexusDiagnostics,
    nexusStorage: {
      getSettings: async () => ({ 'developer.recording': true }),
      onChanged: { addListener: fn => settingsListeners.push(fn) },
    },
    console: { info: (...args) => notices.push(args), warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    setTimeout: fn => { timer = fn; return 1; },
    clearTimeout: () => { timer = undefined; },
    addEventListener: (name, fn) => listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
    postMessage: message => posts.push(plain(message)),
  });
  context.window = context;
  // The helper module is tested separately; inject its resolved import in the VM.
  const script = (await source('diagnostics-relay.js'))
    .replace("import(api.runtime.getURL('diagnostics-core.js'))", 'Promise.resolve()');
  vm.runInContext(script, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  async function emit() {
    vm.runInContext('globalThis.testEvent = {source:window,origin:location.origin,data:{__nxDiagnosticsBatch:[{kind:"api",data:{path:"/api/planets"}}]}}', context);
    for (const listener of listeners) listener(context.testEvent);
    if (timer) { const flush = timer; timer = undefined; flush(); }
    await settle();
  }
  return { context, runtime, posts, notices, warnings, errors, listeners, settingsListeners, settle, emit };
}

test('invalidated relay contexts stop capture and emit one informational notice without warnings or errors', async () => {
  for (const synchronous of [true, false]) {
    let calls = 0;
    const h = await relayHarness(() => {
      calls++;
      const error = new Error('Extension context invalidated.');
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    assert.equal(h.posts.at(-1).__nxDiagnosticsConfig.recording, true);
    await h.emit();
    assert.equal(calls, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.errors.length, 0);
    assert.equal(h.posts.at(-1).__nxDiagnosticsConfig.recording, false);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.context.nexusRecordDiagnosticApi, undefined);
    await h.emit();
    h.settingsListeners[0]({ nexus_settings: {} });
    await h.settle();
    assert.equal(calls, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.posts.at(-1).__nxDiagnosticsConfig.recording, false);
  }
});

test('relay detects a missing runtime id and keeps unrelated messaging failures visible', async () => {
  const h = await relayHarness(async () => { throw new Error('Storage unavailable'); });
  await h.emit();
  assert.equal(h.errors.length, 1);
  assert.equal(h.listeners.size, 1);
  h.runtime.id = undefined;
  await h.emit();
  assert.equal(h.notices.length, 1);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.listeners.size, 0);
});

async function hookHarness() {
  let flush;
  const messages = [];
  const messageListeners = [];
  const requests = [];
  let promise;
  const location = { origin: 'https://s0.nexuslegacy.space' };
  class Socket {
    static OPEN = 1;
    constructor(...args) { this.args = args; }
    addEventListener(name, listener) { this.listener = listener; }
    emit(data) { this.listener({ data }); }
  }
  class Xhr {
    open(...args) { this.openArgs = args; }
    send(body) { this.sentBody = body; }
    addEventListener(name, listener) { this.listener = listener; }
  }
  const context = vm.createContext({
    location, URL, TextDecoder, performance, console, setTimeout: fn => setImmediate(fn),
    WebSocket: Socket, XMLHttpRequest: Xhr,
    setInterval(fn) { flush = fn; },
    addEventListener(name, listener) { messageListeners.push(listener); },
    postMessage(message) { messages.push(plain(message)); },
    fetch(...args) {
      requests.push(args);
      promise = Promise.resolve(new Response('{"ore":42,"accessToken":"hidden"}', { headers: { 'content-type': 'application/json' } }));
      return promise;
    },
  });
  context.window = context;
  await vm.runInContext(await source('diagnostics-core.js'), context);
  await vm.runInContext(await source('diagnostics-hook.js'), context);
  function configure(recording) {
    context.config = { __nxDiagnosticsConfig: { recording } };
    vm.runInContext('globalThis.configEvent = { source: window, origin: location.origin, data: config }', context);
    for (const listener of messageListeners) listener(context.configEvent);
  }
  async function settle() {
    await new Promise(resolve => setTimeout(resolve, 20));
    flush();
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return { context, messages, requests, configure, settle, Xhr, Socket, getPromise: () => promise };
}

test('diagnostic sanitization redacts nested, stringified and oversized secrets before truncation', () => {
  const core = globalThis.nexusDiagnostics;
  const payload = {
    password: 'secret-one',
    nested: [{ authorization: 'secret-two', ore: 42 }],
    responseBody: JSON.stringify({ long: 'x'.repeat(7000), refreshToken: 'secret-three' }),
    text: 'Bearer secret-four token=secret-five',
  };
  const entry = core.entry('api', payload);
  const json = JSON.stringify(entry);
  for (const value of ['secret-one', 'secret-two', 'secret-three', 'secret-four', 'secret-five']) assert.ok(!json.includes(value));
  assert.ok(json.includes('[redacted]'));
  assert.equal(core.sanitize({ amount: 0 }).amount, 0);
  assert.throws(() => core.entry('invalid', {}), /Unknown/);
  const huge = core.entry('api', { items: Array.from({ length: 100 }, () => 'x'.repeat(6000)) });
  assert.equal(huge.data.truncated, true);
  assert.ok(huge.data.preview.length <= core.limits.bodyPreview);
});

test('oversized API entries retain request metadata and separate body previews through relay and storage sanitization', () => {
  const core = globalThis.nexusDiagnostics;
  const original = {
    source: 'addon', method: 'GET', path: '/api/fleet/missions',
    status: 200, durationMs: 135,
    requestBody: { planetId: 7 },
    responseBody: { missions: Array.from({ length: 100 }, (_, id) => ({ id, text: 'x'.repeat(5000), token: 'private-value' })) },
  };
  let item = core.entry('api', original, 123);
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(item.data.method, original.method);
    assert.equal(item.data.path, original.path);
    assert.equal(item.data.status, 200);
    assert.equal(item.data.durationMs, 135);
    assert.equal(item.data.source, 'addon');
    assert.equal(item.data.truncated, true);
    assert.deepEqual(item.data.requestBody, { planetId: 7 });
    assert.equal(item.data.responseBody.truncated, true);
    assert.ok(item.data.responseBody.preview.length <= core.limits.bodyPreview);
    assert.ok(JSON.stringify(item.data).length <= core.limits.entry);
    assert.ok(!JSON.stringify(item).includes('private-value'));
    item = core.entry('api', item.data, item.timestamp);
  }
});

test('development limits retain realistic mission lists without truncation', () => {
  const core = globalThis.nexusDiagnostics;
  const missions = Array.from({ length: 250 }, (_, id) => ({ id, details: 'x'.repeat(500) }));
  const item = core.entry('api', { method: 'GET', path: '/api/fleet/missions', status: 200, responseBody: { missions } });
  assert.equal(item.data.truncated, undefined);
  assert.deepEqual(item.data.responseBody.missions, missions);
  assert.equal(STORAGE_LIMIT, 10000000);
  assert.equal(core.limits.entry, 256000);
  assert.equal(core.limits.capture, 1000000);
});

test('text, array, field and depth cuts are explicit and mark their containing entry', () => {
  const core = globalThis.nexusDiagnostics;
  const cases = [
    { value: 'x'.repeat(core.limits.text + 1), reason: 'Text exceeds' },
    { value: Array.from({ length: core.limits.items + 1 }, (_, i) => i), reason: 'array items omitted' },
    { value: Object.fromEntries(Array.from({ length: core.limits.items + 1 }, (_, i) => [`field${i}`, i])), reason: 'object fields omitted' },
    { value: Array.from({ length: core.limits.depth + 2 }).reduce(value => ({ child: value }), 1), reason: 'nesting depth' },
  ];
  for (const { value, reason } of cases) {
    const item = core.entry('api', { method: 'GET', path: '/api/example', responseBody: value });
    assert.equal(item.data.truncated, true, reason);
    assert.ok(JSON.stringify(item).includes(reason), reason);
    assert.equal(item.data.path, '/api/example');
  }
  const escaped = core.entry('api', {
    method: 'POST', path: '/api/example', requestBody: '\u0000'.repeat(100000),
    responseBody: { rows: Array.from({ length: 100 }, () => '"'.repeat(5000)) },
  });
  assert.ok(JSON.stringify(escaped.data).length <= core.limits.entry);
});

test('log levels filter addon output dynamically without replacing console repeatedly', async () => {
  const calls = [];
  const context = vm.createContext({
    console: Object.fromEntries(['debug', 'info', 'log', 'warn', 'error'].map(key => [key, (...args) => calls.push([key, ...args])])),
  });
  vm.runInContext(await source('diagnostics-core.js'), context);
  context.nexusDiagnostics.setLogLevel('warn');
  context.console.info('hidden');
  context.console.warn('visible');
  context.console.error('visible');
  const logger = context.console.debug;
  context.nexusDiagnostics.setLogLevel('debug');
  assert.equal(context.console.debug, logger);
  context.console.debug('details');
  assert.deepEqual(calls.map(call => call[0]), ['warn', 'error', 'debug']);
});

test('capture is off by default and preserves fetch promises, bodies and WebSocket identity', async () => {
  const h = await hookHarness();
  const result = h.context.fetch('/api/planets');
  assert.equal(result, h.getPromise());
  assert.equal(await (await result).text(), '{"ore":42,"accessToken":"hidden"}');
  const socket = new h.context.WebSocket('wss://s0.nexuslegacy.space/socket');
  assert.ok(socket instanceof h.Socket);
  assert.equal(h.context.WebSocket.OPEN, 1);
  socket.emit('42["galaxy:delta",{"systemId":7}]');
  await h.settle();
  assert.equal(h.messages.filter(message => message.__nxDiagnosticsBatch).length, 0);
});

test('enabled fetch capture excludes auth, headers and query strings and leaves responses readable', async () => {
  const h = await hookHarness();
  h.configure(true);
  const response = await h.context.fetch('/api/planets?token=secret-query', {
    method: 'POST', body: '{"token":"secret-body","ore":12}', headers: { Authorization: 'secret-header' },
  });
  assert.equal(await response.text(), '{"ore":42,"accessToken":"hidden"}');
  await h.context.fetch('/api/auth/me');
  await h.context.fetch('https://example.com/api/planets');
  await h.settle();
  const batch = h.messages.find(message => message.__nxDiagnosticsBatch).__nxDiagnosticsBatch;
  assert.equal(batch.length, 1);
  assert.equal(batch[0].data.path, '/api/planets');
  assert.equal(batch[0].data.requestBody.ore, 12);
  assert.equal(batch[0].data.responseBody.ore, 42);
  assert.ok(!JSON.stringify(batch).includes('secret-'));
});

test('XHR and Socket.IO capture retain payloads, extract galaxy deltas and stop when disabled', async () => {
  const h = await hookHarness();
  h.configure(true);
  const xhr = new h.context.XMLHttpRequest();
  xhr.open('GET', '/api/galaxy/map');
  xhr.send();
  Object.assign(xhr, { status: 200, responseType: '', responseText: '{"systems":[]}' });
  xhr.listener();
  const socket = new h.context.WebSocket('wss://s0.nexuslegacy.space/socket');
  socket.emit('42["galaxy:delta",{"type":"colonized","systemId":7,"token":"secret"}]');
  const external = new h.context.WebSocket('wss://example.com/socket');
  assert.equal(external.listener, undefined);
  await h.settle();
  const batch = h.messages.find(message => message.__nxDiagnosticsBatch).__nxDiagnosticsBatch;
  assert.deepEqual(batch.map(item => item.kind), ['api', 'websocket', 'galaxy']);
  assert.equal(batch[2].data.payload.systemId, 7);
  assert.equal(batch[2].data.payload.token, '[redacted]');
  h.configure(false);
  socket.emit('next');
  await h.settle();
  assert.equal(h.messages.filter(message => message.__nxDiagnosticsBatch).length, 1);
});

test('page capture batches at most 20 events and discards pending events on disable', async () => {
  const h = await hookHarness();
  h.configure(true);
  const socket = new h.context.WebSocket('wss://s0.nexuslegacy.space/socket');
  for (let i = 0; i < 100; i++) socket.emit(`event ${i}`);
  await h.settle();
  assert.equal(h.messages.find(message => message.__nxDiagnosticsBatch).__nxDiagnosticsBatch.length, 20);
  socket.emit('pending');
  h.configure(false);
  await h.settle();
  assert.equal(h.messages.filter(message => message.__nxDiagnosticsBatch).length, 1);
});

test('capture character limits mark oversized XHR, request bodies and WebSocket frames explicitly', async () => {
  const h = await hookHarness();
  h.configure(true);
  const huge = 'x'.repeat(globalThis.nexusDiagnostics.limits.capture + 1);
  const xhr = new h.context.XMLHttpRequest();
  xhr.open('POST', '/api/example');
  xhr.send(huge);
  Object.assign(xhr, { status: 200, responseType: '', responseText: huge });
  xhr.listener();
  const socket = new h.context.WebSocket('wss://s0.nexuslegacy.space/socket');
  socket.emit(huge);
  await h.settle();
  const batch = h.messages.find(message => message.__nxDiagnosticsBatch).__nxDiagnosticsBatch;
  assert.equal(batch.length, 2);
  for (const item of batch) assert.equal(item.data.truncated, true);
  assert.equal(batch[0].data.path, '/api/example');
  assert.equal(batch[0].data.requestBody.truncated, true);
  assert.equal(batch[0].data.responseBody.truncated, true);
  assert.equal(batch[1].data.payload.truncated, true);
  assert.ok(JSON.stringify(batch).includes('capture character limit'));
  assert.ok(!JSON.stringify(batch).includes(huge));
});

test('bounded storage enforces per-stream counts and the UTF-8 byte threshold', async () => {
  await clearDiagnosticLogs('limits');
  const items = Array.from({ length: 1000 }, (_, i) => ({ kind: ['api', 'galaxy', 'websocket'][i % 3], data: i }));
  await writeDiagnosticLogs('limits', items, STREAM_LIMIT, STORAGE_LIMIT);
  const bounded = await readDiagnosticLogs('limits');
  for (const kind of ['api', 'galaxy', 'websocket']) assert.equal(bounded.filter(item => item.kind === kind).length, STREAM_LIMIT);
  await clearDiagnosticLogs('limits');
  const heavy = Array.from({ length: 180 }, () => ({ kind: 'api', data: '\u20ac'.repeat(40000) }));
  await writeDiagnosticLogs('limits', heavy, STREAM_LIMIT, STORAGE_LIMIT);
  const retained = await readDiagnosticLogs('limits');
  const bytes = retained.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  assert.ok(bytes <= STORAGE_LIMIT);
  assert.ok(retained.length > 0 && retained.length < STREAM_LIMIT);
  await clearDiagnosticLogs('limits');
});

test('resource analytics derives retained credits and costs without counting mining raid cargo as income', () => {
  const timestamp = '2026-10-20T01:00:00Z';
  const store = {
    recent_reports: [{ id: 1, created_at: timestamp, ore: 12, ships_lost: 5, debris_ore: 999 }],
    mining_recent_reports: [
      { created_at: timestamp, report_type: 'delivery', ore: 20, maintenance_alloys: 3 },
      { created_at: timestamp, report_type: 'pirate_raid', ore: 999, stolen: { ore: 5 } },
    ],
    exp_recent_reports: [{ created_at: timestamp, kind: 'wormhole', loot: { hydrogen: 7, rare: { artifact: 1 } } }],
    debris_collection_log: [{ collected_at: timestamp, alloys: 2 }],
    fuel_log: [{ created_at: timestamp, type: 'survey', fuel: 4 }],
  };
  const entries = analyticsEntries(store);
  assert.equal(entries.length, 7);
  assert.equal(entries.filter(entry => entry.source === 'mining' && entry.type === 'credit').length, 1);
  assert.deepEqual(entries.find(entry => entry.source === 'survey').resources, { ore: 12 });
  assert.equal(entries.find(entry => entry.source === 'wormhole').resources.artifact, 1);
  const now = Date.parse('2026-10-20T02:00:00Z');
  const buckets = analyticsBuckets(entries, '1h', 7, now);
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0].resources['mining:stolen'].ore, { credit: 0, debit: 5 });
  assert.deepEqual(buckets[0].resources['fuel:survey'].hydrogen, { credit: 0, debit: 4 });
  assert.equal(analyticsBuckets(entries, '15m', 1, now + 2 * 86400000).length, 0);
  assert.throws(() => analyticsBuckets(entries, 'invalid', 7), /Invalid/);
});

test('diagnostic storage is opt-in, redacted and isolated by server', async () => {
  makeBrowserStub();
  await import(`../nexus-addon/server-storage.js?diagnostics=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await clearDiagnosticLogs('s0');
  await clearDiagnosticLogs('beta');
  await storage.withServer('s0', async () => {
    await appendDiagnostics([{ kind: 'api', data: { token: 'hidden' } }]);
    assert.deepEqual(await readDiagnosticLogs('s0'), []);
  });
  await storage.setSettings({ 'developer.recording': true });
  await storage.withServer('s0', () => appendDiagnostics([{ kind: 'api', data: { token: 'hidden', path: '/api/planets' } }]));
  await storage.withServer('beta', async () => {
    assert.deepEqual(await readDiagnosticLogs('beta'), []);
    await appendDiagnostics([{ kind: 'websocket', data: { payload: 'beta event' } }]);
  });
  await storage.withServer('s0', async () => {
    const logs = await readDiagnosticLogs('s0');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].data.token, '[redacted]');
  });
});

test('background accepts logs only from game tabs and clears only the selected diagnostic stream', async () => {
  makeBrowserStub();
  const browser = globalThis.browser;
  await clearDiagnosticLogs('s0');
  await import(`../nexus-addon/server-storage.js?diagnostics=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setSettings({ 'developer.recording': true });
  await loadBackground();
  const listener = browser.runtime.onMessage.listeners[0];
  assert.match((await listener({ type: 'DIAGNOSTICS_APPEND', batch: [] }, {})).error, /not allowed/);
  const sender = { tab: { url: 'https://s0.nexuslegacy.space/' } };
  assert.equal((await listener({ type: 'DIAGNOSTICS_APPEND', batch: [{ kind: 'api', data: { path: '/api/planets' } }, { kind: 'websocket', data: { payload: 'hi' } }] }, sender)).ok, true);
  await browser.storage.local.set({ totals: { ore: 42 } });
  const extension = { url: browser.runtime.getURL('dashboard.html#options'), tab: { id: 12, url: browser.runtime.getURL('dashboard.html#options') } };
  assert.equal((await listener({ type: 'DIAGNOSTICS_CLEAR', kind: 'api', serverKey: 's0' }, extension)).ok, true);
  const stored = await browser.storage.local.get([LOG_KEY, 'totals']);
  assert.deepEqual((await readDiagnosticLogs('s0')).map(item => item.kind), ['websocket']);
  assert.equal(stored.totals.ore, 42);
});

test('diagnostic append and clear complete while the main server queue is blocked and target the explicit server', async () => {
  makeBrowserStub();
  const browser = globalThis.browser;
  await import(`../nexus-addon/server-storage.js?diagnostics=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await clearDiagnosticLogs('s0');
  await clearDiagnosticLogs('beta');
  await storage.setSettings({ 'developer.recording': true });
  await loadBackground();
  const listener = browser.runtime.onMessage.listeners[0];
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const blocker = new Promise(resolve => { release = resolve; });
  const busy = storage.withServer('beta', async () => { started(); await blocker; });
  await ready;
  let timer;
  try {
    await Promise.race([
      (async () => {
        const sender = { tab: { url: 'https://s0.nexuslegacy.space/' } };
        const response = await listener({ type: 'DIAGNOSTICS_APPEND', batch: [{ kind: 'api', data: { path: '/api/example' } }] }, sender);
        assert.equal(response.ok, true);
        const extension = { url: browser.runtime.getURL('dashboard.html#options'), tab: { id: 12 } };
        assert.equal((await listener({ type: 'DIAGNOSTICS_CLEAR', kind: 'api', serverKey: 's0' }, extension)).ok, true);
        assert.match((await listener({ type: 'DIAGNOSTICS_CLEAR', kind: 'api', serverKey: 's0' }, sender)).error, /not allowed/);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostics blocked behind game operation')), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await busy;
  }
  await storage.withServer('s0', async () => {
    assert.deepEqual(await readDiagnosticLogs('s0'), []);
  });
  await storage.withServer('beta', async () => {
    assert.deepEqual(await readDiagnosticLogs('beta'), []);
  });
});

test('incremental database writes retain concurrent batches, enforce limits and isolate servers without storage events', async () => {
  const state = makeBrowserStub();
  let events = 0;
  globalThis.browser.storage.onChanged.addListener(() => events++);
  await clearDiagnosticLogs('s0');
  await Promise.all(Array.from({ length: 20 }, (_, id) =>
    writeDiagnosticLogs('s0', [{ kind: 'api', data: { id } }], 150, STORAGE_LIMIT)));
  assert.equal((await readDiagnosticLogs('s0')).length, 20);
  await writeDiagnosticLogs('s0', [{ kind: 'api', data: { id: 20 } }], 5, STORAGE_LIMIT);
  assert.deepEqual((await readDiagnosticLogs('s0')).map(item => item.data.id), [20, 19, 18, 17, 16]);
  await clearDiagnosticLogs('beta');
  await writeDiagnosticLogs('beta', [{ kind: 'websocket', data: 'beta' }], 150, STORAGE_LIMIT);
  await clearDiagnosticLogs('s0', 'api');
  assert.deepEqual(await readDiagnosticLogs('s0'), []);
  assert.equal((await readDiagnosticLogs('beta')).length, 1);
  await writeDiagnosticLogs('s0', Array.from({ length: 20 }, (_, id) => ({ kind: 'api', data: `${id}:${'x'.repeat(1000)}` })), 150, 5000);
  const retained = await readDiagnosticLogs('s0');
  assert.ok(retained.length > 0 && retained.length < 20);
  assert.ok(retained.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) <= 5000);
  assert.equal(events, 0, 'diagnostic traffic must not broadcast storage.local changes to game tabs');
  assert.deepEqual(state, {});
});

test('legacy log migration preserves history, removes broadcast-heavy storage and handles a later old backup restore', async () => {
  const legacyKey = 'nexus_server:s0:diagnostics_log';
  const state = makeBrowserStub({
    nexus_server_storage_v1: 1,
    nexus_settings: { 'developer.recording': true },
    [legacyKey]: [{ kind: 'api', timestamp: 1, data: { path: '/api/legacy' } }],
  });
  await import(`../nexus-addon/server-storage.js?diagnostics=${crypto.randomUUID()}`);
  await clearDiagnosticLogs('s0');
  await appendDiagnostics([{ kind: 'api', data: { path: '/api/new' } }], 's0');
  assert.deepEqual((await readDiagnosticLogs('s0')).map(item => item.data.path), ['/api/new', '/api/legacy']);
  assert.equal(state[legacyKey], undefined);
  state[legacyKey] = [{ kind: 'api', timestamp: 2, data: { path: '/api/restored' } }];
  await appendDiagnostics([{ kind: 'api', data: { path: '/api/newer' } }], 's0');
  assert.ok((await readDiagnosticLogs('s0')).some(item => item.data.path === '/api/restored'));
  assert.equal(state[legacyKey], undefined);
});

test('packaging includes the capture scripts in both worlds and every new module', async () => {
  const manifest = JSON.parse(await source('manifest.json'));
  const files = JSON.parse(await readFile(new URL('../tools/windows-updater/addon-files.json', import.meta.url), 'utf8'));
  for (const name of ['diagnostics-core.js', 'diagnostics.js', 'diagnostics-store.js', 'diagnostics-hook.js', 'diagnostics-relay.js', 'tabs/developer.js']) assert.ok(files.includes(name), name);
  const main = manifest.content_scripts.find(script => script.js.includes('diagnostics-hook.js'));
  assert.equal(main.world, 'MAIN');
  assert.equal(main.run_at, 'document_start');
  assert.ok(main.js.includes('diagnostics-core.js'));
  const relay = manifest.content_scripts.find(script => script.js.includes('diagnostics-relay.js'));
  assert.equal(relay.run_at, 'document_start');
  assert.ok(relay.js.includes('server-storage.js'));
  assert.ok(!relay.js.includes('diagnostics-core.js'), 'avoid duplicate manifest injection across worlds');
  const relaySource = await source('diagnostics-relay.js');
  assert.match(relaySource, /import\(api\.runtime\.getURL\('diagnostics-core\.js'\)\)/);
  assert.match(relaySource, /const core = await coreReady/);
  assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.includes('diagnostics-core.js')));
});
