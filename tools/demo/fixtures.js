import { publicGalaxyFromRows } from '../../nexus-addon/galaxy-public.js';

export const DEMO_NOW = Date.parse('2030-04-12T12:00:00Z');
const at = minutes => new Date(DEMO_NOW + minutes * 60000).toISOString();
const zones = ['sentinel', 'open', 'dead'];

// Synthetic examples; the dense galaxy's appearance is inspired by a supplied
// screenshot, not extracted account data or reconstructed game coordinates.
export function createDemoData() {
  const ships = [
    ['scout', 'Scout', 'recon', 100, 25, 15, 'kinetic'],
    ['fighter', 'Fighter', 'combat', 250, 60, 30, 'laser'],
    ['interceptor', 'Interceptor', 'combat', 200, 50, 35, 'kinetic'],
    ['torpedo_frigate', 'Torpedo Frigate', 'combat', 180, 40, 55, 'missile'],
    ['cruiser', 'Cruiser', 'combat', 700, 200, 65, 'laser'],
    ['carrier', 'Carrier', 'combat', 1800, 600, 30, 'laser'],
    ['battleship', 'Battleship', 'combat', 1500, 500, 90, 'plasma'],
    ['bomber', 'Bomber', 'combat', 650, 150, 120, 'missile'],
    ['dreadnought', 'Dreadnought', 'combat', 30000, 9000, 1000, 'ion'],
    ['freighter', 'Freighter', 'utility', 50, 12, 0, null],
    ['miner', 'Mining Vessel', 'utility', 200, 75, 5, 'kinetic'],
    ['gas_collector', 'Gas Collector', 'utility', 250, 60, 0, null],
    ['ice_drill', 'Ice Drill', 'utility', 300, 75, 5, 'kinetic'],
    ['excavator', 'Excavator', 'utility', 400, 100, 5, 'kinetic'],
    ['spy_probe', 'Spy Probe', 'recon', 30, 8, 0, null],
    ['colony_ship', 'Colony Ship', 'special', 200, 50, 0, null],
  ].map(([key, name, shipClass, hp, shieldHp, attack, weaponType], i) => ({
    id: i + 1, shipDefId: i + 1, key, reportKey: key, name, shipClass,
    hp, shieldHp, attack, weaponType, armorType: 'light', shipSize: 'medium',
    sortOrder: i, isNpc: false, miningCargo: shipClass === 'utility' ? 500 : 0,
    cargoCapacity: 1500, fuelRate: 1, speed: 100,
    costOre: (i + 1) * 200, costSilicates: (i + 1) * 100,
    costHydrogen: i * 25, costAlloys: i * 30,
    imageUrl: '/icons/icon128.png',
  }));
  const systems = Array.from({ length: 6000 }, (_, i) => {
    const arm = i % 3;
    const fraction = (0.62 + i * 0.61803398875) % 1;
    const radius = 1000 * Math.sqrt(0.08 ** 2 + (1 - 0.08 ** 2) * fraction);
    const spread = Math.sin(i * 127.1 + 3.7) * Math.sin(i * 311.7 + 1.3);
    const angle = arm * Math.PI * 2 / 3 + radius / 280 + spread * (2.6 - radius / 1500);
    const outer = radius > 810;
    return {
      id: i + 1, name: `DEMO-A${1 + i % 3}-${String(i + 1).padStart(3, '0')}`,
      x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius),
      armId: arm + 1, sectorId: arm * 50 + 1 + Math.floor(fraction * 12),
      securityZone: outer ? null : radius < 265 ? 'dead' : radius < 515 ? 'open' : 'sentinel',
      visibility: outer ? 'outline' : 'full', planetCount: outer ? null : 4,
      starType: ['yellow', 'orange', 'red_dwarf', 'blue_giant', 'white_dwarf', 'neutron'][i % 6],
    };
  });
  const planets = ['Aurora', 'Meridian', 'Horizon'].map((name, i) => {
    const s = systems[i * 12];
    return {
      id: i + 1, name, systemId: s.id, systemName: s.name,
      systemX: s.x, systemY: s.y, isHomeworld: i === 0,
      planetType: ['terra', 'rocky', 'crystalline'][i], hasLab: true,
      buildSlots: { used: 16 + i * 3, max: 40 }, queueMax: 3,
      population: 18000 + i * 6500, maxPopulation: 60000, populationRate: 480,
      resources: {
        ore: 180000 + i * 85000, silicates: 125000 + i * 42000,
        hydrogen: 64000 + i * 18000, alloys: 23000 + i * 8000,
        oreRate: 8400 + i * 1200, silicatesRate: 4600 + i * 600,
        hydrogenRate: 2100 + i * 400, alloysRate: 720 + i * 100,
        oreStorage: 800000, silicatesStorage: 600000,
        hydrogenStorage: 300000, alloysStorage: 150000,
        cryoIce: 2400 + i * 600, quantumDust: 320 + i * 120,
        plasmaCore: 1800 + i * 400, darkMatter: 140 + i * 40,
      },
      construction: i === 2 ? [] : [
        { name: 'Ore Mine', level: 17 + i, endsAt: at(48 + i * 20) },
        { name: 'Solar Plant', level: 15 + i },
      ],
      shipYards: [{
        label: 'Shipyard', max: 3, exists: true,
        items: [{ name: 'Cruiser', quantity: 12 + i * 6, endsAt: at(72 + i * 10) }],
      }],
      fleet: { total: 440 + i * 120, classes: { combat: 180 + i * 60, utility: 220 + i * 40, recon: 40 + i * 20 } },
      damaged: [],
    };
  });
  const research = [
    ['weapons', 'Weapons Technology', 'military', 6, 1],
    ['shields', 'Shield Technology', 'military', 4, 3],
    ['armor', 'Armor Technology', 'military', 3, 5],
    ['laser', 'Laser Technology', 'military', 2, 7],
    ['energy', 'Energy Technology', 'science', 8, 1],
    ['drive', 'Combustion Drive', 'science', 5, 3],
    ['impulse', 'Impulse Drive', 'science', 2, 5],
    ['hyperspace', 'Hyperspace Drive', 'science', 0, 7],
    ['mining', 'Mining Technology', 'economy', 7, 1],
    ['storage', 'Storage Technology', 'economy', 5, 3],
    ['logistics', 'Logistics Technology', 'economy', 3, 5],
    ['automation', 'Industrial Automation', 'economy', 0, 7],
  ].map(([key, name, branch, level, requiredLabLevel], i, all) => ({
    id: i + 1, key, name, branch, level, requiredLabLevel, maxLevel: 10,
    status: key === 'shields' ? 'researching' : 'available', eraUnlocked: true,
    description: 'Fictional research example for the screenshot demo.',
    costOre: 1000 + i * 300, costSilicates: 800 + i * 200,
    costHydrogen: 200, costAlloys: 100, costFactor: 1.6,
    researchTime: 600, nextResearchTime: 1800, timeFactor: 1.5,
    requirements: i % 4 ? [{ type: 'research', key: all[i - 1][0], level: 2 + i % 4 }] : [],
  }));
  const activeResearch = [{ key: 'shields', name: 'Shield Technology', level: 5, planetId: 1, endsAt: at(95) }];
  const missions = [
    ['survey', 40, 18], ['mine', 120, 35], ['transport', 30, 54],
  ].map(([type, count, eta], i) => ({
    id: i + 1, type, missionType: type, ships: count,
    sourcePlanetId: 1, sourcePlanetName: 'Aurora',
    targetSystemId: systems[i + 3].id, targetSystemName: systems[i + 3].name,
    departedAt: at(-15), arrivesAt: at(eta), returnDepartsAt: at(eta + 10),
    returnArrivesAt: at(eta * 2 + 25), status: 'outbound',
    fleet: [{ shipDefId: 1, quantity: count }],
  }));
  const hubs = Array.from({ length: 6 }, (_, i) => {
    const angle = i * Math.PI / 3 + 0.3;
    return {
      id: i + 1, name: i === 0 ? 'Demo Central Exchange' : i === 1 ? 'Demo Frontier Exchange' : `Demo Hub ${i + 1}`,
      systemX: Math.round(Math.cos(angle) * 730), systemY: Math.round(Math.sin(angle) * 730),
    };
  });
  const orders = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, hubId: 1 + i % 2, userId: 9100 + i,
    username: ['Demo Nova', 'Demo Vega', 'Demo Orion', 'Demo Lyra'][i % 4],
    offerResource: ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice'][i % 5],
    requestResource: i % 5 === 0 ? 'silicates' : 'ore',
    offerAmount: 15000 + i * 4000, offerRemaining: 15000 + i * 4000,
    requestAmount: 12000 + i * 3200,
  }));
  const trades = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, sellerId: i % 2 ? 9000 : 9100,
    buyerId: i % 2 ? 9100 : 9000, hubId: 1 + i % 2,
    resourceSold: 'silicates', resourcePaid: 'ore',
    amountSold: 12000 + i * 2000, amountPaid: 14000 + i * 2000,
    commissionBuyer: 120, commissionSeller: 140, createdAt: at(-180 - i * 1440),
  }));
  const camps = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, name: ['Demo Corsair Anchorage', 'Demo Crimson Outpost', 'Demo Rogue Bastion', 'Demo Shadow Haven', 'Demo Raider Station'][i],
    systemId: systems[i + 4].id, systemName: systems[i + 4].name,
    securityZone: systems[i + 4].securityZone, tier: 1 + i, lootTier: ['Common', 'Uncommon', 'Rare'][i % 3],
    currentHpPercent: 100, hasFleetIntel: i < 3,
    lastScoutedAt: i < 3 ? at(-25 - i * 10) : null,
    fleetIntel: i < 3 ? [{ name: 'Pirate Fighter', key: 'pirate_fighter', quantity: 20 + i * 15 }] : [],
  }));
  const reports = (scale, source) => Array.from({ length: 28 }, (_, i) => ({
    id: `${source}-${i}`, created_at: at(-i * 1440 - 60),
    zone: zones[i % 3], ore: (4500 + (i * 3571) % 16000) * scale,
    silicates: (2200 + (i * 1877) % 8000) * scale,
    hydrogen: (900 + (i * 733) % 3500) * scale,
    alloys: (400 + i * 21) * scale, cryo_ice: (100 + i * 7) * scale,
    quantum_dust: (20 + i * 3) * scale, plasma_core: (80 + i * 11) * scale,
    dark_matter: (10 + i) * scale,
  }));
  const sum = list => list.reduce((out, r) => {
    for (const [key, value] of Object.entries(r)) {
      if (typeof value === 'number') out[key] = (out[key] || 0) + value;
    }
    return out;
  }, {});
  const survey = reports(1, 'survey');
  const pirate = reports(0.7, 'pirate');
  const mining = reports(1.8, 'mining');
  const expedition = reports(0.4, 'expedition').map(r => ({ ...r, kind: 'expedition', loot: { ...r } }));
  const fields = Array.from({ length: 12 }, (_, i) => ({
    fieldId: i + 1, name: `Demo Field ${String(i + 1).padStart(2, '0')}`,
    system: systems[i + 2].name, systemId: i + 3,
    type: ['ore', 'gas', 'ice', 'plasma', 'quantum', 'dark'][i % 6],
    mult: [1.2, 1.8, 2.4, 1.5][i % 4], remaining: 85000 - i * 4300,
    total: 100000, zone: systems[i + 2].securityZone, sx: systems[i + 2].x, sy: systems[i + 2].y,
    minerPresent: i === 1 ? 'Demo Explorer' : null, ownerName: null,
  }));
  const storage = {
    nexus_settings: { 'general.numberFormat': 'en' },
    records_cap: 5000, last_scrape: at(-2), last_backup: at(-1440),
    totals: { ...sum(survey), missions: survey.length },
    pirate_totals: { ...sum(pirate), raids: pirate.length },
    mining_totals: { ...sum(mining), deliveries: mining.length },
    expedition_totals: { ...sum(expedition), missions: expedition.length },
    exp_totals: { missions: expedition.length },
    recent_reports: survey, pirate_recent_reports: pirate, mining_recent_reports: mining,
    exp_recent_reports: expedition, research, active_research: activeResearch,
    ships: Object.fromEntries(ships.map(s => [s.id, s])),
    fleet_templates: [
      { id: 1, name: 'Demo - Balanced Mining', ships: { 11: 80, 12: 40, 13: 30, 14: 1 } },
      { id: 2, name: 'Demo - Patrol Escort', ships: { 2: 60, 3: 40, 5: 20 }, escortZones: ['open'] },
      { id: 3, name: 'Demo - Survey Wing', ships: { 1: 40 } },
    ],
    tt_queue_targets: [{ key: 'impulse', level: 4 }, { key: 'logistics', level: 5 }],
    asteroid_scan_results: {
      at: DEMO_NOW, planetId: 1, near: 25, types: [], zones: [],
      referenceSystem: { x: planets[0].systemX, y: planets[0].systemY }, fields,
    },
    spy_reports: [{
      id: 1, target_name: 'Demo Frontier', target_user: 'Demo Rival',
      target_system_id: 5, target_system_name: systems[4].name, created_at: at(-30),
      fleet: [{ key: 'fighter', quantity: 60 }, { key: 'cruiser', quantity: 12 }],
      buildings: [{ key: 'laser_defense', level: 3 }],
      resources: { ore: 180000, silicates: 90000, hydrogen: 45000 },
    }],
  };
  const responses = {
    GET_UNIVERSES: [{ key: 'demo', name: 'Demo Universe (fictional)' }],
    GET_AUTH_ME: { user: { id: 9000, username: 'Demo Explorer' }, planets },
    GET_PLANETS: { planets },
    GET_SHIP_DEFS: { ships },
    GET_FLEET: { fleet: { scout: 40, fighter: 120, interceptor: 60, cruiser: 30, freighter: 20, miner: 80 } },
    GET_PLANET_SHIPS: {
      ships: ships.map(s => ({ ...s, quantity: 250 })),
      available: Object.fromEntries(ships.map(s => [s.id, 250])),
    },
    GET_GALAXY_MAP: { systems },
    GET_ARMS: { arms: [1, 2, 3].map(id => ({ id, name: `Demo Arm ${id}`, sectorCount: 12 })) },
    GET_ALLIANCE: { name: 'Demo Explorers', tag: 'DEMO', memberIds: [9000, 9100] },
    GET_HUBS: { hubs },
    GET_STATION_INDEX: { stations: [17, 34, 51, 68, 85, 102].map((id, index) => {
      const system = systems.find(system => system.id === id);
      return { stationId: index + 1, stationName: `Demo Station ${index + 1}`,
        systemId: id, systemName: system.name, systemX: system.x, systemY: system.y,
        ownedByViewerAlliance: index === 0, ownerAllianceId: index === 0 ? 1 : null,
        ownerAllianceName: index === 0 ? 'Demo Explorers' : null, ownerAllianceTag: index === 0 ? 'DEMO' : null,
        capturingAllianceTag: index === 1 ? 'DEMO' : null };
    }) },
    GET_MARKET_ORDERS: { orders },
    GET_ALLIANCE_ORDERS: { orders: orders.slice(0, 4) },
    GET_MARKET_TRADES: { trades },
    GET_PIRATE_CAMPS: { camps },
    GET_PIRATE_REPORTS: { reports: camps.slice(0, 2).map((c, i) => ({
      id: i + 1, campId: c.id, createdAt: at(-180 - i * 120),
      outcome: 'attacker_won', rounds: [{}, {}, {}],
      attackerFleet: [{ name: 'Cruiser', quantity: 30 }],
      pirateFleet: [{ name: 'Pirate Fighter', quantity: 20 }],
      attackerLosses: [], pirateLosses: [{ name: 'Pirate Fighter', lost: 20 }],
      loot: { ore: 18000, silicates: 9000, hydrogen: 4500 }, debris: { ore: 1200 },
    })) },
    GET_MISSIONS: { missions, maxFleetSlots: 12 },
    GET_SURVEY_REPORTS: { reports: [] },
    GET_SURVEY_COOLDOWNS: { cooldowns: [] },
    REFRESH_DEBRIS: { fields: [] },
    GET_DASHBOARD_OVERVIEW: {
      fetchedAt: at(-2), planets, moons: [], missions, research: activeResearch,
      maxFleetSlots: 12, slots: { colonies: 5, moons: 3 },
    },
    GET_RESOURCES: {
      ...planets[0].resources, labLevel: 8, planetSpeeds: [0.8, 1, 1.2],
      researchPlanets: planets.map((p, i) => ({ id: p.id, name: p.name, mult: 0.8 + i * 0.2 })),
    },
    SIM_BOOTSTRAP: {
      playerShips: ships, npcShips: [{
        id: 100, key: 'pirate_fighter', name: 'Pirate Fighter', isNpc: true,
        hp: 180, shieldHp: 30, attack: 20, weaponType: 'laser',
      }],
      pirateShipIds: [100], pirateZones: zones,
      planetaryDefense: ['Missile Defense', 'Laser Defense', 'Railgun Defense', 'Plasma Defense'].map(name => ({
        key: name.toLowerCase().replaceAll(' ', '_'), name,
      })),
      ownProfile: { bonusesAvailable: true, leadership: { available: false } },
    },
  };
  const data = { storage, responses, systems, planets, fields };
  for (const systemId of [17, 34, 51, 68, 85, 102, 19, 38, 57]) {
    demoResponse(data, { type: 'GET_SYSTEM_PLANETS', systemId });
  }
  return data;
}

export function demoResponse(data, message) {
  if (['GET_PUBLIC_GALAXY_STATUS', 'UPDATE_PUBLIC_GALAXY'].includes(message.type)) {
    return { message: 'Fictional demo: no external downloads or uploads.', installed: null };
  }
  if (message.type === 'EXPORT_PUBLIC_GALAXY') {
    const rows = [{ serverKey: 'demo', key: '/api/galaxy/map', data: { systems: data.systems } },
      { serverKey: 'demo', key: '/api/galaxy/station-index', data: data.responses.GET_STATION_INDEX },
      { serverKey: 'demo', key: '/api/market/hubs', data: data.responses.GET_HUBS },
      { serverKey: 'demo', key: '/api/galaxy/arms', data: data.responses.GET_ARMS },
      ...Object.entries(data.storage.planet_scan_cache || {}).map(([id, entry]) =>
        ({ serverKey: 'demo', key: `system:${id}`, data: entry.data }))];
    return { data: publicGalaxyFromRows('demo', rows) };
  }
  if (message.type === 'GET_GALAXY_DELTAS') return { deltas: [] };
  if (message.type === 'GET_GALAXY_SCANS') return { scans: structuredClone(data.storage.planet_scan_cache || {}) };
  if (message.type === 'CLEAR_GALAXY_CACHE') {
    delete data.storage.planet_scan_cache;
    return { ok: true };
  }
  if (Object.hasOwn(data.responses, message.type)) return structuredClone(data.responses[message.type]);
  if (message.type === 'GET_FUEL_ESTIMATE') {
    const source = data.planets.find(p => p.id === message.body?.sourcePlanetId);
    const target = data.systems.find(s => s.id === message.body?.targetSystemId);
    if (!source || !target) return { error: 'Unknown demo route.' };
    const distance = Math.hypot(source.systemX - target.x, source.systemY - target.y);
    const count = (message.body.ships || []).reduce((n, s) => n + s.quantity, 0);
    return { fuelCost: Math.ceil(count * distance / 100), distance, travelTime: 1200, inRange: true };
  }
  if (message.type === 'GET_SECTOR_SYSTEMS') {
    return { systems: data.systems.filter(s => s.sectorId === message.sectorId) };
  }
  if (message.type === 'GET_SYSTEM_PLANETS') {
    const s = data.systems.find(s => s.id === message.systemId);
    if (!s) return { error: 'Unknown demo system.' };
    const response = {
      moons: Array.from({ length: 1 + (s.id + 2) % 3 }, (_, index) => ({
        id: 10000 + s.id * 10 + index, systemId: s.id, planetId: 1000 + s.id,
        name: `Demo Moon ${s.id}-${index + 1}`, moonType: ['metallic', 'icy', 'barren'][index],
        size: 30 + index * 10, buildingSlots: 4 + (s.id + index) % 6,
        userId: index === 2 ? 9100 + s.id : null,
        ownerName: index === 2 ? `Demo Pilot ${s.id}` : null,
      })),
      planets: [{
        id: 1000 + s.id, name: `Demo Colony ${s.id}`, systemId: s.id,
        userId: s.id % 17 === 0 ? 9100 : s.id % 3 ? null : 9100 + s.id,
        ownerName: s.id % 17 === 0 ? 'Demo Ally' : s.id % 3 ? null : `Demo Pilot ${s.id}`,
        ownerAllianceTag: s.id % 17 === 0 ? 'DEMO' : null,
        planetType: ['terra', 'ice', 'crystalline', 'volcanic'][s.id % 4],
        size: 180 + s.id % 120, temperature: -30 + s.id % 90,
        isColonizable: s.id % 3 !== 0, position: 2,
      }],
      asteroidFields: data.fields.filter(f => f.systemId === s.id).map(f => ({
        id: f.fieldId, name: f.name, fieldType: f.type, richness: f.mult,
        remainingResources: f.remaining, totalResources: f.total,
      })),
      _galaxyCache: {
        times: { planets: DEMO_NOW, moons: DEMO_NOW, asteroidFields: DEMO_NOW },
        ownership: { planets: DEMO_NOW, moons: DEMO_NOW },
      },
    };
    data.storage.planet_scan_cache ||= {};
    data.storage.planet_scan_cache[s.id] = { data: structuredClone(response), at: DEMO_NOW };
    return response;
  }
  if (message.type === 'GET_SYSTEM_COORDS') {
    return Object.fromEntries(data.systems
      .filter(s => message.ids?.includes(s.id) || message.names?.includes(s.name))
      .map(s => [message.ids ? s.id : s.name, s]));
  }
  if (message.type === 'GET_PLAYER_ALLIANCE_TAG') return { tag: 'DEMO' };
  if (message.type === 'GET_PLAYER_RANK') return { rank: 42 };
  return { error: `Demo mode: ${message.type || 'unknown action'} is not available. No game request was sent.` };
}
