import assert from 'node:assert/strict';
import test from 'node:test';
import { statusView, waitText, initApiStatus } from '../nexus-addon/api-status.js';
import { createApiScheduler } from '../nexus-addon/api-scheduler.js';

const origin = 'https://s0.nexuslegacy.space';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('scheduler status distinguishes scoped budget waits, active requests and unrelated work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  for (let i = 0; i < 30; i++) {
    await scheduler.observe(origin, '/api/galaxy/systems/1/planets', null, { started: true });
  }
  let release;
  const active = scheduler.schedule({ origin, path: '/api/planets' }, () =>
    new Promise(resolve => { release = resolve; }));
  const queued = scheduler.schedule({ origin, path: '/api/galaxy/systems/31/planets' }, async () => ({ ok: true }));
  await settle();
  const status = await scheduler.status(origin, '/api/galaxy/systems/31/planets');
  assert.equal(status.running, 1);
  assert.equal(status.queued, 1);
  assert.equal(status.request.reason, 'budget');
  assert.equal(status.request.scope, 'system-details');
  assert.equal(status.request.until, 110100);
  assert.equal(status.scopes[1].local[0].counted, 30);
  assert.equal(statusView(status).state, 'budget');
  assert.match(statusView(status).summary, /1 running \/ 1 queued/);
  assert.equal((await scheduler.status(origin, '/api/planets')).request.reason, 'running');
  assert.equal((await scheduler.status('https://beta.nexuslegacy.space')).queued, 0);
  release({ ok: true });
  await active;
  t.mock.timers.tick(10100);
  await queued;
  assert.equal(statusView(await scheduler.status(origin)).state, 'ready');
});

test('server pauses and reported remaining are separate from local reservations', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  await scheduler.observe(origin, '/api/galaxy/systems/1/planets', {
    status: 429, rateLimitScope: 'system-details', retryAfter: '5',
    rateLimitLimit: '30', rateLimitRemaining: '0', rateLimitReset: '5',
  });
  const status = await scheduler.status(origin, '/api/galaxy/systems/2/planets');
  assert.equal(status.request.reason, 'server');
  assert.equal(status.scopes[1].server.reportedRemaining, 0);
  assert.equal(status.scopes[1].local[0].counted, 0);
  const view = statusView(status);
  assert.equal(view.state, 'server');
  assert.match(view.details.join(' '), /Server: 0 left, 0s ago/);
  assert.match(view.details.join(' '), /API server pause \(429\) 5s/);
  assert.ok(view.details.join(' ').length < 500, 'keep expanded status compact');
  assert.doesNotMatch(view.details.join(' '), /0 running \/ 0 queued/);
  assert.match(waitText(status.request), /API server pause \(429\).*5s/);
  t.mock.timers.tick(3000);
  assert.match(waitText(status.request), /2s/);
  assert.match(waitText({ reason: 'queue' }), /higher-priority/);
  assert.match(waitText({ reason: 'pacing', scope: 'general', until: 104000 }), /API request spacing/);
  assert.match(waitText({ reason: 'budget', scope: 'general', until: 104000 }), /API budget pause/);
  assert.equal(waitText({ reason: 'running' }), 'API request in progress');
});

test('status distinguishes concurrency waiting from a budget pause without making game requests', async () => {
  const scheduler = createApiScheduler();
  const releases = [];
  const held = [1, 2, 3].map(id => scheduler.schedule({ origin, path: `/api/held/${id}` },
    () => new Promise(resolve => releases.push(resolve))));
  const pending = scheduler.schedule({ origin, path: '/api/queued' }, async () => ({ ok: true }));
  await settle();
  const status = await scheduler.status(origin, '/api/queued');
  assert.equal(status.request.reason, 'queue');
  assert.equal(statusView(status).state, 'active');
  assert.equal(status.queued, 1);
  releases.forEach(resolve => resolve({ ok: true }));
  await Promise.all([...held, pending]);
});

test('dashboard polls only scheduler metadata, clears stopped search hints, and cleans up on close', async t => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, textContent: '', value: 's0', children: [], listeners: {},
      appendChild(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(value => value !== child);
        this.children.push(child);
        child.parentElement = this;
      },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeEventListener(name) { delete this.listeners[name]; },
    });
    return elements.get(id);
  };
  const document = { hidden: false, getElementById: element,
    createElement: () => ({ textContent: '' }), addEventListener() {}, removeEventListener() {} };
  let close;
  let scheduled;
  t.mock.method(globalThis, 'setTimeout', fn => { scheduled = fn; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldBrowser = globalThis.browser;
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; globalThis.browser = oldBrowser; });
  globalThis.document = document;
  let reposition;
  const media = {
    matches: false,
    addEventListener: (_name, fn) => { reposition = fn; },
    removeEventListener: () => { reposition = null; },
  };
  globalThis.window = {
    addEventListener: (_name, fn) => { close = fn; },
    matchMedia: query => { assert.equal(query, '(max-width: 900px)'); return media; },
  };
  const scheduler = createApiScheduler();
  await scheduler.observe(origin, '/api/galaxy/systems/1/planets', {
    status: 429, rateLimitScope: 'system-details', retryAfter: '5',
  });
  const messages = [];
  globalThis.browser = { runtime: { sendMessage: async message => {
    messages.push(message);
    return scheduler.status(origin, message.path);
  } } };
  element('f-progress').dataset.apiPath = '/api/galaxy/systems/2/planets';
  initApiStatus();
  assert.equal(element('api-status').parentElement, element('api-status-nav'));
  element('api-status').open = true;
  media.matches = true;
  reposition();
  assert.equal(element('api-status').parentElement, element('api-status-header'));
  assert.equal(element('api-status-nav').children.length, 0);
  assert.equal(element('api-status').open, true);
  media.matches = false;
  reposition();
  assert.equal(element('api-status').parentElement, element('api-status-nav'));
  assert.equal(element('api-status-header').children.length, 0);
  await settle();
  assert.match(element('api-status-summary').textContent, /server pause/);
  assert.match(element('f-api-wait').textContent, /^ · System details: API server pause/);
  assert.equal(messages[0].type, 'GET_API_STATUS');
  const sendMessage = globalThis.browser.runtime.sendMessage;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const reason of ['budget', 'server', 'pacing']) {
    for (const remaining of [1001, 1000, 999, 0]) {
      globalThis.browser.runtime.sendMessage = async () => ({
        ...await scheduler.status(origin),
        request: { reason, scope: 'system-details', until: now + remaining },
      });
      await scheduled();
      assert.equal(element('f-api-wait').textContent !== '', remaining > 1000,
        `${reason} hint at ${remaining}ms remaining`);
    }
  }
  globalThis.browser.runtime.sendMessage = sendMessage;
  element('af-progress').dataset.apiPath = '/api/galaxy/systems/3/planets';
  element('ls-status').dataset.apiPath = '/api/galaxy/systems/3/planets';
  await scheduled();
  assert.match(element('af-api-wait').textContent, /^ · System details: API server pause/);
  assert.equal(element('af-api-wait').textContent, element('ls-api-wait').textContent,
    'manual and live asteroid scans use the same hints as Galaxy Scout');
  assert.equal(messages.length, 3, 'matching inline paths share one metadata poll');
  assert.ok(messages.every(message => message.type === 'GET_API_STATUS'));
  delete element('af-progress').dataset.apiPath;
  delete element('ls-status').dataset.apiPath;
  await scheduled();
  assert.equal(element('af-api-wait').textContent, '');
  assert.equal(element('ls-api-wait').textContent, '');
  const beforeHidden = messages.length;
  document.hidden = true;
  await scheduled();
  assert.equal(messages.length, beforeHidden, 'hidden dashboards must not poll');
  document.hidden = false;
  delete element('f-progress').dataset.apiPath;
  element('server-select').listeners.change();
  await settle();
  assert.equal(element('f-api-wait').textContent, '');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  globalThis.browser.runtime.sendMessage = async () => ({ error: 'Scheduler unavailable' });
  await scheduled();
  assert.equal(element('api-status-summary').textContent, 'API · status unavailable');
  assert.equal(element('api-status-details').textContent, 'Scheduler unavailable');
  assert.equal(errors.length, 1);
  let late;
  globalThis.browser.runtime.sendMessage = () => new Promise(resolve => { late = resolve; });
  const refresh = scheduled();
  await settle();
  close();
  assert.equal(reposition, null);
  late(await scheduler.status(origin));
  await refresh;
  assert.equal(element('api-status-summary').textContent, 'API · status unavailable', 'closed UI ignores late results');
  assert.equal(element('server-select').listeners.change, undefined);
});
