import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { missionProgress, usedFleetSlots, usesFleetSlot } from '../nexus-addon/mission-state.js';
import {
  createMissionRefresh, makeMissionBar, missionCountdown,
  missionProgress as commonMissionProgress,
} from '../nexus-addon/common.js';

const at = minutes => new Date(Date.UTC(2026, 9, 19, 10, minutes)).toISOString();
const now = minutes => Date.parse(at(minutes));

test('all shared progress consumers use the same evaluator', () => {
  assert.equal(commonMissionProgress, missionProgress);
});

test('normal fleet slots include expeditions and exclude patrols in every phase', () => {
  for (const status of ['outbound', 'patrolling', 'returning']) {
    assert.equal(usesFleetSlot({ missionType: 'patrol', status }), false);
    assert.equal(usesFleetSlot({ type: 'patrol', status }), false);
    assert.equal(usesFleetSlot({ missionType: 'expedition', status }), true);
  }
  assert.equal(usedFleetSlots(), 0);
  assert.equal(usedFleetSlots([
    { missionType: 'patrol' }, { type: 'patrol' },
    { missionType: 'expedition' }, { type: 'expedition' },
    { missionType: 'mine' }, { missionType: 'market_deliver' },
  ]), 4);
});

test('flight phases respect status even when other leg timestamps contradict it', () => {
  const times = { departsAt: at(0), arrivesAt: at(10), returnDepartsAt: at(20), returnArrivesAt: at(40) };
  for (const missionType of ['survey', 'investigate', 'mine', 'expedition', 'patrol',
    'collect_debris', 'collect_salvage', 'xeno_survey', 'scout_camp',
    'attack_pirates', 'market_pickup', 'market_deliver', 'transport', 'relocate_outpost']) {
    const outbound = missionProgress({ ...times, missionType, status: 'outbound' }, now(5));
    assert.equal(outbound.label, 'Outbound', missionType);
    assert.equal(outbound.frac, 0.5);
    assert.equal(outbound.eta, 300000);
    assert.deepEqual(outbound.event, { label: 'Arrival', at: now(10) });
    const overdue = missionProgress({ ...times, missionType, status: 'outbound' }, now(25));
    assert.equal(overdue.status, 'outbound');
    assert.equal(overdue.frac, 1);
    assert.equal(overdue.needsRefresh, true);
    const returning = missionProgress({
      ...times, arrivesAt: at(90), missionType, status: 'returning',
    }, now(30));
    assert.equal(returning.label, 'Returning');
    assert.equal(returning.frac, 0.5);
    assert.deepEqual(returning.event, { label: 'Return', at: now(40) });
  }
});

test('market delivery with docking requested remains outbound until the API changes its status', () => {
  const mission = {
    missionType: 'market_deliver', status: 'outbound',
    departsAt: '2026-10-19T10:16:29.655Z',
    arrivesAt: '2026-10-19T10:51:54.655Z',
    travelTime: 2125, returnDepartsAt: null, returnArrivesAt: null,
    cargo: { hydrogen: 500000 }, raidParams: { dockAfterDelivery: true },
  };
  const departure = Date.parse(mission.departsAt);
  const arrival = Date.parse(mission.arrivesAt);
  const progress = missionProgress(mission, departure + (arrival - departure) / 2);
  assert.equal(progress.label, 'Outbound');
  assert.equal(progress.frac, 0.5);
  assert.deepEqual(progress.event, { label: 'Arrival', at: arrival });
  const elapsed = missionProgress(mission, arrival + 1000);
  assert.equal(elapsed.status, 'outbound');
  assert.equal(elapsed.needsRefresh, true);
  assert.equal(elapsed.event.label, 'Arrival');
});

test('survey, investigation and ruins use their on-site interval', () => {
  for (const [missionType, status, label] of [
    ['survey', 'surveying', 'Surveying'],
    ['investigate', 'investigating', 'Investigating'],
    ['xeno_survey', 'surveying', 'Surveying ruins'],
  ]) {
    const p = missionProgress({
      missionType, status, arrivesAt: at(10), returnDepartsAt: at(20),
    }, now(15));
    assert.equal(p.label, label);
    assert.equal(p.frac, 0.5);
    assert.deepEqual(p.event, { label: 'Departure', at: now(20) });
    assert.equal(missionProgress({ missionType, status, arrivesAt: at(10) }, now(30)).event, null);
  }
});

test('exploration ends at arrivesAt and starts at actual arrival', () => {
  const mission = {
    missionType: 'expedition', status: 'exploring',
    departsAt: at(0), travelTime: 600, arrivesAt: at(30),
  };
  const p = missionProgress(mission, now(20));
  assert.equal(p.label, 'Exploring');
  assert.equal(p.frac, 0.5);
  assert.equal(p.eta, 600000);
  assert.deepEqual(p.event, { label: 'Exploration ends', at: now(30) });
  const elapsed = missionProgress(mission, now(31));
  assert.equal(elapsed.label, 'Exploring');
  assert.equal(elapsed.needsRefresh, true);
  const incomplete = missionProgress({ ...mission, travelTime: undefined }, now(20));
  assert.equal(incomplete.determinate, false);
  assert.equal(incomplete.event.at, now(30));
});

test('patrolling with a future arrivesAt is never outbound', () => {
  const p = missionProgress({
    missionType: 'patrol', status: 'patrolling', departsAt: at(0), arrivesAt: at(60),
  }, now(30));
  assert.equal(p.label, 'Patrolling');
  assert.equal(p.frac, 0.5);
  assert.deepEqual(p.event, { label: 'Patrol ends', at: now(60) });
});

test('mining progress describes one cycle and raw/dashboard shapes agree', () => {
  const raw = {
    missionType: 'mine', status: 'mining', departsAt: at(-30), arrivesAt: at(-20),
    cargo: { _cycleStartedAt: at(0), _nextCycleAt: at(10), _mineUntilFull: true },
  };
  const p = missionProgress(raw, now(5));
  assert.equal(p.label, 'Mining');
  assert.equal(p.frac, 0.5);
  assert.deepEqual(p.event, { label: 'Next cycle', at: now(10) });
  const summary = {
    type: 'mine', status: 'mining', departsAt: at(-30), arrivesAt: at(-20),
    cycleStartedAt: at(0), nextCycleAt: at(10),
  };
  assert.deepEqual(missionProgress(summary, now(5)), p);
  const noCycle = missionProgress({ ...raw, cargo: {} }, now(5));
  assert.equal(noCycle.event, null);
  assert.equal(noCycle.determinate, false);
  assert.equal(noCycle.frac, 0);
});

test('rolling collection timestamps never select a return leg', () => {
  for (const missionType of ['collect_debris', 'collect_salvage']) {
    const p = missionProgress({
      missionType, status: 'collecting', arrivesAt: at(-10),
      returnDepartsAt: at(10), returnArrivesAt: at(20),
    }, now(5));
    assert.equal(p.label, 'Collecting');
    assert.deepEqual(p.event, { label: 'Collection update', at: now(10) });
    assert.equal(p.determinate, false);
    const elapsed = missionProgress({
      missionType, status: 'collecting', returnDepartsAt: at(-1), returnArrivesAt: at(20),
    }, now(5));
    assert.equal(elapsed.label, 'Collecting');
    assert.equal(elapsed.needsRefresh, true);
  }
});

test('invalid timing, unknown and terminal states do not invent progress', () => {
  for (const status of ['waiting_for_convoy', 'completed', 'cancelled']) {
    const p = missionProgress({
      status, departsAt: at(0), arrivesAt: at(10), returnArrivesAt: at(20),
    }, now(5));
    assert.equal(p.status, status);
    assert.equal(p.event, null);
    assert.equal(p.determinate, false);
    assert.equal(p.frac, 0);
    assert.equal(p.needsRefresh, false);
  }
  for (const mission of [
    {}, { status: 'returning' }, { status: 'outbound', arrivesAt: 'invalid' },
    { status: 'mining', cargo: { _nextCycleAt: 'invalid' } },
  ]) {
    const p = missionProgress(mission, now(5));
    assert.equal(p.event, null);
    assert.equal(Number.isFinite(p.frac), true);
    assert.equal(p.eta, 0);
  }
  const inverted = missionProgress({
    status: 'returning', returnDepartsAt: at(30), returnArrivesAt: at(20),
  }, now(5));
  assert.equal(inverted.determinate, false);
  assert.equal(inverted.frac, 0);
});

test('timestamps are only a fallback when status is absent', () => {
  const base = { missionType: 'survey', departsAt: at(0), arrivesAt: at(10), returnDepartsAt: at(20), returnArrivesAt: at(30) };
  assert.equal(missionProgress(base, now(5)).label, 'Outbound');
  assert.equal(missionProgress(base, now(15)).label, 'Surveying');
  assert.equal(missionProgress(base, now(25)).label, 'Returning');
  assert.equal(missionProgress({ arrivesAt: at(0) }, now(5)).label, 'On site');
});

test('common countdown and compact mission bars label the same event', t => {
  t.mock.method(Date, 'now', () => now(5));
  const oldDocument = globalThis.document;
  t.after(() => { globalThis.document = oldDocument; });
  globalThis.document = {
    createElement: () => ({
      children: [], style: {}, textContent: '',
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
    }),
  };
  const mission = {
    missionType: 'expedition', status: 'exploring', departsAt: at(-10),
    travelTime: 600, arrivesAt: at(10),
  };
  const bar = makeMissionBar(mission);
  const [track, caption] = bar.el.children;
  assert.equal(track.children[0].style.width, '50.0%');
  assert.equal(caption.children[0].textContent, 'Exploring');
  assert.equal(caption.children[1].textContent, 'Exploration ends: 5m 00s');
  t.mock.method(Date, 'now', () => now(11));
  bar.upd();
  assert.equal(caption.children[0].textContent, 'Exploring');
  assert.equal(caption.children[1].textContent, 'Exploration ends: updating…');
  assert.equal(missionCountdown(missionProgress({ status: 'mining' })), '—');
});

test('mission refreshes are event-driven, throttled and never overlap', async t => {
  let clock = now(0), calls = 0, finish;
  t.mock.method(Date, 'now', () => clock);
  const refresh = createMissionRefresh(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const missions = [{ id: 1, status: 'outbound', arrivesAt: at(1) }];
  clock = now(0) + 30000;
  const first = refresh(missions);
  assert.equal(calls, 1);
  clock = now(2);
  await refresh(missions);
  assert.equal(calls, 1);
  finish();
  await first;
  const expired = refresh(missions);
  assert.equal(calls, 2);
  finish();
  await expired;
  clock += 5000;
  await refresh(missions);
  assert.equal(calls, 2);
  missions[0] = { id: 1, status: 'surveying', returnDepartsAt: at(2) };
  const changed = refresh(missions);
  assert.equal(calls, 3);
  finish();
  await changed;
  clock += 30000;
  const periodic = refresh(missions);
  assert.equal(calls, 4);
  finish();
  await periodic;
});

test('refresh failures are logged and do not block later retries', async t => {
  let clock = now(0), calls = 0;
  t.mock.method(Date, 'now', () => clock);
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const refresh = createMissionRefresh(async () => { calls++; throw new Error('offline'); });
  clock += 30000;
  await refresh([]);
  assert.equal(logged[0][1].message, 'offline');
  clock += 30000;
  await refresh([]);
  assert.equal(calls, 2);
});

test('the shared mission evaluator is included in extension release packages', async () => {
  const files = JSON.parse(await readFile(new URL('../tools/windows-updater/addon-files.json', import.meta.url), 'utf8'));
  assert.ok(files.includes('mission-state.js'));
});
