// The `browser.*` polyfill is loaded by the service-worker entry
// (background-sw.js) via a static import before this module runs, so `browser`
// is defined here on both Chrome (polyfilled) and Firefox (native). Tests import
// this file directly with a stubbed `browser`, skipping the polyfill entirely.

import { missionProgress } from './mission-state.js';
import { appendDiagnostics, migrateDiagnostics } from './diagnostics.js';
import { clearDiagnosticLogs } from './diagnostics-store.js';
import { loadSettings, getSetting } from './settings.js';
import { createGalaxyCache, saveSystem, saveCatalog, saveGalaxyDelta, readGalaxyDeltas, catalogPath, exportGalaxyCache,
  readPublicGalaxy, savePublicGalaxy } from './galaxy-cache.js';
import { createGalaxySharing } from './galaxy-sharing.js';
import { createApiScheduler, retryDelay } from './api-scheduler.js';
import { createTrafficRecorder, trafficSource } from './api-telemetry.js';

const recordTraffic = createTrafficRecorder({ enabled: () => getSetting('developer.apiWaitRecording') === true });
const apiScheduler = createApiScheduler({ storage: browser.storage.session, record: recordTraffic });
const activeGameRequests = new Map();

const galaxySharing = createGalaxySharing({
  storage: { get: key => browser.storage.local.get(key), set: values => browser.storage.local.set(values) },
  read: readPublicGalaxy,
  write: async (serverKey, data, sha256) => {
    await savePublicGalaxy(serverKey, data, sha256);
    await browser.storage.local.set({ galaxy_public_revision: { serverKey, at: Date.now() } });
  },
});

const galaxyCache = createGalaxyCache({
  promote: (serverKey, path, priority) => apiScheduler.promote(`https://${serverKey}.nexuslegacy.space`, path, priority),
  fetcher: async (path, options = {}) => {
    const serverOrigin = options.serverKey
      ? `https://${options.serverKey}.nexuslegacy.space` : undefined;
    return apiFetch(path, { polite: true, ...options, serverOrigin });
  },
  storage: {
    get: (keys, serverKey) => (globalThis.nexusStorage?.forServer?.(serverKey) || browser.storage.local).get(keys),
    remove: (keys, serverKey) => (globalThis.nexusStorage?.forServer?.(serverKey) || browser.storage.local).remove(keys),
  },
});

async function galaxyServerKey() {
  return (await globalThis.nexusStorage?.getActiveServer?.())?.key || 's0';
}

async function galaxyCatalog(path, options) {
  return galaxyCache.catalog(await galaxyServerKey(), path, options);
}

const settingsReady = loadSettings().catch(error => console.error('[NexusOverseer] Settings initialization failed:', error));

let GAME_URL = 'https://s0.nexuslegacy.space';
let GAME_ORIGIN = 'https://s0.nexuslegacy.space/';

const UNIVERSE_FALLBACK = [
  { key: 's0', name: 'S0' },
  { key: 'beta', name: 'Beta' },
];
const UNIVERSE_CACHE_MAX_AGE = 6 * 60 * 60 * 1000;

function normalizeUniverses(items) {
  if (!Array.isArray(items)) return [];
  const unique = new Map();
  for (const item of items) {
    if (typeof item?.key !== 'string' || !/^[a-z0-9-]{1,63}$/.test(item.key)) continue;
    unique.set(item.key, {
      key: item.key,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.key.toUpperCase(),
    });
  }
  return [...unique.values()];
}

async function getUniverses({ refresh = false } = {}) {
  const storage = globalThis.nexusStorage;
  let cached;
  let fetchedAt;
  if (typeof storage?.getUniverseCatalog === 'function') {
    cached = normalizeUniverses(await storage.getUniverseCatalog());
    fetchedAt = await storage.getUniverseCatalogFetchedAt();
  } else {
    const state = await browser.storage.local.get(['universes', 'universes_fetched_at']);
    cached = normalizeUniverses(state.universes);
    fetchedAt = Number(state.universes_fetched_at) || 0;
  }

  if (!refresh && cached.length && Date.now() - fetchedAt < UNIVERSE_CACHE_MAX_AGE) {
    return cached;
  }

  try {
    const response = await apiScheduler.schedule({
      origin: 'https://nexuslegacy.space', path: '/api/universes', priority: 'background', source: 'universe-catalog',
    }, async () => {
      const reply = await fetch('https://nexuslegacy.space/api/universes', { signal: AbortSignal.timeout(20000) });
      return { ok: reply.ok, status: reply.status, data: reply.ok ? await reply.json() : null,
        retryAfter: reply.headers?.get('Retry-After'),
        rateLimitScope: reply.headers?.get('X-RateLimit-Scope'),
        rateLimitLimit: reply.headers?.get('RateLimit-Limit'),
        rateLimitPolicy: reply.headers?.get('RateLimit-Policy'),
        rateLimitRemaining: reply.headers?.get('RateLimit-Remaining'),
        rateLimitReset: reply.headers?.get('RateLimit-Reset') };
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const universes = normalizeUniverses(response.data);
    if (!universes.length) throw new Error('The universe catalog was empty or invalid.');
    if (typeof storage?.setUniverseCatalog === 'function') {
      return await storage.setUniverseCatalog(universes);
    }
    await browser.storage.local.set({ universes, universes_fetched_at: Date.now() });
    return universes;
  } catch (error) {
    console.warn('[NexusOverseer] Universe list fetch failed:', error.message);
    return cached.length ? cached : UNIVERSE_FALLBACK;
  }
}

async function syncGameServer() {
  try {
    const server = await globalThis.nexusStorage?.getActiveServer?.();
    if (server?.origin) {
      GAME_URL = server.origin;
      GAME_ORIGIN = `${server.origin}/`;
      return;
    }
  } catch {
    // Fall through to a tab-based detection below.
  }

  try {
    const tabs = await browser.tabs.query({ url: '*://*.nexuslegacy.space/*' });
    const active = tabs.find(tab => tab?.active) || tabs[0];
    const server = active?.url ? globalThis.nexusStorage?.serverFromUrl?.(active.url) : null;
    if (server?.origin) {
      GAME_URL = server.origin;
      GAME_ORIGIN = `${server.origin}/`;
      return;
    }
  } catch {
    // Ignore and keep the default S0 fallback below.
  }

  GAME_URL = 'https://s0.nexuslegacy.space';
  GAME_ORIGIN = 'https://s0.nexuslegacy.space/';
}

browser.tabs?.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (!tab?.active) return;
    if (!tab?.url || !tab.url.includes('nexuslegacy.space')) return;
    const server = globalThis.nexusStorage?.serverFromUrl?.(tab.url);
    if (!server) return;
    if (changeInfo.url || changeInfo.status === 'complete') {
      await globalThis.nexusStorage.setActiveServer(server.key);
      await syncGameServer();
    }
  } catch {
    // Ignore tab-state races; the next page sync will reconcile the server.
  }
});

browser.tabs?.onActivated?.addListener(async () => {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = (tabs || [])[0] || null;
    const server = tab?.url ? globalThis.nexusStorage?.serverFromUrl?.(tab.url) : null;
    if (!server) return;
    await globalThis.nexusStorage.setActiveServer(server.key);
    await syncGameServer();
  } catch {
    // Ignore tab-state races; the next page sync will reconcile the server.
  }
});

const REPORTS_PATH = '/api/fleet/survey-reports';
const PIRATES_PATH = '/api/fleet/pirate-reports';
const PVP_PATH = '/api/fleet/reports';   // player-vs-player combat reports
const SPY_PATH = '/api/fleet/spy-reports';
const CAMP_SCOUT_PATH = '/api/fleet/camp-scout-reports';
const PIRATE_CAMPS_PATH = '/api/fleet/pirate-camps';
const WORMHOLES_PATH = '/api/fleet/wormholes';
const MISSIONS_PATH = '/api/fleet/missions';
const RESEARCH_PATH = '/api/research';
const MINING_PATH = '/api/fleet/mining-reports';
const EXPEDITION_PATH = '/api/fleet/expedition-reports';
const WORMHOLE_PATH = '/api/fleet/wormhole-runs';
// xeno_survey (ruins survey) results aren't a fleet report — they arrive as a
// system message with subject "Xeno Survey Complete", body text like "Your
// science team finished the xeno survey. 0 fragments recovered, plus an
// artifact for your collection." No structured loot/moon/zone data at all.
const XENO_MESSAGES_PATH = '/api/messages/system';
const SYSTEM_DEBRIS_PATH = '/api/fleet/system-debris';
const INTEL_KEEP = 200;
const ALARM = 'nexus-scrape';
const INTERVAL_MIN = 15;
// Bump this when stored data shape changes; add a MIGRATIONS entry for it.
const SCHEMA_VERSION = 10;

const DEFAULT_RECORDS_CAP = 5000;
// Browser storage serializes Infinity as null, so persist 0 as the unlimited sentinel.
function resolveRecordsCap(stored) {
  if (stored === 0) return Infinity;
  return stored ?? DEFAULT_RECORDS_CAP;
}

// ── Setup ──────────────────────────────────────────────────────────────────

async function ensureScrapeAlarm() {
  try {
    const alarm = await browser.alarms.get(ALARM);
    if (!alarm) {
      browser.alarms.create(ALARM, { periodInMinutes: INTERVAL_MIN });
      console.log('[NexusOverseer] Re-armed periodic scrape alarm.');
    }
  } catch (err) {
    console.warn('[NexusOverseer] Failed to ensure scrape alarm:', err);
  }
}

browser.runtime.onInstalled.addListener(async details => {
  browser.alarms.create(ALARM, { periodInMinutes: INTERVAL_MIN });
  // Re-arm the asteroid live-search alarm if it was left enabled.
  const { live_search } = await browser.storage.local.get('live_search');
  if (live_search && live_search.enabled) browser.alarms.create(LS_ALARM, { periodInMinutes: LS_INTERVAL_MIN });
  // Snapshot existing data before the new version touches it.
  if (details.reason === 'update') {
    const { whatsnew_read_version } = await browser.storage.local.get('whatsnew_read_version');
    const version = browser.runtime.getManifest().version;
    if (version !== whatsnew_read_version) await browser.storage.local.set({ whatsnew_pending: version });
    try {
      await backupToDownloads(`pre-update-${details.previousVersion || 'unknown'}`);
    } catch (err) {
      console.warn('[NexusOverseer] Pre-update backup failed:', err);
    }
  }
  await scrape();
});

browser.runtime.onStartup?.addListener(() => {
  ensureScrapeAlarm();
});

// Service workers are ephemeral; re-check on each wake so a cleared alarm
// (browser restart/disable-enable/crash-recovery) self-heals automatically.
ensureScrapeAlarm();

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM) {
    await browser.storage.local.set({ last_alarm_fire_at: new Date().toISOString() });
    await scrape();
  }
  if (alarm.name === LS_ALARM) await liveSearchScan();
});

// ── Asteroid live search ───────────────────────────────────────────────────
// Scans the N nearest explored systems every 5 minutes (background alarm, runs
// regardless of focus) and fires a system notification when a field newly
// matches the saved filter. Mirrors tabs/asteroids.js scan(), API-only.
const LS_ALARM = 'nexus-livesearch';
const LS_INTERVAL_MIN = 5;
const LS_ABORT_AFTER_ERRORS = 6;       // bail the scan after this many consecutive API failures

async function setLiveSearch(config) {
  await browser.storage.local.set({ live_search: config });
  if (config && config.enabled) {
    browser.alarms.create(LS_ALARM, { periodInMinutes: LS_INTERVAL_MIN });
    // Config (filter/planet) may have changed — reset seen so matches re-notify.
    await browser.storage.local.set({ live_search_seen: [] });
    liveSearchScan();   // run one immediately so the user isn't waiting 5 min
  } else {
    browser.alarms.clear(LS_ALARM);
  }
  return { ok: true };
}

async function stopLiveSearch() {
  const { live_search } = await browser.storage.local.get('live_search');
  await browser.storage.local.set({ live_search: { ...(live_search || {}), enabled: false } });
  browser.alarms.clear(LS_ALARM);
  return { ok: true };
}

// Sector systems with a cross-scan TTL cache (names/zones change rarely).
async function lsSectorSystems(sectorId) {
  return (await galaxyCatalog(`/api/galaxy/sectors/${sectorId}/systems`)).systems || [];
}

function fieldMatches(f, cfg) {
  const leftPct = f.totalResources ? (f.remainingResources / f.totalResources) * 100 : null;
  if (cfg.types?.length && !cfg.types.includes(f.fieldType)) return false;
  if (cfg.zones?.length && !cfg.zones.includes(f.zone)) return false;
  if (cfg.multMin != null && !((f.richness ?? -Infinity) >= cfg.multMin)) return false;
  if (cfg.qtyMin != null && !((f.remainingResources ?? -Infinity) >= cfg.qtyMin)) return false;
  if (cfg.leftMin != null && !((leftPct ?? -Infinity) >= cfg.leftMin)) return false;
  return true;
}

let lsScanning = false;
let lsRerun = false;

// Progress/result of the latest scan, shown in the Asteroids tab.
function setLsStatus(status) {
  return browser.storage.local.set({ live_search_status: { ...status, at: Date.now() } }).catch(() => {});
}

async function liveSearchScan() {
  if (lsScanning) { lsRerun = true; return; }   // config changed or alarm overlapped: rerun afterwards
  lsScanning = true;
  try {
    do {
      lsRerun = false;
      await runLiveSearchScan();
    } while (lsRerun);
  } finally {
    lsScanning = false;
  }
}

async function runLiveSearchScan() {
  const { live_search: cfg } = await browser.storage.local.get('live_search');
  if (!cfg || !cfg.enabled || cfg.planetId == null) return;

  try {
    await setLsStatus({ state: 'scanning', phase: 'Loading galaxy map…', scanned: 0, limit: 0, matchingSystems: 0, found: 0 });
    const planets = (await getPlanets()).planets || [];
    const planet = planets.find(p => p.id === cfg.planetId);
    if (!planet || planet.systemId == null) { await setLsStatus({ state: 'error', error: 'Source planet not found.' }); return; }
    const map = await galaxyCatalog('/api/galaxy/map');
    const src = (map.systems || []).find(s => s.id === planet.systemId);
    if (!src) { await setLsStatus({ state: 'error', error: 'Source system not on the map.' }); return; }

    const want = Math.max(1, Math.min(500, cfg.near || 25));
    const candidates = (map.systems || [])
      .filter(s => s.id !== src.id && (s.visibility === 'full' || s.visibility === 'partial'))
      .map(s => ({ s, d: Math.hypot(s.x - src.x, s.y - src.y) }))
      .sort((a, b) => a.d - b.d)
      .map(o => o.s);

    // Same targeting as the manual scan: zones narrow the systems first, and
    // with a type filter the scan continues (up to 500 systems) until `want`
    // systems actually contain that type.
    const typeSet = new Set(cfg.types || []);
    const zoneSet = new Set(cfg.zones || []);
    const systemLimit = typeSet.size ? 500 : want;
    const matches = [];
    let errStreak = 0;
    let inZone = 0, scanned = 0, matchingSystems = 0;
    const report = (phase) => setLsStatus({ state: 'scanning', phase, scanned, limit: systemLimit, matchingSystems, found: matches.length });
    await report('Scanning systems…');
    for (const sys of candidates) {
      if (typeSet.size ? (matchingSystems >= want || scanned >= systemLimit) : inZone >= want) break;
      let sector;
      try { sector = await lsSectorSystems(sys.sectorId); }
      catch { if (++errStreak >= LS_ABORT_AFTER_ERRORS) break; continue; }
      const meta = sector.find(s => s.id === sys.id);
      if (!meta || (zoneSet.size && !zoneSet.has(meta.securityZone))) { errStreak = 0; continue; }
      inZone++;
      if (!meta.planetCount) { errStreak = 0; continue; }
      let data;
      try { data = await galaxyCache.system(await galaxyServerKey(), sys.id, { purpose: 'dynamic', force: true }); }
      catch { if (++errStreak >= LS_ABORT_AFTER_ERRORS) break; continue; }
      errStreak = 0;
      scanned++;
      if (scanned % 5 === 0) report('Scanning systems…');
      if (typeSet.size) {
        if (!(data.asteroidFields || []).some(f => typeSet.has(f.fieldType))) {
          continue;
        }
        matchingSystems++;
      }
      for (const f of (data.asteroidFields || [])) {
        const zone = meta.securityZone || 'unknown';
        if (fieldMatches({ ...f, zone }, cfg)) {
          matches.push({
            id: f.id,
            name: f.name || `#${f.id}`,
            system: meta.name || `#${sys.id}`,
            systemId: sys.id,
            type: f.fieldType || '—',
            mult: f.richness ?? null,
            remaining: f.remainingResources ?? null,
            leftPct: f.totalResources ? Math.round((f.remainingResources / f.totalResources) * 100) : null,
            zone,
            controllerName: f.controllerName || null,
          });
        }
      }
      if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const { live_search_seen } = await browser.storage.local.get('live_search_seen');
    const seen = new Set(live_search_seen || []);
    const fresh = matches.filter(m => !seen.has(m.id));
    // Keep the full current match list + timestamp for the on-click results window.
    await browser.storage.local.set({
      live_search_seen: matches.map(m => m.id),
      live_search_last_matches: matches,
      live_search_last_at: Date.now(),
    });

    await setLsStatus({
      state: errStreak >= LS_ABORT_AFTER_ERRORS ? 'error' : 'idle',
      error: errStreak >= LS_ABORT_AFTER_ERRORS ? 'Scan aborted after repeated API errors.' : null,
      scanned, matchingSystems, found: matches.length, fresh: fresh.length,
    });

    if (fresh.length) {
      const top = fresh[0];
      browser.notifications.create(`${LS_ALARM}-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('icons/icon128.png'),
        title: '🪨 Asteroid match',
        message: fresh.length === 1
          ? `${top.name} (${top.type}) in ${top.system} matches your live search.`
          : `${fresh.length} new fields match your live search — incl. ${top.name} in ${top.system}.`,
      });
    }
  } catch (err) {
    console.warn('[NexusOverseer] Live search failed:', err);
    await setLsStatus({ state: 'error', error: String(err && err.message || err) });
  }
}

// Clicking a live-search notification focuses (or opens) the game tab and asks
// its content script to show the draggable matches window.
browser.notifications?.onClicked?.addListener(async id => {
  if (!id.startsWith(LS_ALARM)) return;
  browser.notifications.clear(id);
  const tabs = await browser.tabs.query({ url: `${GAME_URL}/*` });
  if (tabs.length) {
    const t = tabs[0];
    await browser.tabs.update(t.id, { active: true });
    if (t.windowId != null) browser.windows.update(t.windowId, { focused: true });
    browser.tabs.sendMessage(t.id, { type: 'SHOW_LS_RESULTS' }).catch(() => {});
  } else {
    // No game tab open — flag it so the content script shows the panel on load.
    await browser.storage.local.set({ live_search_open_panel: true });
    browser.tabs.create({ url: GAME_ORIGIN });
  }
});

browser.action.onClicked.addListener(async () => {
  await syncGameServer();
  browser.tabs.create({ url: browser.runtime.getURL('dashboard.html') });
});

const handleRuntimeMessage = async (msg, context = null, options = {}) => {
  if (msg?.type === 'GET_UNIVERSES') return getUniverses();
  if (!options.serverOrigin) await syncGameServer();
  if (msg.type === 'SCRAPE_NOW') return scrape(context);
  if (msg.type === 'GET_FLEET') return getFleet(msg.planetId, options);
  if (msg.type === 'GET_SHIP_DEFS') return getShipDefs(options);
  if (msg.type === 'GET_PLANET_SHIPS') return getPlanetShips(msg.planetId, options);
  if (msg.type === 'GET_MISSIONS') return apiGet('/api/fleet/missions', options);
  if (msg.type === 'GET_PIRATE_CAMPS') return apiGet(PIRATE_CAMPS_PATH, options);
  if (msg.type === 'GET_PIRATE_REPORTS') return apiGet(PIRATES_PATH, options);
  if (msg.type === 'REFRESH_DEBRIS') return refreshDebris();
  if (msg.type === 'GET_FUEL_ESTIMATE') {
    // POST: routed through the game tab (same-origin) — a Bearer POST from the
    // extension carries an Origin header the server 500s on.
    return gamePost('/api/fleet/fuel-estimate', msg.body, options).then(r => (r && r.ok) ? r.data : r);
  }
  if (msg.type === 'GET_SURVEY_COOLDOWNS') return apiGet('/api/fleet/survey-cooldowns', options);
  if (msg.type === 'GET_SURVEY_REPORTS') return apiGet('/api/fleet/survey-reports', options);
  if (msg.type === 'SEND_MINE') {
    const escortRetreatThreshold = [30, 50, 70].includes(msg.escortRetreatThreshold)
      ? msg.escortRetreatThreshold
      : null;
    return gamePost('/api/fleet/mine', {
      sourcePlanetId: msg.sourcePlanetId, targetFieldId: msg.targetFieldId,
      ships: msg.ships, miningDuration: msg.miningDuration,
      hangarAssignments: {},
      mineUntilFull: !!msg.mineUntilFull,
      // The game stores/accepts the threshold as a fraction (0.5), not a percent (50).
      ...(escortRetreatThreshold != null ? { escortRetreatThreshold: escortRetreatThreshold / 100 } : {}),
    }, options);
  }
  if (msg.type === 'SEND_SURVEY') {
    return gamePost('/api/fleet/survey', {
      sourcePlanetId: msg.sourcePlanetId, targetSystemId: msg.targetSystemId, ships: msg.ships,
    }, options);
  }
  if (msg.type === 'SEND_INVESTIGATE') {
    return gamePost('/api/fleet/investigate', {
      sourcePlanetId: msg.sourcePlanetId, reportId: msg.reportId, ships: msg.ships,
      hangarAssignments: {},
    }, options);
  }
  if (msg.type === 'COLLECT_DEBRIS') {
    return gamePost('/api/fleet/collect-debris', {
      sourcePlanetId: msg.sourcePlanetId, debrisId: msg.debrisId, ships: msg.ships,
    }, options);
  }
  if (msg.type === 'COLLECT_SALVAGE') {
    return gamePost('/api/fleet/collect-salvage', {
      sourcePlanetId: msg.sourcePlanetId, reportId: msg.reportId, ships: msg.ships,
    }, options);
  }
  if (msg.type === 'SEND_EXPEDITION') {
    return gamePost('/api/fleet/expedition', {
      sourcePlanetId: msg.sourcePlanetId, ships: msg.ships, zone: msg.zone, depth: msg.depth,
    }, options);
  }
  if (msg.type === 'SEND_SCOUT_CAMP') {
    return gamePost('/api/fleet/scout-camp', {
      sourcePlanetId: msg.sourcePlanetId, campId: msg.campId, ships: msg.ships,
    }, options);
  }
  if (msg.type === 'SEND_ATTACK_PIRATES') {
    return gamePost('/api/fleet/attack-pirates', {
      sourcePlanetId: msg.sourcePlanetId, campId: msg.campId, ships: msg.ships,
      hangarAssignments: {},
    }, options);
  }
  if (msg.type === 'SEND_XENO_SURVEY') {
    return gamePost('/api/fleet/xeno-survey', {
      sourcePlanetId: msg.sourcePlanetId, targetMoonId: msg.targetMoonId, ships: msg.ships,
      hangarAssignments: {},
    }, options);
  }
  if (msg.type === 'GET_PLANETS') return getPlanets(options);
  if (msg.type === 'GET_DASHBOARD_OVERVIEW') return getDashboardOverview({ ...options, polite: msg.polite !== false });
  if (msg.type === 'SIM_BOOTSTRAP') return apiGet('/api/combat-simulator/bootstrap');
  if (msg.type === 'SIM_RUN') return simulateCombat(msg.attacker, msg.defender);
  if (msg.type === 'REBUILD_AGGREGATES') return enqueue(rebuildAggregates).then(() => ({ ok: true }));
  if (msg.type === 'PURGE_OLD') return enqueue(() => purgeOldData(msg.days ?? 3)).then(() => ({ ok: true }));
  if (msg.type === 'BACKUP_NOW') return backupToDownloads(msg.reason || 'manual').then(() => ({ ok: true })).catch(e => ({ error: e.message }));
  if (['GET_PUBLIC_GALAXY_STATUS', 'UPDATE_PUBLIC_GALAXY', 'EXPORT_PUBLIC_GALAXY'].includes(msg.type)) {
    try {
      const serverKey = options.serverKey || await galaxyServerKey();
      if (msg.type === 'EXPORT_PUBLIC_GALAXY') return { data: await galaxyCache.exportPublic(serverKey) };
      if (msg.type === 'GET_PUBLIC_GALAXY_STATUS') return await galaxySharing.status(serverKey);
      return await galaxySharing.update(serverKey, { force: msg.force === true,
        enabled: getSetting('data.publicGalaxyAutoUpdate') });
    } catch (error) {
      console.warn('[NexusOverseer] Public galaxy request failed:', error);
      return { error: error.message };
    }
  }
  if (['GET_ARMS', 'GET_GALAXY_MAP', 'GET_STATION_INDEX', 'GET_HUBS', 'GET_SYSTEM_PLANETS', 'GET_ARM_SECTORS', 'GET_SECTOR_SYSTEMS',
    'GET_GALAXY_SCANS', 'CLEAR_GALAXY_CACHE', 'GALAXY_OBSERVED', 'GALAXY_DELTA', 'GET_GALAXY_DELTAS'].includes(msg.type)) {
    try {
      const serverKey = options.serverKey || await galaxyServerKey();
      if (msg.type === 'GET_GALAXY_DELTAS') return { deltas: await readGalaxyDeltas(serverKey) };
      if (msg.type === 'GALAXY_DELTA') {
        if (!Number.isFinite(msg.at)) throw new Error('Invalid galaxy delta time.');
        const result = await saveGalaxyDelta(serverKey, msg.data, msg.at);
        await browser.storage.local.set({ galaxy_delta_revision: { systemId: msg.data.systemId, at: msg.at } });
        const refresh = result.changed
          ? await galaxyCache.refreshFromDelta(serverKey, msg.data.systemId, msg.at)
          : { refreshed: false };
        if (refresh.refreshed) {
          await browser.storage.local.set({ galaxy_system_revision: { systemId: msg.data.systemId, at: Date.now() } });
        }
        return { ...result, ...refresh };
      }
      if (msg.type === 'GET_GALAXY_SCANS') return { scans: await galaxyCache.scans(serverKey) };
      if (msg.type === 'CLEAR_GALAXY_CACHE') {
        galaxySharing.cancel(serverKey);
        await galaxyCache.clear(serverKey);
        await browser.storage.local.remove([
          'galaxy_public_status', 'galaxy_public_revision',
          'asteroid_scan_results', 'system_zones', 'system_zones_at', 'system_zone_by_id',
          'system_coords_by_id', 'system_coords_by_name', 'sector_zones',
        ]);
        moonIdsCaches.clear();
        return { ok: true };
      }
      if (msg.type === 'GALAXY_OBSERVED') {
        const system = /^\/api\/galaxy\/systems\/(\d+)\/planets$/.exec(msg.path);
        if (system) await saveSystem(serverKey, Number(system[1]), msg.data, msg.at);
        else if (catalogPath(msg.path)) await saveCatalog(serverKey, msg.path, msg.data, msg.at);
        else throw new Error('Invalid observed galaxy path.');
        return { ok: true };
      }
      if (msg.type === 'GET_SYSTEM_PLANETS') return await galaxyCache.system(serverKey, msg.systemId, {
        purpose: msg.purpose, group: msg.group, maxAge: msg.maxAge, force: msg.force === true, priority: options.priority,
        source: msg.source ? options.source : 'galaxy-cache',
      });
      const path = msg.type === 'GET_ARMS' ? '/api/galaxy/arms'
        : msg.type === 'GET_HUBS' ? '/api/market/hubs'
        : msg.type === 'GET_STATION_INDEX' ? '/api/galaxy/station-index'
        : msg.type === 'GET_GALAXY_MAP' ? '/api/galaxy/map'
          : msg.type === 'GET_ARM_SECTORS' ? `/api/galaxy/arms/${msg.armId}/sectors`
            : `/api/galaxy/sectors/${msg.sectorId}/systems`;
      return await galaxyCache.catalog(serverKey, path, { force: msg.force === true, priority: options.priority });
    } catch (error) {
      console.warn('[NexusOverseer] Galaxy cache request failed:', error);
      return { error: error.message, status: error.status, code: error.code, groups: error.groups };
    }
  }
  if (msg.type === 'GET_PLAYER_ALLIANCE_TAG') return getPlayerAllianceTag(msg.name, options);
  if (msg.type === 'GET_AUTH_ME') return apiGet('/api/auth/me', options);
  if (msg.type === 'GET_SYSTEM_COORDS') return getSystemCoords(msg.names || [], msg.ids || []);
  if (msg.type === 'GET_ALLIANCE') return getAlliance(options);
  if (msg.type === 'GET_PLAYER_RANK') return getPlayerRanks(msg.name, options);
  if (msg.type === 'GET_RESOURCES') return getResources(options);
  if (msg.type === 'GET_MARKET_ORDERS') return getOrders('/api/market/orders', options);
  if (msg.type === 'GET_MARKET_TRADES') return getMarketTrades(options);
  if (msg.type === 'GET_ALLIANCE_ORDERS') return getOrders('/api/alliance-trade/orders', options);
  if (msg.type === 'START_RESEARCH') return startResearch(msg.researchId, msg.planetId, msg.useFragments, context, options);
  if (msg.type === 'SET_LIVE_SEARCH') return setLiveSearch(msg.config);
  if (msg.type === 'STOP_LIVE_SEARCH') return stopLiveSearch();
};

const NETWORK_MESSAGES = new Set([
  'GET_FLEET', 'GET_SHIP_DEFS', 'GET_PLANET_SHIPS', 'GET_MISSIONS', 'GET_PIRATE_CAMPS',
  'GET_PIRATE_REPORTS', 'GET_FUEL_ESTIMATE', 'GET_SURVEY_COOLDOWNS', 'GET_SURVEY_REPORTS',
  'SEND_MINE', 'SEND_SURVEY', 'SEND_INVESTIGATE', 'COLLECT_DEBRIS', 'COLLECT_SALVAGE',
  'SEND_EXPEDITION', 'SEND_SCOUT_CAMP', 'SEND_ATTACK_PIRATES', 'SEND_XENO_SURVEY',
  'GET_PLANETS', 'GET_DASHBOARD_OVERVIEW', 'GET_PLAYER_ALLIANCE_TAG', 'GET_AUTH_ME',
  'GET_ALLIANCE', 'GET_PLAYER_RANK', 'GET_RESOURCES', 'GET_MARKET_ORDERS', 'GET_MARKET_TRADES',
  'GET_ALLIANCE_ORDERS', 'START_RESEARCH', 'GET_SYSTEM_PLANETS', 'GET_ARMS',
  'GET_GALAXY_MAP', 'GET_STATION_INDEX', 'GET_HUBS', 'GET_ARM_SECTORS', 'GET_SECTOR_SYSTEMS',
]);
const cancelledRequests = new Map();

browser.runtime.onMessage.addListener(async (msg, sender) => {
  await settingsReady;
  if (msg?.type === 'DIAGNOSTICS_APPEND' || msg?.type === 'DIAGNOSTICS_CLEAR') {
    const server = sender?.tab?.url ? globalThis.nexusStorage?.serverFromUrl(sender.tab.url) : null;
    const extensionPage = sender?.url?.split(/[?#]/)[0] === browser.runtime.getURL('dashboard.html');
    if ((msg.type === 'DIAGNOSTICS_APPEND' && !server) || (msg.type === 'DIAGNOSTICS_CLEAR' && !extensionPage)) {
      return { error: 'Diagnostic request is not allowed from this context.' };
    }
    try {
      const serverKey = server?.key || msg.serverKey;
      if (msg.type === 'DIAGNOSTICS_APPEND') return await appendDiagnostics(msg.batch, serverKey);
      if (!['api', 'galaxy', 'websocket', 'scheduling'].includes(msg.kind)) throw new Error('Unknown diagnostic stream.');
      await migrateDiagnostics(serverKey);
      await clearDiagnosticLogs(serverKey, msg.kind);
      return { ok: true };
    } catch (error) {
      console.error('[NexusOverseer] Diagnostic storage failed:', error);
      return { error: error.message };
    }
  }
  if (msg?.type === 'GET_UNIVERSES') return handleRuntimeMessage(msg);
  const sourceServer = sender?.tab?.url
    ? globalThis.nexusStorage?.serverFromUrl?.(sender.tab.url)
    : null;
  const server = sourceServer || await (globalThis.nexusStorage?.getSelectedServer?.()
    ?? globalThis.nexusStorage?.getActiveServer?.());
  const options = {
    source: trafficSource(msg.source || (msg.type === 'GET_DASHBOARD_OVERVIEW' ? 'dashboard'
      : msg.type?.startsWith('SEND_') || msg.type?.startsWith('COLLECT_') ? 'fleet-action'
        : msg.type?.includes('PIRATE') ? 'pirates'
          : msg.type?.includes('MARKET') || msg.type === 'GET_ALLIANCE_ORDERS' ? 'market'
            : msg.type === 'START_RESEARCH' ? 'research'
              : msg.type?.includes('SURVEY') ? 'scouting'
        : msg.type === 'API_REQUEST' ? 'content-tool' : 'background-maintenance')),
    serverOrigin: server?.origin || 'https://s0.nexuslegacy.space',
    serverKey: server?.key || 's0',
    priority: msg.priority || (msg.type?.startsWith('SEND_') || msg.type?.startsWith('COLLECT_') ||
      msg.type === 'START_RESEARCH' || msg.type === 'API_REQUEST' && msg.method === 'POST'
      ? 'action' : msg.polite ? 'background' : 'interactive'),
  };
  if (msg.type === 'GET_API_STATUS') {
    if (msg.path != null && !validApiPath(msg.path)) return { error: 'Invalid API status path.' };
    try {
      return await apiScheduler.status(options.serverOrigin, msg.path);
    } catch (error) {
      console.error('[NexusOverseer] API status failed:', error);
      return { error: error.message };
    }
  }
  if (msg.type === 'API_TRAFFIC') {
    if (!sourceServer || !validApiPath(msg.path)) return { error: 'Invalid API observation.' };
    try {
      await apiScheduler.observe(options.serverOrigin, msg.path, msg.response,
        { started: msg.started === true });
      return { ok: true };
    } catch (error) {
      console.error('[NexusOverseer] API observation failed:', error);
      return { error: error.message };
    }
  }
  const cancellationKey = `${sender?.tab?.id ?? sender?.url ?? 'extension'}:${msg.requestId}`;
  if (msg.type === 'API_CANCEL') {
    cancelledRequests.get(cancellationKey)?.abort(new Error('API request cancelled.'));
    return { ok: true };
  }
  if (msg.type === 'API_REQUEST') {
    if (!validApiPath(msg.path) || !['GET', 'POST'].includes(msg.method)) {
      return { error: 'Invalid game API request.' };
    }
    const controller = new AbortController();
    cancelledRequests.set(cancellationKey, controller);
    try {
      const requestOptions = { ...options, signal: controller.signal };
      return msg.method === 'GET'
        ? { ok: true, data: await apiFetch(msg.path, requestOptions) }
        : await gamePost(msg.path, msg.body || {}, requestOptions);
    } catch (error) {
      console.error('[NexusOverseer] Game API request failed:', error);
      return { error: error.message, status: error.status };
    } finally {
      cancelledRequests.delete(cancellationKey);
    }
  }
  // Local galaxy reads use explicit server keys and must not wait behind a
  // scoped background operation that is itself waiting for network capacity.
  if (NETWORK_MESSAGES.has(msg.type) || msg.type === 'GET_GALAXY_SCANS' || msg.type === 'GET_GALAXY_DELTAS') {
    return handleRuntimeMessage(msg, null, options);
  }
  if (msg?.type === 'GALAXY_DELTA' && !sourceServer) return { error: 'Galaxy delta requires a game-tab origin.' };
  // Simulations do not access scoped storage. Pin their origin explicitly so
  // a long scrape cannot hold them behind the storage scope for another server.
  if (msg?.type === 'SIM_RUN' || msg?.type === 'SIM_BOOTSTRAP') {
    const storage = globalThis.nexusStorage;
    const server = sourceServer || await (storage?.getSelectedServer?.() ?? storage?.getActiveServer?.());
    const serverOrigin = server?.origin || 'https://s0.nexuslegacy.space';
    return msg.type === 'SIM_RUN'
      ? simulateCombat(msg.attacker, msg.defender, serverOrigin)
      : apiGet('/api/combat-simulator/bootstrap', { serverOrigin, source: 'simulator' });
  }
  const selectedServer = server;
  const serverKey = ['SCRAPE_NOW', 'CLEAR_GALAXY_CACHE', 'GET_PUBLIC_GALAXY_STATUS', 'UPDATE_PUBLIC_GALAXY',
    'EXPORT_PUBLIC_GALAXY'].includes(msg?.type) && msg.serverKey
    ? msg.serverKey
    : selectedServer?.key || 's0';
  if (globalThis.nexusStorage?.withServer) {
    return globalThis.nexusStorage.withServer(
      serverKey,
      (_server, context) => handleRuntimeMessage(msg, context),
    );
  }
  return handleRuntimeMessage(msg);
});

function validApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#\s]/.test(path)) return false;
  try {
    const url = new URL(path, 'https://s0.nexuslegacy.space');
    return url.origin === 'https://s0.nexuslegacy.space' && url.pathname.startsWith('/api/');
  } catch { return false; }
}

// Launch a research on a planet: POST /api/research/{id}/start { planetId }.
// (Endpoint mirrors the game client.) Refreshes stored state on success so the
// dashboard reflects the new active research.
async function startResearch(researchId, planetId, useFragments = false, context = null, options = {}) {
  if (researchId == null || planetId == null) return { error: 'Missing research or planet id.' };
  try {
    const body = { planetId };
    if (useFragments) body.useFragments = true;
    const r = await gamePost(`/api/research/${researchId}/start`, body, options);
    if (!r?.ok) return { error: `Start failed: ${r?.error || r?.status || 'unknown error'}` };
    // A confirmed action must not wait for an entire report scrape to complete.
    const refresh = options.serverKey && globalThis.nexusStorage?.withServer
      ? globalThis.nexusStorage.withServer(options.serverKey, (_server, scope) => scrape(scope))
      : scrape(context);
    void refresh.catch(error => console.error('[NexusOverseer] Research follow-up refresh failed:', error));
    return { ok: true, data: r.data || {} };
  } catch (e) {
    console.error('[NexusOverseer] Research start failed:', e);
    return { error: e.message };
  }
}

// The highest-level Research Lab building in a planet response, or null.
// `buildings` sits at the response wrapper level (a sibling of `planet`), so
// pass the whole response; scan every array field for the research_lab entry.
function findResearchLab(resp) {
  let best = null;
  for (const v of Object.values(resp || {})) {
    if (!Array.isArray(v)) continue;
    for (const b of v) {
      if (b?.definition?.key === 'research_lab' || b?.key === 'research_lab') {
        if (!best || (b.level || 0) > (best.level || 0)) best = b;
      }
    }
  }
  return best;
}

// Total stored resources + production rates across all your planets, plus
// research-planner inputs: highest research-lab level (+ its definition and the
// host planet's build-speed), the count of planets (= parallel research slots),
// and any in-progress lab upgrade end time.
async function getResources(options = {}) {
  try {
    const data = await apiFetch('/api/planets', options);
    const planets = data.planets || [];
    const keys = ['ore', 'silicates', 'hydrogen', 'alloys',
      'oreRate', 'silicatesRate', 'hydrogenRate', 'alloysRate'];
    const tot = Object.fromEntries(keys.map(k => [k, 0]));
    let labLevel = 0, labDef = null, buildSpeedMult = 1, labUpgradeEndsAt = null;
    const researchPlanets = [];   // { id, name, mult } — one research slot each
    for (const p of planets) {
      const d = await apiFetch(`/api/planets/${p.id}`, options);
      const pl = d.planet || d;
      for (const k of keys) tot[k] += pl[k] || 0;
      const lab = findResearchLab(d);
      if (lab && (lab.level || 0) > labLevel) {
        labLevel = lab.level || 0;
        labDef = lab.definition || null;
        buildSpeedMult = d.buildSpeedMult || 1;
        labUpgradeEndsAt = lab.isUpgrading ? (lab.upgradeEndsAt || null) : null;
      }
      // Research speed is per-planet; actual time = nextResearchTime × this mult.
      try {
        const r = await apiFetch(`/api/research?planetId=${p.id}`, options);
        researchPlanets.push({ id: p.id, name: p.name || `Planet #${p.id}`, mult: r.researchSpeedMult || 1 });
      } catch { /* skip this planet's slot */ }
    }
    tot.labLevel = labLevel;
    tot.labDef = labDef;
    tot.buildSpeedMult = buildSpeedMult;
    tot.labUpgradeEndsAt = labUpgradeEndsAt;
    tot.planetCount = planets.length;
    tot.researchPlanets = researchPlanets;
    tot.planetSpeeds = researchPlanets.map(rp => rp.mult);
    return tot;
  } catch (err) {
    return { error: err.message };
  }
}

// Your alliance tag + member ids, so the finder can flag alliance-owned
// planets it scans.
async function getAlliance(options = {}) {
  try {
    const data = await apiFetch('/api/alliances/my', options);
    const a = data.alliance || {};
    const members = a.members || [];
    return {
      tag: a.tag || null,
      name: a.name || null,
      memberIds: members.map(m => m.userId).filter(x => x != null),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Look up a player's per-category leaderboard ranks by exact name (finder
// rank columns). `category=` re-ranks the board; `rank` then holds that
// category's rank. One request per category.
async function getPlayerRanks(name, options = {}) {
  if (!name) return { military: null, economy: null, research: null };
  const out = { military: null, economy: null, research: null };
  for (const cat of ['military', 'economy', 'research']) {
    const data = await apiGet(`/api/rankings/players?category=${cat}&search=${encodeURIComponent(name)}`, options);
    if (data.error) return data;
    const lb = data.leaderboard || [];
    const e = lb.find(x => x.username === name) || lb[0];
    if (e) out[cat] = e.rank;
  }
  return out;
}

// A player's current alliance tag by exact username (asteroid field outpost
// owners), via the same leaderboard search endpoint.
async function getPlayerAllianceTag(name, options = {}) {
  if (!name) return { tag: null };
  const data = await apiGet(`/api/rankings/players?category=military&search=${encodeURIComponent(name)}`, options);
  if (data.error) return data;
  const e = (data.leaderboard || []).find(x => x.username === name);
  return { tag: e ? (e.allianceTag || null) : null };
}

// All open orders from a paginated orders endpoint (public market or alliance
// trade), across every page.
async function getOrders(path, options = {}) {
  try {
    const first = await apiFetch(`${path}?page=1&limit=100`, options);
    const limit = first.pagination?.limit || 100;        // server may cap below 100
    const total = first.pagination?.total ?? (first.orders || []).length;
    const orders = [...(first.orders || [])];
    const pages = Math.ceil(total / limit);
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          apiFetch(`${path}?page=${i + 2}&limit=${limit}`, { ...options, priority: 'bulk' })
            .then(d => d.orders || []).catch(() => [])));
      for (const o of rest) orders.push(...o);
    }
    return { orders };
  } catch (err) {
    return { error: err.message };
  }
}

// Full personal market history. Fetch every page so profit/net-flow totals
// cover the complete account history instead of just the first page.
async function getMarketTrades(options = {}) {
  try {
    const first = await apiFetch('/api/market/my-trades?page=1&limit=100', options);
    const trades = [...(Array.isArray(first) ? first : first.trades || [])];
    const pagination = Array.isArray(first) ? null : first.pagination;
    const limit = pagination?.limit || 100;
    const total = pagination?.total ?? trades.length;
    const pages = Math.ceil(total / limit);
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          apiFetch(`/api/market/my-trades?page=${i + 2}&limit=${limit}`, { ...options, priority: 'bulk' })
            .then(data => Array.isArray(data) ? data : data.trades || [])));
      for (const page of rest) trades.push(...page);
    }
    return { trades };
  } catch (err) {
    return { error: err.message };
  }
}

// Authenticated GET for dashboard pages, routed through the logged-in game tab.
async function apiGet(path, options) {
  try {
    return await apiFetch(path, options);
  } catch (err) {
    return { error: err.message, status: err.status };
  }
}

// ── API ────────────────────────────────────────────────────────────────────

const MISSING_GAME_FETCH_RECEIVER = /Receiving end does not exist|Could not establish connection|No matching message handler|message port closed before a response was received/i;

function isMissingGameFetchReceiver(error) {
  return MISSING_GAME_FETCH_RECEIVER.test(String(error?.message || error || ''));
}

async function injectGameApiBridge(tabId) {
  if (!browser.scripting?.executeScript) {
    throw new Error('Browser does not support automatic bridge injection. Reload the game tab and try again.');
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['game-api-bridge.js'],
    });
  } catch (error) {
    throw new Error(`Failed to inject game API bridge script: ${error.message}`, { cause: error });
  }
}

async function sendGameFetchMessage(tabId, message) {
  try {
    const response = await browser.tabs.sendMessage(tabId, message);
    if (response) return response;
  } catch (error) {
    if (!isMissingGameFetchReceiver(error)) throw error;
  }

  await injectGameApiBridge(tabId);
  const response = await browser.tabs.sendMessage(tabId, message);
  if (!response) throw new Error('Game tab returned no response. Reload the game tab and try again.');
  return response;
}

// The game now authenticates API calls with an HttpOnly session cookie rather
// than the old nexus_token Bearer header. Run requests in a game content script
// so they are same-origin and the browser attaches that cookie itself.
async function requestFromGameTab(path, { method = 'GET', body, serverOrigin } = {}) {
  if (!serverOrigin) await syncGameServer();
  const tabs = await browser.tabs.query({ url: `${serverOrigin || GAME_URL}/*` });
  if (!tabs.length) {
    throw new Error('Open the logged-in game tab first.');
  }
  const requestKey = `${tabs[0].id}:${path.split('?')[0]}`;
  activeGameRequests.set(requestKey, (activeGameRequests.get(requestKey) || 0) + 1);
  try {
    return await sendGameFetchMessage(tabs[0].id, { type: 'GAME_FETCH', method, path, body });
  } catch (error) {
    throw new Error(`Unable to request API through game tab: ${error.message}`, { cause: error });
  } finally {
    const remaining = activeGameRequests.get(requestKey) - 1;
    if (remaining) activeGameRequests.set(requestKey, remaining);
    else activeGameRequests.delete(requestKey);
  }
}

async function requestOrigin(serverOrigin) {
  if (serverOrigin) return serverOrigin;
  await syncGameServer();
  return GAME_URL;
}

function scheduledGameRequest(path, options) {
  return apiScheduler.schedule({ origin: options.serverOrigin, path, ...options },
    () => requestFromGameTab(path, options));
}

class NexusAPIError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.name = 'NexusAPIError';
    this.status = status;
  }
}

async function apiFetch(path, { polite = false, serverOrigin, priority = 'background', signal, source = 'background-maintenance' } = {}) {
  serverOrigin = await requestOrigin(serverOrigin);
  let delayMs = 1000;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let r;
    try {
      r = await scheduledGameRequest(path, { method: 'GET', serverOrigin, polite, priority, signal, source,
        fallback: Math.max(5000, delayMs) });
    } catch (e) {
      throw new NexusAPIError(0, `API ${path} → ${e.message}`, { cause: e });
    }

    if (r.networkError) {
      const error = new NexusAPIError(0, `API ${path} → network error: ${r.error}`);
      if (attempt === maxAttempts) throw error;
      await new Promise(res => setTimeout(res, delayMs));
      delayMs *= 2;
      continue;
    }

    if (r.ok) return r.data || {};

    const status = Number(r.status) || 0;
    const message = r.error || `Request failed with status ${status}`;
    const rateLimitWait = status === 429 ? retryAfterMs(r.retryAfter, Math.max(5000, delayMs)) : 0;
    if (status === 401) {
      throw new NexusAPIError(401, `API ${path} → Unauthorized. Please log in to Nexus Legacy.`);
    }
    if (r.parseError) {
      throw new NexusAPIError(status, `API ${path} → ${message}`);
    }
    if ((status === 429 || status >= 500) && attempt < maxAttempts) {
      const waitMs = status === 429 ? rateLimitWait : retryAfterMs(r.retryAfter, delayMs);
      await new Promise(res => setTimeout(res, waitMs));
      delayMs *= 2;
      continue;
    }

    throw new NexusAPIError(status, `API ${path} → ${message}`);
  }

  throw new NexusAPIError(0, `API ${path} → request failed after ${maxAttempts} attempts`);
}

// Home planet id, discovered once via /api/planets and cached.
async function getHomePlanetId() {
  const { planet_id } = await browser.storage.local.get('planet_id');
  if (planet_id) return planet_id;
  const data = await apiFetch('/api/planets');
  const planets = data.planets || [];
  const home = planets.find(p => p.isHomeworld) || planets[0];
  if (!home) throw new Error('No planets found for this account');
  await browser.storage.local.set({ planet_id: home.id });
  console.log(`[NexusOverseer] Home planet: ${home.name} (#${home.id})`);
  return home.id;
}

// ── Fuel ─────────────────────────────────────────────────────────────────────
// Hydrogen burned by a mission: fuel = Σ(fuelRate × qty) × (FUEL_K × distance + FUEL_BASE)
// Constants fitted to 14 real send-fleet costs spanning mixed fleets and
// distances (mean error ~6%). Verified accurate for survey missions.
// NOTE: m.distance from the API is NOT in the same units as galaxy-map
// coordinates — the simulator uses COORD_TO_FUEL_AU (1/57.4) to convert.
const FUEL_K    = 0.0496;
const FUEL_BASE = 3.48;

// Map a mission type to a dashboard tab key for fuel accounting.
function fuelMissionType(t) {
  const s = (t || '').toLowerCase();
  if (s.includes('debris')) return 'debris';
  if (s.includes('xeno')) return 'xeno';   // must precede the 'survey' check below
  if (s.includes('survey') || s.includes('investigate') || s.includes('anomaly')) return 'survey';
  if (s.includes('min')) return 'mining';
  if (s.includes('raid') || s.includes('pirate') || s.includes('attack')) return 'pirate';
  if (s.includes('expedition') || s.includes('wormhole')) return 'expedition';
  return 'other';
}

function fleetFuelRate(fleetMap, ships) {
  // `ships` is keyed by numeric id; build a key→def index (fleets use keys).
  const byKey = {};
  for (const d of Object.values(ships || {})) if (d && d.key) byKey[d.key] = d;
  let rate = 0;
  for (const [key, qty] of Object.entries(fleetMap || {})) {
    const def = ships[key] || byKey[key];
    if (def) rate += (def.fuelRate || 0) * qty;
  }
  return rate;
}

// Precise fuel from a captured mission: its real fleet + real distance.
function missionFuel(mo, ships) {
  if (!mo || mo.distance == null || !(mo.fleet && mo.fleet.length)) return null;
  const fleetMap = mo.fleet.reduce((m, i) => { m[i.key] = (m[i.key] || 0) + (i.quantity || 1); return m; }, {});
  const rate = fleetFuelRate(fleetMap, ships);
  if (!rate) return null;
  return Math.round(rate * (FUEL_K * mo.distance + FUEL_BASE));
}

// Exact fuel from the game's own fuel-estimate, using the mission's real fleet
// and route. Returns null if the route/fleet is incomplete or no game tab is
// open (the POST must route through one) — caller falls back to missionFuel().
async function apiMissionFuel(m) {
  if (m.sourcePlanetId == null || m.targetSystemId == null) return null;
  const ships = (m.fleetComposition || [])
    .map(f => ({ shipDefId: f.shipDefId, quantity: f.quantity || 1 }))
    .filter(s => s.shipDefId != null && s.quantity > 0);
  if (!ships.length) return null;
  const r = await gamePost('/api/fleet/fuel-estimate', {
    sourcePlanetId: m.sourcePlanetId, targetSystemId: m.targetSystemId, ships,
  });
  const data = (r && r.ok) ? r.data : r;
  return (data && data.error == null && data.fuelCost != null) ? data.fuelCost : null;
}

// Current stationed fleet as { shipKey: usableQuantity } — for the simulator.
async function getPlanets(options = {}) {
  try {
    const data = await apiFetch('/api/planets', options);
    const planets = (data.planets || []).map(p => ({
      id: p.id,
      name: p.name || `Planet ${p.id}`,
      isHomeworld: !!p.isHomeworld,
      systemId: p.systemId ?? p.system?.id ?? null,
      systemName: p.systemName || null,
    }));
    return { planets };
  } catch (err) {
    return { error: err.message };
  }
}

// Bird's-eye data for the Dashboard tab: running missions + fleet slots,
// account-wide active research, and per colony the construction queue, ship
// queue, resource stock and stationed fleet split by class.
// Own moon ids are only discoverable via the galaxy view of the systems my planets
// sit in, so cache them (moon ownership rarely changes).
const MOON_IDS_TTL = 30 * 60 * 1000;
const moonIdsCaches = new Map();
async function getOwnMoonIds(planetList, opts) {
  const sysIds = [...new Set(planetList.map(p => p.systemId).filter(x => x != null))].sort();
  const serverKey = opts?.serverKey || await galaxyServerKey();
  const key = `${serverKey}:${sysIds.join(',')}`;
  const moonIdsCache = moonIdsCaches.get(key) || { at: 0, ids: [] };
  if (moonIdsCache.key === key && Date.now() - moonIdsCache.at < MOON_IDS_TTL) return moonIdsCache.ids;
  try {
    const me = await apiFetch('/api/auth/me', opts);
    const myId = me.user && (me.user.id ?? me.user.userId);
    if (myId == null) return moonIdsCache.ids;
    const ids = [];
    for (const s of sysIds) {
      let sd;
      try { sd = await galaxyCache.system(serverKey, s, { group: 'moons', maxAge: MOON_IDS_TTL, priority: opts?.priority }); }
      catch (error) {
        console.warn(`[NexusOverseer] Unable to refresh moons in system ${s}:`, error);
        continue;
      }
      for (const mo of (sd.moons || [])) if (mo.userId != null && mo.userId === myId) ids.push(mo.id);
    }
    moonIdsCaches.set(key, { key, at: Date.now(), ids });
    return ids;
  } catch {
    return moonIdsCache.ids;
  }
}

// One shipyard for the dashboard: running job first, queued jobs after it.
function makeShipYard(label, exists, queue, max, future) {
  const items = (queue || [])
    .filter(it => it.status === 'pending' || future(it.endsAt))
    .map(it => ({
      name: it.shipName || it.shipKey || 'Ship',
      quantity: Math.max(1, (it.quantity || 1) - (it.completed || 0)),
      repair: !!(it.isRepair || it.operation === 'repair'),
      endsAt: it.status === 'pending' ? null : it.endsAt,
    }));
  return { label, exists, max: max ?? 3, items };
}

// Damaged hangar ships (broken drills included) that are not already in a repair job.
function damagedShips(fleet, shipYards) {
  const repairing = {};
  for (const y of shipYards) for (const it of y.items) if (it.repair) repairing[it.name] = (repairing[it.name] || 0) + it.quantity;
  const out = [];
  for (const f of (fleet || [])) {
    const name = f.definition?.name || f.definition?.key || 'Ship';
    const left = (f.damagedQuantity || 0) - (repairing[name] || 0);
    if (left > 0) out.push({ name, quantity: left });
    if (repairing[name]) repairing[name] = Math.max(0, repairing[name] - (f.damagedQuantity || 0));
  }
  return out;
}

async function getDashboardOverview({ polite = true, ...options } = {}) {
  const opts = { ...options, polite, priority: polite ? 'background' : options.priority || 'interactive' };
  try {
    const [planetsData, missionsData, researchData] = await Promise.all([
      apiFetch('/api/planets', opts),
      apiFetch(MISSIONS_PATH, opts).catch(() => ({ missions: [] })),
      apiFetch(RESEARCH_PATH, opts).catch(() => ({})),
    ]);
    const now = Date.now();
    const future = t => t && new Date(t).getTime() > now;

    const planets = [];
    for (const p of (planetsData.planets || [])) {
      const [detail, fleetData, yard] = await Promise.all([
        apiFetch(`/api/planets/${p.id}`, opts).catch(() => null),
        apiFetch(`/api/planets/${p.id}/fleet`, opts).catch(() => null),
        apiFetch(`/api/planets/${p.id}/shipyard`, opts).catch(() => null),
      ]);
      const pl = detail?.planet || p;
      const construction = (detail?.buildings || [])
        .filter(b => b.queueId != null || (b.isUpgrading && future(b.upgradeEndsAt)))
        .map(b => ({
          key: b.definition?.key,
          name: b.definition?.name || b.definition?.key || 'Building',
          level: b.queueTargetLevel || (b.level || 0) + 1,
          endsAt: b.isUpgrading ? b.upgradeEndsAt : null,
          upgrading: !!(b.isUpgrading && future(b.upgradeEndsAt)),
          pending: b.queueStatus === 'pending',
          order: b.queueId ?? 0,
        }))
        .sort((a, b) => (a.pending - b.pending) || (a.order - b.order));
      const hasBuilding = key => (detail?.buildings || []).some(b => b.definition?.key === key && (b.level || 0) > 0);
      const shipYards = [
        ['Planetary shipyard', 'p_shipyard', yard?.planetaryQueueAll],
        ['Orbital shipyard', 'orbital_dock', yard?.orbitalQueueAll],
      ].map(([label, key, q]) => makeShipYard(label, hasBuilding(key) || (q || []).length > 0, q, yard?.maxQueueSize, future));
      const classes = {};
      let totalShips = 0;
      for (const f of (fleetData?.fleet || [])) {
        const q = f.quantity || 0;
        const cls = (f.definition?.shipClass || 'other').toLowerCase();
        classes[cls] = (classes[cls] || 0) + q;
        totalShips += q;
      }
      planets.push({
        id: p.id,
        name: pl.name || p.name || `Planet ${p.id}`,
        systemName: detail?.systemInfo?.systemName || p.systemName || null,
        isHomeworld: !!(p.isHomeworld ?? pl.isHomeworld),
        sortOrder: pl.sortOrder ?? p.sortOrder ?? null,
        hasLab: (detail?.buildings || []).some(b => b.definition?.key === 'research_lab' && (b.level || 0) > 0),
        planetType: pl.planetType || null,
        population: pl.population ?? null,
        maxPopulation: pl.maxPopulation ?? null,
        populationRate: pl.populationGrowthRate ?? null,
        buildSlots: { used: pl.usedBuildingSlots ?? null, max: pl.maxBuildingSlots ?? null },
        resources: {
          ore: pl.ore || 0, silicates: pl.silicates || 0, hydrogen: pl.hydrogen || 0, alloys: pl.alloys || 0,
          oreStorage: pl.oreStorage || 0, silicatesStorage: pl.silicatesStorage || 0, hydrogenStorage: pl.hydrogenStorage || 0, alloysStorage: pl.alloysStorage || 0,
          oreRate: pl.oreRate || 0, silicatesRate: pl.silicatesRate || 0,
          hydrogenRate: pl.hydrogenRate || 0, alloysRate: pl.alloysRate || 0,
          cryoIce: pl.cryoIce || 0, quantumDust: pl.quantumDust || 0, plasmaCore: pl.plasmaCore || 0,
          bioExtract: pl.bioExtract || 0, darkMatter: pl.darkMatter || 0, antimatter: pl.antimatter || 0,
          cryoIceRate: pl.cryoIceRate || 0, quantumDustRate: pl.quantumDustRate || 0, plasmaCoreRate: pl.plasmaCoreRate || 0,
          bioExtractRate: pl.bioExtractRate || 0, darkMatterRate: pl.darkMatterRate || 0, antimatterRate: pl.antimatterRate || 0,
          rareStorage: pl.rareResourceStorage || 0,
        },
        construction,
        queueMax: detail?.buildQueueMax ?? null,
        shipYards,
        damaged: damagedShips(fleetData?.fleet, shipYards),
        fleet: { total: totalShips, classes },
      });
    }
    planets.sort((a, b) => ((a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)) || (b.isHomeworld - a.isHomeworld) || (a.id - b.id));

    const moons = [];
    for (const mid of await getOwnMoonIds(planetsData.planets || [], opts)) {
      const [det, fl] = await Promise.all([
        apiFetch(`/api/moons/${mid}`, opts).catch(() => null),
        apiFetch(`/api/moons/${mid}/shipyard`, opts).catch(() => null),
      ]);
      const mo = det?.moon;
      if (!mo) continue;
      const classes = {};
      let totalShips = 0;
      for (const f of (fl?.fleet || [])) {
        const q = f.quantity || 0;
        const cls = (f.definition?.shipClass || 'other').toLowerCase();
        classes[cls] = (classes[cls] || 0) + q;
        totalShips += q;
      }
      const moonYards = [makeShipYard('Moon dockyard', (fl?.dockyardLevel || 0) > 0 || (fl?.queueAll || []).length > 0, fl?.queueAll, fl?.maxQueueSize, future)];
      moons.push({
        id: mid,
        name: mo.name || `Moon #${mid}`,
        systemName: (planets.find(x => x.id === mo.planetId) || {}).systemName || null,
        isMoon: true,
        parentPlanetId: mo.planetId ?? null,
        planetType: mo.moonType || mo.type || null,
        population: null,
        maxPopulation: null,
        buildSlots: { used: (det.buildings || []).length, max: mo.buildingSlots ?? null },
        resources: {
          ore: mo.ore || 0, silicates: mo.silicates || 0, hydrogen: mo.hydrogen || 0, alloys: mo.alloys || 0,
          oreStorage: mo.storage || 0, silicatesStorage: mo.storage || 0, hydrogenStorage: mo.storage || 0, alloysStorage: mo.storage || 0,
          oreRate: mo.oreRate || 0, silicatesRate: mo.silicatesRate || 0,
          hydrogenRate: mo.hydrogenRate || 0, alloysRate: mo.alloysRate || 0,
          cryoIce: mo.cryoIce || 0, quantumDust: mo.quantumDust || 0, plasmaCore: mo.plasmaCore || 0,
          bioExtract: mo.bioExtract || 0, darkMatter: mo.darkMatter || 0, antimatter: mo.antimatter || 0,
          cryoIceRate: mo.cryoIceRate || 0, quantumDustRate: mo.quantumDustRate || 0, plasmaCoreRate: mo.plasmaCoreRate || 0,
          bioExtractRate: mo.bioExtractRate || 0, darkMatterRate: mo.darkMatterRate || 0, antimatterRate: mo.antimatterRate || 0,
        },
        construction: (det.buildings || [])
          .filter(b => b.isUpgrading && future(b.upgradeEndsAt))
          .map(b => ({ name: b.name || b.key || 'Building', level: b.queueTargetLevel || (b.level || 0) + 1, endsAt: b.upgradeEndsAt }))
          .sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt)),
        shipYards: moonYards,
        damaged: damagedShips(fl?.fleet, moonYards),
        fleet: { total: totalShips, classes },
      });
    }
    const activeRaw = researchData.activeResearches || (researchData.activeResearch ? [researchData.activeResearch] : []);
    const planetName = Object.fromEntries(planets.map(p => [p.id, p.name]));
    const researchLevel = Object.fromEntries((researchData.research || []).map(x => [x.id, x.level]));
    const research = activeRaw
      .filter(r => future(r.endsAt))
      .map(r => ({
        name: r.name || r.researchName || r.definition?.name || r.researchKey || r.key || 'Research',
        level: (researchLevel[r.id] ?? null) == null ? null : researchLevel[r.id] + 1,
        planetId: r.planetId ?? null,
        planetName: planetName[r.planetId] || null,
        endsAt: r.endsAt,
      }))
      .sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));

    const missions = (missionsData.missions || []).map(m => ({
      id: m.id,
      type: m.missionType || 'unknown',
      status: m.status || null,
      sourcePlanetId: m.sourcePlanetId ?? null,
      arrivesAt: m.arrivesAt || null,
      returnArrivesAt: m.returnArrivesAt || null,
      returnDepartsAt: m.returnDepartsAt || null,
      nextCycleAt: m.cargo?._nextCycleAt || null,
      cycleStartedAt: m.cargo?._cycleStartedAt || null,
      departsAt: m.departsAt || m.createdAt || null,
      travelTime: m.travelTime ?? null,
      ships: (m.fleetComposition || []).reduce((s, f) => s + (f.quantity || 0), 0),
    }));

    // Colony and moon limits come from the colony-status endpoints; the research
    // effect sums are only a fallback (they omit the base value for colonies).
    const slots = { colonies: 0, moons: 0 };
    for (const r of (researchData.research || [])) {
      for (const e of (r.effects || [])) {
        if (e.type === 'colony_slots') slots.colonies += (e.value || 0) * (r.level || 0);
        if (e.type === 'moon_slots') slots.moons += (e.slots || 0) * (r.level || 0);
      }
    }
    const [moonStatus, colonyStatus] = await Promise.all([
      apiFetch('/api/moons/colony-status', opts).catch(() => null),
      apiFetch('/api/galaxy/colony-status', opts).catch(() => null),
    ]);
    if (Number.isFinite(moonStatus?.maxMoons)) slots.moons = moonStatus.maxMoons;
    if (Number.isFinite(colonyStatus?.maxColonies)) slots.colonies = colonyStatus.maxColonies;

    const lead = await apiFetch('/api/leadership', opts).catch(() => null);
    const commander = lead?.unlocked && lead.vessel
      ? {
        callsign: lead.vessel.callsign,
        talentPoints: lead.vessel.unspentTalentPoints || 0,
        missingHull: lead.repair?.missingHull || Math.max(0, (lead.vessel.maxHullIntegrity || 0) - (lead.vessel.hullIntegrity || 0)),
        maxHull: lead.vessel.maxHullIntegrity || 0,
      }
      : null;

    return {
      planets, moons, research, missions, slots, commander,
      maxFleetSlots: missionsData.maxFleetSlots ?? null,
      researchSlots: planets.filter(p => p.hasLab).length,
      fetchedAt: now,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function getFleet(planetId, options = {}) {
  try {
    let targets;
    if (planetId === 'all') {
      const data = await apiFetch('/api/planets', options);
      targets = (data.planets || []).map(p => p.id);
    } else {
      targets = [planetId || await requestHomePlanetId(options)];
    }
    const fleet = {};
    for (const id of targets) {
      const data = await apiFetch(`/api/planets/${id}/fleet`, options);
      for (const f of (data.fleet || [])) {
        const key = f.definition?.key;
        const qty = (f.quantity || 0) - (f.damagedQuantity || 0);
        if (key && qty > 0) fleet[key] = (fleet[key] || 0) + qty;
      }
    }
    return { fleet };
  } catch (err) {
    return { error: err.message };
  }
}

// Full ship catalog (all types, owned or not) from the shipyard, so templates
// can include combat escorts you don't currently field. Raw shipDefId (= the
// shipyard ship id) is what the mine endpoint needs.
async function requestHomePlanetId(options) {
  if (!options.serverOrigin) return getHomePlanetId();
  const data = await apiFetch('/api/planets', options);
  const planets = data.planets || [];
  const home = planets.find(planet => planet.isHomeworld) || planets[0];
  if (!home) throw new Error('No planets found for this account');
  return home.id;
}

async function getShipDefs(options = {}) {
  try {
    const serverOrigin = await requestOrigin(options.serverOrigin);
    options = { ...options, serverOrigin };
    const planetId = await requestHomePlanetId(options);
    const [data, me] = await Promise.all([
      apiFetch(`/api/planets/${planetId}/shipyard`, options),
      apiFetch('/api/auth/me', options).catch(() => ({})),
    ]);
    const race = me.user?.race || null;
    const ships = (data.ships || []).map(s => ({
      shipDefId: s.id,
      key: s.key || '',
      name: s.name || `#${s.id}`,
      cargoCapacity: s.cargoCapacity || 0,
      imageUrl: (race && s.key) ? `${serverOrigin}/api/images/ships/${race}/${s.key}.webp` : null,
      shipClass: s.shipClass || '',
      miningCargo: s.miningCargoCapacity || 0,
      sortOrder: s.sortOrder || 0,
      attack: s.attack || 0,
      hp: s.hp || 0,
      shieldHp: s.shieldHp || 0,
      weaponType: s.weaponType || null,
      armorType: s.armorType || '',
    }));
    return { ships };
  } catch (err) {
    return { error: err.message };
  }
}

// Ships actually available on one planet, as { shipDefId: undamagedQuantity }.
async function getPlanetShips(planetId, options = {}) {
  if (planetId == null) return { error: 'No planet selected.' };
  try {
    const data = await apiFetch(`/api/planets/${planetId}/fleet`, options);
    const available = {};
    for (const f of (data.fleet || [])) {
      const qty = (f.quantity || 0) - (f.damagedQuantity || 0);
      if (qty > 0) available[f.shipDefId] = qty;
    }
    return { available };
  } catch (err) {
    return { error: err.message };
  }
}

// POST through the game tab's content script so requests are same-origin
// requests include the logged-in session cookie and match the game's origin.
// identical to the game's own call. A Bearer request straight from the
// extension is rejected by the server (500).
function retryAfterMs(value, fallbackMs) {
  return retryDelay(value, fallbackMs);
}

async function gamePost(path, body, { retry429 = true, serverOrigin, priority = 'action', signal, source = 'fleet-action' } = {}) {
  if (body.ships && !body.ships.length) return { error: 'No ships selected.' };
  try {
    serverOrigin = await requestOrigin(serverOrigin);
    // Retry on 429, honouring Retry-After, then exponential backoff — same policy as apiFetch.
    for (let attempt = 0; ; attempt++) {
      const r = await scheduledGameRequest(path, { method: 'POST', body, serverOrigin, priority, signal, source,
        fallback: Math.max(5000, 1000 * 2 ** attempt) });
      if (Number(r?.status) === 429) {
        const waitMs = retryAfterMs(r.retryAfter, Math.max(5000, 1000 * 2 ** attempt));
        if (retry429 && attempt < 4) {
          await new Promise(res => setTimeout(res, waitMs));
          continue;
        }
      }
      return r;
    }
  } catch (e) {
    console.error(`[NexusOverseer] API POST ${path} failed:`, e);
    return { error: e.message };
  }
}

// The simulator may have a tighter limit than the global API budget. Serialize
// all dashboard/planner callers, not just the ship types in one planner run.
const SIM_MIN_INTERVAL_MS = 500;
const SIM_MAX_INTERVAL_MS = 2000;
const SIM_RECOVERY_SUCCESSES = 10;
const SIM_RETRY_DELAY_MS = 5000;
const SIM_MAX_RETRIES = 3;
const SIM_FAILURE_COOLDOWN_MS = 30000;
const simulationStates = new Map();

function simulationRateLimitError(state) {
  const seconds = Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 1000));
  return {
    status: 429,
    retryAfter: String(seconds),
    error: `Combat simulator API rate limit reached. Try again in ${seconds} seconds.`,
  };
}

async function simulateCombat(attacker, defender, serverOrigin) {
  if (!attacker?.fleet?.length) return { error: 'Attacker needs at least one ship.' };
  if (!defender?.fleet?.length && !Object.keys(defender?.planetaryDefense?.levels || {}).length) {
    return { error: 'Defender needs ships, or a planetary defence level.' };
  }
  serverOrigin = await requestOrigin(serverOrigin);
  if (!simulationStates.has(serverOrigin)) simulationStates.set(serverOrigin, {
    queue: Promise.resolve(), interval: SIM_MIN_INTERVAL_MS, successes: 0, nextAt: 0, blockedUntil: 0,
  });
  const state = simulationStates.get(serverOrigin);
  const run = async () => {
    if (Date.now() < state.blockedUntil) return simulationRateLimitError(state);
    for (let attempt = 0; ; attempt++) {
      const waitMs = Math.max(state.nextAt, state.blockedUntil) - Date.now();
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      const response = await gamePost('/api/combat-simulator/simulate', { attacker, defender },
        { retry429: false, serverOrigin, priority: 'bulk', source: 'simulator' });
      if (response?.status !== 429) {
        if (response?.ok) {
          if (++state.successes >= SIM_RECOVERY_SUCCESSES) {
            state.interval = Math.max(SIM_MIN_INTERVAL_MS, state.interval - 50);
            state.successes = 0;
          }
        } else {
          state.successes = 0;
        }
        state.nextAt = Date.now() + state.interval;
        if (response?.rateLimitRemaining != null && Number(response.rateLimitRemaining) <= 0) {
          const resetMs = Number(response.rateLimitReset) * 1000;
          if (Number.isFinite(resetMs)) state.nextAt = Math.max(state.nextAt, Date.now() + resetMs);
        }
        return response;
      }
      state.interval = Math.min(SIM_MAX_INTERVAL_MS, state.interval * 2);
      state.successes = 0;
      const exhausted = attempt >= SIM_MAX_RETRIES;
      // A reset header alone does not mean the simulator's budget is exhausted.
      const resetMs = response.rateLimitRemaining == null || Number(response.rateLimitRemaining) <= 0
        ? Number(response.rateLimitReset) * 1000 : 0;
      state.blockedUntil = Date.now() + Math.max(
        exhausted ? SIM_FAILURE_COOLDOWN_MS : 0,
        SIM_RETRY_DELAY_MS,
        retryAfterMs(response.retryAfter, SIM_RETRY_DELAY_MS * 2 ** attempt),
        Number.isFinite(resetMs) ? resetMs : 0,
      );
      if (exhausted) {
        await apiScheduler.observe(serverOrigin, '/api/combat-simulator/simulate', {
          status: 429, rateLimitScope: 'simulator',
          retryAfter: String(Math.ceil((state.blockedUntil - Date.now()) / 1000)),
        });
        return simulationRateLimitError(state);
      }
    }
  };
  const result = state.queue.then(run);
  state.queue = result.then(() => {}, () => {});
  return result;
}

// ── Processing queue ───────────────────────────────────────────────────────
// All storage writes go through one chain so an intercepted game response
// and a scheduled scrape can never interleave their read-modify-write cycles.

let processing = Promise.resolve();

function enqueue(fn) {
  processing = processing.then(fn).catch(async err => {
    console.error('[NexusOverseer] Processing failed:', err);
    await browser.storage.local.set({ last_error: err.message });
  });
  return processing;
}

// ── Report archives ─────────────────────────────────────────────────────────
// Uncapped history, sharded by month (`survey_archive_2026-06`, …) so a scrape
// only rewrites the current month instead of the whole history. The index
// tracks shard months and counts per type.

const ARCHIVE_TYPES = ['survey', 'pirate', 'mining', 'exp', 'xeno'];

// Backfills any ARCHIVE_TYPES entry missing from a stored index (e.g. a type
// added after the index was first written, like 'xeno') so every caller can
// assume idx[type] exists without checking.
async function getArchiveIndex() {
  const { archive_index } = await browser.storage.local.get('archive_index');
  const idx = archive_index || {};
  for (const t of ARCHIVE_TYPES) if (!idx[t]) idx[t] = { months: [], count: 0 };
  return idx;
}

async function appendToArchive(type, records) {
  if (!records.length) return;
  const index = await getArchiveIndex();
  const byMonth = {};
  for (const r of records) {
    const m = (r.created_at || '').slice(0, 7) || 'unknown';
    (byMonth[m] = byMonth[m] || []).push(r);
  }
  for (const [m, recs] of Object.entries(byMonth)) {
    const key = `${type}_archive_${m}`;
    const cur = (await browser.storage.local.get(key))[key] || [];
    await browser.storage.local.set({ [key]: [...recs, ...cur] });
    if (!index[type].months.includes(m)) index[type].months.push(m);
    index[type].count += recs.length;
  }
  index[type].months.sort();
  await browser.storage.local.set({ archive_index: index });
}

async function loadArchive(type) {
  const index = await getArchiveIndex();
  const keys = index[type].months.map(m => `${type}_archive_${m}`);
  if (!keys.length) return [];
  const got = await browser.storage.local.get(keys);
  const out = [];
  for (const k of keys) out.push(...(got[k] || []));
  return out;
}

// Drop every stored record older than `days`, keeping only the recent window,
// then recompute aggregates from what remains. Trims the monthly archive shards
// and the capped recents; empty shards are removed. Seen-id sets are left alone
// so a re-scrape doesn't re-import the purged reports.
async function purgeOldData(days = 3) {
  const cutoff = Date.now() - days * 86400000;
  const keep = r => new Date(r.created_at || 0).getTime() >= cutoff;
  const index = await getArchiveIndex();
  const patch = {};
  const remove = [];
  for (const type of ARCHIVE_TYPES) {
    const months = index[type].months || [];
    const keys = months.map(m => `${type}_archive_${m}`);
    const got = keys.length ? await browser.storage.local.get(keys) : {};
    const keptMonths = [];
    let count = 0;
    for (const m of months) {
      const key = `${type}_archive_${m}`;
      const kept = (got[key] || []).filter(keep);
      if (kept.length) { patch[key] = kept; keptMonths.push(m); count += kept.length; }
      else remove.push(key);
    }
    index[type] = { months: keptMonths, count };
  }
  patch.archive_index = index;
  const recentKeys = ['recent_reports', 'pirate_recent_reports', 'mining_recent_reports', 'exp_recent_reports'];
  const recents = await browser.storage.local.get(recentKeys);
  for (const k of recentKeys) if (Array.isArray(recents[k])) patch[k] = recents[k].filter(keep);
  await browser.storage.local.set(patch);
  if (remove.length) await browser.storage.local.remove(remove);
  await rebuildAggregates();
  return { ok: true };
}

// ── Processors ─────────────────────────────────────────────────────────────

function parseShipsLost(shipsLost) {
  const counts = {};
  for (const item of (shipsLost || [])) {
    const id = item.shipDefId;
    if (id != null) counts[id] = (counts[id] || 0) + (item.quantity || 1);
  }
  return counts;
}

// A damaged ship costs half its build cost to repair.
const REPAIR_FACTOR = 0.5;

function emptyResources() {
  return { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
}

// Value a tolerant ship-loss array into `into`. Items may be keyed by
// shipDefId ({ shipDefId, quantity }) or by ship key ({ key, lost }) — combat
// results (shipsDestroyed) use the latter. ships is the defId-keyed catalog.
function addLossCost(arr, ships, into, factor = 1) {
  if (!arr || !arr.length) return;
  let byKey = addLossCost._byKey;
  if (!byKey || byKey._for !== ships) {
    byKey = { _for: ships };
    for (const s of Object.values(ships)) if (s && s.key) byKey[s.key] = s;
    addLossCost._byKey = byKey;
  }
  for (const it of arr) {
    const ship = (it.shipDefId != null && ships[it.shipDefId]) || (it.key && byKey[it.key]);
    if (!ship) continue;
    const q = (it.quantity ?? it.lost ?? it.destroyed ?? 1) * factor;
    into.ore += q * (ship.costOre || 0);
    into.silicates += q * (ship.costSilicates || 0);
    into.hydrogen += q * (ship.costHydrogen || 0);
    into.alloys += q * (ship.costAlloys || 0);
    for (const [k, v] of Object.entries(ship.rareCosts || {})) {
      into.rare[k] = (into.rare[k] || 0) + q * v;
    }
  }
}
function emptyLost() {
  return { destroyed: emptyResources(), repair: emptyResources() };
}

// Add the build-cost value of a { shipDefId: qty } map into `into`, scaled by
// factor (1 for destroyed ships, REPAIR_FACTOR for damaged ones).
function addShipCost(detail, ships, into, factor) {
  for (const [defId, qty] of Object.entries(detail || {})) {
    const ship = ships[defId];
    if (!ship) continue;
    const q = qty * factor;
    into.ore += q * ship.costOre;
    into.silicates += q * ship.costSilicates;
    into.hydrogen += q * ship.costHydrogen;
    into.alloys += q * ship.costAlloys;
    for (const [k, v] of Object.entries(ship.rareCosts || {})) {
      into.rare[k] = (into.rare[k] || 0) + q * v;
    }
  }
}

// ── Security zones ──────────────────────────────────────────────────────────
// Only survey reports carry securityZone directly. For others we resolve the
// zone from the system in their location string via a cached system→zone map
// built from the galaxy map (refreshed at most once a day — it's large).

const ZONE_REFRESH_MS = 24 * 3600 * 1000;

export async function getSystemZones() {
  const { system_zones, system_zones_at, system_coords_by_id, sector_zones } =
    await browser.storage.local.get(['system_zones', 'system_zones_at', 'system_coords_by_id', 'sector_zones']);
  if (system_zones && system_zones_at && system_coords_by_id && sector_zones
      && Date.now() - system_zones_at < ZONE_REFRESH_MS) {
    return system_zones;
  }
  try {
    const data = await galaxyCatalog('/api/galaxy/map');
    const map = {};        // name → zone
    const byId = {};       // systemId → zone
    const coordsById = {}; // systemId → {x, y}  (AU — galaxy map units = AU, verified 2026-06-22)
    const coordsByName = {};
    const sectorZones = {}; // sectorId → zone
    for (const s of (data.systems || [])) {
      if (s.securityZone) {
        if (s.name) map[s.name] = s.securityZone;
        if (s.id != null) byId[s.id] = s.securityZone;
        if (s.sectorId != null) sectorZones[s.sectorId] = s.securityZone;
      }
      if (s.id != null && s.x != null) {
        coordsById[s.id] = { x: s.x, y: s.y, name: s.name || null };
        if (s.name) coordsByName[s.name] = { x: s.x, y: s.y };
      }
    }
    await browser.storage.local.set({
      system_zones: map, system_zone_by_id: byId, system_zones_at: Date.now(),
      system_coords_by_id: coordsById, system_coords_by_name: coordsByName,
      sector_zones: sectorZones,
    });
    return map;
  } catch {
    return system_zones || {};   // keep the stale map on failure
  }
}

async function getSystemCoords(names, ids) {
  const { system_coords_by_id, system_coords_by_name } =
    await browser.storage.local.get(['system_coords_by_id', 'system_coords_by_name']);
  const byId = system_coords_by_id || {};
  const byName = system_coords_by_name || {};
  const result = {};
  for (const n of names) result[n] = byName[n] || null;
  for (const id of ids) result[id] = byId[id] || null;
  return result;
}

// "A12-27 / A12-27-AF1" or "A12-27-AF1" → system "A12-27".
function systemFromLocation(loc) {
  if (!loc) return null;
  const dest = loc.includes('/') ? loc.split('/').pop().trim() : loc.trim();
  const m = dest.match(/^([A-Za-z]+\d+-\d+)/);
  return m ? m[1] : null;
}

function resolveZone(systemName, zones) {
  return (systemName && zones[systemName]) || 'unknown';
}

// Pirate reports reference only a campId; pirate-camps maps that to a system,
// which the galaxy map maps to a zone. Cached so completed-raid reports (and
// the back-fill) can resolve their zone.
async function getCampZones(zones) {
  let camps;
  try {
    camps = (await apiFetch(PIRATE_CAMPS_PATH)).camps || [];
  } catch {
    const { camp_zones } = await browser.storage.local.get('camp_zones');
    return camp_zones || {};
  }
  const { camp_zones } = await browser.storage.local.get('camp_zones');
  const map = { ...(camp_zones || {}) };   // keep camps that have since despawned
  for (const c of camps) {
    if (c.id != null) map[c.id] = resolveZone(c.systemName, zones);
  }
  await browser.storage.local.set({ camp_zones: map });
  return map;
}

// Wormhole runs reference only a wormholeId; the wormholes endpoint maps that
// to a system → zone. Cached so completed runs (and the back-fill) resolve.
async function getWormholeZones(zones) {
  let holes;
  try {
    holes = (await apiFetch(WORMHOLES_PATH)).wormholes || [];
  } catch {
    const { wormhole_zones } = await browser.storage.local.get('wormhole_zones');
    return wormhole_zones || {};
  }
  const got = await browser.storage.local.get(['wormhole_zones', 'wormhole_classes']);
  const map = { ...(got.wormhole_zones || {}) };       // keep wormholes that have closed
  const classes = { ...(got.wormhole_classes || {}) };
  for (const w of holes) {
    if (w.id == null) continue;
    map[w.id] = resolveZone(w.systemName, zones);
    if (w.wormholeClass) classes[w.id] = w.wormholeClass;
  }
  await browser.storage.local.set({ wormhole_zones: map, wormhole_classes: classes });
  return map;
}

// One-time back-fill of the `zone` field on records stored before zones were
// tracked, using the cached system→zone map. Without this, old records read
// as 'unknown' and zone filtering shows nothing for real zones. seen_ids
// blocks re-ingestion, so the records must be patched in place.
async function backfillZones(zones, campZones = {}, wormholeZones = {}) {
  const { zones_backfilled } = await browser.storage.local.get('zones_backfilled');
  if (zones_backfilled) return;

  const recentKey = {
    survey: 'recent_reports', pirate: 'pirate_recent_reports',
    mining: 'mining_recent_reports', exp: 'exp_recent_reports', xeno: 'xeno_recent_reports',
  };
  const whId = r => r.wormhole_id ?? (String(r.location || '').match(/Wormhole #(\d+)/) || [])[1];
  const stamp = (r, type) => {
    if (r.zone) return r;
    if (type === 'survey') r.zone = resolveZone(r.system_name, zones);
    else if (type === 'mining') r.zone = resolveZone(systemFromLocation(r.location), zones);
    else if (type === 'exp') r.zone = wormholeZones[whId(r)] || resolveZone(systemFromLocation(r.location), zones);
    else if (type === 'pirate') r.zone = campZones[r.camp_id] || 'unknown';
    else r.zone = 'unknown';
    return r;
  };

  const idx = await getArchiveIndex();
  for (const type of ARCHIVE_TYPES) {
    const keys = [recentKey[type], ...idx[type].months.map(m => `${type}_archive_${m}`)];
    for (const key of keys) {
      const got = await browser.storage.local.get(key);
      if (got[key]) await browser.storage.local.set({ [key]: got[key].map(r => stamp(r, type)) });
    }
  }
  await browser.storage.local.set({ zones_backfilled: true });
  console.log('[NexusOverseer] Zone back-fill complete.');
}

// Ship catalog keyed by shipDefId
function buildShipCatalog(shipyardData) {
  const ships = {};
  for (const s of (shipyardData.ships || [])) {
    ships[s.id] = {
      key: s.key,
      name: s.name,
      costOre: s.costOre || 0,
      costSilicates: s.costSilicates || 0,
      costHydrogen: s.costHydrogen || 0,
      costAlloys: s.costAlloys || 0,
      rareCosts: s.rareCosts || {},
      // Combat stats for the simulator
      hp: s.hp || 0,
      shieldHp: s.shieldHp || 0,
      attack: s.attack || 0,
      weaponType: s.weaponType || null,
      armorType: s.armorType || null,
      shipClass: s.shipClass || 'utility',
      shipSize: s.shipSize || 'small',
      sortOrder: s.sortOrder || 0,
      // Logistics
      fuelRate: s.fuelRate || 0,            // hydrogen per AU travelled
      cargoCapacity: s.cargoCapacity || 0,
    };
  }
  return ships;
}

// Alloys + exotic resources collected (beyond ore/silicates/hydrogen).
const EXTRA_RES_KEYS = ['alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter'];
function addExtraRes(target, loot) {
  for (const k of EXTRA_RES_KEYS) { const v = loot[k] || 0; if (v) target[k] = (target[k] || 0) + v; }
}
function extrasOf(loot) {
  const o = {};
  for (const k of EXTRA_RES_KEYS) { const v = loot[k] || 0; if (v) o[k] = v; }
  return o;
}

async function processSurveyReports(reports, ships, zones = {}) {
  const stored = await browser.storage.local.get([
    'seen_ids', 'totals', 'daily', 'hourly', 'resources_lost',
    'event_breakdown', 'recent_reports', 'records_cap',
  ]);
  const recordsCap = resolveRecordsCap(stored.records_cap);

  const seenIds = new Set(stored.seen_ids || []);
  const totals = stored.totals || {
    ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0,
    first_report: null, last_report: null,
  };

  const dailyMap = {};
  for (const d of (stored.daily || [])) dailyMap[d.day] = { ...d };

  const hourlyMap = {};
  for (const h of (stored.hourly || [])) hourlyMap[h.hour] = { ...h };

  const resourcesLost = stored.resources_lost?.destroyed ? stored.resources_lost : emptyLost();

  const eventMap = {};
  for (const e of (stored.event_breakdown || [])) eventMap[e.event_type] = { ...e };

  const recentReports = [...(stored.recent_reports || [])];

  const newReports = reports.filter(r => !seenIds.has(r.id));

  for (const r of newReports) {
    // Not yet investigated — anomaly pending exploration, skip and retry next scrape.
    if (!r.investigated) continue;
    // Loot not yet collected — skip and retry next scrape.
    if (r.uncollectedLoot !== null) continue;

    seenIds.add(r.id);
    const loot = r.loot || {};
    const ore = loot.ore || 0;
    const hydrogen = loot.hydrogen || 0;
    const silicates = loot.silicates || 0;
    const nLost = (r.shipsLost || []).reduce((sum, item) => sum + (item.quantity || 1), 0);
    const lostDetail = parseShipsLost(r.shipsLost);
    const damagedDetail = parseShipsLost(r.shipsDamaged);
    const nDamaged = Object.values(damagedDetail).reduce((sum, q) => sum + q, 0);

    totals.ore += ore;
    totals.hydrogen += hydrogen;
    totals.silicates += silicates;
    totals.missions += 1;
    totals.ships_lost += nLost;
    addExtraRes(totals, loot);

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].ore += ore;
    dailyMap[day].hydrogen += hydrogen;
    dailyMap[day].silicates += silicates;
    dailyMap[day].missions += 1;
    dailyMap[day].ships_lost += nLost;
    addExtraRes(dailyMap[day], loot);

    const hour = r.createdAt.slice(0, 13) + ':00';
    if (!hourlyMap[hour]) hourlyMap[hour] = { hour, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
    hourlyMap[hour].ore += ore;
    hourlyMap[hour].hydrogen += hydrogen;
    hourlyMap[hour].silicates += silicates;
    hourlyMap[hour].missions += 1;
    hourlyMap[hour].ships_lost += nLost;
    addExtraRes(hourlyMap[hour], loot);

    const et = r.eventType || 'unknown';
    if (!eventMap[et]) eventMap[et] = { event_type: et, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    eventMap[et].count += 1;
    eventMap[et].ore += ore;
    eventMap[et].hydrogen += hydrogen;
    eventMap[et].silicates += silicates;
    addExtraRes(eventMap[et], loot);

    addShipCost(lostDetail, ships, resourcesLost.destroyed, 1);
    addShipCost(damagedDetail, ships, resourcesLost.repair, REPAIR_FACTOR);

    recentReports.unshift({
      id: r.id,
      created_at: r.createdAt,
      system_name: r.systemName,
      event_type: r.eventType,
      zone: r.securityZone || resolveZone(r.systemName, zones),
      ore, hydrogen, silicates, ...extrasOf(loot),
      ships_lost: nLost,
      ships_damaged: nDamaged,
      wormholes_detected: r.wormholesDetected || 0,
      ships_lost_detail: lostDetail,
      ships_damaged_detail: damagedDetail,
      ...(r.combatLog ? (d => ({
        combat_outcome: r.combatLog.outcome || r.outcome || null,
        debris_ore: d.ore, debris_alloys: d.alloys, debris_silicates: d.silicates,
        rounds: combatRounds(r),
        your_fleet: combatFleet(r, 'attackerFleet'), enemy_fleet: combatFleet(r, 'defenderFleet'),   // you investigate, pirates defend
      }))(combatDebris(r)) : {}),
    });
  }

  // Backfill: enrich already-stored combat surveys whose record predates the
  // combat fields (or stored a null outcome from the old top-level `r.outcome`
  // path — survey outcome is actually nested in combatLog). Patches in place,
  // never touches totals/seen, so no double-count. Idempotent + self-limiting:
  // gated on `your_fleet` (the last-added field) so records enriched by an
  // earlier build — which set combat_outcome but not the fleets — still get
  // patched, while fully-enriched records are skipped.
  // ponytail: runs every scrape but only mutates records still missing fields.
  const recentById = new Map(recentReports.map(rr => [rr.id, rr]));
  for (const r of reports) {
    if (!r.combatLog) continue;
    const rec = recentById.get(r.id);
    if (!rec || (rec.your_fleet && rec.your_fleet.length)) continue;   // re-patch records left with an empty fleet
    const d = combatDebris(r);
    rec.combat_outcome = r.combatLog.outcome || r.outcome || null;
    rec.debris_ore = d.ore; rec.debris_alloys = d.alloys; rec.debris_silicates = d.silicates;
    rec.rounds = combatRounds(r);
    rec.your_fleet = combatFleet(r, 'attackerFleet');
    rec.enemy_fleet = combatFleet(r, 'defenderFleet');
  }

  const timestamps = reports.map(r => r.createdAt).sort();
  if (timestamps.length) {
    totals.first_report = timestamps[0];
    totals.last_report = timestamps[timestamps.length - 1];
  }

  const addedSurveys = recentReports.length - (stored.recent_reports || []).length;
  await appendToArchive('survey', recentReports.slice(0, addedSurveys));

  await browser.storage.local.set({
    seen_ids: [...seenIds],
    totals,
    daily: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    hourly: Object.values(hourlyMap).sort((a, b) => a.hour.localeCompare(b.hour)),
    resources_lost: resourcesLost,
    event_breakdown: Object.values(eventMap).sort((a, b) => b.count - a.count),
    recent_reports: recentReports.slice(0, recordsCap),
    schema_version: SCHEMA_VERSION,
  });

  return newReports.length;
}

async function processPirateReports(pirateReports, ships, campZones = {}) {
  const pstored = await browser.storage.local.get([
    'pirate_seen_ids', 'pirate_totals', 'pirate_daily', 'pirate_resources_lost',
    'pirate_outcomes', 'pirate_debris_total', 'pirate_recent_reports', 'records_cap', 'mission_zones',
  ]);
  const missionZones = pstored.mission_zones || {};
  const recordsCap = resolveRecordsCap(pstored.records_cap);

  const pirateSeen = new Set(pstored.pirate_seen_ids || []);
  const pirateTotals = pstored.pirate_totals || {
    ore: 0, hydrogen: 0, silicates: 0, raids: 0,
    ships_destroyed: 0, ships_damaged: 0, pirates_destroyed: 0,
    first_report: null, last_report: null,
  };

  const pirateDailyMap = {};
  for (const d of (pstored.pirate_daily || [])) pirateDailyMap[d.day] = { ...d };

  const pirateLost = pstored.pirate_resources_lost?.destroyed ? pstored.pirate_resources_lost : emptyLost();

  const outcomeMap = {};
  for (const o of (pstored.pirate_outcomes || [])) outcomeMap[o.outcome] = { ...o };

  const pirateDebris = pstored.pirate_debris_total || { ore: 0, alloys: 0, silicates: 0 };
  const pirateRecent = [...(pstored.pirate_recent_reports || [])];

  const newPirateReports = pirateReports.filter(r => !pirateSeen.has(r.id));

  for (const r of newPirateReports) {
    pirateSeen.add(r.id);
    const loot = r.loot || {};
    const ore = loot.ore || 0;
    const hydrogen = loot.hydrogen || 0;
    const silicates = loot.silicates || 0;

    // attackerLosses items: { shipDefId, lost, damaged, destroyed } —
    // only destroyed ships are gone for good, damaged ones survive.
    const destroyedDetail = {};
    const damagedDetail = {};
    let nDestroyed = 0, nDamaged = 0;
    for (const item of (r.attackerLosses || [])) {
      const destroyed = item.destroyed ?? item.lost ?? 0;
      const damaged = item.damaged || 0;
      nDestroyed += destroyed;
      nDamaged += damaged;
      if (item.shipDefId != null && destroyed) {
        destroyedDetail[item.shipDefId] = (destroyedDetail[item.shipDefId] || 0) + destroyed;
      }
      if (item.shipDefId != null && damaged) {
        damagedDetail[item.shipDefId] = (damagedDetail[item.shipDefId] || 0) + damaged;
      }
    }
    const piratesDestroyed = (r.pirateLosses || [])
      .reduce((sum, i) => sum + (i.destroyed ?? i.lost ?? 0), 0);

    pirateTotals.ore += ore;
    pirateTotals.hydrogen += hydrogen;
    pirateTotals.silicates += silicates;
    pirateTotals.raids += 1;
    pirateTotals.ships_destroyed += nDestroyed;
    pirateTotals.ships_damaged += nDamaged;
    pirateTotals.pirates_destroyed += piratesDestroyed;
    addExtraRes(pirateTotals, loot);

    const day = r.createdAt.slice(0, 10);
    if (!pirateDailyMap[day]) pirateDailyMap[day] = { day, ore: 0, hydrogen: 0, silicates: 0, raids: 0, ships_destroyed: 0 };
    pirateDailyMap[day].ore += ore;
    pirateDailyMap[day].hydrogen += hydrogen;
    pirateDailyMap[day].silicates += silicates;
    addExtraRes(pirateDailyMap[day], loot);
    pirateDailyMap[day].raids += 1;
    pirateDailyMap[day].ships_destroyed += nDestroyed;

    const outcome = r.outcome || 'unknown';
    if (!outcomeMap[outcome]) outcomeMap[outcome] = { outcome, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    outcomeMap[outcome].count += 1;
    outcomeMap[outcome].ore += ore;
    outcomeMap[outcome].hydrogen += hydrogen;
    outcomeMap[outcome].silicates += silicates;

    const debris = r.debris || {};
    pirateDebris.ore += debris.ore || 0;
    pirateDebris.alloys += debris.alloys || 0;
    pirateDebris.silicates += debris.silicates || 0;

    addShipCost(destroyedDetail, ships, pirateLost.destroyed, 1);
    addShipCost(damagedDetail, ships, pirateLost.repair, REPAIR_FACTOR);

    pirateRecent.unshift({
      id: r.id,
      created_at: r.createdAt,
      camp_id: r.campId,
      zone: r.securityZone || campZones[r.campId] || missionZones[r.missionId] || 'unknown',
      outcome,
      ore, hydrogen, silicates, ...extrasOf(loot),
      ships_lost: nDestroyed,
      ships_damaged: nDamaged,
      pirates_destroyed: piratesDestroyed,
      debris_ore: debris.ore || 0,
      debris_alloys: debris.alloys || 0,
      debris_silicates: debris.silicates || 0,
      ships_lost_detail: destroyedDetail,
      ships_damaged_detail: damagedDetail,
      // Fleet compositions kept so the simulator can replay this battle
      // and measure engine accuracy against the real outcome.
      attacker_fleet: (r.attackerFleet || []).map(i => ({ key: i.key, quantity: i.quantity || 1 })),
      pirate_fleet: (r.pirateFleet || []).map(i => ({ key: i.key, quantity: i.quantity || 1 })),
      rounds: combatRounds(r),
    });
  }

  const pirateTimestamps = pirateReports.map(r => r.createdAt).sort();
  if (pirateTimestamps.length) {
    pirateTotals.first_report = pirateTimestamps[0];
    pirateTotals.last_report = pirateTimestamps[pirateTimestamps.length - 1];
  }

  // Backfill: pirate records stored before the round log was captured keep their
  // fleets but no rounds, so the tab can't render them like survey/mining. Patch
  // rounds in place from the live API. Gated on a non-empty rounds array.
  // ponytail: runs every scrape but only mutates records still missing rounds.
  const pirateById = new Map(pirateRecent.map(rr => [rr.id, rr]));
  for (const r of pirateReports) {
    const rec = pirateById.get(r.id);
    if (!rec || (rec.rounds && rec.rounds.length)) continue;
    rec.rounds = combatRounds(r);
  }

  await appendToArchive('pirate', pirateRecent.slice(0, pirateRecent.length - (pstored.pirate_recent_reports || []).length));

  await browser.storage.local.set({
    pirate_seen_ids: [...pirateSeen],
    pirate_totals: pirateTotals,
    pirate_daily: Object.values(pirateDailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    pirate_resources_lost: pirateLost,
    pirate_outcomes: Object.values(outcomeMap).sort((a, b) => b.count - a.count),
    pirate_debris_total: pirateDebris,
    pirate_recent_reports: pirateRecent.slice(0, recordsCap),
    schema_version: SCHEMA_VERSION,
  });

  return newPirateReports.length;
}

// Tolerant fleet extraction: any array of { key, quantity } shaped items.
function extractFleet(arr) {
  const out = [];
  for (const i of (arr || [])) {
    if (i && typeof i.key === 'string' && (i.quantity || 0) > 0) {
      out.push({ key: i.key, quantity: i.quantity });
    }
  }
  return out;
}

const rangeTop = value => {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.max === 'number') return value.max;
  return typeof value.min === 'number' ? value.min : null;
};

function spyIntelFleet(ships) {
  return extractFleet((ships || []).map(ship => ({
    key: ship.key,
    quantity: rangeTop(ship.quantity ?? ship.quantityRange),
  })));
}

function spyIntelLevels(items) {
  return (items || []).map(item => ({
    key: item.key,
    name: item.name,
    level: rangeTop(item.level ?? item.levelRange),
  }));
}

function spyIntelResources(resources) {
  const out = {};
  for (const [key, value] of Object.entries(resources || {})) {
    const quantity = typeof value === 'number'
      ? value
      : value && typeof value.min === 'number' ? value.min : null;
    if (quantity != null) out[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] = quantity;
  }
  return out;
}

// Spy reports → defender intel for the simulator (latest INTEL_KEEP kept).
async function processSpyReports(reports) {
  if (!reports.length) return 0;
  const { spy_reports } = await browser.storage.local.get('spy_reports');
  const byId = {};
  for (const r of (spy_reports || [])) byId[r.id] = r;
  for (const r of reports) {
    const intel = r.intel || {};
    byId[r.id] = {
      id: r.id,
      created_at: r.createdAt,
      outcome: r.outcome,
      target_name: r.targetPlanetName || r.targetStationName || r.targetFieldName || 'unknown target',
      target_user: r.targetUsername || null,
      target_system_id:   r.targetSystemId   || null,
      target_system_name: r.targetSystemName || null,
      fleet: r.fleetData != null ? extractFleet(r.fleetData) : spyIntelFleet(intel.fleet && intel.fleet.ships),
      buildings: r.buildingData ?? spyIntelLevels(intel.buildings),
      defense: r.defenseData ?? (intel.defenses ? spyIntelLevels(intel.defenses) : null),
      resources: r.resourceData ?? spyIntelResources(intel.resources),
    };
  }
  const merged = Object.values(byId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, INTEL_KEEP);
  await browser.storage.local.set({ spy_reports: merged });
  return merged.length;
}

// Camp scout reports → pirate camp intel (shape unseen so far — parsed tolerantly).
async function processCampScoutReports(reports) {
  if (!reports.length) return 0;
  const { camp_scout_reports } = await browser.storage.local.get('camp_scout_reports');
  const byId = {};
  for (const r of (camp_scout_reports || [])) byId[r.id] = r;
  for (const r of reports) {
    const fleet = extractFleet(r.pirateFleet) .length ? extractFleet(r.pirateFleet)
      : extractFleet(r.fleet).length ? extractFleet(r.fleet)
      : extractFleet(r.campFleet);
    byId[r.id] = {
      id: r.id,
      created_at: r.createdAt,
      camp_id: r.campId ?? null,
      fleet,
    };
  }
  const merged = Object.values(byId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, INTEL_KEEP);
  await browser.storage.local.set({ camp_scout_reports: merged });
  return merged.length;
}

// Sum numeric resource entries, ignoring internal "_"-prefixed keys
// (mining resourcesDelivered carries _cyclesDone etc.).
function numericResources(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!k.startsWith('_') && typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

// Alloy cost to repair one breakdown, per drill type (game cost). The broken
// drills show up as `damagedQuantity` on the report's fleetComposition entry.
// ponytail: only known drills charged; add a key when a new drill ships.
const DRILL_MAINTENANCE_ALLOY = { miner: 15, ice_drill: 25 };

// Total alloy maintenance for a mining report = Σ damagedQuantity × cost[key].
function maintenanceAlloys(fleetComposition) {
  let a = 0;
  for (const f of (fleetComposition || [])) a += (DRILL_MAINTENANCE_ALLOY[f.shipKey] || 0) * (f.damagedQuantity || 0);
  return a;
}

// Debris a combat report generated. Pirate reports carry it at the top level
// (r.debris); survey and mining-raid reports nest it under combatLog.debris.
function combatDebris(r) {
  const d = (r && r.debris) || (r && r.combatLog && r.combatLog.debris) || {};
  return { ore: d.ore || 0, alloys: d.alloys || 0, silicates: d.silicates || 0 };
}

// Normalize a combat fleet ([{ key/name, quantity }]) for the Battles tab,
// keeping the name so enemy ships absent from your shipyard still display.
function normFleet(arr) {
  return (arr || []).map(f => ({ key: f.key || f.shipKey, name: f.name || null, quantity: f.quantity || 1 }))
    .filter(f => f.quantity > 0 && (f.key || f.name));
}
// A named combat fleet — nested under combatLog for survey/mining raids,
// top-level for pirate reports.
function combatFleet(r, name) {
  return normFleet((r.combatLog && r.combatLog[name]) || r[name]);
}

// A fleet given by shipDefId ([{ shipDefId, quantity }] — wormhole currentFleet),
// resolved to key/name via the ship catalog.
function defIdFleet(arr, ships) {
  return (arr || []).map(f => {
    const s = (ships && ships[f.shipDefId]) || {};
    return { key: s.key || null, name: s.name || `#${f.shipDefId}`, quantity: f.quantity || 1 };
  }).filter(f => f.quantity > 0);
}

// Trimmed combat encounters from a wormhole run's encounterLog — each is its own
// battle (own outcome + round log). Your fleet is the run's currentFleet.
function wormholeEncounters(r, ships) {
  const yourFleet = defIdFleet(r.currentFleet, ships);
  return (r.encounterLog || [])
    .filter(e => e && e.combat)
    .map((e, i) => ({
      title: e.title || e.type || `Encounter ${e.encounter ?? i + 1}`,
      outcome: e.outcome || null,
      lost: (e.shipsLost || []).reduce((s, x) => s + (x.quantity ?? x.lost ?? 1), 0),
      rounds: combatRounds({ rounds: e.combatRounds }),
      your_fleet: yourFleet,
    }));
}

// Trimmed round-by-round combat log for the Battles tab. Pirate reports keep
// rounds at the top level; survey/mining raids nest them under combatLog.
// Per round: damage + kills + remaining HP% for each side (attacker = you).
function combatRounds(r) {
  const raw = (r && r.rounds) || (r && r.combatRounds)
    || (r && r.combatLog && (r.combatLog.rounds || r.combatLog.combatRounds)) || [];
  const kills = e => ((e && e.shipsDestroyed) || []).map(s => ({ name: s.name || s.key, qty: s.lost || 0 }));
  return raw.map(rd => {
    const ev = {};
    for (const e of (rd.events || [])) ev[e.side] = e;
    return {
      round: rd.round,
      atk_dmg: (ev.attacker && ev.attacker.totalDamage) || 0,
      def_dmg: (ev.defender && ev.defender.totalDamage) || 0,
      atk_hp: rd.attackerHpPercent ?? null,
      def_hp: rd.defenderHpPercent ?? null,
      atk_killed: kills(ev.attacker),
      def_killed: kills(ev.defender),
    };
  });
}

const CORE_RESOURCES = ['ore', 'silicates', 'hydrogen', 'alloys'];

function addResources(target, res) {
  if (!target.rare) target.rare = {};   // totals saved before `rare` existed lack this
  for (const [k, v] of Object.entries(res)) {
    if (CORE_RESOURCES.includes(k)) target[k] = (target[k] || 0) + v;
    else target.rare[k] = (target.rare[k] || 0) + v;
  }
}

// Player-vs-player combat reports for the battles tab. The list endpoint
// (/api/fleet/reports) omits the fleets/rounds/debris, so for each new report we
// fetch the detail (/api/fleet/reports/{id}) to store a full battle record: side
// fought on, win/loss, our real-ship losses (defense buildings have negative
// shipDefId + no build cost → excluded), opponent, both fleets, the round log, the
// debris field, and the loot (gained if we attacked, lost if we defended).
async function processPvpReports(reports) {
  const stored = await browser.storage.local.get(['pvp_seen_ids', 'pvp_recent_reports', 'records_cap']);
  const cap = resolveRecordsCap(stored.records_cap);
  const seen = new Set(stored.pvp_seen_ids || []);
  const recent = [...(stored.pvp_recent_reports || [])];
  const CORE = ['ore', 'silicates', 'hydrogen', 'alloys'];
  const fresh = reports.filter(r => !seen.has(r.id));
  if (!fresh.length) return 0;
  let n = 0;
  for (const lite of fresh) {
    seen.add(lite.id);   // mark seen even if we skip it, so it's not reconsidered
    // /api/fleet/reports is a generic combat feed — most entries are pirate/NPC
    // encounters (no opponent profile). Keep only real player-vs-player fights.
    const liteSide = lite.currentUserBattleSide === 'defender' ? 'defender' : 'attacker';
    const liteOpp = liteSide === 'attacker' ? lite.defenderProfile : lite.attackerProfile;
    if (!liteOpp || !liteOpp.username) continue;
    let r = lite;
    try { const det = await apiFetch(`/api/fleet/reports/${lite.id}`); if (det && det.report) r = det.report; }
    catch { /* fall back to the list record */ }
    const side = r.currentUserBattleSide === 'defender' ? 'defender' : 'attacker';
    const won = (r.outcome === 'attacker_won' && side === 'attacker') ||
                (r.outcome === 'defender_won' && side === 'defender');
    const myLosses = (side === 'attacker' ? r.attackerLosses : r.defenderLosses) || [];
    const lostDetail = {}, dmgDetail = {};
    let lostN = 0, dmgN = 0;
    for (const it of myLosses) {
      const destroyed = it.destroyed ?? it.lost ?? 0, damaged = it.damaged || 0;
      lostN += destroyed; dmgN += damaged;
      if (it.shipDefId > 0) {   // real ships only (defense buildings have negative ids)
        if (destroyed) lostDetail[it.shipDefId] = (lostDetail[it.shipDefId] || 0) + destroyed;
        if (damaged) dmgDetail[it.shipDefId] = (dmgDetail[it.shipDefId] || 0) + damaged;
      }
    }
    const raw = numericResources(r.lootStolen);
    const loot = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
    for (const [k, v] of Object.entries(raw)) { if (CORE.includes(k)) loot[k] = v; else loot.rare[k] = v; }
    const opp = side === 'attacker' ? r.defenderProfile : r.attackerProfile;
    const debris = r.debrisField || {};
    // The defender's fleet lists only ships; its planetary defenses live in
    // defenderDefenses.planetaryDefense — merge them so the defending side shows
    // its turrets too.
    const attackerFleet = r.attackerFleet || [];
    const defenderFleet = [
      ...(r.defenderFleet || []),
      ...((r.defenderDefenses && r.defenderDefenses.planetaryDefense) || []),
    ];
    recent.unshift({
      id: r.id, created_at: r.createdAt,
      planet: r.planetName || null,
      side, won, opponent: (opp && opp.username) || null,
      ships_lost_detail: lostDetail, ships_damaged_detail: dmgDetail, ships_lost: lostN, ships_damaged: dmgN,
      your_fleet: side === 'attacker' ? attackerFleet : defenderFleet,
      enemy_fleet: side === 'attacker' ? defenderFleet : attackerFleet,
      rounds: combatRounds(r),
      debris_ore: debris.ore || 0, debris_silicates: debris.silicates || 0, debris_alloys: debris.alloys || 0,
      loot,
    });
    n++;
  }
  recent.length = Math.min(recent.length, cap);
  await browser.storage.local.set({
    pvp_seen_ids: [...seen].slice(-20000),
    pvp_recent_reports: recent,
  });
  return n;
}

async function processMiningReports(reports, ships, zones = {}) {
  const stored = await browser.storage.local.get([
    'mining_seen_ids', 'mining_totals', 'mining_daily', 'mining_resources_lost',
    'mining_recent_reports', 'records_cap',
  ]);
  const recordsCap = resolveRecordsCap(stored.records_cap);

  const seen = new Set(stored.mining_seen_ids || []);
  const totals = stored.mining_totals || {
    ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {},
    deliveries: 0, cycles: 0, drill_breakdowns: 0, maintenance_alloys: 0, ships_lost: 0,
    stolen: { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} },
  };
  if (!totals.stolen) totals.stolen = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };   // totals saved before `stolen` existed lack this
  const dailyMap = {};
  for (const d of (stored.mining_daily || [])) dailyMap[d.day] = { ...d };
  const lost = stored.mining_resources_lost?.destroyed ? stored.mining_resources_lost : emptyLost();
  const recent = [...(stored.mining_recent_reports || [])];

  const fresh = reports.filter(r => !seen.has(r.id));

  for (const r of fresh) {
    if (seen.has(r.id)) continue; // duplicate id within one batch
    seen.add(r.id);
    const delivered = numericResources(r.resourcesDelivered);
    const stolen = numericResources(r.cargoStolen);
    const nLost = (r.shipsLost || []).reduce((sum, i) => sum + (i.quantity || 1), 0);
    const lostDetail = parseShipsLost(r.shipsLost);

    // Only 'delivery' reports count toward mining totals; 'pirate_raid' etc. are
    // kept for combat/loss tracking but aren't deliveries. Cycles come from
    // resourcesDelivered._cyclesDone; a finished delivery drops that meta, so
    // assume a full run of MAX cycles (10) when it's absent.
    const isDelivery = r.reportType === 'delivery';
    const cyc = isDelivery
      ? (typeof r.resourcesDelivered?._cyclesDone === 'number' ? r.resourcesDelivered._cyclesDone : 10)
      : 0;
    const maint = maintenanceAlloys(r.fleetComposition);

    addResources(totals.stolen, stolen);
    totals.maintenance_alloys = (totals.maintenance_alloys || 0) + maint;
    totals.ships_lost += nLost;
    if (isDelivery) {
      addResources(totals, delivered);
      totals.deliveries += 1;
      totals.cycles += cyc;
      totals.drill_breakdowns += r.drillBreakdowns || 0;
    }

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, deliveries: 0, ships_lost: 0 };
    dailyMap[day].ships_lost += nLost;
    if (isDelivery) {
      dailyMap[day].ore += delivered.ore || 0;
      dailyMap[day].silicates += delivered.silicates || 0;
      dailyMap[day].hydrogen += delivered.hydrogen || 0;
      dailyMap[day].deliveries += 1;
      addExtraRes(dailyMap[day], delivered);
    }

    addShipCost(lostDetail, ships, lost.destroyed, 1);

    recent.unshift({
      id: r.id,
      created_at: r.createdAt,
      location: r.locationName || '—',
      planet: r.planetName || '—',
      zone: resolveZone(systemFromLocation(r.locationName), zones),
      report_type: r.reportType || 'delivery',
      source_planet_id: r.planetId ?? null,   // for the mining tab's per-row fuel estimate
      fleet: (r.fleetComposition || []).map(s => ({ shipDefId: s.shipDefId, quantity: s.quantity })),
      ore: delivered.ore || 0,
      silicates: delivered.silicates || 0,
      hydrogen: delivered.hydrogen || 0,
      ...extrasOf(delivered),
      cycles: cyc,
      drill_breakdowns: r.drillBreakdowns || 0,
      maintenance_alloys: maint,
      ships_lost: nLost,
      ships_lost_detail: lostDetail,   // shipDefId→qty, so losses can be valued per period
      stolen_total: Object.values(stolen).reduce((s, v) => s + v, 0),
      stolen,   // granular cargo the raid stole from you, valued as a loss in the battles tab
      combat_outcome: r.combatOutcome || null,
      ...(r.combatOutcome ? (d => ({
        debris_ore: d.ore, debris_alloys: d.alloys, debris_silicates: d.silicates, rounds: combatRounds(r),
        your_fleet: combatFleet(r, 'defenderFleet'), enemy_fleet: combatFleet(r, 'attackerFleet'),   // a raid: pirates attack, you defend
      }))(combatDebris(r)) : {}),
    });
  }

  // Backfill mining-raid records stored before combat detail was captured:
  // patch debris/rounds/fleets in place from the live API, never touching
  // totals/seen. Gated on your_fleet so partially-enriched records still get
  // their fleets; only raids (r.combatOutcome) are considered.
  // ponytail: runs every scrape but only mutates raids still missing fields.
  const recentById = new Map(recent.map(rr => [rr.id, rr]));
  for (const r of reports) {
    if (!r.combatOutcome) continue;
    const rec = recentById.get(r.id);
    if (!rec) continue;
    if (rec.stolen === undefined) rec.stolen = numericResources(r.cargoStolen);   // backfill granular cargo loss
    if (rec.your_fleet && rec.your_fleet.length) continue;   // combat detail already patched
    const d = combatDebris(r);
    rec.combat_outcome = r.combatOutcome;
    rec.debris_ore = d.ore; rec.debris_alloys = d.alloys; rec.debris_silicates = d.silicates;
    rec.rounds = combatRounds(r);
    rec.your_fleet = combatFleet(r, 'defenderFleet');
    rec.enemy_fleet = combatFleet(r, 'attackerFleet');
  }

  await appendToArchive('mining', recent.slice(0, recent.length - (stored.mining_recent_reports || []).length));

  await browser.storage.local.set({
    mining_seen_ids: [...seen],
    mining_totals: totals,
    mining_daily: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    mining_resources_lost: lost,
    mining_recent_reports: recent.slice(0, recordsCap),
  });

  return fresh.length;
}

// Expedition reports + wormhole runs share one tab. Wormhole runs put their
// aggregate loot in `totalLoot`; expedition shape is still unobserved, so the
// other keys are kept as tolerant fallbacks.
function extractLoot(r) {
  const src = r.totalLoot || r.loot || r.resourcesGained || r.resources || r.reward || r.rewards || {};
  return numericResources(src);
}

// Ships lost count: wormhole runs use `totalShipsLost`, combat uses
// `shipsDestroyed` ({ lost }), others `shipsLost` ({ quantity }).
function extractShipsLost(r) {
  const arr = r.totalShipsLost || r.shipsDestroyed || r.shipsLost || [];
  return arr.reduce((sum, i) => sum + (i.quantity ?? i.lost ?? 1), 0);
}

async function processExpeditionReports(reports, runs, ships, zones = {}, wormholeZones = {}, wormholeClasses = {}) {
  const items = [
    ...(reports || []).map(r => ({ r, kind: 'expedition', uid: `exp-${r.id}` })),
    ...(runs || []).map(r => ({ r, kind: 'wormhole', uid: `wh-${r.id}` })),
  ];
  if (!items.length) return 0;

  const stored = await browser.storage.local.get([
    'exp_seen_ids', 'exp_totals', 'expedition_totals', 'wormhole_totals', 'exp_daily', 'exp_recent_reports',
    'expedition_resources_lost', 'wormhole_resources_lost', 'records_cap', 'mission_zones', 'sector_zones',
  ]);
  const missionZones = stored.mission_zones || {};
  const sectorZones = stored.sector_zones || {};
  const recordsCap = resolveRecordsCap(stored.records_cap);

  const emptyTotals = () => ({ ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0 });
  const seen = new Set(stored.exp_seen_ids || []);
  const totals = stored.exp_totals || emptyTotals();   // combined, kept for the drift check + overall ops count
  const expTotals = stored.expedition_totals || emptyTotals();
  const whTotals = stored.wormhole_totals || emptyTotals();
  // Ships lost tracked separately per kind (both real: pirate_ambush/fleet_lost
  // expedition events do destroy ships, not just wormhole encounters).
  const expLost = stored.expedition_resources_lost?.destroyed ? stored.expedition_resources_lost : emptyLost();
  const whLost = stored.wormhole_resources_lost?.destroyed ? stored.wormhole_resources_lost : emptyLost();
  const dailyMap = {};
  for (const d of (stored.exp_daily || [])) dailyMap[d.day] = { ...d };
  const recent = [...(stored.exp_recent_reports || [])];

  let added = 0;
  for (const { r, kind, uid } of items) {
    if (seen.has(uid) || !r.createdAt) continue;
    // Skip runs still in progress — their totals are partial and `seen`
    // would lock the partial value in. Re-counted once completed.
    if (r.status && r.status !== 'completed') continue;
    seen.add(uid);
    added++;
    const loot = extractLoot(r);
    const destroyedArr = r.totalShipsLost || r.shipsDestroyed || r.shipsLost || [];
    const nLost = extractShipsLost(r);

    const kindTotals = kind === 'wormhole' ? whTotals : expTotals;
    addResources(totals, loot);
    addResources(kindTotals, loot);
    addLossCost(destroyedArr, ships, (kind === 'wormhole' ? whLost : expLost).destroyed, 1);
    totals.missions += 1;
    totals.ships_lost += nLost;
    kindTotals.missions += 1;
    kindTotals.ships_lost += nLost;

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].ore += loot.ore || 0;
    dailyMap[day].silicates += loot.silicates || 0;
    dailyMap[day].hydrogen += loot.hydrogen || 0;
    dailyMap[day].missions += 1;
    dailyMap[day].ships_lost += nLost;

    recent.unshift({
      id: uid,
      created_at: r.createdAt,
      kind,
      wormhole_id: r.wormholeId ?? null,
      wclass: r.wormholeClass || wormholeClasses[r.wormholeId] || null,
      event: r.eventType || r.outcome || r.result || r.status || null,
      location: r.systemName || r.locationName || r.targetName ||
        (r.wormholeId != null ? `Wormhole #${r.wormholeId}` : r.sectorId != null ? `Sector #${r.sectorId}` : '—'),
      zone: wormholeZones[r.wormholeId] || sectorZones[r.sectorId] || missionZones[r.missionId]
        || resolveZone(r.systemName || systemFromLocation(r.locationName), zones),
      loot,
      ships_lost: nLost,
      ships_destroyed_raw: destroyedArr,
      ...(kind === 'wormhole' ? { encounters: wormholeEncounters(r, ships) } : {}),
    });
  }

  // Backfill: wormhole runs stored before encounter combat was captured. Patch
  // the combat encounters (outcome + rounds + your fleet) in place from the live
  // API — no totals/seen change. Gated on a non-empty encounters array.
  // ponytail: runs every scrape but only mutates completed runs still missing it.
  const expById = new Map(recent.map(rr => [rr.id, rr]));
  let patched = false;
  for (const { r, kind, uid } of items) {
    if (kind !== 'wormhole' || (r.status && r.status !== 'completed')) continue;
    const rec = expById.get(uid);
    if (!rec || (rec.encounters && rec.encounters.length)) continue;
    rec.encounters = wormholeEncounters(r, ships);
    patched = true;
  }

  if (added || patched) {
    await appendToArchive('exp', recent.slice(0, recent.length - (stored.exp_recent_reports || []).length));
    await browser.storage.local.set({
      exp_seen_ids: [...seen],
      exp_totals: totals,
      expedition_totals: expTotals,
      wormhole_totals: whTotals,
      expedition_resources_lost: expLost,
      wormhole_resources_lost: whLost,
      exp_daily: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
      exp_recent_reports: recent.slice(0, recordsCap),
    });
  }
  return added;
}

// Ruins survey (xeno_survey) results arrive as a system message, not a fleet
// report: subject "Xeno Survey Complete", body e.g. "Your science team
// finished the xeno survey. 0 fragments recovered, plus an artifact for your
// collection." No structured loot, and no moon/system/ships-lost data at all
// — location/zone/ships_lost are unknowable from this feed.
const XENO_FRAGMENTS_RE = /(\d+)\s*fragments?\s*recovered/i;
const XENO_ARTIFACT_RE = /plus\s+(\d+|an?)\s*artifacts?/i;

function parseXenoMessage(body) {
  const loot = {};
  const frag = XENO_FRAGMENTS_RE.exec(body || '');
  if (frag && +frag[1]) loot.precursor_fragments = +frag[1];
  const art = XENO_ARTIFACT_RE.exec(body || '');
  if (art) {
    const n = /^an?$/i.test(art[1]) ? 1 : +art[1];
    if (n) loot.artifact = n;
  }
  return loot;
}

async function processXenoReports(messages) {
  const xenoMsgs = (messages || []).filter(m => m.subject === 'Xeno Survey Complete');
  if (!xenoMsgs.length) return 0;

  const stored = await browser.storage.local.get([
    'xeno_seen_ids', 'xeno_totals', 'xeno_daily', 'xeno_recent_reports', 'records_cap',
  ]);
  const recordsCap = resolveRecordsCap(stored.records_cap);

  const seen = new Set(stored.xeno_seen_ids || []);
  const totals = stored.xeno_totals || {
    ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0,
  };
  const dailyMap = {};
  for (const d of (stored.xeno_daily || [])) dailyMap[d.day] = { ...d };
  const recent = [...(stored.xeno_recent_reports || [])];

  let added = 0;
  for (const m of xenoMsgs) {
    const uid = `xeno-${m.id}`;
    if (seen.has(uid) || !m.createdAt) continue;
    seen.add(uid);
    added++;
    const loot = parseXenoMessage(m.body);

    addResources(totals, loot);
    totals.missions += 1;

    const day = m.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].missions += 1;

    recent.unshift({
      id: uid,
      created_at: m.createdAt,
      event: 'ruins_survey_complete',
      location: '—',
      zone: null,
      loot,
      ships_lost: 0,
      ships_destroyed_raw: [],
    });
  }

  if (added) {
    await appendToArchive('xeno', recent.slice(0, recent.length - (stored.xeno_recent_reports || []).length));
    await browser.storage.local.set({
      xeno_seen_ids: [...seen],
      xeno_totals: totals,
      xeno_daily: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
      xeno_recent_reports: recent.slice(0, recordsCap),
    });
  }
  return added;
}

// system-debris is live state, not history. Snapshot it and treat decreases
// between snapshots as "collected by someone" (us or another player).
// Snapshot the live debris fields (with first-seen timestamps) for the
// "Live debris fields" table. Precise collection is tracked separately from
// returning collect_debris missions (processMissions).
async function processSystemDebris(debrisArr, zones = {}) {
  const stored = await browser.storage.local.get('debris_fields');
  const prev = {};
  for (const f of (stored.debris_fields || [])) prev[f.id] = f;

  const now = new Date().toISOString();
  const next = {};
  for (const d of (debrisArr || [])) {
    const id = String(d.id ?? `${d.systemId ?? '?'}-${d.position ?? ''}`);
    next[id] = {
      id,
      debrisId: d.id ?? null,         // numeric id for collect-debris
      systemId: d.systemId ?? null,   // for the fuel estimate
      system: d.systemName || d.locationName || (d.systemId != null ? `System #${d.systemId}` : 'unknown'),
      zone: d.securityZone || resolveZone(d.systemName, zones),
      ore: d.ore || 0,
      silicates: d.silicates || 0,
      alloys: d.alloys || 0,
      expires: d.expiresAt ?? null,
      first_seen: prev[id]?.first_seen || now,
      updated_at: now,
    };
  }

  await browser.storage.local.set({
    debris_fields: Object.values(next),
    debris_last_check: now,
  });
}

async function refreshDebris() {
  const json = await apiGet(SYSTEM_DEBRIS_PATH);
  if (json.error) return json;
  const { system_zones } = await browser.storage.local.get('system_zones');
  await enqueue(() => processSystemDebris(json.debris || [], system_zones || {}));
  return { ok: true };
}

// Active fleet missions → precise debris collection. A returning
// `collect_debris` fleet's cargo is exactly what it salvaged, so we record
// each such mission once (deduped by mission id) as a real collection, plus
// keep the in-flight runs for a live view. zoneById: systemId → zone.
async function processMissions(missions, zoneById = {}, ships = {}) {
  // Count each fleet's fuel once, when first seen in flight (a survey is two
  // missions — a scout then a heavy collection fleet — so per-report joins
  // miss the second; counting per mission catches every trip).
  if (missions && missions.length) {
    const { fuel_log, fuel_counted_ids, mission_zones, sector_zones } =
      await browser.storage.local.get(['fuel_log', 'fuel_counted_ids', 'mission_zones', 'sector_zones']);
    const missionZoneMap = { ...(mission_zones || {}) };
    for (const mission of missions) {
      const zone = zoneById[mission.targetSystemId] || (sector_zones || {})[mission.targetSectorId];
      if (mission.id != null && zone) missionZoneMap[mission.id] = zone;
    }
    const missionZoneIds = Object.keys(missionZoneMap);
    for (const id of missionZoneIds.slice(0, Math.max(0, missionZoneIds.length - 3000))) {
      delete missionZoneMap[id];
    }
    await browser.storage.local.set({ mission_zones: missionZoneMap });
    const counted = new Set(fuel_counted_ids || []);
    const flog = [...(fuel_log || [])];
    for (const m of missions) {
      if (m.id == null || counted.has(m.id)) continue;
      counted.add(m.id);
      // Prefer the game's exact fuel-estimate; fall back to the fitted formula
      // when no game tab is open or the route/fleet is incomplete.
      const fuel = (await apiMissionFuel(m)) ?? missionFuel({
        distance: m.distance,
        fleet: (m.fleetComposition || []).map(f => ({ key: f.shipKey || f.key, quantity: f.quantity || 1 })),
      }, ships) ?? 0;
      if (!fuel) continue;
      flog.unshift({
        created_at: m.departsAt || m.createdAt || new Date().toISOString(),
        type: fuelMissionType(m.missionType),
        zone: zoneById[m.targetSystemId] || 'unknown',
        fuel,
      });
    }
    const countedArr = [...counted];
    await browser.storage.local.set({
      fuel_log: flog.slice(0, 4000),
      fuel_counted_ids: countedArr.slice(Math.max(0, countedArr.length - 5000)),
    });
  }

  const runs = (missions || []).filter(m => m.missionType === 'collect_debris');

  const stored = await browser.storage.local.get([
    'debris_collected', 'debris_collection_log', 'debris_collection_ids',
    'debris_resources_lost', 'debris_loss_ids', 'records_cap',
  ]);
  const recordsCap = resolveRecordsCap(stored.records_cap);
  const total = stored.debris_collected || { ore: 0, silicates: 0, alloys: 0, hydrogen: 0 };
  const log = [...(stored.debris_collection_log || [])];
  const seen = new Set(stored.debris_collection_ids || []);
  const lost = stored.debris_resources_lost?.destroyed ? stored.debris_resources_lost : emptyLost();
  const lossSeen = new Set(stored.debris_loss_ids || []);

  const active = [];
  for (const m of runs) {
    const cargo = m.cargo || {};
    const amount = (cargo.ore || 0) + (cargo.silicates || 0) + (cargo.alloys || 0) + (cargo.hydrogen || 0);
    // Collection now runs in repeating ticks (cargo grows each tick, same mission
    // id); `returnDepartsAt` is set from the first tick on as a rolling ETA, so it
    // no longer means the haul is final. `raidParams.collectionComplete` does.
    const progress = missionProgress(m);
    const collectionDone = m.raidParams?.collectionComplete === true || m.status === 'returning';

    active.push({
      id: m.id,
      fleet: (m.fleetComposition || []).map(f => ({ key: f.shipKey || f.key, quantity: f.quantity || 1 })),
      system: m.targetSystemName || (m.targetSystemId != null ? `System #${m.targetSystemId}` : '—'),
      system_id: m.targetSystemId ?? null,   // so the UI can mark a field already collecting
      zone: zoneById[m.targetSystemId] || 'unknown',
      status: progress.status,
      statusLabel: progress.label,
      eta: progress.event ? new Date(progress.event.at).toISOString() : null,
      etaLabel: progress.event?.label || null,
      ore: cargo.ore || 0, silicates: cargo.silicates || 0,
      alloys: cargo.alloys || 0, hydrogen: cargo.hydrogen || 0,
    });

    // Ships lost if the fleet was ambushed en route — valued once per mission.
    const destroyed = m.shipsDestroyed || m.shipsLost;
    if (destroyed?.length && !lossSeen.has(m.id)) {
      lossSeen.add(m.id);
      addLossCost(destroyed, ships, lost.destroyed, 1);
    }

    // Commit once the haul is known (collection tick loop finished, non-empty cargo).
    if (collectionDone && amount > 0 && !seen.has(m.id)) {
      seen.add(m.id);
      total.ore += cargo.ore || 0;
      total.silicates += cargo.silicates || 0;
      total.hydrogen += cargo.hydrogen || 0;
      addExtraRes(total, cargo);   // alloys + rares
      log.unshift({
        id: m.id,
        collected_at: new Date().toISOString(),
        system: m.targetSystemName || (m.targetSystemId != null ? `System #${m.targetSystemId}` : '—'),
        zone: zoneById[m.targetSystemId] || 'unknown',
        ore: cargo.ore || 0, silicates: cargo.silicates || 0,
        alloys: cargo.alloys || 0, hydrogen: cargo.hydrogen || 0, ...extrasOf(cargo),
      });
    }
  }

  await browser.storage.local.set({
    debris_active_runs: active,
    debris_collected: total,
    debris_collection_log: log.slice(0, recordsCap),
    debris_collection_ids: [...seen].slice(-2000),   // bounded dedup window
    debris_resources_lost: lost,
    debris_loss_ids: [...lossSeen].slice(-2000),
  });
  return log.length;
}

// ── Aggregate rebuild ──────────────────────────────────────────────────────
// Recomputes every aggregate from the stored per-report records, repairing
// drift after partial failures. Limits: history beyond the records cap is
// lost from totals, and mining alloys/rares/stolen-breakdown and mining loss
// valuation cannot be reconstructed (per-report records lack the detail).

// Destroyed ships at full cost + damaged ships at the repair factor.
function costFromDetail(record, ships, into) {
  addShipCost(record.ships_lost_detail, ships, into.destroyed, 1);
  addShipCost(record.ships_damaged_detail, ships, into.repair, REPAIR_FACTOR);
}

async function rebuildAggregates() {
  const s = await browser.storage.local.get([
    'recent_reports', 'pirate_recent_reports', 'mining_recent_reports',
    'exp_recent_reports', 'xeno_recent_reports', 'ships',
  ]);
  const ships = s.ships || {};
  const out = {};
  // Archives hold every report ever seen; capped recents are the fallback
  // for data collected before archives existed.
  const archives = {};
  for (const t of ARCHIVE_TYPES) archives[t] = await loadArchive(t);
  const surveyRecords = archives.survey.length ? archives.survey : (s.recent_reports || []);
  const pirateRecords = archives.pirate.length ? archives.pirate : (s.pirate_recent_reports || []);
  const miningRecords = archives.mining.length ? archives.mining : (s.mining_recent_reports || []);
  const expRecords = archives.exp.length ? archives.exp : (s.exp_recent_reports || []);
  const xenoRecords = archives.xeno.length ? archives.xeno : (s.xeno_recent_reports || []);

  // Surveys
  {
    const totals = { ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0, first_report: null, last_report: null };
    const daily = {}, hourly = {}, events = {};
    const lost = emptyLost();
    for (const r of surveyRecords) {
      totals.ore += r.ore || 0;
      totals.hydrogen += r.hydrogen || 0;
      totals.silicates += r.silicates || 0;
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;
      addExtraRes(totals, r);
      if (!totals.first_report || r.created_at < totals.first_report) totals.first_report = r.created_at;
      if (!totals.last_report || r.created_at > totals.last_report) totals.last_report = r.created_at;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.ore || 0;
      daily[day].hydrogen += r.hydrogen || 0;
      daily[day].silicates += r.silicates || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
      addExtraRes(daily[day], r);

      const hour = r.created_at.slice(0, 13) + ':00';
      if (!hourly[hour]) hourly[hour] = { hour, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
      hourly[hour].ore += r.ore || 0;
      hourly[hour].hydrogen += r.hydrogen || 0;
      hourly[hour].silicates += r.silicates || 0;
      hourly[hour].missions += 1;
      hourly[hour].ships_lost += r.ships_lost || 0;
      addExtraRes(hourly[hour], r);

      const et = r.event_type || 'unknown';
      if (!events[et]) events[et] = { event_type: et, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
      events[et].count += 1;
      events[et].ore += r.ore || 0;
      events[et].hydrogen += r.hydrogen || 0;
      events[et].silicates += r.silicates || 0;
      addExtraRes(events[et], r);

      costFromDetail(r, ships, lost);
    }
    out.totals = totals;
    out.daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.hourly = Object.values(hourly).sort((a, b) => a.hour.localeCompare(b.hour));
    out.event_breakdown = Object.values(events).sort((a, b) => b.count - a.count);
    out.resources_lost = lost;
  }

  // Pirates
  {
    const totals = {
      ore: 0, hydrogen: 0, silicates: 0, raids: 0,
      ships_destroyed: 0, ships_damaged: 0, pirates_destroyed: 0,
      first_report: null, last_report: null,
    };
    const daily = {}, outcomes = {};
    const lost = emptyLost();
    const debris = { ore: 0, alloys: 0, silicates: 0 };
    for (const r of pirateRecords) {
      totals.ore += r.ore || 0;
      totals.hydrogen += r.hydrogen || 0;
      totals.silicates += r.silicates || 0;
      totals.raids += 1;
      totals.ships_destroyed += r.ships_lost || 0;
      totals.ships_damaged += r.ships_damaged || 0;
      totals.pirates_destroyed += r.pirates_destroyed || 0;
      addExtraRes(totals, r);
      if (!totals.first_report || r.created_at < totals.first_report) totals.first_report = r.created_at;
      if (!totals.last_report || r.created_at > totals.last_report) totals.last_report = r.created_at;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, hydrogen: 0, silicates: 0, raids: 0, ships_destroyed: 0 };
      daily[day].ore += r.ore || 0;
      daily[day].hydrogen += r.hydrogen || 0;
      daily[day].silicates += r.silicates || 0;
      addExtraRes(daily[day], r);
      daily[day].raids += 1;
      daily[day].ships_destroyed += r.ships_lost || 0;

      const o = r.outcome || 'unknown';
      if (!outcomes[o]) outcomes[o] = { outcome: o, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
      outcomes[o].count += 1;
      outcomes[o].ore += r.ore || 0;
      outcomes[o].hydrogen += r.hydrogen || 0;
      outcomes[o].silicates += r.silicates || 0;

      debris.ore += r.debris_ore || 0;
      debris.alloys += r.debris_alloys || 0;
      debris.silicates += r.debris_silicates || 0;

      costFromDetail(r, ships, lost);
    }
    out.pirate_totals = totals;
    out.pirate_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.pirate_outcomes = Object.values(outcomes).sort((a, b) => b.count - a.count);
    out.pirate_resources_lost = lost;
    out.pirate_debris_total = debris;
  }

  // Mining (alloys/rare/stolen breakdown and loss valuation are not rebuildable)
  {
    const totals = {
      ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {},
      deliveries: 0, cycles: 0, drill_breakdowns: 0, maintenance_alloys: 0, ships_lost: 0,
      stolen: { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} },
    };
    const daily = {};
    for (const r of miningRecords) {
      // Match live processing: only 'delivery' records are deliveries. Older
      // records predate report_type; treat those as deliveries (default).
      const isDelivery = (r.report_type || 'delivery') === 'delivery';
      totals.maintenance_alloys += r.maintenance_alloys || 0;
      totals.ships_lost += r.ships_lost || 0;
      totals.stolen.ore += r.stolen_total || 0; // breakdown unknown — lump into ore
      if (isDelivery) {
        totals.ore += r.ore || 0;
        totals.silicates += r.silicates || 0;
        totals.hydrogen += r.hydrogen || 0;
        totals.deliveries += 1;
        totals.cycles += r.cycles || 0;
        totals.drill_breakdowns += r.drill_breakdowns || 0;
        addExtraRes(totals, r);
      }

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, deliveries: 0, ships_lost: 0 };
      daily[day].ships_lost += r.ships_lost || 0;
      if (isDelivery) {
        daily[day].ore += r.ore || 0;
        daily[day].silicates += r.silicates || 0;
        daily[day].hydrogen += r.hydrogen || 0;
        addExtraRes(daily[day], r);
        daily[day].deliveries += 1;
      }
    }
    out.mining_totals = totals;
    out.mining_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.mining_resources_lost = emptyLost();   // not rebuildable — records lack ship detail
  }

  // Expeditions (full loot map per record — fully rebuildable)
  {
    const emptyTotals = () => ({ ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0, fuel: 0 });
    const totals = emptyTotals();
    const expTotals = emptyTotals();
    const whTotals = emptyTotals();
    const expLost = emptyLost();
    const whLost = emptyLost();
    const daily = {};
    for (const r of expRecords) {
      const kindTotals = r.kind === 'wormhole' ? whTotals : expTotals;
      addResources(totals, r.loot || {});
      addResources(kindTotals, r.loot || {});
      addLossCost(r.ships_destroyed_raw, ships, (r.kind === 'wormhole' ? whLost : expLost).destroyed, 1);
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;
      kindTotals.missions += 1;
      kindTotals.ships_lost += r.ships_lost || 0;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.loot?.ore || 0;
      daily[day].silicates += r.loot?.silicates || 0;
      daily[day].hydrogen += r.loot?.hydrogen || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
    }
    out.exp_totals = totals;
    out.expedition_totals = expTotals;
    out.wormhole_totals = whTotals;
    out.expedition_resources_lost = expLost;
    out.wormhole_resources_lost = whLost;
    out.exp_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
  }

  // Xeno ruins surveys (full loot map per record — fully rebuildable)
  {
    const totals = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0 };
    const lost = emptyLost();
    const daily = {};
    for (const r of xenoRecords) {
      addResources(totals, r.loot || {});
      addLossCost(r.ships_destroyed_raw, ships, lost.destroyed, 1);
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.loot?.ore || 0;
      daily[day].silicates += r.loot?.silicates || 0;
      daily[day].hydrogen += r.loot?.hydrogen || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
    }
    out.xeno_totals = totals;
    out.xeno_resources_lost = lost;
    out.xeno_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
  }

  await browser.storage.local.set(out);
  await browser.storage.local.remove('stats_drift');
  console.log('[NexusOverseer] Aggregates rebuilt from stored records.');
}

// ── Backups ─────────────────────────────────────────────────────────────────
// Full storage snapshots written to Downloads/NexusOverseer/: weekly while
// scraping runs, and before every destructive operation (reset, import,
// schema-fallback wipe). Same format as the manual dashboard export.

const BACKUP_INTERVALS_MS = { daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };

async function backupToDownloads(reason) {
  const data = globalThis.nexusStorage?.exportFullStorage ? await globalThis.nexusStorage.exportFullStorage() : await browser.storage.local.get(null);
  if (data.records_cap === Infinity) data.records_cap = 0;
  const payload = {
    nexus_overseer_backup: 1,
    galaxyCache: await exportGalaxyCache(),
    exported_at: new Date().toISOString(),
    reason,
    data,
  };
  // MV3 service workers have no URL.createObjectURL, so download from a data
  // URL instead of a blob URL.
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload));
  await browser.downloads.download({
    url,
    filename: `NexusOverseer/nexus-overseer-${reason}-${new Date().toISOString().slice(0, 10)}.json`,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  await browser.storage.local.set({ last_backup: new Date().toISOString() });
  console.log(`[NexusOverseer] Backup written (${reason}).`);
}

async function maybeAutoBackup() {
  const settings = await globalThis.nexusStorage?.getSettings?.() || {};
  const interval = BACKUP_INTERVALS_MS[settings['data.autoBackup'] || 'weekly'];
  if (!interval) return;
  const { last_backup } = await browser.storage.local.get('last_backup');
  if (last_backup && Date.now() - new Date(last_backup).getTime() < interval) return;
  try {
    await backupToDownloads('auto');
  } catch (err) {
    console.warn('[NexusOverseer] Auto-backup failed:', err);
  }
}

// ── Drift detection ─────────────────────────────────────────────────────────
// Recompute archive-derived sums and compare with the stored totals. Only
// fields that are fully reconstructible from archives are compared, so a
// legitimate rebuild never reports drift.

async function checkDrift() {
  const s = await browser.storage.local.get([
    'totals', 'pirate_totals', 'mining_totals', 'exp_totals',
  ]);
  const surveyArchive = await loadArchive('survey');
  const pirateArchive = await loadArchive('pirate');
  const miningArchive = await loadArchive('mining');
  const expArchive = await loadArchive('exp');

  const sum = (arr, field) => (arr || []).reduce((t, r) => t + (r[field] || 0), 0);
  const problems = [];

  if (s.totals && surveyArchive.length) {
    for (const f of ['ore', 'hydrogen', 'silicates', 'ships_lost']) {
      if (sum(surveyArchive, f) !== (s.totals[f] || 0)) problems.push(`surveys.${f}`);
    }
    if (surveyArchive.length !== (s.totals.missions || 0)) problems.push('surveys.missions');
  }
  if (s.pirate_totals && pirateArchive.length) {
    for (const f of ['ore', 'hydrogen', 'silicates']) {
      if (sum(pirateArchive, f) !== (s.pirate_totals[f] || 0)) problems.push(`pirates.${f}`);
    }
    if (pirateArchive.length !== (s.pirate_totals.raids || 0)) problems.push('pirates.raids');
  }
  if (s.mining_totals && miningArchive.length) {
    // Totals count 'delivery' reports only (pirate_raid records are kept for the
    // battles tab), so compare against delivery records — not the whole archive.
    const miningDeliv = miningArchive.filter(r => (r.report_type || 'delivery') === 'delivery');
    for (const f of ['ore', 'silicates', 'hydrogen']) {
      if (sum(miningDeliv, f) !== (s.mining_totals[f] || 0)) problems.push(`mining.${f}`);
    }
    if (miningDeliv.length !== (s.mining_totals.deliveries || 0)) problems.push('mining.deliveries');
  }
  if (s.exp_totals && expArchive.length) {
    if (expArchive.length !== (s.exp_totals.missions || 0)) problems.push('expeditions.missions');
  }

  if (problems.length) {
    await browser.storage.local.set({
      stats_drift: { detected_at: new Date().toISOString(), fields: problems },
    });
    console.warn('[NexusOverseer] Stats drift detected:', problems.join(', '));
  } else {
    await browser.storage.local.remove('stats_drift');
  }
}

// ── Schema migrations ───────────────────────────────────────────────────────
// When a stored data shape changes, bump SCHEMA_VERSION and add a migration
// keyed by the NEW version that transforms existing data in place. Purely
// additive changes (new keys with defaults) need no bump at all. Since report
// archives exist, a record-shape migration is usually just "transform the
// archives, then rebuildAggregates()". Data is only wiped as a last resort,
// when a migration step is missing — and the user's records cap survives even
// that.

const MIGRATIONS = {
  // v4: archives moved from one big array per type to monthly shards.
  4: async () => {
    const legacyKeys = {
      survey: ['survey_archive', 'recent_reports'],
      pirate: ['pirate_archive', 'pirate_recent_reports'],
      mining: ['mining_archive', 'mining_recent_reports'],
      exp: ['exp_archive', 'exp_recent_reports'],
    };
    for (const [type, [legacy, fallback]] of Object.entries(legacyKeys)) {
      const s = await browser.storage.local.get([legacy, fallback]);
      await appendToArchive(type, s[legacy] || s[fallback] || []);
      await browser.storage.local.remove(legacy);
    }
  },
  // v5: the wormhole/expedition parser was broken (loot lives in `totalLoot`,
  // not `loot`), so stored runs have empty loot and block re-ingest via
  // seen_ids. Drop the expedition data so it re-ingests with the fixed parser.
  5: async () => {
    const idx = await getArchiveIndex();
    const shardKeys = (idx.exp?.months || []).map(m => `exp_archive_${m}`);
    await browser.storage.local.remove([
      ...shardKeys, 'exp_seen_ids', 'exp_totals', 'exp_daily', 'exp_recent_reports',
    ]);
    if (idx.exp) {
      idx.exp = { months: [], count: 0 };
      await browser.storage.local.set({ archive_index: idx });
    }
  },
  // v6: resources_lost split into { destroyed, repair }. Rebuild recomputes the
  // new shape from the archives (mining loss stays empty — records lack detail).
  6: async () => {
    await rebuildAggregates();
  },
  // v7: fuel is now counted per launched mission into fuel_log. Clear the log
  // (early entries mis-tagged "investigate" survey fleets as "other") plus the
  // stale coords caches; system_coords_by_id/_by_name get re-populated by
  // getSystemZones() on the next galaxy map refresh, the rest rebuild from new launches.
  7: async () => {
    await browser.storage.local.remove([
      'fuel_log', 'fuel_counted_ids', 'mission_origins',
      'system_coords_by_id', 'system_coords_by_name', 'camp_coords',
      'home_system_id', 'owned_system_ids',
    ]);
  },
  // v8: PvP battle records added; early ones were list-only (no fleets/rounds/
  // debris/defenses). Clear them so they re-ingest from the detail endpoint.
  8: async () => {
    await browser.storage.local.remove(['pvp_seen_ids', 'pvp_recent_reports']);
  },
  // v9: exp_resources_lost (combined expedition+wormhole ship-loss cost) split
  // into expedition_resources_lost/wormhole_resources_lost, per-kind — real
  // expedition events (pirate_ambush, fleet_lost) destroy ships too, not just
  // wormhole encounters. Rebuild recomputes both from the archives.
  9: async () => {
    await browser.storage.local.remove('exp_resources_lost');
    await rebuildAggregates();
  },
  // v10: expedition_totals/wormhole_totals (per-kind gain totals, for the
  // Global tab's source-share split) added alongside the combined exp_totals.
  // Rebuild backfills them for reports already marked seen.
  10: async () => {
    await rebuildAggregates();
  },
};

async function ensureSchema() {
  const { schema_version } = await browser.storage.local.get('schema_version');
  const from = schema_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    if (MIGRATIONS[v]) {
      console.log(`[NexusOverseer] Migrating storage to schema ${v}.`);
      await MIGRATIONS[v]();
    } else if (from !== 0) {
      // No migration path from this version — snapshot, then wipe and re-scrape.
      console.log(`[NexusOverseer] No migration to schema ${v}, resetting storage.`);
      try {
        await backupToDownloads('pre-schema-wipe');
      } catch (err) {
        console.warn('[NexusOverseer] Pre-wipe backup failed:', err);
      }
      const { records_cap } = await browser.storage.local.get('records_cap');
      await browser.storage.local.clear();
      if (records_cap !== undefined) await browser.storage.local.set({ records_cap });
      break;
    }
  }
  await browser.storage.local.set({ schema_version: SCHEMA_VERSION });
}

// ── Full scrape (15-min alarm fallback + manual button) ────────────────────

async function scrape(context = null) {
  const listedUniverses = await getUniverses({ refresh: true });
  // Authenticated API requests must go through a same-origin game tab.
  const tabs = await browser.tabs.query({ url: '*://*.nexuslegacy.space/*' });
  const openUniverses = new Map();
  for (const tab of tabs) {
    const server = tab?.url ? globalThis.nexusStorage?.serverFromUrl?.(tab.url) : null;
    if (server) openUniverses.set(server.key, { key: server.key, name: server.name });
  }

  const ordered = new Map(listedUniverses.map(universe => [universe.key, universe]));
  for (const universe of openUniverses.values()) {
    if (!ordered.has(universe.key)) ordered.set(universe.key, universe);
  }
  const universesToScrape = [...ordered.keys()]
    .filter(key => openUniverses.has(key))
    .sort((a, b) => a.localeCompare(b));

  if (!universesToScrape.length) {
    const active = await globalThis.nexusStorage?.getActiveServer?.();
    universesToScrape.push(active?.key || 's0');
  }

  const errors = [];
  for (const universeKey of universesToScrape) {
    const run = async () => {
      await syncGameServer();
      return scrapeCurrentUniverse();
    };
    const result = globalThis.nexusStorage?.withServer
      ? await globalThis.nexusStorage.withServer(universeKey, run, context)
      : await run();
    if (!result?.ok) errors.push(`${universeKey}: ${result?.error || 'scrape failed'}`);
  }

  return errors.length
    ? { ok: false, error: `Some universe scrapes failed: ${errors.join('; ')}` }
    : { ok: true };
}

async function scrapeCurrentUniverse() {
  try {
    await ensureSchema();
    const planetId = await getHomePlanetId();
    const [shipyardData, reportData, pirateData, spyData, campScoutData,
           miningData, expeditionData, wormholeData, xenoMessagesData, systemDebrisData, missionsData, researchData, pvpData, zones] = await Promise.all([
      apiFetch(`/api/planets/${planetId}/shipyard`).catch(() => null),   // 403s while ships are on patrol — fall back to cached catalog
      apiFetch(REPORTS_PATH),
      apiFetch(PIRATES_PATH),
      apiFetch(SPY_PATH),
      apiFetch(CAMP_SCOUT_PATH),
      apiFetch(MINING_PATH).catch(() => ({ reports: [] })),
      apiFetch(EXPEDITION_PATH).catch(() => ({ reports: [] })),
      apiFetch(WORMHOLE_PATH).catch(() => ({ runs: [] })),
      apiFetch(`${XENO_MESSAGES_PATH}?page=1`).catch(() => ({ notifications: [] })),
      apiFetch(SYSTEM_DEBRIS_PATH).catch(() => null),
      apiFetch(MISSIONS_PATH).catch(() => ({ missions: [] })),
      apiFetch(RESEARCH_PATH).catch(() => ({ research: [] })),
      apiFetch(PVP_PATH).catch(() => ({ reports: [] })),
      getSystemZones(),
    ]);

    const [campZones, wormholeZones] = await Promise.all([
      getCampZones(zones),
      getWormholeZones(zones),
    ]);
    const { wormhole_classes: wormholeClasses, system_zone_by_id: zoneById } =
      await browser.storage.local.get(['wormhole_classes', 'system_zone_by_id']);

    await enqueue(async () => {
      // Shipyard can 403 (e.g. ships on patrol) — reuse the last-known catalog so
      // the rest of the scrape still runs. Ship defs rarely change.
      let ships;
      if (shipyardData) {
        ships = buildShipCatalog(shipyardData);
        await browser.storage.local.set({ ships });
      } else {
        ships = (await browser.storage.local.get('ships')).ships || {};
      }
      await backfillZones(zones, campZones, wormholeZones);
      await processMissions(missionsData.missions || [], zoneById || {}, ships);
      const nSurveys = await processSurveyReports(reportData.reports || [], ships, zones);
      const nPirates = await processPirateReports(pirateData.reports || [], ships, campZones);
      const nMining = await processMiningReports(miningData.reports || [], ships, zones);
      await processExpeditionReports(expeditionData.reports || [], wormholeData.runs || [], ships, zones, wormholeZones, wormholeClasses || {});
      await processXenoReports(xenoMessagesData.notifications || []);
      if (systemDebrisData) await processSystemDebris(systemDebrisData.debris || [], zones);
      await browser.storage.local.set({
        research: researchData.research || [],
        research_speed_mult: researchData.researchSpeedMult || 1,
        active_research: researchData.activeResearches || (researchData.activeResearch ? [researchData.activeResearch] : []),
      });
      await processSpyReports(spyData.reports || []);
      await processCampScoutReports(campScoutData.reports || []);
      await processPvpReports(pvpData.reports || []);
      await checkDrift();
      console.log(`[NexusOverseer] Scraped ${nSurveys} surveys, ${nPirates} pirate, ${nMining} mining reports.`);
    });
    await maybeAutoBackup();
    await browser.storage.local.set({
      last_scrape: new Date().toISOString(),
      last_error: null,
    });
    return { ok: true };
  } catch (err) {
    console.error('[NexusOverseer] Scrape failed:', err);
    // Cached planet may be gone (recolonized) — rediscover on next scrape.
    if (err.message.includes('→ 404')) await browser.storage.local.remove('planet_id');
    await browser.storage.local.set({ last_error: err.message });
    return { ok: false, error: err.message };
  }
}

// ── Realtime intercept (observe + re-fetch) ────────────────────────────────
// MV3 has no response-body reading (Chrome dropped blocking webRequest;
// Firefox's StreamFilter is MV2-only), so we OBSERVE when the game itself
// calls a report endpoint and then re-fetch that same endpoint to pick up the
// new data. Works identically on Chrome and Firefox; costs one extra request
// per change. Still near-realtime — the dashboard updates seconds after you
// open a report in game.

const WATCHED_URLS = [
  'https://*.nexuslegacy.space/api/fleet/survey-reports*',
  'https://*.nexuslegacy.space/api/fleet/pirate-reports*',
  'https://*.nexuslegacy.space/api/fleet/reports*',   // PvP combat reports
  'https://*.nexuslegacy.space/api/fleet/spy-reports*',
  'https://*.nexuslegacy.space/api/fleet/camp-scout-reports*',
  'https://*.nexuslegacy.space/api/fleet/mining-reports*',
  'https://*.nexuslegacy.space/api/fleet/expedition-reports*',
  'https://*.nexuslegacy.space/api/fleet/wormhole-runs*',
  'https://*.nexuslegacy.space/api/messages/system*',
  'https://*.nexuslegacy.space/api/fleet/system-debris*',
  'https://*.nexuslegacy.space/api/fleet/missions*',
  'https://*.nexuslegacy.space/api/research*',
  'https://*.nexuslegacy.space/api/planets/*/shipyard*',
];

// Best-effort debounce so a burst of game calls to the same endpoint triggers
// one re-fetch. Module scope resets if the service worker sleeps, which only
// risks an extra (deduped) re-fetch — harmless.
const refetchPending = new Set();

browser.webRequest.onCompleted.addListener(
  details => {
    if (details.tabId === -1) return;                       // our own re-fetches
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const url = new URL(details.url);
    const server = globalThis.nexusStorage?.serverFromUrl?.(url.href);
    if (!server) return;
    const path = url.pathname;
    if (activeGameRequests.has(`${details.tabId}:${path}`)) return;
    const key = `${url.host}${path}`;
    if (refetchPending.has(key)) return;
    refetchPending.add(key);
    setTimeout(() => refetchPending.delete(key), 3000);
    void refetchEndpoint(path, server.key);
  },
  { urls: WATCHED_URLS }
);

async function refetchEndpoint(path, serverKey) {
  try {
    const refresh = async () => {
      await syncGameServer();
      const json = await apiFetch(path, { priority: 'background' });
      const server = await globalThis.nexusStorage?.getActiveServer?.();
      await routeIntercepted(`${server?.origin || GAME_URL}${path}`, json);
    };
    if (globalThis.nexusStorage?.withServer) {
      await globalThis.nexusStorage.withServer(serverKey, refresh);
    } else {
      await refresh();
    }
  } catch (error) {
    console.warn(`[NexusOverseer] Realtime refresh failed for ${serverKey}${path}:`, error.message);
  }
}

function routeIntercepted(url, json) {
  return enqueue(async () => {
    if (url.includes('/shipyard')) {
      await browser.storage.local.set({ ships: buildShipCatalog(json) });
      return;
    }
    if (url.includes('/spy-reports')) {
      await processSpyReports(json.reports || []);
      return;
    }
    if (url.includes('/camp-scout-reports')) {
      await processCampScoutReports(json.reports || []);
      return;
    }
    if (url.includes('/messages/system')) {
      await processXenoReports(json.notifications || []);
      return;
    }
    if (url.includes('/api/fleet/reports')) {   // PvP (distinct from *-reports)
      await processPvpReports(json.reports || []);
      return;
    }
    if (url.includes('/system-debris')) {
      const { system_zones } = await browser.storage.local.get('system_zones');
      await processSystemDebris(json.debris || [], system_zones || {});
      return;
    }
    if (url.includes('/missions')) {
      const { system_zone_by_id, ships } = await browser.storage.local.get(['system_zone_by_id', 'ships']);
      await processMissions(json.missions || [], system_zone_by_id || {}, ships || {});
      return;
    }
    if (url.includes('/api/research')) {
      await browser.storage.local.set({
        research: json.research || [],
        research_speed_mult: json.researchSpeedMult || 1,
        active_research: json.activeResearches || (json.activeResearch ? [json.activeResearch] : []),
      });
      return;
    }
    const { ships, system_zones, camp_zones, wormhole_zones, wormhole_classes } =
      await browser.storage.local.get(['ships', 'system_zones', 'camp_zones', 'wormhole_zones', 'wormhole_classes']);
    if (!ships) return; // no catalog yet — the next full scrape bootstraps it
    const zones = system_zones || {};
    const wz = wormhole_zones || {};
    const wc = wormhole_classes || {};
    let n = 0;
    if (url.includes('/survey-reports')) n = await processSurveyReports(json.reports || [], ships, zones);
    else if (url.includes('/pirate-reports')) n = await processPirateReports(json.reports || [], ships, camp_zones || {});
    else if (url.includes('/mining-reports')) n = await processMiningReports(json.reports || [], ships, zones);
    else if (url.includes('/expedition-reports')) n = await processExpeditionReports(json.reports || [], [], ships, zones, wz, wc);
    else if (url.includes('/wormhole-runs')) n = await processExpeditionReports([], json.runs || [], ships, zones, wz, wc);
    if (n) console.log(`[NexusOverseer] Realtime: ${n} new reports from ${url}`);
  });
}

// Exposed for the node test harness (tests/processors.test.js). The service
// worker itself drives everything through the listeners registered above.
export {
  apiFetch,
  getMarketTrades,
  processSurveyReports, processPirateReports, processMiningReports,
  processPvpReports,
  processExpeditionReports, processSystemDebris, processSpyReports, rebuildAggregates,
  checkDrift, ensureSchema, appendToArchive, loadArchive,
  systemFromLocation, resolveZone, backfillZones, processMissions,
  fieldMatches, purgeOldData, resolveRecordsCap,
};
