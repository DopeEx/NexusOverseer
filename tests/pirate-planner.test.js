import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { makeBrowserStub } from './helpers.js';

const camp = {
  hasFleetIntel: true,
  securityZone: 'open',
  fleetIntel: [{ shipDefId: 101, quantity: 2 }],
};
const playerShips = [
  { id: 5, name: 'Fighter', attack: 30, hp: 250 },
  { id: 6, name: 'Cruiser', attack: 65, hp: 700 },
];
let instance = 0;

async function plannerFixture(run) {
  const store = makeBrowserStub();
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'SIM_BOOTSTRAP') return { playerShips };
    assert.equal(message.type, 'SIM_RUN');
    return run(message);
  };
  const planner = await import(`../nexus-addon/pirate-planner.js?test=${instance++}`);
  return { store, suggest: (available, options) => planner.suggestAttackFleet(camp, available, options) };
}

function simulationResult(clean) {
  return {
    ok: true,
    data: {
      report: {
        outcome: 'attacker_won',
        attackerLosses: [],
        rounds: [{ attackerHpPercent: clean ? 70 : 40 }],
      },
    },
  };
}

test('planner retains binary-search results, safety margin and cache reuse', async () => {
  const requests = [];
  const { suggest, store } = await plannerFixture(async message => {
    const { quantity } = message.attacker.fleet[0];
    requests.push(quantity);
    return simulationResult(quantity >= 7);
  });
  const result = await suggest({ 5: 32 });
  assert.deepEqual(result.ships, { 5: 8 });
  assert.match(result.note, /minimum 7/);
  assert.equal(requests.length, 6);
  assert.equal(Object.values(store.pirate_plan_cache)[0].hi, 7);
  requests.length = 0;
  assert.deepEqual((await suggest({ 5: 32 })).ships, { 5: 8 });
  assert.equal(requests.length, 0);
});

test('planner reports ship type, probe and cache progress without changing results', async () => {
  const progress = [];
  const { suggest } = await plannerFixture(async message =>
    simulationResult(message.attacker.fleet[0].quantity >= 7));
  const result = await suggest({ 5: 32 }, { onProgress: text => progress.push(text) });
  assert.deepEqual(result.ships, { 5: 8 });
  assert.match(progress[0], /1\/1: Fighter.*Reading cached bounds/);
  assert.match(progress[1], /Simulating 32 ships.*0 simulations completed/);
  assert.match(progress.at(-1), /5 simulations completed/);
  progress.length = 0;
  assert.deepEqual((await suggest({ 5: 32 }, { onProgress: text => progress.push(text) })).ships, { 5: 8 });
  assert.equal(progress.length, 1);
  assert.match(progress[0], /Reading cached bounds/);
});

test('planner stops on a final background 429 without starting another ship type', async () => {
  const requests = [];
  const { suggest } = await plannerFixture(async message => {
    requests.push(message);
    return { error: 'Combat simulator rate limit reached.', status: 429, retryAfter: '60' };
  });
  const result = await suggest({ 5: 32, 6: 32 });
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, '60');
  assert.match(result.error, /Simulation failed:.*rate limit/);
  assert.equal(requests.length, 1);
});

test('planner saves learned bounds when a later probe hits the rate limit', async () => {
  let calls = 0;
  const { suggest, store } = await plannerFixture(async () => {
    if (++calls === 1) return simulationResult(true);
    return { error: 'Rate limit reached', status: 429, retryAfter: '60' };
  });
  assert.equal((await suggest({ 5: 32, 6: 32 })).status, 429);
  assert.equal(calls, 2);
  const [record] = Object.values(store.pirate_plan_cache);
  assert.equal(record.hi, 32);
  assert.equal(record.lo, 0);
});

test('automatic attacks stop after exhausted retries and can launch on a later successful pass', async () => {
  const source = await readFile(new URL('../nexus-addon/tabs/pirates.js', import.meta.url), 'utf8');
  const pickSource = source.slice(source.indexOf('async function pickSourcePlanet('), source.indexOf('\nfunction attackShipsPresent('));
  const automate = source.slice(source.indexOf('async function automatePirateAttacks('), source.indexOf('\nasync function automatePirateScouting('));
  const planets = [{ id: 1 }, { id: 2 }];
  const statuses = [];
  let plans = 0;
  let fleetReads = 0;
  const context = vm.createContext({
    pcAttackRunning: false,
    pcJustAttacked: new Map(),
    pcMissions: [],
    pcSlots: { max: 10, used: 0 },
    pcPlanets: planets,
    pcCamps: [{ id: 1, name: 'First camp' }, { id: 2, name: 'Second camp' }],
    refreshPirateReports: async () => {},
    refreshPirateMissions: async () => {},
    rememberedSelections: async () => ({}),
    attackLossGuard: () => ({ lost: 0, defeats: 0 }),
    campReadyToAttack: () => true,
    sourceCandidates: async () => planets,
    attackPlannerOptions: () => ({}),
    document: { getElementById: () => ({ value: '1' }) },
    setStatusText: (_element, text) => statuses.push(text),
    suggestAttackFleet: async () => {
      plans++;
      return { status: 429, retryAfter: '60', error: 'Rate limit reached' };
    },
    browser: {
      runtime: {
        sendMessage: async message => {
          assert.equal(message.type, 'GET_PLANET_SHIPS', 'no attack should be launched');
          fleetReads++;
          return { available: { 5: 32 } };
        },
      },
    },
  });
  vm.runInContext(`${pickSource}\n${automate}`, context);
  await context.automatePirateAttacks();
  assert.equal(plans, 1);
  assert.equal(fleetReads, 1);
  assert.equal(statuses.at(-1), 'First camp: Rate limit reached');
  assert.equal(context.pcAttackRunning, false);

  let finishPlan;
  context.suggestAttackFleet = () => new Promise(resolve => { finishPlan = resolve; });
  const attacks = [];
  context.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_PLANET_SHIPS') return { available: { 5: 32 } };
    assert.equal(message.type, 'SEND_ATTACK_PIRATES');
    attacks.push(message);
    return { ok: true };
  };
  const nextPass = context.automatePirateAttacks();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.pcAttackRunning, true, 'keep the automation pass active while planning waits');
  assert.equal(attacks.length, 0, 'never launch before planning completes');
  finishPlan({ ships: { 5: 8 }, note: 'Suggested: 8 fighters' });
  await nextPass;
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0].campId, 1);
  assert.equal(attacks[0].sourcePlanetId, 1);
  assert.equal(attacks[0].ships[0].quantity, 8);
  assert.equal(context.pcAttackRunning, false);
});
