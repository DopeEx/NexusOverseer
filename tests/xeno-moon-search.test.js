import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignFromInFlightSurveys, findAvailableAncientMoon, xenoSearchSystems, xenoTargetExclusions } from '../nexus-addon/xeno-moon-search.js';

async function collectSystems(targets, zone, getSectorSystems, shouldContinue) {
  const found = [];
  for await (const target of xenoSearchSystems(targets, zone, getSectorSystems, shouldContinue)) found.push(target.s.id);
  return found;
}

test('Xeno zone filtering skips other zones before the 500-system limit and caches each sector', async () => {
  const targets = Array.from({ length: 1002 }, (_, index) =>
    ({ s: { id: index + 1, sectorId: index < 501 ? 1 : 2 }, d: index }));
  const calls = [];
  const getSector = async sectorId => {
    calls.push(sectorId);
    return { systems: targets.filter(target => target.s.sectorId === sectorId).map(target => ({
      id: target.s.id, securityZone: sectorId === 1 ? 'sentinel' : 'open',
    })) };
  };
  const found = await collectSystems(targets, 'open', getSector);
  assert.equal(found.length, 500);
  assert.equal(found[0], 502);
  assert.equal(found.at(-1), 1001);
  assert.deepEqual(calls, [1, 2]);
});

test('Xeno unrestricted search does not fetch sector zones and keeps the nearest 500', async () => {
  const targets = Array.from({ length: 501 }, (_, index) => ({ s: { id: index + 1 } }));
  const found = await collectSystems(targets, '', () => { throw new Error('Unexpected sector read'); });
  assert.equal(found.length, 500);
  assert.equal(found.at(-1), 500);
});

test('Xeno zone search reports unverifiable sectors instead of scanning unknown systems', async () => {
  const targets = [{ s: { id: 1, sectorId: 7 } }];
  for (const [response, expected] of [
    [{ error: 'Unavailable' }, /Could not check sector 7: Unavailable/],
    [{}, /invalid system list/],
    [{ systems: [] }, /no verified security zone/],
    [{ systems: [{ id: 1 }] }, /no verified security zone/],
  ]) {
    await assert.rejects(collectSystems(targets, 'dead', async () => response), expected);
  }
  await assert.rejects(collectSystems([{ s: { id: 1 } }], 'dead', async () => ({})), /no sector ID/);
});

test('Xeno zone search stops before scanning after an in-flight sector read', async () => {
  let running = true;
  const found = await collectSystems([{ s: { id: 1, sectorId: 7 } }], 'open', async () => {
    running = false;
    return { systems: [{ id: 1, securityZone: 'open' }] };
  }, () => running);
  assert.deepEqual(found, []);
});

test('Xeno exclusions cover whole credited and in-flight systems, not unrelated fleet targets', () => {
  const chain = { clues: [{ moonId: 11, systemId: 1 }, { moonId: 22, systemId: 2 }] };
  const missions = [
    { missionType: 'xeno_survey', targetMoonId: 33, targetSystemId: 3 },
    { missionType: 'xeno_survey', cargo: { _targetMoonId: 44 }, targetSystemId: 4 },
    { missionType: 'xeno_survey', cargo: { _xenoClue: { moonId: 45 } }, targetSystemId: 6 },
    { missionType: 'survey', targetMoonId: 55, targetSystemId: 5 },
  ];
  assert.deepEqual(xenoTargetExclusions(chain, missions), {
    moonIds: new Set([11, 22, 33, 44, 45]),
    systemIds: new Set([1, 2, 3, 4, 6]),
  });
  assert.deepEqual(xenoTargetExclusions(null, missions).systemIds, new Set([3, 4, 6]));
});

test('Xeno search skips targeted and globally cooling-down moons, including owned Ancient moons', async () => {
  const moons = [
    { id: 1, moonType: 'ancient', userId: 7 },
    { id: 2, moonType: 'ancient', userId: 8 },
    { id: 3, moonType: 'ancient', userId: 9 },
    { id: 4, moonType: 'normal' },
  ];
  const checked = [];
  const found = await findAvailableAncientMoon(moons, new Set([1]), async id => {
    checked.push(id);
    return { cooldownRemainingSeconds: id === 2 ? 80 : 0, trace: 'observatory', zone: 'sentinel' };
  });

  assert.equal(found, moons[2]);
  assert.deepEqual(checked, [2, 3]);
});

test('Xeno search does not select a moon when stopped during its cooldown lookup', async () => {
  let active = true;
  const found = await findAvailableAncientMoon(
    [{ id: 1, moonType: 'ancient' }],
    new Set(),
    async () => {
      active = false;
      return { cooldownRemainingSeconds: 0, trace: 'ruins' };
    },
    () => active,
  );
  assert.equal(found, null);
});

test('Xeno search matches a selected first trace without restricting the zone', async () => {
  const moons = [1, 2].map(id => ({ id, moonType: 'ancient' }));
  const details = [
    { cooldownRemainingSeconds: 0, trace: 'observatory', zone: 'sentinel' },
    { cooldownRemainingSeconds: 0, trace: 'ruins', zone: 'open' },
  ];
  const found = await findAvailableAncientMoon(moons, new Set(), async id => details[id - 1],
    undefined, { trace: 'ruins' });
  assert.equal(found, moons[1]);
});

test('Xeno search matches an active channel trace and zone', async () => {
  const moons = [1, 2, 3].map(id => ({ id, moonType: 'ancient' }));
  const details = {
    1: { cooldownRemainingSeconds: 0, trace: 'observatory', zone: 'sentinel' },
    2: { cooldownRemainingSeconds: 0, trace: 'ruins', zone: 'open' },
    3: { cooldownRemainingSeconds: 0, trace: 'ruins', zone: 'sentinel' },
  };
  const checked = [];
  const found = await findAvailableAncientMoon(moons, new Set(), async id => {
    checked.push(id);
    return details[id];
  }, undefined, { trace: 'ruins', zone: 'sentinel' });

  assert.equal(found, moons[2]);
  assert.deepEqual(checked, [1, 2, 3]);
});

test('Xeno search matches a selected first zone with automatic trace', async () => {
  const moons = [1, 2].map(id => ({ id, moonType: 'ancient' }));
  const found = await findAvailableAncientMoon(moons, new Set(), async id => ({
    cooldownRemainingSeconds: 0,
    trace: id === 1 ? 'ruins' : 'spire',
    zone: id === 1 ? 'sentinel' : 'open',
  }), undefined, { trace: '', zone: 'open' });
  assert.equal(found, moons[1]);
});

test('active Xeno missions provide a consistent campaign trace and zone when overview omits the chain', async () => {
  const missions = [
    { missionType: 'xeno_survey', cargo: { _targetMoonId: 31 } },
    { missionType: 'xeno_survey', cargo: { _targetMoonId: 32 } },
  ];
  const campaign = await campaignFromInFlightSurveys(missions, async moonId => ({
    trace: 'ruins', zone: 'sentinel', cooldownRemainingSeconds: moonId,
  }));
  assert.deepEqual(campaign, { trace: 'ruins', zone: 'sentinel' });
});

test('active Xeno surveys use clue cargo and top-level target moon fields', async () => {
  const missions = [
    { missionType: 'xeno_survey', targetMoonId: 31 },
    { missionType: 'xeno_survey', cargo: { _xenoClue: { moonId: 32 } } },
  ];
  const campaign = await campaignFromInFlightSurveys(missions, async () => ({
    trace: 'ruins', zone: 'sentinel',
  }));
  assert.deepEqual(campaign, { trace: 'ruins', zone: 'sentinel' });
});

test('active Xeno missions with conflicting traces cannot silently choose a campaign', async () => {
  const missions = [
    { missionType: 'xeno_survey', cargo: { _targetMoonId: 31 } },
    { missionType: 'xeno_survey', cargo: { _targetMoonId: 32 } },
  ];
  await assert.rejects(
    campaignFromInFlightSurveys(missions, async moonId => ({
      trace: moonId === 31 ? 'ruins' : 'spire', zone: 'sentinel',
    })),
    /different traces or zones/,
  );
});

test('Xeno search reports failed or malformed global cooldown checks', async t => {
  await t.test('server error', async () => {
    await assert.rejects(
      findAvailableAncientMoon([{ id: 1, moonType: 'ancient' }], new Set(), async () => ({ error: 'Request failed.' })),
      /Request failed/,
    );
  });
  await t.test('missing cooldown', async () => {
    await assert.rejects(
      findAvailableAncientMoon([{ id: 1, moonType: 'ancient' }], new Set(), async () => ({ ancient: true })),
      /invalid Xeno cooldown/,
    );
  });
});
