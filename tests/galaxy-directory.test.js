import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGalaxyDirectory, directoryOwner, moonsByPlanet, planetSlots, queryGalaxyDirectory, systemBodyRows } from '../nexus-addon/galaxy-directory.js';

test('planet slots prefer explicit capacity and otherwise calculate base slots with gas giant reduction', () => {
  assert.equal(planetSlots({ size: 229, planetType: 'terra' }), 22);
  assert.equal(planetSlots({ size: 299, planetType: 'gas_giant' }), 8);
  assert.equal(planetSlots({ size: 299, planetType: 'Gas Giant' }), 8);
  assert.equal(planetSlots({ size: 299, planetType: 'gas_giant', buildingSlots: 15 }), 15);
  assert.equal(planetSlots({ maxBuildingSlots: 0, buildingSlots: 15 }), 0);
  assert.equal(planetSlots({ maxBuildingSlots: 30, buildingSlots: 15 }), 30);
  for (const planet of [{}, { size: null }, { size: -10, planetType: 'terra' }, { size: '200', planetType: 'terra' }]) {
    assert.equal(planetSlots(planet), null);
  }
  assert.equal(buildGalaxyDirectory(fixture(), 'planets')[0].slots, 22);
});

test('overview groups moons below each planet by saved position and retains unknown parents', () => {
  const data = {
    planets: [{ id: 2, position: 4 }, { id: 1, position: 1 }],
    moons: [
      { id: 12, planetId: 1, position: 2 },
      { id: 21, parentPlanetId: 2, position: 1 },
      { id: 11, planetId: 1, position: 1 },
      { id: 13, planetId: 1 },
      { id: 99, planetId: 9, position: 1 },
    ],
  };
  const rows = systemBodyRows(data);
  assert.deepEqual(rows.map(row => row.item.id), [1, 11, 12, 13, 2, 21, 99]);
  assert.equal(rows[1].parent, 1);
  assert.equal(rows.at(-1).parent, 9);
  assert.equal(rows[3].item.position, undefined);
  assert.deepEqual(data.planets.map(planet => planet.id), [2, 1]);
  assert.deepEqual(systemBodyRows({}), []);
});

test('moon indexing supports both parent fields, retains ordering and reads each parent only once', () => {
  let reads = 0;
  const moons = Array.from({ length: 2000 }, (_, index) => ({
    id: index,
    get parentPlanetId() { reads++; return index % 100; },
  }));
  const grouped = moonsByPlanet(moons);
  assert.equal(reads, moons.length);
  assert.equal(grouped.size, 100);
  assert.deepEqual(grouped.get(3).map(moon => moon.id), moons.filter(moon => moon.id % 100 === 3).map(moon => moon.id));
  assert.deepEqual([...moonsByPlanet([{ id: 1, planetId: 4 }, { id: 2, parentPlanetId: 4 }, { id: 3 }]).entries()],
    [[4, [{ id: 1, planetId: 4 }, { id: 2, parentPlanetId: 4 }]], [undefined, [{ id: 3 }]]]);
  assert.equal(moonsByPlanet().size, 0);
  assert.equal(moonsByPlanet(null).size, 0);
});

test('planet lists and overview group large moon arrays in linear parent lookups', () => {
  let reads = 0;
  const data = {
    planets: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
    moons: Array.from({ length: 2000 }, (_, index) => ({
      id: index + 101,
      get planetId() { reads++; return index % 100 + 1; },
    })),
  };
  const rows = buildGalaxyDirectory({
    systems: [{ id: 1 }], scans: { 1: { data } }, hits: [], scope: 'all',
  }, 'planets');
  assert.equal(rows.length, 100);
  assert.ok(rows.every(row => row.moons === 20));
  assert.equal(reads, data.moons.length, 'not one full moon-array scan per planet');
  reads = 0;
  assert.equal(systemBodyRows(data).length, 2100);
  assert.equal(reads, 2 * data.moons.length, 'one grouping pass and one orphan-parent pass');
});

function fixture() {
  return {
    systems: [
      { id: 1, name: 'Alpha', x: 3, y: 4, securityZone: 'open', starType: 'orange' },
      { id: 2, name: 'Beta', x: 0, y: 0, securityZone: 'dead' },
      { id: 3, name: 'Fog', securityZone: 'sentinel' },
    ],
    scans: {
      1: { data: {
        planets: [
          { id: 11, name: 'Terra A', planetType: 'terra', size: 220, userId: null },
          { id: 12, name: 'Terra B', planetType: 'terra', size: 240, userId: 5 },
          { id: 13, name: 'Other', planetType: 'ice', size: 180 },
        ],
        moons: [
          { id: 111, planetId: 11, buildingSlots: 6, userId: null },
          { id: 112, planetId: 11, buildingSlots: 5, userId: null },
          { id: 113, planetId: 11, buildingSlots: 8, userId: 5 },
          { id: 114, planetId: 11, buildingSlots: 8 },
          { id: 121, parentPlanetId: 12, buildingSlots: 7, userId: null },
          { id: 131, planetId: 13, buildingSlots: 9, userId: null },
        ],
        asteroidFields: [],
      } },
      2: { data: { planets: [], moons: [] } },
      4: { data: { planets: [{ id: 41, size: 100 }], moons: [] } },
    },
    hits: [{ planetId: 11, systemId: 1, minMoonSlots: 6 }, { planetId: 12, systemId: 1, minMoonSlots: 6 }],
    scope: 'matches', origin: { x: 0, y: 0 },
  };
}

test('one search projects into unique systems, matching planets and only qualifying free moons', () => {
  const state = fixture();
  const systems = buildGalaxyDirectory(state, 'systems');
  assert.equal(systems.length, 1);
  assert.equal(systems[0].matches, 2);
  assert.equal(systems[0].distance, 5);
  assert.equal(systems[0].starType, 'orange');
  assert.deepEqual(buildGalaxyDirectory(state, 'planets').map(row => row.id), [11, 12]);
  assert.deepEqual(buildGalaxyDirectory(state, 'moons').map(row => row.id), [111, 121]);
  state.hits = [{ planetId: 11, systemId: 1, minMoonSlots: 0 }];
  assert.deepEqual(buildGalaxyDirectory(state, 'moons').map(row => row.id), [111, 112, 113, 114]);
});

test('all known scope includes fog and imported systems and distinguishes unknown from empty sections', () => {
  const state = { ...fixture(), scope: 'all' };
  const systems = buildGalaxyDirectory(state, 'systems');
  assert.equal(systems.length, 4);
  assert.equal(systems.find(row => row.systemId === 2).planets, 0);
  assert.equal(systems.find(row => row.systemId === 3).planets, null);
  assert.equal(systems.find(row => row.systemId === 4).name, '#4');
  assert.equal(buildGalaxyDirectory(state, 'planets').length, 4);
  assert.equal(buildGalaxyDirectory(state, 'moons').length, 6);
});

test('unknown ownership is distinct from unowned, including imported unresolved statuses', () => {
  assert.equal(directoryOwner({}), 'unknown');
  assert.equal(directoryOwner({ userId: null, ownershipKnown: false }), 'unknown');
  assert.equal(directoryOwner({ userId: null }), 'unowned');
  assert.equal(directoryOwner({ userId: 5 }), 'Player #5');
  assert.equal(directoryOwner({ userId: 5, ownerName: 'Owner' }), 'Owner');
});

test('directory queries filter locally, sort numerically, page at 50 and keep unknown distances last', () => {
  const rows = Array.from({ length: 121 }, (_, index) => ({
    id: index + 1, name: `Planet ${index}`, distance: index === 120 ? null : index, owner: index % 2 ? 'Pilot' : 'unowned',
  }));
  const first = queryGalaxyDirectory(rows, { direction: -1 });
  assert.equal(first.rows.length, 50);
  assert.equal(first.rows[0].distance, 119);
  assert.equal(first.pages, 3);
  const last = queryGalaxyDirectory(rows, { direction: -1, page: 500 });
  assert.equal(last.page, 2);
  assert.equal(last.rows.at(-1).distance, null);
  assert.equal(queryGalaxyDirectory(rows, { text: 'PILOT' }).total, 60);
  assert.equal(queryGalaxyDirectory(rows, { text: 'no matches', page: 5 }).page, 0);
  assert.equal(rows[0].id, 1);
});

test('zone filtering supports several zones, intersects text filters and resets out-of-range pages', () => {
  const rows = buildGalaxyDirectory({ ...fixture(), scope: 'all' }, 'systems');
  assert.equal(queryGalaxyDirectory(rows, { zones: ['open'] }).total, 1);
  assert.equal(queryGalaxyDirectory(rows, { zones: ['open', 'dead'] }).total, 2);
  assert.equal(queryGalaxyDirectory(rows, { zones: ['unknown'] }).rows[0].systemId, 4);
  assert.equal(queryGalaxyDirectory(rows, { zones: ['open'], text: 'Beta' }).total, 0);
  assert.equal(queryGalaxyDirectory(rows, { zones: [], page: 99 }).total, 4);
  assert.equal(queryGalaxyDirectory(rows, { zones: ['open'], page: 99 }).page, 0);
});

test('system filters use star type, region, counts and recorded contents, never infer ownership', () => {
  const state = { ...fixture(), scope: 'all' };
  Object.assign(state.systems[0], { armId: 2, sectorId: 66 });
  Object.assign(state.systems[2], { armId: 1, sectorId: 3, planetCount: 5 });
  const rows = buildGalaxyDirectory(state, 'systems');
  assert.equal(queryGalaxyDirectory(rows, {
    types: ['orange'], arm: '2', sector: '16', ranges: { planetCount: { min: '3' }, moons: { min: '6' } },
  }).rows[0].systemId, 1);
  assert.equal(queryGalaxyDirectory(rows, { types: ['unknown'] }).total, 3);
  assert.deepEqual(queryGalaxyDirectory(rows, { contents: 'missing' }).rows.map(row => row.systemId), [3]);
  assert.equal(queryGalaxyDirectory(rows, { contents: 'recorded' }).total, 3);
  assert.equal(queryGalaxyDirectory(rows, { ranges: { planetCount: { min: '5' } } }).rows[0].systemId, 3);
  assert.equal(queryGalaxyDirectory(rows, { ranges: { moons: { max: '0' } } }).total, 2);
  assert.equal(rows.some(row => Object.hasOwn(row, 'ownerStatus')), false);
});

test('sector field accepts one sector or an inclusive range in every directory, independently of arm', () => {
  const state = { ...fixture(), scope: 'all' };
  Object.assign(state.systems[0], { armId: 2, sectorId: 66 });
  Object.assign(state.systems[1], { armId: 1, sectorId: 17 });
  state.scans[2].data = { planets: [{ id: 21 }], moons: [{ id: 211, planetId: 21 }] };
  for (const view of ['systems', 'planets', 'moons']) {
    const rows = buildGalaxyDirectory(state, view);
    const systemIds = filters => [...new Set(queryGalaxyDirectory(rows, filters).rows.map(row => row.systemId))].sort((a, b) => a - b);
    assert.deepEqual(systemIds({ sector: '16' }), [1]);
    for (const sector of ['16-17', '17-16', ' 16 - 17 ', '16–17', '16—17']) {
      assert.deepEqual(systemIds({ sector }), [1, 2]);
    }
    assert.deepEqual(systemIds({ sector: '16-17', arm: '1' }), [2]);
    assert.equal(queryGalaxyDirectory(rows, { sector: '  ' }).total, rows.length);
    for (const sector of ['0', '-1', '1.5', '1-', '1-2-3', 'abc', '1e2', '9007199254740992']) {
      const result = queryGalaxyDirectory(rows, { sector });
      assert.match(result.error, /Enter a sector or sector range/);
      assert.deepEqual(result.rows, []);
    }
  }
});

test('planet filters intersect types, ownership, ranges and any matching moon type', () => {
  const state = { ...fixture(), scope: 'all' };
  state.scans[1].data.moons[0].moonType = 'metallic';
  state.scans[1].data.moons[1].moonType = 'icy';
  state.scans[1].data.planets[1].ownerAllianceTag = 'EX';
  state.scans[1].data.planets[1].ownerName = 'Pilot';
  const rows = buildGalaxyDirectory(state, 'planets');
  const ids = filters => queryGalaxyDirectory(rows, filters).rows.map(row => row.id);
  assert.deepEqual(ids({ types: ['terra', 'ice'], ranges: { size: { min: '220' }, slots: { max: '22' } } }), [11]);
  assert.deepEqual(ids({ ownership: 'free', ranges: { moons: { min: '3' } } }), [11]);
  assert.deepEqual(ids({ ownership: 'colonized', text: 'PIL' }), [12]);
  assert.deepEqual(ids({ ownership: 'colonized', text: 'ex' }), [12]);
  assert.deepEqual(ids({ ownership: 'unknown' }), [13, 41]);
  assert.deepEqual(ids({ moonTypes: ['icy', 'ancient'] }), [11]);
  assert.deepEqual(ids({ moonTypes: ['ancient'] }), []);
  assert.deepEqual(ids({ minFreeMoonSlots: '6' }), [11, 12, 13]);
  assert.deepEqual(ids({ minFreeMoonSlots: '8' }), [13]);
  assert.deepEqual(ids({ minFreeMoonSlots: '0', ranges: { moons: { max: '0' } } }), []);
  assert.deepEqual(ids({ text: 'unknown', ownership: 'colonized' }), []);
});

test('moon filters use own type and slots, parent type, owner and distance without treating unknown as zero', () => {
  const state = { ...fixture(), scope: 'all' };
  Object.assign(state.scans[1].data.moons[0], { moonType: 'metallic', ownerAllianceTag: null });
  Object.assign(state.scans[1].data.moons[2], { moonType: 'icy', ownerName: 'Pilot', ownerAllianceTag: 'EX' });
  state.scans[4].data.moons.push({ id: 411, planetId: 999, moonType: 'metallic' });
  const rows = buildGalaxyDirectory(state, 'moons');
  assert.equal(queryGalaxyDirectory(rows, {
    types: ['metallic', 'icy'], parentTypes: ['terra'], ownership: 'free',
    ranges: { distance: { min: '5', max: '5' }, slots: { min: '6', max: '6' } },
  }).rows[0].id, 111);
  assert.equal(queryGalaxyDirectory(rows, { parentTypes: ['ice'] }).rows[0].id, 131);
  assert.equal(queryGalaxyDirectory(rows, { text: 'pilot' }).rows[0].id, 113);
  assert.equal(queryGalaxyDirectory(rows, { text: 'ex' }).rows[0].id, 113);
  assert.equal(queryGalaxyDirectory(rows, { ownership: 'unknown' }).total, 2);
  assert.equal(queryGalaxyDirectory(rows, { ranges: { slots: { max: '0' } } }).total, 0);
  assert.equal(queryGalaxyDirectory(rows, { ranges: { distance: { min: '0' } } }).total, 6);
});

test('invalid numeric filters report errors and never return success-shaped unfiltered results', () => {
  const rows = buildGalaxyDirectory({ ...fixture(), scope: 'all' }, 'planets');
  for (const filters of [
    { ranges: { size: { min: '-1' } } }, { ranges: { size: { min: 'abc' } } },
    { ranges: { slots: { min: '1.5' } } }, { ranges: { moons: { min: '4', max: '3' } } },
    { minFreeMoonSlots: '-1' }, { minFreeMoonSlots: 'bad' },
  ]) {
    const result = queryGalaxyDirectory(rows, filters);
    assert.ok(result.error);
    assert.equal(result.total, 0);
    assert.deepEqual(result.rows, []);
  }
});
