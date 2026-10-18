import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowserStub, setupDomStub, loadBackground } from './helpers.js';

setupDomStub();
const simulator = await import('../nexus-addon/tabs/simulator.js');

const report = {
  outcome: 'attacker_won',
  attackerSurvivors: [{ shipDefId: 5, key: 'fighter', quantity: 1462 }],
  defenderSurvivors: [],
  attackerLosses: [
    { shipDefId: 5, key: 'fighter', lost: 338, destroyed: 237, damaged: 101 },
  ],
  defenderLosses: [
    { shipDefId: -2100001, key: 'missile_defense', name: 'Missile Defense', lost: 10 },
  ],
};

test('lossEntries preserves the server destroyed/damaged split', () => {
  const [loss] = simulator.lossEntries(report.attackerLosses);
  assert.equal(loss.destroyed, 237);
  assert.equal(loss.damaged, 101);
  assert.equal(loss.lost, 338);
});

test('lossEntries tolerates object-shaped loss maps', () => {
  assert.deepEqual(simulator.lossEntries({ cruiser: { lost: 12 } }), [
    { key: 'cruiser', lost: 12 },
  ]);
  assert.deepEqual(simulator.lossEntries(undefined), []);
});

test('fleetRows uses the server survivor list and includes generated defenses', () => {
  const rows = simulator.fleetRows(
    { 5: 1800 },
    [...report.attackerSurvivors, { shipDefId: -9000432, key: 'leader_command_vessel', quantity: 1 }],
    report.attackerLosses,
  );
  const fighter = rows.find(row => row.shipDefId === 5);
  assert.equal(fighter.remain, 1462);
  assert.equal(fighter.lost, 338);
  const leader = rows.find(row => row.shipDefId === -9000432);
  assert.equal(leader.sent, 1);
  assert.equal(leader.remain, 1);

  const defense = simulator.fleetRows({}, [], report.defenderLosses)[0];
  assert.equal(defense.shipDefId, -2100001);
  assert.equal(defense.remain, 0);
});

test('simPayload unwraps the game-tab transport and rejects missing reports', () => {
  assert.deepEqual(simulator.simPayload({ ok: true, data: { report } }), { report });
  assert.equal(simulator.simPayload({ ok: true, data: {} }), null);
  assert.equal(simulator.simPayload(undefined), null);
});

test('SIM_RUN posts the official body through the game-tab bridge', async () => {
  const store = makeBrowserStub();
  const sent = [];
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = async (_tabId, message) => {
    sent.push(message);
    return { ok: true, data: { report } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const attacker = { type: 'player', fleet: [{ shipDefId: 5, quantity: 10 }] };
  const defender = { type: 'pirate', fleet: [{ shipDefId: 101, quantity: 2 }], pirateZone: 'open' };
  const response = await listener({ type: 'SIM_RUN', attacker, defender });

  assert.equal(response.ok, true);
  assert.equal(sent[0].type, 'GAME_FETCH');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, '/api/combat-simulator/simulate');
  assert.deepEqual(sent[0].body, { attacker, defender });
  assert.equal(store.last_error, undefined);
});

test('SIM_RUN rejects an empty attacker before issuing a game request', async () => {
  const store = makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const response = await listener({ type: 'SIM_RUN', attacker: { fleet: [] }, defender: { fleet: [] } });
  assert.match(response.error, /Attacker needs/);
  assert.equal(store.last_error, undefined);
});
