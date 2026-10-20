import assert from 'node:assert/strict';
import test from 'node:test';
import { missionsCard } from '../nexus-addon/tabs/dashboard.js';
import { missionProgress } from '../nexus-addon/mission-state.js';
import { loadBackground, makeBrowserStub } from './helpers.js';

const arrivesAt = '2026-10-19T10:00:00.000Z';
const returnDepartsAt = '2026-10-19T10:12:00.000Z';
const returnArrivesAt = '2026-10-19T10:30:00.000Z';
const nextCycleAt = '2026-10-19T10:10:00.000Z';
const missionStage = mission => missionProgress(mission).label;
const missionEvent = mission => missionProgress(mission).event;

test('explicit mission statuses take priority over travel timestamps', () => {
  for (const [status, expected] of [
    ['outbound', 'Outbound'], ['surveying', 'Surveying'], ['mining', 'Mining'],
    ['exploring', 'Exploring'], ['patrolling', 'Patrolling'], ['returning', 'Returning'],
    ['awaiting_orders', 'Awaiting orders'],
  ]) {
    assert.equal(missionStage({ status, arrivesAt, returnDepartsAt: null }), expected);
    assert.equal(missionStage({ status, arrivesAt: '2099-01-01', returnDepartsAt }), expected);
  }
});

test('mission countdowns use phase-specific events, not the earliest travel timestamp', () => {
  const times = { arrivesAt, returnDepartsAt, returnArrivesAt, nextCycleAt };
  for (const [status, label, value] of [
    ['outbound', 'Arrival', arrivesAt],
    ['dispatched', 'Arrival', arrivesAt],
    ['surveying', 'Departure', returnDepartsAt],
    ['mining', 'Next cycle', nextCycleAt],
    ['exploring', 'Exploration ends', arrivesAt],
    ['patrolling', 'Patrol ends', arrivesAt],
    ['returning', 'Return', returnArrivesAt],
  ]) {
    assert.deepEqual(missionEvent({ ...times, status }), { label, at: Date.parse(value) });
  }
  for (const status of ['mining', 'surveying', 'returning', 'unknown_status']) {
    assert.equal(missionEvent({ status, arrivesAt }), null);
  }
  assert.equal(missionEvent({ status: 'mining', nextCycleAt: 'invalid' }), null);
  assert.equal(missionEvent({ status: 'completed', ...times }), null);
});

test('missing statuses use conservative timestamp inference without inventing a return', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-19T10:05:00Z'));
  assert.equal(missionStage({ arrivesAt: '2099-01-01' }), 'Outbound');
  assert.equal(missionStage({ arrivesAt, returnDepartsAt: '2099-01-01' }), 'On site');
  assert.equal(missionStage({ arrivesAt, returnArrivesAt }), 'Returning');
  assert.equal(missionStage({ arrivesAt }), 'On site');
  assert.equal(missionStage({}), 'On site');
});

function domElement() {
  return {
    children: [], textContent: '', style: {}, classList: { add() {} },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
  };
}

const text = node => [node.textContent, ...node.children.map(text)].join(' ');

test('Active Missions groups real stages and summarizes the next fleet-slot return', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-19T09:57:00Z'));
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  globalThis.document = { createElement: domElement };
  const card = missionsCard({
    maxFleetSlots: 18,
    missions: [
      { type: 'mine', status: 'mining', arrivesAt, nextCycleAt, ships: 112 },
      { type: 'mine', status: 'returning', arrivesAt, returnArrivesAt, ships: 20 },
      { type: 'patrol', status: 'patrolling', arrivesAt: '2026-10-19T19:53:04Z', ships: 5 },
      { type: 'survey', status: 'surveying', arrivesAt, returnDepartsAt, ships: 1 },
    ],
  });
  const content = text(card);
  assert.match(text(card.children[1]), /Fleet slots used\s+3 \/ 18/);
  assert.equal(card.children[2].className, 'ov-bar');
  assert.equal(card.children[2].children[0].style.width, `${3 / 18 * 100}%`);
  assert.match(content, /Fleet slots used\s+3 \/ 18/);
  assert.match(content, /Active patrols \(no fleet slot\)\s+1/);
  assert.doesNotMatch(content, /Total active/);
  assert.match(content, /Next return\s+⏱ 33m 00s/);
  assert.match(content, /mine · 2 fleets · 132 ships\s+1 mining, 1 returning\s+Next cycle:/);
  assert.match(content, /1 patrolling\s+Patrol ends:/);
  assert.match(content, /1 surveying\s+Departure:/);
  assert.doesNotMatch(content, /outbound/);
  assert.match(text(missionsCard({
    maxFleetSlots: 18,
    missions: [{ type: 'survey', status: 'outbound', arrivesAt, ships: 1 }],
  })), /Arrival:.*3m 00s/);
  const empty = text(missionsCard({ maxFleetSlots: 18, missions: [] }));
  assert.match(empty, /Fleet slots used\s+0 \/ 18/);
  assert.match(empty, /Next return\s+-/);
  assert.doesNotMatch(empty, /Active patrols/);
  const patrolOnly = text(missionsCard({
    maxFleetSlots: 18,
    missions: [{ type: 'patrol', status: 'patrolling', ships: 5 }],
  }));
  assert.match(patrolOnly, /Fleet slots used\s+0 \/ 18/);
  assert.match(patrolOnly, /Active patrols \(no fleet slot\)\s+1/);
});

test('next return includes expeditions but excludes patrols and work events', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-19T10:00:00Z'));
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  globalThis.document = { createElement: domElement };
  const missions = [
    { type: 'mine', status: 'mining', nextCycleAt: '2026-10-19T10:01:00Z', returnArrivesAt, ships: 1 },
    { type: 'survey', status: 'outbound', arrivesAt: '2026-10-19T10:02:00Z', returnArrivesAt, ships: 1 },
    { type: 'survey', status: 'surveying', returnDepartsAt, returnArrivesAt, ships: 1 },
    { type: 'patrol', status: 'returning', returnArrivesAt: '2026-10-19T10:03:00Z', ships: 1 },
    { type: 'transport', status: 'returning', returnArrivesAt: 'invalid', ships: 1 },
  ];
  assert.match(text(missionsCard({ missions, maxFleetSlots: 18 }).children[3]), /Next return\s+-/);
  missions.push(
    { type: 'mine', status: 'returning', returnArrivesAt, ships: 1 },
    { type: 'transport', status: 'returning', returnArrivesAt: '2026-10-19T10:15:00Z', ships: 1 },
  );
  const summary = text(missionsCard({ missions, maxFleetSlots: 18 }).children[3]);
  assert.match(summary, /Next return\s+⏱ 15m 00s/);
  assert.doesNotMatch(summary, /Next cycle|Arrival|Departure/);
  missions.push({ type: 'expedition', status: 'returning', returnArrivesAt: '2026-10-19T10:05:00Z', ships: 1 });
  assert.match(text(missionsCard({ missions, maxFleetSlots: 18 }).children[3]), /Next return\s+⏱ 5m 00s/);
});

test('dashboard overview preserves mining cycle times from the API cargo', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 1 }];
  const responses = {
    '/api/planets': { planets: [] },
    '/api/fleet/missions': {
      maxFleetSlots: 18,
      missions: [
        {
          id: 1, missionType: 'mine', status: 'mining', arrivesAt,
          cargo: { _nextCycleAt: nextCycleAt, ore: 15259 },
          fleetComposition: [{ quantity: 68, damagedQuantity: 16 }, { quantity: 43 }],
        },
        { id: 2, missionType: 'patrol', status: 'patrolling', arrivesAt },
      ],
    },
    '/api/research': {},
    '/api/auth/me': { user: { id: 1 } },
    '/api/moons/colony-status': {},
    '/api/galaxy/colony-status': {},
    '/api/leadership': {},
  };
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    assert.ok(Object.hasOwn(responses, message.path), message.path);
    return { ok: true, data: responses[message.path] };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners[0];
  const overview = await listener({ type: 'GET_DASHBOARD_OVERVIEW', polite: false });
  assert.equal(overview.error, undefined);
  assert.equal(overview.maxFleetSlots, 18);
  assert.equal(overview.missions[0].status, 'mining');
  assert.equal(overview.missions[0].ships, 111);
  assert.equal(overview.missions[0].nextCycleAt, nextCycleAt);
  assert.deepEqual(missionEvent(overview.missions[0]), { label: 'Next cycle', at: Date.parse(nextCycleAt) });
  assert.equal(overview.missions[1].nextCycleAt, null);
  assert.equal(missionStage(overview.missions[1]), 'Patrolling');
});
