import test from 'node:test';
import assert from 'node:assert/strict';
import { compareXenoResults, prepareXenoDig, xenoCandidates, xenoDefender, xenoEntrances, xenoLeadershipFingerprint, xenoSimulationResult, xenoTemplateCandidate } from '../nexus-addon/xeno-dig-planner.js';

const ships = [
  { id: 29, key: 'excavator', name: 'Excavator', hp: 400, shipSize: 'large', shipClass: 'utility' },
  { id: 12, key: 'missile_cruiser', name: 'Missile Cruiser', hp: 1000, shieldHp: 300, attack: 70, shipSize: 'large', shipClass: 'combat' },
  { id: 8, key: 'cruiser', name: 'Cruiser', hp: 700, shieldHp: 200, attack: 65, shipSize: 'large', shipClass: 'combat' },
  { id: 99, key: 'titan', name: 'Titan', hp: 100, attack: 100, shipSize: 'capital', shipClass: 'combat' },
];

test('candidate fleets reserve excavators and commander mass and exclude capital ships', () => {
  const candidates = xenoCandidates(ships, { 29: 3, 12: 40, 8: 1, 99: 1 }, { excavators: 3, massLimit: 45000 }, 2050);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].fleet, [{ shipDefId: 12, quantity: 40 }, { shipDefId: 29, quantity: 3 }]);
  assert.equal(candidates[0].mass, 43250);
  assert.throws(() => xenoCandidates(ships, { 29: 2, 12: 40 }, { excavators: 3, massLimit: 45000 }), /3 undamaged excavators/);
});

test('Open dig uses six excavators, a 100k mass limit and excludes capital ships', () => {
  const zone = { excavators: 6, massLimit: 100000, hall: false };
  const candidates = xenoCandidates(ships, { 29: 6, 12: 90, 8: 20, 99: 1 }, zone, 2050);
  assert.equal(candidates[0].fleet[1].quantity, 6);
  assert.equal(candidates[0].mass <= 100000, true);
  assert.ok(candidates.every(candidate => candidate.fleet.every(ship => ship.shipDefId !== 99)));
  assert.throws(() => xenoTemplateCandidate(ships, { 29: 6, 99: 1 }, zone, 2050,
    { ships: { 99: 1 } }), /cannot enter the tunnel/);
});

test('mixed templates include required excavators and enforce availability and tunnel mass', () => {
  const zone = { excavators: 3, massLimit: 45000 };
  const available = { 29: 3, 12: 40, 8: 1 };
  const template = { ships: { 12: 40, 8: 1 } };
  const candidate = xenoTemplateCandidate(ships, available, zone, 2050, template);
  assert.equal(candidate.mass, 43950);
  assert.ok(candidate.fleet.some(ship => ship.shipDefId === 29 && ship.quantity === 3));
  assert.throws(() => xenoTemplateCandidate(ships, available, zone, 4000, template), /exceeds/);
  assert.throws(() => xenoTemplateCandidate(ships, available, zone, 0, { ships: { 29: 2, 12: 1 } }), /exactly 3/);
  assert.throws(() => xenoTemplateCandidate(ships, available, zone, 0, { ships: { 99: 1 } }), /cannot enter/);
  assert.throws(() => xenoTemplateCandidate(ships, available, zone, 0, { ships: { 12: 41 } }), /Not enough/);
});

test('entrances map guardians by bootstrap key to NPC ids, not generic report keys', () => {
  const chain = { trace: 'ruins', site: { moonId: 1 }, garrison: [{ key: 'xeno_golem', quantity: 21 }],
    sideEntrances: [{ trace: 'spire', garrison: [{ key: 'xeno_chorus', quantity: 43 }] }] };
  const entries = xenoEntrances(chain);
  assert.deepEqual(xenoDefender(entries[1], [{ key: 'xeno_chorus', id: -20008, isNpc: true }]).fleet,
    [{ shipDefId: -20008, quantity: 43 }]);
  assert.throws(() => xenoDefender(entries[0], []), /unknown guardian/i);
});

test('only wins with sufficient excavators are viable and losses determine ranking', () => {
  const result = (outcome, excavators, destroyed, damaged) => xenoSimulationResult({
    report: { outcome, attackerSurvivors: [{ shipDefId: 29, quantity: excavators }],
      attackerLosses: [{ destroyed, damaged }] },
  }, 29, 3);
  const viable = result('attacker_won', 2, 3, 5);
  const fewer = result('attacker_won', 3, 2, 9);
  const failure = result('attacker_won', 1, 0, 0);
  assert.equal(failure.viable, false);
  assert.ok(compareXenoResults({ result: fewer }, { result: viable }) < 0);
  assert.ok(compareXenoResults({ result: viable }, { result: failure }) < 0);
  assert.throws(() => xenoSimulationResult({ report: { outcome: 'attacker_won', attackerSurvivors: [], attackerLosses: [{ lost: 1 }] } }, 29, 3),
    /incomplete outcome or loss/);
});

test('dig launch uses the compared fleet and validates current state', () => {
  const leadership = { vessel: { callsign: 'Leader', level: 7, status: 'ready', currentPlanetId: 1 },
    combatStats: { maxHull: 2050, currentHull: 2050 } };
  const garrison = [{ key: 'xeno_chorus', quantity: 43 }, { key: 'xeno_golem', quantity: 9 }];
  const zone = { excavators: 3, massLimit: 45000 };
  const overview = {
    liveDig: null, config: { zones: { sentinel: zone }, modes: { careful: {}, fast: {} } },
    chain: { id: 5, site: { moonId: 10 }, zone: 'sentinel', trace: 'ruins',
      expiresAt: '2099-01-01T00:00:00Z', garrison: [], sideEntrances: [{ trace: 'spire', garrison }] },
  };
  const snapshot = { planetId: 1, chainId: 5, siteMoonId: 10, zone: 'sentinel', massLimit: 45000,
    leadership: true, leadershipFingerprint: xenoLeadershipFingerprint(leadership) };
  const fleet = [{ shipDefId: 12, quantity: 41 }, { shipDefId: 29, quantity: 3 }];
  const entry = { entranceId: 'spire', garrison, result: { viable: true }, candidate: { fleet, mass: 44250 } };
  const inventory = { 12: 41, 29: 3 };
  const prepare = (snap = snapshot, result = entry, state = overview, avail = inventory, leader = leadership, mode = 'careful') =>
    prepareXenoDig(snap, result, state, avail, ships, leader, mode);
  assert.deepEqual(prepare(), { sourcePlanetId: 1, ships: fleet, attachLeader: true,
    hangarAssignments: {}, mode: 'careful', entrance: 'spire', hall: false });
  assert.equal(prepare(snapshot, entry, overview, inventory, leadership, 'fast').mode, 'fast');
  assert.throws(() => prepare({ ...snapshot, siteMoonId: 11 }), /changed or expired/);
  assert.throws(() => prepare(snapshot, { ...entry, entranceId: 'main' }), /garrison changed/);
  assert.throws(() => prepare(snapshot, { ...entry, entranceId: 'unknown' }), /selected entrance/);
  assert.throws(() => prepare(snapshot, { ...entry, garrison: [{ key: 'xeno_golem', quantity: 1 }] }), /garrison changed/);
  assert.throws(() => prepare(snapshot, entry, { ...overview, liveDig: { status: 'outbound' } }), /already active/);
  assert.throws(() => prepare(snapshot, entry, overview, { 12: 40, 29: 3 }), /Not enough/);
  assert.throws(() => prepare(snapshot, entry, overview, inventory,
    { ...leadership, vessel: { ...leadership.vessel, level: 8 } }), /leadership vessel changed/i);
  assert.throws(() => prepare({ ...snapshot, siteMoonId: undefined }), /lacks launch data/);
  assert.throws(() => prepare(snapshot, entry, overview, inventory, leadership, 'unknown'), /mode/);

  const mainGarrison = [{ key: 'xeno_chorus', quantity: 39 }, { key: 'xeno_golem', quantity: 8 }];
  const mainOverview = { ...overview, chain: { ...overview.chain, trace: 'spire', garrison: mainGarrison,
    sideEntrances: [{ trace: 'observatory', garrison: [{ key: 'xeno_lens', quantity: 11 }, { key: 'xeno_golem', quantity: 10 }] },
      { trace: 'ruins', garrison: [{ key: 'xeno_golem', quantity: 23 }] }] } };
  const mainEntry = { ...entry, entranceId: 'main', garrison: mainGarrison };
  assert.deepEqual(prepare(snapshot, mainEntry, mainOverview), { sourcePlanetId: 1, ships: fleet,
    attachLeader: true, hangarAssignments: {}, mode: 'careful', entrance: 'main', hall: false });
  assert.throws(() => prepare(snapshot, mainEntry, { ...mainOverview, liveDig: { status: 'outbound' } }), /already active/);
  assert.throws(() => prepare(snapshot, { ...mainEntry, garrison }, mainOverview), /garrison changed/);
  assert.throws(() => prepare(snapshot, mainEntry, mainOverview, { 12: 40, 29: 3 }), /Not enough/);
});

test('dig launch without leadership retains the simulated fleet', () => {
  const garrison = [{ key: 'xeno_golem', quantity: 1 }];
  const snapshot = { planetId: 1, chainId: 2, siteMoonId: 3, zone: 'sentinel', massLimit: 45000, leadership: false };
  const entry = { entranceId: 'observatory', garrison, result: { viable: true },
    candidate: { fleet: [{ shipDefId: 12, quantity: 40 }, { shipDefId: 29, quantity: 3 }], mass: 41200 } };
  const overview = { liveDig: null, config: { zones: { sentinel: { excavators: 3, massLimit: 45000 } }, modes: { careful: {} } },
    chain: { id: 2, zone: 'sentinel', trace: 'ruins', site: { moonId: 3 }, expiresAt: '2099-01-01T00:00:00Z',
      garrison: [], sideEntrances: [{ trace: 'observatory', garrison }] } };
  assert.equal(prepareXenoDig(snapshot, entry, overview, { 12: 40, 29: 3 }, ships, null, 'careful').attachLeader, false);
});
