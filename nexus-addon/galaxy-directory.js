export const hasKnownOwnership = body => body.ownershipKnown !== false && Object.hasOwn(body, 'userId');

export function directoryOwner(body) {
  if (!hasKnownOwnership(body)) return 'unknown';
  return body.userId == null ? 'unowned' : body.ownerName || `Player #${body.userId}`;
}

export function directoryOwnership(body) {
  return !hasKnownOwnership(body) ? 'unknown' : body.userId == null ? 'free' : 'colonized';
}

export function planetSlots(planet) {
  for (const value of [planet.maxBuildingSlots, planet.buildingSlots]) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  if (!Number.isFinite(planet.size) || planet.size <= 0 || typeof planet.planetType !== 'string') return null;
  const base = Math.floor(planet.size / 10);
  return planet.planetType.toLowerCase().replace(/ /g, '_') === 'gas_giant' ? Math.floor(base * 0.3) : base;
}

export function matchesSearchMoon(moon, { moonTypes = [], minMoonSlots = 0 }) {
  return (!moonTypes.length || moonTypes.includes(moon.moonType)) &&
    (!(minMoonSlots > 0) || Number.isFinite(moon.buildingSlots) && moon.buildingSlots >= minMoonSlots);
}

export function moonsByPlanet(moons = []) {
  const groups = new Map();
  for (const moon of moons || []) {
    const parent = moon.planetId ?? moon.parentPlanetId;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(moon);
  }
  return groups;
}

export function systemBodyRows(data) {
  const byPosition = (a, b) => {
    if (a.position == null || b.position == null) return a.position == null ? (b.position == null ? a.id - b.id : 1) : -1;
    return a.position - b.position || a.id - b.id;
  };
  const planets = [...(data.planets || [])].sort(byPosition);
  const moons = [...(data.moons || [])].sort(byPosition);
  const children = moonsByPlanet(moons);
  const planetIds = new Set(planets.map(planet => planet.id));
  const rows = [];
  for (const planet of planets) {
    rows.push({ group: 'planets', item: planet });
    for (const moon of children.get(planet.id) || []) {
      rows.push({ group: 'moons', item: moon, parent: planet.id });
    }
  }
  for (const moon of moons) {
    const parent = moon.planetId ?? moon.parentPlanetId;
    if (!planetIds.has(parent)) rows.push({ group: 'moons', item: moon, parent });
  }
  return rows;
}

export function buildGalaxyDirectory({ systems, scans, hits, scope, origin }, view) {
  const matching = scope === 'matches';
  const hitsByPlanet = new Map(hits.map(hit => [hit.planetId, hit]));
  const matchedSystems = new Set(hits.map(hit => hit.systemId));
  const matchCounts = new Map();
  for (const hit of hits) matchCounts.set(hit.systemId, (matchCounts.get(hit.systemId) || 0) + 1);
  const catalog = new Map(systems.map(system => [system.id, system]));
  for (const id of Object.keys(scans)) {
    if (!catalog.has(Number(id))) catalog.set(Number(id), { id: Number(id) });
  }
  const rows = [];
  for (const system of catalog.values()) {
    if (matching && !matchedSystems.has(system.id)) continue;
    const data = scans[system.id]?.data || {};
    const planets = data.planets || [];
    const moons = data.moons || [];
    const systemName = system.name || `#${system.id}`;
    const common = {
      systemId: system.id, system: systemName, zone: system.securityZone || 'unknown',
      armId: system.armId, sector: system.armId != null && system.sectorId != null
        ? system.sectorId - (system.armId - 1) * 50 : null,
      distance: origin && system.x != null && system.y != null
        ? Math.round(Math.hypot(system.x - origin.x, system.y - origin.y)) : null,
    };
    if (view === 'systems') {
      rows.push({
        ...common, name: systemName, starType: system.starType,
        planets: Array.isArray(data.planets) ? planets.length : null,
        moons: Array.isArray(data.moons) ? moons.length : null,
        asteroids: Array.isArray(data.asteroidFields) ? data.asteroidFields.length : null,
        planetCount: Array.isArray(data.planets) ? planets.length : system.planetCount,
        contents: ['planets', 'moons', 'asteroidFields'].some(group => Array.isArray(data[group])) ? 'recorded' : 'missing',
        matches: matchCounts.get(system.id) || 0,
        coverage: ['planets', 'moons', 'asteroidFields'].map(group =>
          `${group}: ${Array.isArray(data[group]) ? data[group].length : 'unknown'}`).join(' · '),
      });
      continue;
    }
    if (view === 'planets') {
      const moonsByParent = moonsByPlanet(moons);
      for (const planet of planets) {
        if (matching && !hitsByPlanet.has(planet.id)) continue;
        const children = moonsByParent.get(planet.id) || [];
        rows.push({
          ...common, id: planet.id, name: planet.name || `Planet #${planet.id}`,
          type: planet.planetType, size: planet.size, slots: planetSlots(planet),
          moons: Array.isArray(data.moons) ? children.length : null,
          moonTypes: [...new Set(children.map(moon => moon.moonType).filter(Boolean))],
          freeMoonSlots: children.filter(moon => hasKnownOwnership(moon) && moon.userId === null &&
            Number.isFinite(moon.buildingSlots)).map(moon => moon.buildingSlots),
          owner: directoryOwner(planet), ownerStatus: directoryOwnership(planet), alliance: planet.ownerAllianceTag,
          imagePath: planet.imagePath,
          ownershipAt: data._galaxyCache?.ownership?.planets || 0,
        });
      }
      continue;
    }
    const planetsById = new Map(planets.map(planet => [planet.id, planet]));
    for (const moon of moons) {
      const parentId = moon.planetId ?? moon.parentPlanetId;
      const hit = hitsByPlanet.get(parentId);
      if (matching && (!hit || !matchesSearchMoon(moon, hit) || (hit.minMoonSlots > 0 &&
          !(hasKnownOwnership(moon) && moon.userId === null)))) continue;
      const planet = planetsById.get(parentId);
      rows.push({
        ...common, id: moon.id, name: moon.name || `Moon #${moon.id}`,
        planet: planet?.name || `Planet #${parentId}`, parentType: planet?.planetType, type: moon.moonType,
        slots: moon.buildingSlots, size: moon.size, owner: directoryOwner(moon), ownerStatus: directoryOwnership(moon),
        imagePath: moon.imagePath, alliance: moon.ownerAllianceTag,
        ownershipAt: data._galaxyCache?.ownership?.moons || 0,
      });
    }
  }
  return rows;
}

export const DIRECTORY_RANGES = {
  systems: [['distance', 'distance'], ['planetCount', 'planets'], ['moons', 'moons']],
  planets: [['distance', 'distance'], ['size', 'size'], ['slots', 'slots'], ['moons', 'moons']],
  moons: [['distance', 'distance'], ['slots', 'slots'], ['size', 'size']],
};

export function parseSectorRange(raw) {
  const match = raw.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/) || raw.trim().match(/^(\d+)$/);
  if (!match) return null;
  const from = Number(match[1]), to = Number(match[2] ?? match[1]);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export function queryGalaxyDirectory(rows, {
  text = '', zones = [], types = [], arm = '', sector = '', ranges = {}, ownership = '',
  contents = '', moonTypes = [], parentTypes = [],
  minFreeMoonSlots = '', invalidNumbers = [], sort = 'distance', direction = 1, page = 0, pageSize = 50,
}) {
  const bounds = [];
  const empty = error => ({ rows: [], total: 0, page: 0, pages: 1, error });
  if (invalidNumbers.length) return empty('Filter ranges require non-negative whole numbers.');
  if (sector.trim()) {
    const region = parseSectorRange(sector);
    if (!region || ![region.from, region.to].every(value => Number.isSafeInteger(value) && value >= 1)) {
      return empty('Enter a sector or sector range, e.g. 35 or 33-35.');
    }
    bounds.push({ key: 'sector', min: region.from, max: region.to });
  }
  const number = value => value === '' || value == null ? null : Number(value);
  for (const [key, range] of Object.entries(ranges)) {
    const min = number(range.min), max = number(range.max);
    if ([min, max].some(value => value != null && (!Number.isSafeInteger(value) || value < 0))) {
      return empty('Filter ranges require non-negative whole numbers.');
    }
    if (min != null && max != null && min > max) return empty('A filter minimum cannot exceed its maximum.');
    if (min != null || max != null) bounds.push({ key, min, max });
  }
  const moonSlots = number(minFreeMoonSlots);
  if (moonSlots != null && (!Number.isSafeInteger(moonSlots) || moonSlots < 0)) {
    return empty('Min moon slots requires a non-negative whole number.');
  }
  const needle = text.trim().toLowerCase();
  const selectedZones = new Set(zones);
  const filtered = rows.filter(row => (!selectedZones.size || selectedZones.has(row.zone)) &&
    (!types.length || types.includes(row.type ?? row.starType ?? 'unknown')) &&
    (!arm || row.armId != null && String(row.armId) === arm) &&
    bounds.every(({ key, min, max }) => Number.isFinite(row[key]) &&
      (min == null || row[key] >= min) && (max == null || row[key] <= max)) &&
    (!ownership || row.ownerStatus === ownership) &&
    (!contents || row.contents === contents) &&
    (!moonTypes.length || row.moonTypes?.some(type => moonTypes.includes(type))) &&
    (!parentTypes.length || parentTypes.includes(row.parentType)) &&
    (moonSlots == null || row.freeMoonSlots?.some(slots => slots >= moonSlots)) &&
    (!needle || Object.values(row).some(value =>
      value != null && String(value).toLowerCase().includes(needle))));
  filtered.sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    const compared = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return compared * direction || (a.id ?? a.systemId) - (b.id ?? b.systemId);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { rows: filtered.slice(current * pageSize, (current + 1) * pageSize), total: filtered.length, page: current, pages };
}
