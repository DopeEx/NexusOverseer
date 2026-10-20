import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiScheduler } from '../nexus-addon/api-scheduler.js';
import { createTrafficRecorder, summarizeTraffic, trafficSource } from '../nexus-addon/api-telemetry.js';
import 'fake-indexeddb/auto';
import { clearDiagnosticLogs, readDiagnosticLogs, writeDiagnosticLogs } from '../nexus-addon/diagnostics-store.js';

const origin = 'https://s0.nexuslegacy.space';
const path = '/api/galaxy/systems/1/planets';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('one wait episode records actual duration and window reasons without per-tick entries or request contents', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const events = [];
  const scheduler = createApiScheduler({ record: (host, data) => events.push({ host, kind: 'scheduling', timestamp: Date.now(), data }) });
  for (let i = 0; i < 30; i++) await scheduler.observe(origin, path, null, { started: true });
  const pending = scheduler.schedule({ origin, path, source: 'galaxy-search', priority: 'bulk' },
    async () => ({ ok: true, status: 200, data: { private: 'secret' } }));
  await settle();
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].data.event, 'wait-start');
  assert.equal(events[0].data.reasons[0].windowMs, 10000);
  assert.equal(events[0].data.contributors['native-game'], 30);
  t.mock.timers.tick(100);
  await pending;
  assert.deepEqual(events.map(entry => entry.data.event), ['wait-start', 'wait-end', 'dispatch', 'response']);
  assert.equal(events[1].data.durationMs, 10100);
  assert.equal(events[1].data.outcome, 'dispatched');
  assert.doesNotMatch(JSON.stringify(events), /secret|\/api\/|planets\/1/);
  assert.deepEqual(summarizeTraffic(events).groups, [
    { source: 'galaxy-search', requests: 1, pauses: 1, waitMs: 10100, limited: 0, interrupted: 0 },
  ]);
});

test('cancelled waits and server 429s remain distinct; coalesced reads count once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const events = [];
  const scheduler = createApiScheduler({ record: (_host, data) => events.push(data) });
  await scheduler.observe(origin, path, { status: 429, rateLimitScope: 'system-details', retryAfter: '3' });
  const controller = new AbortController();
  const cancelled = scheduler.schedule({ origin, path, signal: controller.signal, source: 'galaxy-search' }, () => assert.fail());
  const rejected = assert.rejects(cancelled);
  await settle();
  t.mock.timers.tick(1000);
  controller.abort();
  await rejected;
  assert.equal(events[1].outcome, 'cancelled');
  assert.equal(events[1].durationMs, 1000);
  assert.equal(events[0].reasons[0].reason, 'server');
  const first = scheduler.schedule({ origin, path, source: 'ownership-check' }, async () => ({ status: 429 }));
  const second = scheduler.schedule({ origin, path, source: 'galaxy-search' }, () => assert.fail());
  await settle();
  t.mock.timers.tick(2000);
  await Promise.all([first, second]);
  assert.equal(events.filter(entry => entry.event === 'dispatch').length, 1);
  assert.equal(events.at(-1).status, 429);
});

test('recording defaults to no writes, recovers interrupted waits once and enforces storage bounds', async () => {
  let enabled = false;
  const calls = [];
  const old = [{ kind: 'scheduling', timestamp: 1, data: {
    id: 'old', event: 'wait-start', source: 'galaxy-search', startedAt: 1,
    reasons: [{ reason: 'budget' }],
  } }];
  const record = createTrafficRecorder({
    enabled: () => enabled, read: async () => old,
    write: async (...args) => calls.push(args),
  });
  await record(origin, { event: 'dispatch', source: 'dashboard' });
  assert.equal(calls.length, 0);
  enabled = true;
  await record(origin, { event: 'dispatch', source: 'dashboard' });
  await record(origin, { event: 'response', source: 'dashboard', status: 200 });
  assert.equal(calls[0][0], 's0');
  assert.equal(calls[0][2], 150);
  assert.equal(calls[0][3], 10000000);
  assert.equal(calls[0][1][0].data.outcome, 'interrupted');
  assert.equal(calls[0][1][0].data.durationIncomplete, true);
  assert.equal(calls[1][1].length, 1);
  const entries = calls.flatMap(call => call[1]);
  assert.equal(summarizeTraffic([...old, ...entries]).pending.length, 0);
  assert.equal(trafficSource('private arbitrary data'), 'background-maintenance');
});

test('a failed telemetry write is explicit and does not poison later writes', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  let attempts = 0;
  const record = createTrafficRecorder({ enabled: () => true, read: async () => [],
    write: async () => { if (++attempts === 1) throw new Error('Disk unavailable'); } });
  await record(origin, { event: 'dispatch' });
  await record(origin, { event: 'dispatch' });
  assert.equal(errors.length, 1);
  assert.equal(attempts, 2);
});

test('diagnostic retention preserves separate scheduling and payload caps across writers', async () => {
  const server = 'telemetry-test';
  await clearDiagnosticLogs(server);
  await writeDiagnosticLogs(server, Array.from({ length: 1005 }, (_, id) => ({
    kind: 'scheduling', timestamp: id, data: { event: 'dispatch', source: 'galaxy-search', id },
  })), 150, 10000000);
  await writeDiagnosticLogs(server, Array.from({ length: 155 }, (_, id) => ({
    kind: 'api', timestamp: id, data: { status: 200 },
  })), 150, 10000000);
  const entries = await readDiagnosticLogs(server);
  assert.equal(entries.filter(entry => entry.kind === 'scheduling').length, 1000);
  assert.equal(entries.filter(entry => entry.kind === 'api').length, 150);
  await clearDiagnosticLogs(server, 'scheduling');
  assert.equal((await readDiagnosticLogs(server)).length, 150);
  await clearDiagnosticLogs(server);
});
