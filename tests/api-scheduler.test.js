import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiScheduler, apiScope } from '../nexus-addon/api-scheduler.js';

const origin = 'https://s0.nexuslegacy.space';
const settle = () => new Promise(resolve => setImmediate(resolve));
const reply = { ok: true, data: {} };
const request = (scheduler, path, run, options = {}) =>
  scheduler.schedule({ origin, path, ...options }, run);

test('scope matching retains query variants and excludes unrelated paths', () => {
  assert.equal(apiScope('/api/galaxy/systems/12/planets?include=moons'), 'system-details');
  assert.equal(apiScope('/api/fleet/fuel-estimate'), 'fuel-estimate');
  assert.equal(apiScope('/api/planets/12'), 'general');
});

test('simulator fourth attempt waits for the response-based 3/10s window, including native starts and restarts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let saved = {};
  const storage = {
    get: async () => structuredClone(saved),
    set: async value => { saved = structuredClone(value); },
  };
  const scheduler = createApiScheduler({ storage });
  const path = '/api/combat-simulator/simulate';
  await scheduler.observe(origin, path, null, { started: true });
  for (let i = 0; i < 2; i++) {
    await request(scheduler, path, async () => reply, { method: 'POST' });
  }
  const restarted = createApiScheduler({ storage });
  let calls = 0;
  const fourth = request(restarted, path, async () => { calls++; return reply; }, { method: 'POST' });
  await settle();
  const status = await restarted.status(origin, path);
  assert.ok(status.scopes.find(scope => scope.name === 'simulator').wait);
  await request(restarted, '/api/planets', async () => reply);
  t.mock.timers.tick(10099);
  await settle();
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await fourth;
  assert.equal(calls, 1);
});

test('captured combat-simulator 429 headers pause only the simulator until reset plus margin', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  const path = '/api/combat-simulator/simulate';
  await scheduler.observe(origin, path, {
    status: 429, rateLimitScope: 'combat-simulator', rateLimitLimit: '3',
    rateLimitPolicy: '3;w=10', rateLimitRemaining: '0', rateLimitReset: '8', retryAfter: '8',
  });
  await request(scheduler, '/api/planets', async () => reply);
  let sent = false;
  const next = request(scheduler, path, async () => { sent = true; return reply; }, { method: 'POST' });
  await settle();
  t.mock.timers.tick(8000);
  await settle();
  assert.equal(sent, false);
  t.mock.timers.tick(100);
  await next;
  assert.equal(sent, true);
});

test('system-detail slots stay reserved through transport latency and a window safety margin', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let saved = {};
  const storage = {
    get: async () => structuredClone(saved),
    set: async value => { saved = structuredClone(value); },
  };
  const scheduler = createApiScheduler({ storage });
  const arrivals = [];
  for (let i = 0; i < 30; i++) {
    const pending = request(scheduler, `/api/galaxy/systems/${i}/planets`, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      arrivals.push(Date.now());
      return reply;
    });
    await settle();
    t.mock.timers.tick(10);
    await pending;
  }
  const restarted = createApiScheduler({ storage });
  const next = request(restarted, '/api/galaxy/systems/31/planets', async () => {
    arrivals.push(Date.now());
    return reply;
  });
  await settle();
  t.mock.timers.tick(9700);
  await settle();
  assert.equal(arrivals.length, 30, 'admission time must not release a slot before its response window ends');
  t.mock.timers.tick(109);
  await settle();
  assert.equal(arrivals.length, 30, 'leave a margin beyond the full response-based window');
  t.mock.timers.tick(1);
  await next;
  assert.equal(arrivals.at(-1), 110110);
  for (const time of arrivals) {
    assert.ok(arrivals.filter(value => value >= time - 10000 && value <= time).length <= 30);
  }
});

for (const [scope, path, count, short, minute] of [
  ['fuel-estimate', '/api/fleet/fuel-estimate', 125, 40, 120],
  ['system-details', '/api/galaxy/systems/1/planets', 185, 30, 180],
]) {
  test(`${scope} enforces both rolling windows for every scheduled attempt`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const scheduler = createApiScheduler();
    const times = [];
    const pending = Array.from({ length: count }, () => request(scheduler, path, async () => {
      times.push(Date.now());
      return reply;
    }, { method: 'POST', priority: 'action' }));
    await settle();
    assert.equal(times.length, short);
    t.mock.timers.tick(9999);
    await settle();
    assert.equal(times.length, short);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(times.length, short, 'the exact window boundary retains a safety margin');
    t.mock.timers.tick(100);
    await settle();
    assert.equal(times.length, short * 2);
    for (let step = 0; times.length < count && step < 600; step++) {
      t.mock.timers.tick(100);
      await settle();
    }
    await Promise.all(pending);
    assert.equal(times.length, count);
    assert.equal(times.at(-1), scope === 'fuel-estimate' ? 160100 : 160600);
    for (const time of times) {
      assert.ok(times.filter(value => value > time - 10000 && value <= time).length <= short);
      assert.ok(times.filter(value => value > time - 60000 && value <= time).length <= minute);
    }
  });
}

test('scope cooldown skips blocked work, including on another universe, without poisoning general headers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  await scheduler.observe(origin, '/api/fleet/fuel-estimate', {
    status: 429, retryAfter: '5', rateLimitScope: 'fuel-estimate',
    rateLimitLimit: '120', rateLimitRemaining: '0', rateLimitReset: '60',
  });
  const calls = [];
  const fuel = request(scheduler, '/api/fleet/fuel-estimate', async () => {
    calls.push('fuel');
    return reply;
  });
  await request(scheduler, '/api/planets', async () => { calls.push('planet'); return reply; });
  await request(scheduler, '/api/fleet/fuel-estimate', async () => { calls.push('beta'); return reply; },
    { origin: 'https://beta.nexuslegacy.space' });
  assert.deepEqual(calls, ['planet', 'beta']);
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(calls, ['planet', 'beta'], 'exhausted scope headers also require waiting for reset');
  t.mock.timers.tick(55100);
  await fuel;
  assert.deepEqual(calls, ['planet', 'beta', 'fuel']);
});

test('unknown 429 scope blocks the origin and late optimistic replies do not release it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  await scheduler.observe(origin, '/api/test', { status: 429, rateLimitScope: 'unknown', retryAfter: '3' });
  await scheduler.observe(origin, '/api/other', { status: 200, rateLimitRemaining: '350', rateLimitReset: '60' });
  let started = false;
  const pending = request(scheduler, '/api/planets', async () => { started = true; return reply; });
  await settle();
  assert.equal(started, false);
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(started, false);
  t.mock.timers.tick(1001);
  await pending;
  assert.equal(started, true);
});

test('bounded background concurrency leaves a slot for actions and queued actions precede bulk work', async () => {
  const scheduler = createApiScheduler();
  const starts = [];
  const releases = [];
  const blocked = name => async () => {
    starts.push(name);
    await new Promise(resolve => releases.push(resolve));
    return reply;
  };
  const first = request(scheduler, '/api/first', blocked('first'), { priority: 'background' });
  const second = request(scheduler, '/api/second', blocked('second'), { priority: 'background' });
  const third = request(scheduler, '/api/third', blocked('third'), { priority: 'background' });
  await settle();
  assert.deepEqual(starts, ['first', 'second']);
  const action = request(scheduler, '/api/action', blocked('action'), { method: 'POST', priority: 'action' });
  await settle();
  assert.deepEqual(starts, ['first', 'second', 'action']);
  releases.shift()();
  releases.shift()();
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(starts, ['first', 'second', 'action', 'third']);
  for (const release of releases) release();
  await Promise.all([action, third]);
});

test('matching reads coalesce, promote and cancel independently; writes never coalesce', async () => {
  const scheduler = createApiScheduler();
  const controller = new AbortController();
  let release;
  let sends = 0;
  const run = async () => { sends++; await new Promise(resolve => { release = resolve; }); return reply; };
  const first = request(scheduler, '/api/shared', run, { signal: controller.signal, priority: 'bulk' });
  const second = request(scheduler, '/api/shared', run, { priority: 'action' });
  const rejection = assert.rejects(first, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejection;
  await settle();
  assert.equal(sends, 1);
  release();
  assert.equal(await second, reply);
  await Promise.all([1, 2].map(() => request(scheduler, '/api/write', async () => {
    sends++;
    return reply;
  }, { method: 'POST' })));
  assert.equal(sends, 3);
});

test('cancelling queued work prevents transmission', async () => {
  const scheduler = createApiScheduler();
  const controller = new AbortController();
  let calls = 0;
  const pending = request(scheduler, '/api/cancel', async () => { calls++; return reply; },
    { signal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejection;
  await settle();
  assert.equal(calls, 0);
});

test('cooldowns and actual request windows survive scheduler recreation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let saved = {};
  const storage = {
    get: async () => structuredClone(saved),
    set: async value => { saved = structuredClone(value); },
  };
  const first = createApiScheduler({ storage });
  for (let i = 0; i < 40; i++) {
    await request(first, '/api/fleet/fuel-estimate', async () => reply, { method: 'POST' });
  }
  await first.observe(origin, '/api/test', { status: 429, retryAfter: '3' });
  const restarted = createApiScheduler({ storage });
  let sent = false;
  const pending = request(restarted, '/api/fleet/fuel-estimate', async () => { sent = true; return reply; });
  await settle();
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(sent, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(sent, false);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(sent, true);
});

test('failed persistence prevents sending an unrecorded request', async () => {
  const scheduler = createApiScheduler({ storage: {
    get: async () => ({}), set: async () => { throw new Error('Session storage unavailable'); },
  } });
  await assert.rejects(request(scheduler, '/api/test', () => assert.fail('must not send')),
    /Session storage unavailable/);
});

test('native starts count against scope budgets even without successful responses', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  for (let i = 0; i < 30; i++) {
    await scheduler.observe(origin, '/api/galaxy/systems/1/planets', null, { started: true });
  }
  let sent = false;
  const pending = request(scheduler, '/api/galaxy/systems/2/planets', async () => { sent = true; return reply; });
  await settle();
  assert.equal(sent, false);
  t.mock.timers.tick(10100);
  await pending;
  assert.equal(sent, true);
});

test('the general local ceiling reserves room for actions across origins', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  for (let i = 0; i < 380; i++) {
    await scheduler.observe(origin, '/api/test', null, { started: true });
  }
  let sent = false;
  const background = request(scheduler, '/api/background', async () => { sent = true; return reply; });
  await request(scheduler, '/api/action', async () => reply, { priority: 'action', method: 'POST',
    origin: 'https://beta.nexuslegacy.space' });
  assert.equal(sent, false);
  t.mock.timers.tick(60100);
  await background;
});

test('aged background work progresses even while new interactive work is queued', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  const starts = [];
  const releases = [];
  const held = name => async () => {
    starts.push(name);
    await new Promise(resolve => releases.push(resolve));
    return reply;
  };
  const active = [1, 2, 3].map(id => request(scheduler, `/api/held/${id}`, held(`held${id}`),
    { priority: 'interactive' }));
  await settle();
  const background = request(scheduler, '/api/maintenance', held('maintenance'), { priority: 'background' });
  await settle();
  t.mock.timers.tick(120000);
  const action = request(scheduler, '/api/new-action', held('new-action'), { priority: 'action' });
  releases.shift()();
  await active[0];
  await settle();
  assert.equal(starts[3], 'maintenance');
  for (const release of releases.splice(0)) release();
  await settle();
  for (const release of releases) release();
  await Promise.all([...active, background, action]);
});

test('malformed retry/budget headers retain fallback cooldown and reject invalid priorities', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = createApiScheduler();
  await assert.rejects(request(scheduler, '/api/test', () => reply, { priority: 'constructor' }), /Unknown API priority/);
  await scheduler.observe(origin, '/api/test', {
    status: 429, retryAfter: 'not a date', rateLimitRemaining: 'bad', rateLimitReset: 'bad',
  });
  let started = false;
  const pending = request(scheduler, '/api/test', async () => { started = true; return reply; });
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(started, false);
  t.mock.timers.tick(1);
  await pending;
});
