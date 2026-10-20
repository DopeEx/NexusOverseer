import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBrowserStub, loadBackground } from './helpers.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

async function api(send) {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 1, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = (_id, message) => send(message);
  return loadBackground();
}

test('polite requests share a 200 ms start interval, even without rate-limit headers', async t => {
  const times = [];
  const bg = await api(async () => {
    times.push(Date.now());
    return { ok: true, data: {} };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = [1, 2, 3].map(id => bg.apiFetch(`/api/test/${id}`, { polite: true }));
  await settle();
  assert.deepEqual(times, [100000]);
  t.mock.timers.tick(199);
  await settle();
  assert.equal(times.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(times, [100000, 100200]);
  t.mock.timers.tick(200);
  await Promise.all(pending);
  assert.deepEqual(times, [100000, 100200, 100400]);
});

test('429 cooldown survives optimistic headers from another in-flight response and gates other callers', async t => {
  let release;
  let attempts = 0;
  const sent = [];
  const bg = await api(async message => {
    sent.push({ path: message.path, at: Date.now() });
    if (message.path === '/api/late') return new Promise(resolve => { release = resolve; });
    if (message.path === '/api/limited' && ++attempts === 1) {
      return { status: 429, retryAfter: '3', rateLimitRemaining: '300', rateLimitReset: '60', error: 'Limited' };
    }
    return { ok: true, data: {} };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const late = bg.apiFetch('/api/late');
  const limited = bg.apiFetch('/api/limited');
  await settle();
  release({ ok: true, data: {}, rateLimitRemaining: '350', rateLimitReset: '60' });
  await late;
  const other = bg.apiFetch('/api/other');
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(sent.length, 2);
  t.mock.timers.tick(1);
  await settle();
  // Gates recheck at most every two seconds, so the other caller may wake later.
  t.mock.timers.tick(1000);
  await Promise.all([limited, other]);
  assert.ok(sent.slice(2).every(request => request.at >= 103000));
});

test('GET 429 supports HTTP-date Retry-After and leaves a shared pause after the final failure', async t => {
  let calls = 0;
  const bg = await api(async message => {
    calls++;
    if (message.path === '/api/other') return { ok: true, data: {} };
    return { status: 429, error: 'Limited', retryAfter: new Date(Date.now() + 3000).toUTCString() };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let error;
  const request = bg.apiFetch('/api/limited').catch(value => { error = value; });
  await settle();
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.tick(2999);
    await settle();
    assert.equal(calls, attempt + 1);
    t.mock.timers.tick(1);
    await settle();
  }
  await request;
  assert.equal(error.status, 429);
  assert.equal(calls, 4);
  const other = bg.apiFetch('/api/other');
  await settle();
  assert.equal(calls, 4);
  t.mock.timers.tick(3000);
  await other;
  assert.equal(calls, 5);
});

test('missing Retry-After uses a five-second fallback instead of immediate follow-up requests', async t => {
  let calls = 0;
  const bg = await api(async () => ++calls === 1
    ? { status: 429, error: 'Limited' } : { ok: true, data: { recovered: true } });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const request = bg.apiFetch('/api/test');
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await request, { recovered: true });
});

test('a recovered 429 slows subsequent polite requests, further limits increase spacing and quiet time restores it', async t => {
  const sent = [];
  let limited = true;
  const bg = await api(async message => {
    sent.push({ path: message.path, at: Date.now() });
    if (limited) {
      limited = false;
      return { status: 429, error: 'Limited', retryAfter: '1' };
    }
    return { ok: true, data: {} };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const recovered = bg.apiFetch('/api/first', { polite: true });
  await settle();
  t.mock.timers.tick(1000);
  await recovered;
  const next = bg.apiFetch('/api/next', { polite: true });
  await settle();
  t.mock.timers.tick(399);
  await settle();
  assert.equal(sent.length, 2);
  t.mock.timers.tick(1);
  await next;
  assert.equal(sent.at(-1).at, 101400);
  limited = true;
  const limitedAgain = bg.apiFetch('/api/second', { polite: true });
  t.mock.timers.tick(400);
  await settle();
  t.mock.timers.tick(1000);
  await limitedAgain;
  const slower = bg.apiFetch('/api/slower', { polite: true });
  await settle();
  const before = sent.length;
  t.mock.timers.tick(799);
  await settle();
  assert.equal(sent.length, before);
  t.mock.timers.tick(1);
  await slower;
  assert.equal(sent.at(-1).at, 103600);
  t.mock.timers.tick(60000);
  await bg.apiFetch('/api/quiet', { polite: true });
  const normal = bg.apiFetch('/api/normal', { polite: true });
  await settle();
  t.mock.timers.tick(200);
  await normal;
  assert.equal(sent.at(-1).at - sent.at(-2).at, 200);
});
