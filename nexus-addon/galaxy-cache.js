import { galaxyImagePath } from './galaxy-images.js';
import { validatePublicGalaxy, publicGalaxyFromRows, overlayPublicSystem, overlayPublicCatalog } from './galaxy-public.js';

export const OWNERSHIP_TTL = 60 * 60 * 1000;
export const DYNAMIC_TTL = 15 * 60 * 1000;
export const MAP_TTL = 15 * 60 * 1000;

let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('nexus-galaxy', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('entries', { keyPath: ['serverKey', 'key'] });
      store.createIndex('server', 'serverKey');
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => {
      connection = undefined;
      reject(new Error('Galaxy database is blocked. Close older addon tabs and retry.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
  });
  return connection;
}

function validateServer(serverKey) {
  if (typeof serverKey !== 'string' || !/^[a-z0-9-]{1,63}$/.test(serverKey)) throw new Error('Invalid galaxy server.');
}

async function transaction(serverKey, mode, work) {
  validateServer(serverKey);
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Galaxy database transaction aborted.'));
    tx.onerror = () => reject(tx.error || new Error('Galaxy database transaction failed.'));
    try { work(tx.objectStore('entries'), value => { result = value; }, error => { tx.abort(); reject(error); }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function readRow(serverKey, key) {
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.get([serverKey, key]);
    request.onsuccess = () => done(request.result);
  });
}

function readServerRows(serverKey) {
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.index('server').getAll(serverKey);
    request.onsuccess = () => done(request.result);
  });
}

function systemKey(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid galaxy system id.');
  return `system:${id}`;
}

const statusField = key => key === 'name' || key === 'userId' || key.startsWith('owner') ||
  key === 'colonizedAt' || key === 'isHomeworld' || key === 'isColonizable';

function resolved(data, group) {
  if (!Array.isArray(data[group])) return false;
  if (data._galaxyCache?.times?.[group]) return true;
  if (data.visibility === 'fog') return false;
  const inclusionKey = group === 'asteroidFields' ? 'fields' : group;
  if (Array.isArray(data.included)) return data.included.includes(inclusionKey) || data.included.includes(group);
  if (data.included && typeof data.included === 'object') {
    return data.included[Object.hasOwn(data.included, inclusionKey) ? inclusionKey : group] === true;
  }
  return true;
}

function mergeSystem(previous, data, at) {
  if (!data || typeof data !== 'object' || data.error ||
      !['planets', 'moons', 'asteroidFields'].some(group => Array.isArray(data[group]))) {
    throw new Error('Invalid galaxy system response.');
  }
  const row = structuredClone(previous || { base: {}, status: {}, times: {}, extra: {} });
  for (const group of ['planets', 'moons']) {
    const groupAt = Math.min(at, data._galaxyCache?.times?.[group] ?? at);
    if (!Number.isFinite(groupAt) || groupAt <= 0) throw new Error('Invalid galaxy section time.');
    if (!resolved(data, group) || groupAt < (row.times[group] || 0)) continue;
    const priorBase = new Map((row.base[group] || []).map(item => [item.id, item]));
    const priorStatus = new Map((row.status[group] || []).map(item => [item.id, item]));
    const base = [], status = [];
    for (const item of data[group]) {
      if (!Number.isSafeInteger(item?.id) || item.id <= 0) throw new Error(`Invalid galaxy ${group} id.`);
      const properties = {
        ...priorBase.get(item.id),
        ...Object.fromEntries(Object.entries(item).filter(([key]) => !statusField(key) && key !== 'ownershipKnown')),
      };
      const imagePath = galaxyImagePath(group, properties);
      if (imagePath) properties.imagePath = imagePath;
      base.push(properties);
      const known = Object.hasOwn(item, 'userId') && item.ownershipKnown !== false;
      const statusAt = Math.min(groupAt, data._galaxyCache?.ownership?.[group] ?? groupAt);
      if (!Number.isFinite(statusAt) || statusAt < 0) throw new Error('Invalid galaxy ownership time.');
      const state = known ? { id: item.id, at: statusAt } : { ...priorStatus.get(item.id), id: item.id };
      for (const [key, value] of Object.entries(item)) {
        if (statusField(key)) state[key] = value;
      }
      // An abandoned colony must not inherit its former owner's metadata.
      if (known && item.userId == null) {
        for (const key of Object.keys(state)) {
          if (key.startsWith('owner') || key === 'colonizedAt') state[key] = null;
        }
        state.isHomeworld = false;
      }
      status.push(state);
    }
    row.base[group] = base;
    row.status[group] = status;
    row.times[group] = groupAt;
  }
  const fieldsAt = Math.min(at, data._galaxyCache?.times?.asteroidFields ?? at);
  if (!Number.isFinite(fieldsAt) || fieldsAt <= 0) throw new Error('Invalid galaxy field time.');
  if (resolved(data, 'asteroidFields') && fieldsAt >= (row.times.asteroidFields || 0)) {
    row.extra.asteroidFields = data.asteroidFields;
    row.times.asteroidFields = fieldsAt;
  }
  if (at >= (row.at || 0)) {
    for (const [key, value] of Object.entries(data)) {
      if (!['planets', 'moons', 'asteroidFields', '_galaxyCache'].includes(key)) row.extra[key] = value;
    }
    row.at = at;
  }
  return row;
}

function unpack(row) {
  if (!row) return null;
  const data = { ...row.extra };
  const ownership = {};
  for (const group of ['planets', 'moons']) {
    if (!row.base[group]) continue;
    const statuses = new Map((row.status[group] || []).map(item => [item.id, item]));
    data[group] = row.base[group].map(item => {
      const { at, ...status } = statuses.get(item.id) || {};
      return { ...item, ...status, ownershipKnown: !!at };
    });
    ownership[group] = row.base[group].length
      ? Math.min(...row.base[group].map(item => statuses.get(item.id)?.at || 0))
      : row.times[group];
  }
  data._galaxyCache = { times: row.times, ownership };
  return { data, at: row.at, baseAt: row.times.planets || 0 };
}

function requestedGroups(purpose, group) {
  return purpose === 'dynamic' ? ['asteroidFields'] : group === 'both' ? ['planets', 'moons'] : [group];
}

export function systemCacheFresh(entry, purpose = 'ownership', maxAge, now = Date.now(), group = 'both') {
  const meta = entry?.data?._galaxyCache;
  if (!meta) return false;
  return requestedGroups(purpose, group).every(group => {
    if (purpose === 'static') return !!meta.times[group] || !!meta.publicGroups?.includes(group);
    if (!meta.times[group]) return false;
    const at = purpose === 'dynamic' ? meta.times[group] : meta.ownership[group];
    return at > 0 && now - at < (maxAge ?? (purpose === 'dynamic' ? DYNAMIC_TTL : OWNERSHIP_TTL));
  });
}

export async function saveSystem(serverKey, systemId, data, at = Date.now()) {
  const key = systemKey(systemId);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60000) throw new Error('Invalid galaxy observation time.');
  return transaction(serverKey, 'readwrite', (store, done, fail) => {
    const request = store.get([serverKey, key]);
    request.onsuccess = () => {
      try {
        const row = { ...mergeSystem(request.result, data, at), serverKey, key };
        if (Object.keys(row.times).length) store.put(row);
        done(unpack(row));
      } catch (error) {
        fail(error);
      }
    };
  });
}

export function readSystem(serverKey, systemId) {
  const key = systemKey(systemId);
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.get([serverKey, key]);
    const shared = store.get([serverKey, 'public:galaxy']);
    shared.onsuccess = () => done(overlayPublicSystem(unpack(request.result),
      shared.result?.data.systems.find(system => system.id === systemId)));
  });
}

export async function readScans(serverKey) {
  const rows = await readServerRows(serverKey);
  const shared = rows.find(row => row.key === 'public:galaxy')?.data;
  const scans = Object.fromEntries(rows.filter(row => row.key.startsWith('system:'))
    .map(row => [row.key.slice(7), unpack(row)]));
  for (const system of shared?.systems || []) {
    if (system.planets || system.moons) scans[system.id] = overlayPublicSystem(scans[system.id], system);
  }
  return scans;
}

export async function readPublicGalaxy(serverKey) {
  return await readRow(serverKey, 'public:galaxy') || null;
}

export function savePublicGalaxy(serverKey, data, sha256) {
  validatePublicGalaxy(data, serverKey);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid public galaxy checksum.');
  return transaction(serverKey, 'readwrite', store => {
    store.put({ serverKey, key: 'public:galaxy', at: Date.now(), sha256, data });
  });
}

export async function exportPublicGalaxy(serverKey) {
  const rows = await readServerRows(serverKey);
  return publicGalaxyFromRows(serverKey, rows.map(exportRow));
}

async function applyPublicCatalog(serverKey, path, data) {
  const shared = await readPublicGalaxy(serverKey);
  return overlayPublicCatalog(data, path, shared?.data);
}

export async function readSavedCatalog(serverKey, path) {
  if (!catalogPath(path)) throw new Error('Invalid saved galaxy catalog path.');
  const cached = await readRow(serverKey, path);
  return applyPublicCatalog(serverKey, path,
    await applyGalaxyDeltas(serverKey, cached ? catalogData(cached) : { [catalogGroup(path)]: [] }, cached?.at || 0));
}

export function clearGalaxyCache(serverKey) {
  return transaction(serverKey, 'readwrite', store => {
    const request = store.index('server').openKeyCursor(serverKey);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
    };
  });
}

export function catalogPath(path) {
  return path === '/api/market/hubs' ||
    /^\/api\/galaxy\/(?:map|station-index|arms|arms\/\d+\/sectors|sectors\/\d+\/systems)$/.test(path);
}

function catalogGroup(path) {
  return path.endsWith('/hubs') ? 'hubs' : path.endsWith('/station-index') ? 'stations'
    : path.endsWith('/map') || path.endsWith('/systems') ? 'systems' : path.endsWith('/sectors') ? 'sectors' : 'arms';
}

function validateStations(data, at) {
  if (!Array.isArray(data?.stations)) throw new Error('Invalid station index response.');
  const ids = new Set();
  for (const station of data.stations) {
    if (!Number.isSafeInteger(station?.stationId) || station.stationId <= 0 || ids.has(station.stationId) ||
      !Number.isSafeInteger(station.systemId) || station.systemId <= 0 ||
      !Number.isFinite(station.systemX) || !Number.isFinite(station.systemY) ||
      typeof station.stationName !== 'string' || typeof station.systemName !== 'string' ||
      typeof station.ownedByViewerAlliance !== 'boolean' ||
      !['ownerAllianceName', 'ownerAllianceTag', 'capturingAllianceTag'].every(key =>
        station[key] === null || typeof station[key] === 'string') ||
      !(station.ownerAllianceId === null || Number.isSafeInteger(station.ownerAllianceId) && station.ownerAllianceId > 0)) {
      throw new Error('Invalid station index entry.');
    }
    ids.add(station.stationId);
    if (station._observedAt !== undefined &&
      (!Number.isFinite(station._observedAt) || station._observedAt <= 0 || station._observedAt > at)) {
      throw new Error('Invalid station observation time.');
    }
  }
}

function stationCatalogRow(serverKey, path, data, at, previous) {
  const known = new Map((previous ? catalogData(previous).stations : [])
    .map(station => [station.stationId, station]));
  for (const station of data.stations) known.set(station.stationId,
    { ...station, _observedAt: station._observedAt ?? at });
  const stations = [...known.values()];
  return {
    serverKey, key: path, at,
    base: stations.map(({ stationId, stationName, systemId, systemName, systemX, systemY }) =>
      ({ stationId, stationName, systemId, systemName, systemX, systemY })),
    status: stations.map(({ stationId, ownedByViewerAlliance, ownerAllianceId, ownerAllianceName,
      ownerAllianceTag, capturingAllianceTag, _observedAt }) =>
      ({ stationId, ownedByViewerAlliance, ownerAllianceId, ownerAllianceName, ownerAllianceTag,
        capturingAllianceTag, _observedAt })),
  };
}

function catalogData(row) {
  if (row.key !== '/api/galaxy/station-index' || !row.base) return row.data;
  const statuses = new Map(row.status.map(station => [station.stationId, station]));
  return { stations: row.base.map(station => ({ ...station, ...statuses.get(station.stationId) })) };
}

export function saveCatalog(serverKey, path, data, at = Date.now()) {
  if (!catalogPath(path)) throw new Error('Invalid galaxy catalog path.');
  const group = catalogGroup(path);
  if (!Array.isArray(data?.[group])) throw new Error('Invalid galaxy catalog response.');
  if (group === 'stations') validateStations(data, at);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60000) throw new Error('Invalid galaxy observation time.');
  return transaction(serverKey, 'readwrite', store => {
    const request = store.get([serverKey, path]);
    request.onsuccess = () => {
      if (!request.result || at >= request.result.at) store.put(group === 'stations'
        ? stationCatalogRow(serverKey, path, data, at, request.result) : { serverKey, key: path, data, at });
    };
  });
}

function validateDelta(data, at) {
  if (data?.type !== 'colonized' || data.hasColonies !== true) throw new Error('Unsupported galaxy delta.');
  systemKey(data.systemId);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60000) throw new Error('Invalid galaxy delta time.');
}

export function saveGalaxyDelta(serverKey, data, at = Date.now()) {
  validateDelta(data, at);
  return transaction(serverKey, 'readwrite', (store, done) => {
    const key = `delta:${data.systemId}`;
    const request = store.get([serverKey, key]);
    request.onsuccess = () => {
      if (!request.result || at > request.result.at) {
        store.put({ serverKey, key, at, data: { type: 'colonized', systemId: data.systemId, hasColonies: true } });
        done({ ok: true, changed: true });
      } else {
        done({ ok: true, changed: false });
      }
    };
  });
}

export function readGalaxyDeltas(serverKey) {
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.getAll(IDBKeyRange.bound([serverKey, 'delta:'], [serverKey, 'delta:\uffff']));
    request.onsuccess = () => done(request.result.map(row => ({ ...row.data, at: row.at })));
  });
}

async function canRefreshSystem(serverKey, systemId) {
  const entry = await readSystem(serverKey, systemId);
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.getAll(IDBKeyRange.bound([serverKey, '/api/galaxy/'], [serverKey, '/api/galaxy/\uffff']));
    request.onsuccess = () => {
      let visibility = entry?.data.visibility;
      let at = entry?.at || 0;
      for (const catalog of request.result) {
        const system = catalog.data?.systems?.find(system => system.id === systemId);
        if (system?.visibility && catalog.at >= at) {
          visibility = system.visibility;
          at = catalog.at;
        }
      }
      done(visibility === 'full');
    };
  });
}

async function applyGalaxyDeltas(serverKey, data, catalogAt) {
  if (!Array.isArray(data.systems)) return data;
  const deltas = new Map((await readGalaxyDeltas(serverKey)).map(delta => [delta.systemId, delta]));
  return { ...data, _galaxyCatalogAt: catalogAt, systems: data.systems.map(system => {
    const delta = deltas.get(system.id);
    return delta && (delta.at > catalogAt || !Object.hasOwn(system, 'hasColonies'))
      ? { ...system, hasColonies: true, colonyStateObservedAt: delta.at } : system;
  }) };
}

function exportRow(row) {
  return {
    serverKey: row.serverKey, key: row.key, at: row.at,
    ...(row.key === 'public:galaxy' ? { sha256: row.sha256 } : {}),
    data: row.key.startsWith('system:') ? unpack(row).data : catalogData(row),
  };
}

export function exportGalaxyCache() {
  return transaction('backup', 'readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done({
      version: 1,
      entries: request.result.map(exportRow),
    });
  });
}

function backupRows(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.entries)) throw new Error('Invalid galaxy backup.');
  return snapshot.entries.map(entry => {
    validateServer(entry.serverKey);
    if (!Number.isFinite(entry.at) || entry.at <= 0 || entry.at > Date.now() + 60000) throw new Error('Invalid galaxy backup time.');
    if (entry.key === 'public:galaxy') {
      validatePublicGalaxy(entry.data, entry.serverKey);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid public galaxy backup checksum.');
      return { serverKey: entry.serverKey, key: entry.key, at: entry.at, sha256: entry.sha256, data: entry.data };
    }
    if (typeof entry.key === 'string' && entry.key.startsWith('system:')) {
      systemKey(Number(entry.key.slice(7)));
      return { ...mergeSystem(null, entry.data, entry.at), serverKey: entry.serverKey, key: entry.key };
    }
    if (typeof entry.key === 'string' && entry.key.startsWith('delta:')) {
      validateDelta(entry.data, entry.at);
      if (entry.key !== `delta:${entry.data.systemId}`) throw new Error('Invalid galaxy delta key.');
      return { serverKey: entry.serverKey, key: entry.key, at: entry.at, data: {
        type: 'colonized', systemId: entry.data.systemId, hasColonies: true,
      } };
    }
    if (!catalogPath(entry.key)) throw new Error('Invalid galaxy backup key.');
    const group = catalogGroup(entry.key);
    if (!Array.isArray(entry.data?.[group])) throw new Error('Invalid galaxy backup catalog.');
    if (group === 'stations') {
      validateStations(entry.data, entry.at);
      return stationCatalogRow(entry.serverKey, entry.key, entry.data, entry.at);
    }
    return entry;
  });
}

export function validateGalaxyBackup(snapshot) {
  backupRows(snapshot);
}

export function restoreGalaxyCache(snapshot = { version: 1, entries: [] }) {
  const rows = backupRows(snapshot);
  return transaction('backup', 'readwrite', store => {
    store.clear();
    for (const row of rows) store.put(row);
  });
}

// The service owns request coalescing and legacy migration; the database remains
// the source of truth across dashboards and MV3 worker restarts.
export function createGalaxyCache({ fetcher, storage, promote }) {
  const pending = new Map();
  const unavailable = new Map();
  const migrations = new Map();
  async function migrate(serverKey) {
    if (migrations.has(serverKey)) return migrations.get(serverKey);
    const promise = (async () => {
      const { planet_scan_cache } = await storage.get('planet_scan_cache', serverKey);
      if (!planet_scan_cache) return;
      for (const [id, entry] of Object.entries(planet_scan_cache)) {
        await saveSystem(serverKey, Number(id), entry.data, entry.at);
      }
      await storage.remove('planet_scan_cache', serverKey);
    })();
    migrations.set(serverKey, promise);
    try { await promise; }
    finally { migrations.delete(serverKey); }
  }
  async function once(key, work) {
    if (pending.has(key)) return pending.get(key);
    const promise = work();
    pending.set(key, promise);
    try { return await promise; }
    finally { pending.delete(key); }
  }
  return {
    async refreshFromDelta(serverKey, systemId, at) {
      systemKey(systemId);
      if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60000) throw new Error('Invalid galaxy delta time.');
      return once(`${serverKey}:delta:${systemId}`, async () => {
        await migrate(serverKey);
        if (!await canRefreshSystem(serverKey, systemId)) return { refreshed: false };
        const entry = await readSystem(serverKey, systemId);
        if (['planets', 'moons'].every(group => (entry?.data._galaxyCache?.ownership?.[group] || 0) >= at)) {
          return { refreshed: false };
        }
        await this.system(serverKey, systemId, { purpose: 'ownership', force: true });
        return { refreshed: true };
      });
    },
    async scans(serverKey) {
      await migrate(serverKey);
      return readScans(serverKey);
    },
    async exportPublic(serverKey) {
      await migrate(serverKey);
      return exportPublicGalaxy(serverKey);
    },
    async system(serverKey, systemId, { purpose = 'ownership', group = 'both', maxAge, force = false, priority, source = 'galaxy-cache' } = {}) {
      if (!['static', 'ownership', 'dynamic'].includes(purpose)) throw new Error('Invalid galaxy cache purpose.');
      if (!['both', 'planets', 'moons'].includes(group)) throw new Error('Invalid galaxy cache group.');
      if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge < 0)) throw new Error('Invalid galaxy cache age.');
      await migrate(serverKey);
      const entry = await readSystem(serverKey, systemId);
      if (!force && systemCacheFresh(entry, purpose, maxAge, Date.now(), group)) return entry.data;
      const unavailableKey = `${serverKey}:${systemKey(systemId)}:${group}`;
      const previousFailure = unavailable.get(unavailableKey);
      if (!force && purpose === 'static' && previousFailure?.until > Date.now()) throw previousFailure.error;
      unavailable.delete(unavailableKey);
      promote?.(serverKey, `/api/galaxy/systems/${systemId}/planets`, priority);
      const updated = await once(`${serverKey}:${systemKey(systemId)}`, async () => {
        const data = await fetcher(`/api/galaxy/systems/${systemId}/planets`, { serverKey, source, ...(priority ? { priority } : {}) });
        await saveSystem(serverKey, systemId, data);
        return { source: data, entry: await readSystem(serverKey, systemId) };
      });
      const missing = requestedGroups(purpose, group).filter(name => purpose === 'static'
        ? !systemCacheFresh(updated.entry, 'static', undefined, Date.now(), name)
        : !resolved(updated.source, name) ||
          (purpose === 'ownership' && updated.source[name].some(item => !Object.hasOwn(item, 'userId'))));
      if (missing.length) {
        const error = new Error(`Galaxy response did not resolve requested ${purpose} data for system ${systemId} (${missing.join(', ')} unavailable).`);
        error.code = 'GALAXY_DATA_UNAVAILABLE';
        error.groups = missing;
        if (purpose === 'static') unavailable.set(unavailableKey, { until: Date.now() + MAP_TTL, error });
        throw error;
      }
      return updated.entry.data;
    },
    async catalog(serverKey, path, { force = false, priority } = {}) {
      if (!catalogPath(path)) throw new Error('Invalid galaxy catalog path.');
      const cached = await readRow(serverKey, path);
      if (!force && cached && Date.now() - cached.at < MAP_TTL) return applyPublicCatalog(serverKey, path,
        await applyGalaxyDeltas(serverKey, catalogData(cached), cached.at));
      promote?.(serverKey, path, priority);
      const fresh = await once(`${serverKey}:${path}`, async () => {
        const data = await fetcher(path, { serverKey, ...(priority ? { priority } : {}) });
        const at = Date.now();
        await saveCatalog(serverKey, path, data, at);
        if (path === '/api/galaxy/station-index') {
          const row = await readRow(serverKey, path);
          return { data: catalogData(row), at: row.at };
        }
        return { data, at };
      });
      return applyPublicCatalog(serverKey, path, await applyGalaxyDeltas(serverKey, fresh.data, fresh.at));
    },
    async clear(serverKey) {
      for (const key of unavailable.keys()) if (key.startsWith(`${serverKey}:`)) unavailable.delete(key);
      await storage.remove('planet_scan_cache', serverKey);
      await clearGalaxyCache(serverKey);
    },
  };
}
