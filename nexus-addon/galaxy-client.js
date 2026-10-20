import { systemCacheFresh } from './galaxy-cache.js';

export async function loadGalaxyScans() {
  const response = await browser.runtime.sendMessage({ type: 'GET_GALAXY_SCANS' });
  if (response.error) throw new Error(response.error);
  return response.scans;
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
