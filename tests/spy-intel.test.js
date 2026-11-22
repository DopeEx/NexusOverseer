import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowserStub, loadBackground } from './helpers.js';

test('processSpyReports reads espionage v2 intel and keeps legacy reports working', async () => {
  const store = makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  const bg = await loadBackground();
  const base = {
    outcome: 'success',
    targetPlanetName: 'GAS',
    buildingData: null,
    defenseData: null,
    fleetData: null,
    resourceData: null,
  };

  await bg.processSpyReports([
    {
      ...base,
      id: 3,
      createdAt: '2026-09-26T20:34:47.876Z',
      intel: {
        tier: 4,
        mode: 'quick',
        fleet: { ships: [
          { key: 'probe', quantity: 0, damagedQuantity: 4 },
          { key: 'battleship', quantity: 12, damagedQuantity: 22 },
        ] },
        buildings: [{ key: 'solar_plant', name: 'Solar Plant', level: 22 }],
        defenses: [{ key: 'shield_generator', name: 'Shield Generator', level: 7 }],
        resources: { ore: 0, hydrogen: 24, cryoIce: 5 },
      },
    },
    {
      ...base,
      id: 2,
      createdAt: '2026-09-25T15:28:00.000Z',
      intel: {
        tier: 2,
        fleet: { ships: [{ key: 'cruiser', quantityRange: { min: 10, max: 50 } }] },
        buildings: [{ key: 'ore_mine', name: 'Ore Mine', levelRange: { min: 15, max: 20 } }],
        defenses: null,
        resources: { ore: { min: 1000, max: 5000 } },
      },
    },
    {
      id: 1,
      createdAt: '2026-08-28T13:58:00.000Z',
      outcome: 'success',
      targetPlanetName: 'Old',
      buildingData: [{ key: 'ore_mine', name: 'Ore Mine', level: 19 }],
      defenseData: [{ key: 'ion_defense', name: 'Ion Defense System', level: 9 }],
      fleetData: [{ key: 'bulk_carrier', name: 'Bulk Carrier', quantity: 35, shipDefId: 24 }],
      resourceData: { ore: 435379, tier: 'exact' },
    },
  ]);

  const [v4, ranged, old] = store.spy_reports;
  assert.deepEqual(v4.fleet, [{ key: 'battleship', quantity: 12 }], 'damaged ships are not counted');
  assert.deepEqual(v4.buildings, [{ key: 'solar_plant', name: 'Solar Plant', level: 22 }]);
  assert.deepEqual(v4.defense, [{ key: 'shield_generator', name: 'Shield Generator', level: 7 }]);
  assert.deepEqual(v4.resources, { ore: 0, hydrogen: 24, cryo_ice: 5 });

  assert.deepEqual(ranged.fleet, [{ key: 'cruiser', quantity: 50 }]);
  assert.equal(ranged.buildings[0].level, 20);
  assert.equal(ranged.defense, null);
  assert.deepEqual(ranged.resources, { ore: 1000 });

  assert.deepEqual(old.fleet, [{ key: 'bulk_carrier', quantity: 35 }]);
  assert.equal(old.buildings[0].level, 19);
  assert.equal(old.defense[0].key, 'ion_defense');
  assert.equal(old.resources.ore, 435379);
});

test('mine, investigate and xeno-survey include hangarAssignments', async () => {
  makeBrowserStub();
  await import(`../nexus-addon/server-storage.js?spy-intel=${crypto.randomUUID()}`);
  await globalThis.nexusStorage.setActiveServer('s0');
  const requests = [];
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = async (_tabId, message) => {
    if (message.path === '/api/planets/1/fleet') {
      return { ok: true, data: { fleet: [{ shipDefId: 2, quantity: 1 }, { shipDefId: 16, quantity: 1 }] } };
    }
    if (message.path === '/api/fleet/missions') return { ok: true, data: { missions: [] } };
    requests.push(message);
    return { ok: true, data: { missionId: 1 } };
  };

  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const ships = [{ shipDefId: 1, quantity: 1 }];
  await listener({ type: 'SEND_MINE', sourcePlanetId: 1, targetFieldId: 2, ships, miningDuration: 60 });
  await listener({ type: 'SEND_INVESTIGATE', sourcePlanetId: 1, reportId: 2, ships });
  const result = await listener({ type: 'SEND_XENO_SURVEY', serverKey: 's0', sourcePlanetId: 1, targetMoonId: 2,
    ships: [{ shipDefId: 2, quantity: 1 }, { shipDefId: 16, quantity: 1 }] });

  assert.equal(result.ok, true);
  assert.deepEqual(requests.map(request => request.body.hangarAssignments), [{}, {}, {}]);
});
