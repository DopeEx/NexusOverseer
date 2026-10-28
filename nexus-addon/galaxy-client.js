import { systemCacheFresh } from './galaxy-cache.js';
export { asteroidMatches, visibleAsteroidFields, reconcileAsteroidRows } from './asteroid-search.js';

export async function loadGalaxyScans() {
  const scans = {};
  let page = { type: 'GET_GALAXY_SCANS' };
  while (page) {
    const response = await browser.runtime.sendMessage(page);
    if (response.error) throw new Error(response.error);
    Object.assign(scans, response.scans);
    page = response.next == null ? null : { type: 'GET_GALAXY_SCANS', snapshot: response.snapshot, offset: response.next };
  }
  return scans;
}

export async function getSystemPlanets(systemId, cache, { purpose = 'ownership', group = 'both', maxAge, force = false, priority = 'bulk', source = 'galaxy-cache' } = {}) {
  if (!force && systemCacheFresh(cache[systemId], purpose, maxAge, Date.now(), group)) return cache[systemId].data;
  const data = await browser.runtime.sendMessage({ type: 'GET_SYSTEM_PLANETS', systemId, purpose, group, maxAge, force, priority, source });
  if (data.error) {
    const error = new Error(data.error);
    error.status = data.status;
    error.code = data.code;
    error.groups = data.groups;
    throw error;
  }
  cache[systemId] = { data, at: Date.now() };
  return data;
}

export function asteroidRow(field, system, meta = system, observedAt = Date.now()) {
  return {
    fieldId: field.id, name: field.name || `#${field.id}`, systemId: system.id,
    system: meta.name || `#${system.id}`, type: field.fieldType || 'unknown',
    mult: field.richness ?? null, remaining: field.remainingResources ?? null,
    total: field.totalResources ?? null, zone: meta.securityZone || 'unknown',
    sx: system.x, sy: system.y, minerPresent: field.controllerName || null,
    ownerName: (field.outpostShieldMaxHp ?? 0) > 0 ? field.controllerName || null : null,
    observedAt,
  };
}

export function sameAsteroidSearch(a, b) {
  const normalize = config => [config.planetId, config.near ?? 10,
    config.multMin ?? null, config.qtyMin ?? null, config.leftMin ?? null,
    [...(config.types || [])].sort(), [...(config.zones || [])].sort()];
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// Missing rows only survive for a known own mission, never as usable targets.
export function retainMiningFields(current, previous, missionIds, observations, pending = false) {
  const rows = new Map(current.map(field => [field.fieldId, field]));
  for (const field of previous) {
    if (pending && !rows.has(field.fieldId) && !observations.has(field.systemId)) {
      rows.set(field.fieldId, field);
    }
    if (!missionIds.has(field.fieldId) || rows.has(field.fieldId)) continue;
    const observation = observations.get(field.systemId);
    const found = observation?.fields.find(row => row.fieldId === field.fieldId);
    rows.set(field.fieldId, found || {
      ...field, missing: !!observation, unconfirmed: !observation,
      mult: null, remaining: null, total: null, ownerName: null, minerPresent: null,
      observedAt: observation?.at ?? field.observedAt,
    });
  }
  return [...rows.values()];
}
