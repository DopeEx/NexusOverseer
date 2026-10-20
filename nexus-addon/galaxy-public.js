import { galaxyImagePath } from './galaxy-images.js';

export const PUBLIC_GROUPS = ['systems', 'stations', 'hubs', 'arms'];
export const PUBLIC_MAX_BYTES = 25 * 1024 * 1024;
const id = value => Number.isSafeInteger(value) && value > 0;
const number = value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const size = value => number(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const type = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value);
const position = value => Number.isSafeInteger(value) && value >= 0;
const schemas = {
  systems: { id, name: text, x: number, y: number, armId: id, sectorId: id,
    starType: type, securityZone: type },
  planets: { id, planetType: type, size, temperature: number, position },
  moons: { id, planetId: id, moonType: type, size, position },
  stations: { stationId: id, stationName: text, systemId: id, systemName: text, systemX: number, systemY: number },
  hubs: { id, systemId: id, name: text, systemX: number, systemY: number },
  arms: { id, name: text, sectorCount: position },
};

export function emptyPublicGalaxy(serverKey) {
  return { schemaVersion: 1, serverKey, systems: [], stations: [], hubs: [], arms: [] };
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validatePublicManifest(manifest) {
  if (!object(manifest) || manifest.schemaVersion !== 1 || !object(manifest.servers)) {
    throw new Error('Invalid public galaxy manifest.');
  }
  for (const [server, entry] of Object.entries(manifest.servers)) {
    if (!/^[a-z0-9-]{1,63}$/.test(server) || !object(entry) ||
        entry.file !== `${server}.json` || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Invalid public galaxy manifest entry.');
    }
  }
  return manifest;
}

export function validatePublicGalaxy(data, serverKey = data?.serverKey) {
  if (!object(data) || data.schemaVersion !== 1 || data.serverKey !== serverKey ||
      typeof serverKey !== 'string' || !/^[a-z0-9-]{1,63}$/.test(serverKey) ||
      Object.keys(data).some(key => !['schemaVersion', 'serverKey', ...PUBLIC_GROUPS].includes(key))) {
    throw new Error('Invalid public galaxy format or universe.');
  }
  const bodyIds = { planets: new Set(), moons: new Set() };
  const validate = (items, group) => {
    if (!Array.isArray(items) || items.length > 200000) throw new Error(`Invalid public ${group} list.`);
    const ids = new Set();
    for (const item of items) {
      const key = group === 'stations' ? 'stationId' : 'id';
      if (!object(item) || !id(item[key]) || ids.has(item[key])) throw new Error(`Invalid or duplicate public ${group} ID.`);
      ids.add(item[key]);
      if (bodyIds[group]) {
        if (bodyIds[group].has(item[key])) throw new Error(`Public ${group} ID belongs to multiple systems.`);
        bodyIds[group].add(item[key]);
      }
      for (const [field, value] of Object.entries(item)) {
        if (group === 'systems' && ['planets', 'moons'].includes(field)) validate(value, field);
        else if (!schemas[group][field] || !Object.hasOwn(schemas[group], field) || !schemas[group][field](value)) {
          throw new Error(`Forbidden or invalid public ${group} field: ${field}`);
        }
      }
      if (group === 'moons' && !id(item.planetId)) throw new Error('Public moon is missing its parent planet.');
      if (group === 'stations' && ['systemId', 'stationName', 'systemName', 'systemX', 'systemY']
        .some(field => !Object.hasOwn(item, field))) throw new Error('Public station is missing its location or name.');
    }
  };
  for (const group of PUBLIC_GROUPS) validate(data[group], group);
  return data;
}

function pick(item, group) {
  return Object.fromEntries(Object.entries(schemas[group])
    .filter(([key, valid]) => valid(item[key])).map(([key]) => [key, item[key]]));
}

// Only explicitly approved fields ever leave local storage; backups are not public exports.
export function publicGalaxyFromRows(serverKey, rows) {
  const result = emptyPublicGalaxy(serverKey);
  const systems = new Map();
  const addSystem = system => systems.set(system.id, { ...systems.get(system.id), ...pick(system, 'systems') });
  const relevant = rows.filter(row => row.serverKey === serverKey);
  for (const row of relevant) {
    if (row.key === 'public:galaxy') {
      const merged = mergePublicGalaxies(result, row.data).data;
      Object.assign(result, merged);
      for (const system of result.systems) systems.set(system.id, system);
    }
  }
  for (const row of relevant.filter(row => row.key !== 'public:galaxy').sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const data = row.data;
    if (Array.isArray(data.systems)) for (const system of data.systems) addSystem(system);
    if (row.key.startsWith('system:')) {
      const systemId = Number(row.key.slice(7));
      if (!systems.has(systemId)) systems.set(systemId, { id: systemId });
      const system = systems.get(systemId);
      for (const group of ['planets', 'moons']) {
        if (!data._galaxyCache?.times?.[group]) continue;
        const prior = new Map((system[group] || []).map(body => [body.id, body]));
        system[group] = data[group].map(body => ({ ...prior.get(body.id), ...pick(group === 'moons'
          ? { ...body, planetId: body.planetId ?? body.parentPlanetId } : body, group) }));
      }
    }
    for (const group of ['stations', 'hubs', 'arms']) {
      if (!Array.isArray(data[group])) continue;
      const key = group === 'stations' ? 'stationId' : 'id';
      const merged = new Map(result[group].map(item => [item[key], item]));
      for (const item of data[group]) {
        const clean = pick(item, group);
        if (id(clean[key])) merged.set(clean[key], { ...merged.get(clean[key]), ...clean });
      }
      result[group] = [...merged.values()];
    }
  }
  result.systems = [...systems.values()];
  return sortPublicGalaxy(validatePublicGalaxy(result));
}

export function sortPublicGalaxy(data) {
  const sorted = structuredClone(data);
  for (const group of PUBLIC_GROUPS) {
    const key = group === 'stations' ? 'stationId' : 'id';
    sorted[group].sort((a, b) => a[key] - b[key]);
  }
  for (const system of sorted.systems) for (const group of ['planets', 'moons']) system[group]?.sort((a, b) => a.id - b.id);
  return sorted;
}

export function mergePublicGalaxies(existing, incoming) {
  validatePublicGalaxy(existing);
  validatePublicGalaxy(incoming, existing.serverKey);
  const conflicts = [];
  let added = 0, filled = 0;
  const mergeList = (left, right, group, path) => {
    const key = group === 'stations' ? 'stationId' : 'id';
    const items = new Map(left.map(item => [item[key], structuredClone(item)]));
    for (const item of right) {
      if (!items.has(item[key])) { items.set(item[key], structuredClone(item)); added++; continue; }
      const target = items.get(item[key]);
      for (const [field, value] of Object.entries(item)) {
        if (group === 'systems' && ['planets', 'moons'].includes(field) && target[field]) {
          target[field] = mergeList(target[field], value, field, `${path}/${item[key]}/${field}`);
        } else if (!Object.hasOwn(target, field)) { target[field] = structuredClone(value); filled++; }
        else if (target[field] !== value) conflicts.push(`${path}/${item[key]}/${field}: ${JSON.stringify(target[field])} != ${JSON.stringify(value)}`);
      }
    }
    return [...items.values()];
  };
  const data = emptyPublicGalaxy(existing.serverKey);
  for (const group of PUBLIC_GROUPS) data[group] = mergeList(existing[group], incoming[group], group, group);
  return { data: sortPublicGalaxy(validatePublicGalaxy(data)), added, filled, conflicts };
}

export function overlayPublicSystem(entry, system) {
  if (!system) return entry;
  const data = structuredClone(entry?.data || { visibility: 'unknown' });
  const meta = data._galaxyCache ||= { times: {}, ownership: {} };
  meta.publicGroups = [];
  for (const group of ['planets', 'moons']) {
    if (!system[group]) continue;
    const observed = data[group];
    const source = new Map(system[group].map(item => [item.id, item]));
    data[group] = observed
      ? observed.map(item => fillPublicFields(source.get(item.id), item))
      : system[group].map(item => ({ ...item, ownershipKnown: false }));
    data[group] = data[group].map(item => {
      const path = galaxyImagePath(group, item);
      return path ? { ...item, imagePath: path } : item;
    });
    if (group === 'planets' ? data[group].every(item => type(item.planetType) && Number.isFinite(item.size))
      : data[group].every(item => type(item.moonType))) meta.publicGroups.push(group);
  }
  meta.publicSource = true;
  return { ...entry, at: entry?.at || 0, data };
}

function fillPublicFields(base, observed) {
  const result = { ...base };
  for (const [key, value] of Object.entries(observed)) {
    if (value != null || result[key] == null) result[key] = value;
  }
  return result;
}

export function overlayPublicCatalog(data, path, shared) {
  if (!shared) return data;
  let group;
  if (path === '/api/galaxy/map' || /\/sectors\/\d+\/systems$/.test(path)) group = 'systems';
  else if (path === '/api/galaxy/arms') group = 'arms';
  else if (path === '/api/galaxy/station-index') group = 'stations';
  else if (path === '/api/market/hubs') group = 'hubs';
  else return data;
  const key = group === 'stations' ? 'stationId' : 'id';
  let source = shared[group];
  if (/\/sectors\/(\d+)\/systems$/.test(path)) {
    const sectorId = Number(/\/sectors\/(\d+)/.exec(path)[1]);
    source = source.filter(system => system.sectorId === sectorId);
  }
  const publicItem = item => {
    const clean = { ...item, _publicSource: true };
    delete clean.planets;
    delete clean.moons;
    if (group === 'systems') clean.visibility = 'unknown';
    return clean;
  };
  const items = new Map(source.map(item => [item[key], publicItem(item)]));
  for (const item of data[group] || []) {
    items.set(item[key], fillPublicFields(items.get(item[key]), item));
  }
  return { ...data, [group]: [...items.values()] };
}
