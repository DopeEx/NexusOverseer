// Asteroids Fields tab: asteroid fields in the N nearest explored systems to a
// chosen planet (type, content, multiplier, security zone, distance, miner).
//
//   /api/galaxy/map                        → all systems with coords + sector id
//   /api/galaxy/sectors/{sectorId}/systems → name/zone/planetCount for a sector
//   /api/galaxy/systems/{id}/planets       → that system's asteroidFields
// Per-system scans reuse the finder's shared cache.

import { loadGalaxyScans, getSystemPlanets, asteroidRow, asteroidMatches, retainMiningFields, visibleAsteroidFields, sameAsteroidSearch, reconcileAsteroidRows } from '../galaxy-client.js';
import { loadFleetTemplates } from './fleets.js';
import { usedFleetSlots } from '../mission-state.js';
import { ALL_RES_COLORS, clearAvailStrip, editFleetDialog, fmt, fuelEstimate, missionProgress, rememberSelection, rememberedSelections, renderAvailStrip, setStatusText, ZONE_DEFS, listBadge, zoneBadge, allianceBadge } from '../common.js';

const ICON_BASE = 'https://s0.nexuslegacy.space/images/resources/';
// asteroid fieldType → resource icon + label
const FIELD_TYPES = [
  { type: 'ore', res: 'ore', label: 'ore', color: ALL_RES_COLORS.ore },
  { type: 'gas', res: 'hydrogen', label: 'gas (hydrogen)', color: ALL_RES_COLORS.hydrogen },
  { type: 'ice', res: 'cryo_ice', label: 'ice (cryo-ice)', color: ALL_RES_COLORS.cryo_ice },
  { type: 'plasma', res: 'plasma_core', label: 'plasma (core)', color: ALL_RES_COLORS.plasma_core },
  { type: 'quantum', res: 'quantum_dust', label: 'quantum (dust)', color: ALL_RES_COLORS.quantum_dust },
  { type: 'dark', res: 'dark_matter', label: 'dark (matter)', color: ALL_RES_COLORS.dark_matter },
];
const TYPE_COLOR = Object.fromEntries(FIELD_TYPES.map(t => [t.type, t.color]));
// Ship recommendation per asteroid field type: specialized ship + per-cycle
// extraction of that resource (Stats.txt "Mining extraction capacity").
const REC_SHIP = {
  ore: ['Mining Vessel', 50], plasma: ['Mining Vessel', 25],
  gas: ['Gas Collector', 17], quantum: ['Gas Collector', 3],
  ice: ['Ice Drill', 25], dark: ['Ice Drill', 3],
};
const REC_CYCLES = 10;   // ships to clear the field in this many mining cycles
const EXCAVATOR_BONUS = 1.2;   // +20% fleet extraction capacity when an Excavator is present
// Mining ships the recommendation manages; other template ships (escort/combat)
// are left untouched when seeding the launch fleet.
const MINING_SHIPS = new Set([...Object.values(REC_SHIP).map(s => s[0]), 'Excavator']);
const afTypeFilter = new Set();    // empty = any; multi-select like the market
const afZoneFilter = new Set();    // empty = any

let afInited = false;
let afPlanets = [];                // [{ id, name, systemId, systemName, isHomeworld }]
let afRefMS = null;                // chosen reference planet system coords
let afFields = [];                 // scanned asteroid fields
let afRunning = false;
let afStopRequested = false;
let afGeneration = 0;
let afSort = { key: 'distance', dir: 1 };
let afPage = 1;
const AF_PER_PAGE = 25;

export function resetAsteroidsTab() {
  afGeneration++;
  afInited = false;
  afPlanets = [];
  afRefMS = null;
  afFields = [];
  afRunning = false;
  afStopRequested = false;
  document.getElementById('af-scan').textContent = 'Scan';
  document.getElementById('af-scan').disabled = false;
  delete document.getElementById('af-progress').dataset.apiPath;
  document.getElementById('af-api-wait').textContent = '';
  afPage = 1;
  afTemplates = [];
  afMap = null;
  Object.keys(sectorSystems).forEach(k => delete sectorSystems[k]);
  afAllShips = [];
  if (afAvailTimer) clearInterval(afAvailTimer);
  afAvailTimer = null;
  afMyUsername = null;
  afMiningFieldIds = new Set();
  afMissions = [];
  afMissionsAt = 0;
  Object.keys(allianceTagCache).forEach(k => delete allianceTagCache[k]);
}
const MINING_DURATION = 600;   // seconds; fixed for asteroid mining missions
const ASTEROID_CACHE_TTL = 15 * 60 * 1000;   // fields drain fast — refetch after 15 min
const ASTEROID_RESULTS_CACHE_KEY = 'asteroid_scan_results';
let afTemplates = [];        // fleet templates, managed in the Fleets tab
let afMap = null;            // { byId: {id→{x,y,sectorId,visibility}}, systems: [...] }, cached
const sectorSystems = {};   // sectorId → systems[] (name/zone/planetCount), cached
let afAllShips = [];        // every ship def: [{ shipDefId, name, imageUrl }]
let afAvailTimer = null;    // periodic availability poll
let afMyUsername = null;    // this player's username, to spot fields already mined by us
let afMiningFieldIds = new Set();   // fieldIds with an in-flight/active mine mission
let afMissions = [];        // current fleet missions from the fleet API
let afMissionsAt = 0;
const allianceTagCache = {};   // player name → alliance tag (or null), session cache

async function restoreCachedAsteroidResults(planetId) {
  const stored = await browser.storage.local.get(ASTEROID_RESULTS_CACHE_KEY);
  const cached = stored[ASTEROID_RESULTS_CACHE_KEY];
  const count = Math.max(1, Math.min(500, parseInt(document.getElementById('af-near').value, 10) || 10));
  const zones = [...afZoneFilter].sort();
  const types = [...afTypeFilter].sort();
  if (!cached || cached.planetId !== planetId || !Array.isArray(cached.fields) ||
      !Number.isFinite(cached.at) || Date.now() - cached.at >= ASTEROID_CACHE_TTL ||
      cached.near !== count || JSON.stringify(cached.zones || []) !== JSON.stringify(zones) ||
      JSON.stringify(cached.types || []) !== JSON.stringify(types) ||
      !cached.referenceSystem || !Number.isFinite(cached.referenceSystem.x) ||
      !Number.isFinite(cached.referenceSystem.y)) {
    return false;
  }
  afFields = cached.fields;
  afRefMS = cached.referenceSystem;
  afPage = 1;
  const matchingFields = renderAsteroids();
  const ageMinutes = Math.max(0, Math.floor((Date.now() - cached.at) / 60000));
  setStatusText(document.getElementById('af-progress'),
    `Showing cached${cached.incomplete ? ' incomplete' : ''} scan: ${afFields.length} fields discovered, ${matchingFields} match filters (${ageMinutes} min old).`);
  return true;
}

// Resolve alliance tags for a set of player names not already cached.
async function resolveAllianceTags(names, generation) {
  const need = [...new Set(names)].filter(n => n && !(n in allianceTagCache));
  await Promise.all(need.map(async name => {
    const res = await browser.runtime.sendMessage({ type: 'GET_PLAYER_ALLIANCE_TAG', name,
      priority: 'background', source: 'asteroid-search' });
    if (!res || res.error) throw new Error(res?.error || 'No alliance response.');
    if (generation === afGeneration) allianceTagCache[name] = res.tag || null;
  }));
}

export async function initAsteroidsTab() {
  if (afInited) return;
  afInited = true;
  const status = document.getElementById('af-progress');
  setStatusText(status, 'Loading…');

  const planets = await browser.runtime.sendMessage({ type: 'GET_PLANETS' });
  if (planets.error) { setStatusText(status, `Error: ${planets.error}`); afInited = false; return; }
  afPlanets = (planets.planets || []).filter(p => p.systemId != null);

  const me = await browser.runtime.sendMessage({ type: 'GET_AUTH_ME' });
  afMyUsername = (me && !me.error && me.user) ? me.user.username : null;

  const pSel = document.getElementById('af-planet');
  pSel.textContent = '';
  for (const p of afPlanets) {
    const label = p.systemName ? `${p.name} (${p.systemName})` : p.name;
    const o = document.createElement('option');
    o.value = p.id; o.textContent = label;
    if (p.isHomeworld) o.selected = true;
    pSel.appendChild(o);
  }
  const savedSel = await rememberedSelections();
  if (savedSel['af-planet'] && afPlanets.some(p => String(p.id) === savedSel['af-planet'])) {
    pSel.value = savedSel['af-planet'];   // remembered planet survives tabs/sessions
  }
  for (const [id, key] of [['af-mult-min', 'af-mult-min'], ['af-qty-min', 'af-qty-min'], ['af-left-min', 'af-left-min'], ['af-near', 'af-near']]) {
    const value = savedSel[key];
    if (value != null && String(value) !== '') document.getElementById(id).value = String(value);
  }
  if (Array.isArray(savedSel['af-type-filter'])) {
    afTypeFilter.clear(); savedSel['af-type-filter'].forEach(v => afTypeFilter.add(v));
  }
  if (Array.isArray(savedSel['af-zone-filter'])) {
    afZoneFilter.clear(); savedSel['af-zone-filter'].forEach(v => afZoneFilter.add(v));
  }

  drawTypeIcons();
  drawZoneToggles();
  await loadLiveSearch(savedSel);
  await initLsStatus();
  renderLsStatus();
  await refreshSlots();

  await refreshTemplates();
  const restoredCachedResults = await restoreCachedAsteroidResults(Number(pSel.value));
  if (lsRunning) await loadLiveResults();
  // Keep the selector in sync with edits made in the Fleets tab.
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.fleet_templates) refreshTemplates();
    // Live search can be stopped from the game-page results window — reflect it.
    if (changes.live_search) {
      const config = changes.live_search.newValue;
      const en = !!config?.enabled;
      if (en !== lsRunning) { lsRunning = en; setLsButton(); }
      if (en && !sameAsteroidSearch(config, readLsConfig())) {
        afStopRequested = true;
        afGeneration++;
        afRunning = false;
        document.getElementById('af-scan').textContent = 'Scan';
        document.getElementById('af-scan').disabled = false;
        void loadLiveSearch({}, config).then(loadLiveResults).catch(showLiveError);
      }
    }
    if (changes.asteroid_scan_results && lsRunning && !afRunning) void loadLiveResults().catch(showLiveError);
  });

  pSel.addEventListener('change', () => { rememberSelection('af-planet', pSel.value); setRefFromMap(pSel.value); renderAsteroids(); updateAfAvail(); saveLiveSearchIfOn(); });
  document.getElementById('af-scan').addEventListener('click', scan);
  document.getElementById('af-template-select').addEventListener('change', e => { rememberSelection('af-template-select', e.target.value); computeFuel(); });
  document.getElementById('af-results-head').addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    afSort = { key: th.dataset.key, dir: afSort.key === th.dataset.key ? -afSort.dir : -1 };
    afPage = 1;
    renderAsteroids();
  });
  document.getElementById('af-btn-prev').addEventListener('click', () => { afPage--; renderAsteroids(); });
  document.getElementById('af-btn-next').addEventListener('click', () => { afPage++; renderAsteroids(); });
  for (const id of ['af-mult-min', 'af-qty-min', 'af-left-min', 'af-near']) {
    document.getElementById(id).addEventListener('change', e => {
      if (parseFloat(e.target.value) < 0) e.target.value = '';   // positive only
      rememberSelection(id, e.target.value);
      afPage = 1;
      renderAsteroids();
      saveLiveSearchIfOn();
    });
  }

  // Live-search controls.
  document.getElementById('ls-search').addEventListener('click', toggleLiveSearch);

  // Ship catalog (names + icons) for the availability strip, then start it.
  const defs = await browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' });
  afAllShips = (defs.ships || []).map(s => ({ shipDefId: s.shipDefId, name: s.name, imageUrl: s.imageUrl }));
  updateAfAvail();
  if (!afAvailTimer) {
    afAvailTimer = setInterval(() => {
      if (document.getElementById('asteroids-content').style.display !== 'none') { updateAfAvail(); refreshSlots(); }
    }, 10000);   // catch returning mining fleets without a reload
  }

  if (!restoredCachedResults && !lsRunning) setStatusText(status, '');
}

// Ships stationed on the selected mining planet, shown above the fields table.
async function updateAfAvail() {
  const box = document.getElementById('af-avail');
  const planetId = Number(document.getElementById('af-planet').value);
  if (!planetId || !afAllShips.length) { clearAvailStrip(box); return; }
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) { clearAvailStrip(box, av.error); return; }
  renderAvailStrip(box, afAllShips, av.available, 'No ships on this planet.');
}

// Galaxy map (all systems with coords + sector id), fetched once and cached.
async function loadMap() {
  if (afMap) return afMap;
  const generation = afGeneration;
  const res = await browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' });
  if (res.error) throw Object.assign(new Error(res.error), { status: res.status });
  const systems = res.systems || [];
  const byId = {};
  for (const s of systems) byId[s.id] = s;
  const map = { systems, byId };
  if (generation === afGeneration) afMap = map;
  return map;
}

// Systems of a sector (with name/zone/planetCount/visibility), cached.
async function sectorSystemsFor(sectorId) {
  if (sectorSystems[sectorId]) return sectorSystems[sectorId];
  const generation = afGeneration;
  const res = await browser.runtime.sendMessage({ type: 'GET_SECTOR_SYSTEMS', sectorId,
    priority: 'bulk', source: 'asteroid-search' });
  if (res.error) throw Object.assign(new Error(res.error), { status: res.status });
  const systems = res.systems || [];
  if (generation === afGeneration) sectorSystems[sectorId] = systems;
  return systems;
}

// Set the distance reference from the cached map (no fetch if map isn't loaded).
function setRefFromMap(planetId) {
  afRefMS = null;
  const p = afPlanets.find(x => x.id === Number(planetId));
  const sys = p && afMap && afMap.byId[p.systemId];
  if (sys) afRefMS = { x: sys.x, y: sys.y };
}

// Clickable resource-icon type toggles (mirrors the market filter). Empty
// selection means all types. `redraw` re-renders the set; `after` runs side
// effects (re-render table for the main filter, save config for live search).
function drawTypeInto(boxId, filter, redraw, after) {
  const box = document.getElementById(boxId);
  box.textContent = '';
  for (const t of FIELD_TYPES) {
    const img = document.createElement('img');
    img.className = 'res-icon' + (filter.has(t.type) ? ' sel' : '');
    img.src = `${ICON_BASE}${t.res}.webp`;
    img.alt = t.label;
    img.title = t.label;
    img.addEventListener('click', () => {
      if (filter.has(t.type)) filter.delete(t.type); else filter.add(t.type);
      redraw();
      if (after) after();
    });
    box.appendChild(img);
  }
}

// Clickable zone toggles, coloured per zone. Empty selection means all zones.
function drawZoneInto(boxId, filter, redraw, after) {
  const box = document.getElementById(boxId);
  box.textContent = '';
  for (const { key: z } of ZONE_DEFS) {
    const b = document.createElement('button');
    const on = filter.has(z);
    b.type = 'button';
    b.className = `zone-toggle zone-${z}${on ? ' is-selected' : ''}`;
    b.textContent = z;
    b.addEventListener('click', () => {
      if (on) filter.delete(z); else filter.add(z);
      redraw();
      if (after) after();
    });
    box.appendChild(b);
  }
}

// Main fields filter: re-render the table on toggle.
function drawTypeIcons() {
  drawTypeInto('af-type', afTypeFilter, drawTypeIcons, () => {
    afPage = 1;
    rememberSelection('af-type-filter', [...afTypeFilter]);
    renderAsteroids();
    saveLiveSearchIfOn();
  });
}
function drawZoneToggles() {
  drawZoneInto('af-zone', afZoneFilter, drawZoneToggles, () => {
    afPage = 1;
    rememberSelection('af-zone-filter', [...afZoneFilter]);
    renderAsteroids();
    saveLiveSearchIfOn();
  });
}
// Live-search filter: persist config on toggle (if currently running).

// ── Live search (background, every 5 min) ──────────────────────────────────
let lsRunning = false;

function readLsConfig() {
  const num = id => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? null : v; };
  return {
    enabled: lsRunning,
    planetId: Number(document.getElementById('af-planet').value) || null,
    multMin: num('af-mult-min'),
    qtyMin: num('af-qty-min'),
    leftMin: num('af-left-min'),
    near: Math.max(1, Math.min(500, parseInt(document.getElementById('af-near').value, 10) || 10)),
    types: [...afTypeFilter],
    zones: [...afZoneFilter],
  };
}
let liveConfigVersion = 0;
async function saveLiveSearch() {
  const version = ++liveConfigVersion;
  const generation = afGeneration;
  const config = readLsConfig();
  const saved = await rememberedSelections();
  await browser.storage.local.set({ template_selections: { ...saved,
    'af-planet': String(config.planetId), 'af-near': String(config.near),
    'af-mult-min': config.multMin ?? '', 'af-qty-min': config.qtyMin ?? '', 'af-left-min': config.leftMin ?? '',
    'af-type-filter': config.types, 'af-zone-filter': config.zones,
  } });
  if (version !== liveConfigVersion || generation !== afGeneration) return;
  const response = await browser.runtime.sendMessage({ type: 'SET_LIVE_SEARCH', config });
  if (!response || response.error) throw new Error(response?.error || 'No Auto Scan response.');
}
function saveLiveSearchIfOn() {
  if (lsRunning) void saveLiveSearch().catch(showLiveError);
  else {
    liveConfigVersion++;
    void browser.storage.local.set({ live_search: readLsConfig() }).catch(showLiveError);
  }
}
function showLiveError(error) {
  console.error('[NexusOverseer] Live search failed:', error);
  setStatusText(document.getElementById('ls-status'), `Error: ${error.message}`);
}
let liveResultRead = 0;
async function loadLiveResults() {
  const read = ++liveResultRead;
  const generation = afGeneration;
  const { asteroid_scan_results: snapshot } = await browser.storage.local.get(ASTEROID_RESULTS_CACHE_KEY);
  if (read !== liveResultRead || generation !== afGeneration || !lsRunning || afRunning || !snapshot?.config ||
      !sameAsteroidSearch(snapshot.config, readLsConfig())) return;
  afFields = snapshot.fields;
  afRefMS = snapshot.referenceSystem;
  if (Array.isArray(snapshot.missions) && (snapshot.missionsAt ?? Date.now()) >= afMissionsAt) {
    afMissions = snapshot.missions;
    afMissionsAt = snapshot.missionsAt ?? Date.now();
    afMiningFieldIds = new Set(afMissions.filter(m => m.missionType === 'mine' && m.targetFieldId != null).map(m => m.targetFieldId));
  }
  renderAsteroids();
  setStatusText(document.getElementById('af-progress'), snapshot.updating ? 'Updating…'
    : snapshot.incomplete ? 'Partial results' : '');
}

let lsStatusData = null;
let lsStatusTimer = null;

function scanCounts(status, completed = false) {
  const target = status.target;
  const progress = status.targetProgress;
  const targetText = Number.isFinite(target) && Number.isFinite(progress)
    ? `Target ${progress}/${target}` +
      (completed && progress < target ? ' (not reached)' : '')
    : 'Target —';
  const fields = status.matchingFields == null
    ? `Listed ${status.found || 0}`
    : `Fields ${status.matchingFields}` +
      (status.missionExceptions ? ` + ${status.missionExceptions} mission${status.missionExceptions === 1 ? '' : 's'}` : '');
  return `${targetText} · Checked ${status.scanned || 0} · ${fields}`;
}

async function renderLsStatus() {
  const status = document.getElementById('ls-status');
  if (!status) return;
  status.title = 'Target counts systems with selected resource types, or nearby systems in selected zones when no type is selected. Checked counts inspected systems. Fields counts fields matching all filters; own mission exceptions are separate. Auto Scan runs every 5 minutes and reuses field data for up to 15 minutes.';
  delete status.dataset.apiPath;
  document.getElementById('ls-api-wait').textContent = '';
  if (!lsRunning) { setStatusText(status, ''); return; }
  const s = lsStatusData;
  const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (s && s.state === 'scanning') {
    if (s.apiPath) status.dataset.apiPath = s.apiPath;
    setStatusText(status, `🔍 ${s.phase || 'Scanning…'}${s.target != null ? ` ${scanCounts(s)}` : ''}`);
    return;
  }
  if (s && s.state === 'error') {
    setStatusText(status, `⚠ ${time(s.at)} · ${s.error}` +
      (s.target != null ? ` · ${scanCounts(s, true)}` : ''), 'warning');
    return;
  }
  let next = '';
  try {
    const alarm = await browser.alarms.get('nexus-livesearch');
    if (alarm) {
      const mins = Math.max(0, Math.ceil((alarm.scheduledTime - Date.now()) / 60000));
      next = ` · Next ~${mins}m`;
    }
  } catch { /* alarms unavailable */ }
  if (s && s.state === 'idle') {
    setStatusText(status, `${time(s.at)} · ${scanCounts(s, true)}${next}`);
  } else {
    setStatusText(status, `Waiting…${next}`);
  }
}

function setLsButton() {
  const btn = document.getElementById('ls-search');
  btn.textContent = lsRunning ? 'Stop Auto Scan' : 'Auto Scan';
  btn.classList.toggle('is-running', lsRunning);
  renderLsStatus();
}

async function initLsStatus() {
  ({ live_search_status: lsStatusData } = await browser.storage.local.get('live_search_status'));
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.live_search_status) return;
    lsStatusData = changes.live_search_status.newValue || null;
    renderLsStatus();
  });
  if (!lsStatusTimer) lsStatusTimer = setInterval(renderLsStatus, 15000);
}
async function toggleLiveSearch() {
  if (!lsRunning && !document.getElementById('af-planet').value) return;
  if (afRunning) { afStopRequested = true; afGeneration++; afRunning = false; }
  lsRunning = !lsRunning;
  setLsButton();
  document.getElementById('af-scan').textContent = 'Scan';
  document.getElementById('af-scan').disabled = false;
  try { await saveLiveSearch(); }
  catch (error) { lsRunning = false; setLsButton(); showLiveError(error); }
}

// Restore the live-search controls from the persisted config.
async function loadLiveSearch(saved = {}, config) {
  const cfg = config ?? (await browser.storage.local.get('live_search')).live_search;
  if (cfg) {
    if (cfg.planetId != null && (cfg.enabled || !saved['af-planet'])) document.getElementById('af-planet').value = String(cfg.planetId);
    for (const [id, key] of [['af-mult-min', 'multMin'], ['af-qty-min', 'qtyMin'], ['af-left-min', 'leftMin'], ['af-near', 'near']]) {
      if (cfg.enabled || saved[id] == null) document.getElementById(id).value = String(cfg[key] ?? (key === 'near' ? 10 : ''));
    }
    if (cfg.enabled || !Array.isArray(saved['af-type-filter'])) {
      afTypeFilter.clear(); (cfg.types || []).forEach(t => afTypeFilter.add(t));
    }
    if (cfg.enabled || !Array.isArray(saved['af-zone-filter'])) {
      afZoneFilter.clear(); (cfg.zones || []).forEach(z => afZoneFilter.add(z));
    }
    lsRunning = !!cfg.enabled;
  }
  drawTypeIcons();
  drawZoneToggles();
  setLsButton();
}

async function scan() {
  const btn = document.getElementById('af-scan');
  if (afRunning) {
    afStopRequested = true;
    btn.disabled = true;
    return;
  }
  if (lsRunning) {
    try { await saveLiveSearch(); } catch (error) { showLiveError(error); }
    return;
  }

  const status = document.getElementById('af-progress');
  const planetId = Number(document.getElementById('af-planet').value);
  const p = afPlanets.find(x => x.id === planetId);
  if (!p) return;
  const count = Math.max(1, Math.min(500, parseInt(document.getElementById('af-near').value, 10) || 10));
  const generation = ++afGeneration;
  afRunning = true;
  afStopRequested = false;
  btn.disabled = false;
  btn.textContent = 'Stop';
  const targetZones = new Set(afZoneFilter);
  const targetTypes = new Set(afTypeFilter);
  const config = readLsConfig();
  const previous = afFields;
  const foundFields = [];
  const observations = new Map();
  const reconcile = (pending = true) => {
    afFields = retainMiningFields(foundFields, previous, afMiningFieldIds, observations, pending);
    renderAsteroids();
  };
  const observe = (sys, meta, data) => {
    const at = data._galaxyCache?.times?.asteroidFields ?? Date.now();
    const rows = (data.asteroidFields || []).map(f => asteroidRow(f, sys, meta, at));
    observations.set(sys.id, { fields: rows, at });
    return rows;
  };
  const systemLimit = targetTypes.size ? 500 : count;
  let errors = 0, scanned = 0, matchingSystems = 0, inZone = 0;
  let stopReason = '';
  const current = () => generation === afGeneration;
  const reportIssue = (system, error) => {
    const label = system ? `${system.name || `#${system.id}`} (#${system.id})` : 'Owner alliance details';
    console.warn(`[NexusOverseer] Asteroid search issue for ${label}:`, error);
    if (error.status === 429) stopReason = 'Stopped: API rate limit (429). Retry the search later; saved results are retained';
    if (error.status === 401) stopReason = 'Stopped: Please log in to Nexus Legacy; saved results are retained';
    errors++;
    const item = document.createElement('li');
    item.textContent = `${label}: ${error.status ? `HTTP ${error.status}: ` : ''}${error.message}`;
    document.getElementById('af-search-issues-list').appendChild(item);
    document.getElementById('af-search-issues-summary').textContent = `Search issues (${errors})`;
    document.getElementById('af-search-issues').hidden = false;
  };
  const clearWait = () => {
    delete status.dataset.apiPath;
    document.getElementById('af-api-wait').textContent = '';
  };
  const progress = () => {
    const visible = visibleAsteroidFields(afFields, config, afMiningFieldIds);
    const exceptions = visible.filter(f => f.missing || f.unconfirmed || !asteroidMatches(f, config)).length;
    return `Scanning… ${scanCounts({
      target: count, targetProgress: targetTypes.size ? matchingSystems : inZone,
      typeFiltered: !!targetTypes.size, scanned,
      matchingFields: visible.length - exceptions, missionExceptions: exceptions,
    })}.`;
  };
  document.getElementById('af-search-issues').hidden = true;
  document.getElementById('af-search-issues-list').textContent = '';
  clearWait();
  try {
    setStatusText(status, 'Loading galaxy map…');
    status.dataset.apiPath = '/api/galaxy/map';
    const map = await loadMap();
    if (!current()) return;
    clearWait();
    if (afStopRequested) { setStatusText(status, 'Stopped.'); return; }
    const src = map.byId[p.systemId];
    if (!src) throw new Error('Source system not on the map.');
    const cache = await loadGalaxyScans();
    if (!current()) return;
    await refreshSlots();
    if (!current()) return;
    afRefMS = { x: src.x, y: src.y };
    const candidates = map.systems
      .filter(s => s.id !== p.systemId && (s.visibility === 'full' || s.visibility === 'partial'))
      .map(s => ({ s, d: Math.hypot(s.x - src.x, s.y - src.y) }))
      .sort((a, b) => a.d - b.d)
      .map(o => o.s);
    reconcile();
    afPage = 1;
    renderAsteroids();
    const saveResults = incomplete => browser.storage.local.set({
      [ASTEROID_RESULTS_CACHE_KEY]: {
        at: Date.now(), planetId, referenceSystem: { x: src.x, y: src.y },
        fields: [...afFields], near: count,
        zones: [...targetZones].sort(), types: [...targetTypes].sort(), incomplete, config,
      },
    });
    for (const sys of candidates) {
      if (afStopRequested || (targetTypes.size
        ? matchingSystems >= count || scanned >= systemLimit : inZone >= count)) break;
      let meta;
      let data;
      try {
        setStatusText(status, progress());
        status.dataset.apiPath = `/api/galaxy/sectors/${sys.sectorId}/systems`;
        meta = (await sectorSystemsFor(sys.sectorId)).find(s => s.id === sys.id);
        if (!current()) return;
        if (afStopRequested) break;
        if (!meta) throw new Error('System missing from sector response.');
        if (targetZones.size && !targetZones.has(meta.securityZone)) continue;
        inZone++;
        if (!meta.planetCount) continue;
        status.dataset.apiPath = `/api/galaxy/systems/${sys.id}/planets`;
        scanned++;
        data = await getSystemPlanets(sys.id, cache, { purpose: 'dynamic', maxAge: ASTEROID_CACHE_TTL, source: 'asteroid-search' });
      } catch (error) {
        if (!current()) return;
        reportIssue(sys, error);
        if (stopReason || afStopRequested) break;
        continue;
      } finally {
        if (current()) clearWait();
      }
      if (!current()) return;
      const fields = data.asteroidFields || [];
      const rows = observe(sys, meta, data);
      if (targetTypes.size && !fields.some(f => targetTypes.has(f.fieldType))) {
        reconcile();
        setStatusText(status, progress());
        if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
        if (!current()) return;
        continue;
      }
      matchingSystems++;
      foundFields.push(...rows);
      reconcile();
      setStatusText(status, progress());
      renderAsteroids();
      await saveResults(true);
      if (!current()) return;
      if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
      if (!current()) return;
    }
    if (!stopReason && !afStopRequested) {
      for (const field of previous) {
        if (!afMiningFieldIds.has(field.fieldId) || observations.has(field.systemId)) continue;
        try {
          status.dataset.apiPath = `/api/galaxy/systems/${field.systemId}/planets`;
          const data = await getSystemPlanets(field.systemId, cache,
            { purpose: 'dynamic', maxAge: ASTEROID_CACHE_TTL, source: 'asteroid-search' });
          if (!current()) return;
          observe({ id: field.systemId, x: field.sx, y: field.sy },
            { name: field.system, securityZone: field.zone }, data);
          reconcile();
        } catch (error) {
          if (!current()) return;
          reportIssue({ id: field.systemId, name: field.system }, error);
          if (stopReason) break;
        } finally {
          if (current()) clearWait();
        }
        if (afStopRequested) break;
      }
    }
    reconcile(false);
    await saveResults(!!stopReason || afStopRequested || errors > 0);
    if (!current()) return;
    const matchingFields = renderAsteroids();
    const visible = visibleAsteroidFields(afFields, config, afMiningFieldIds);
    const exceptions = visible.filter(f => f.missing || f.unconfirmed || !asteroidMatches(f, config)).length;
    const scanSummary = scanCounts({
      target: count, targetProgress: targetTypes.size ? matchingSystems : inZone,
      typeFiltered: !!targetTypes.size, scanned,
      matchingFields: matchingFields - exceptions, missionExceptions: exceptions,
    }, true);
    setStatusText(status, `${stopReason || (afStopRequested ? 'Stopped' : errors ? 'Incomplete' : 'Done')}: ` +
      scanSummary +
      (!inZone ? ' · no explored systems for these filters' : '') +
      (errors ? ` · ${errors} systems failed (see Search issues)` : '') + '.');
    const owners = afFields.filter(f => f.ownerName).map(f => f.ownerName);
    if (!stopReason && !afStopRequested && owners.length) {
      void resolveAllianceTags(owners, generation)
        .then(() => { if (current()) renderAsteroids(); })
        .catch(error => { if (current()) reportIssue(null, error); });
    }
  } catch (error) {
    if (current()) {
      console.warn('[NexusOverseer] Asteroid search failed:', error);
      setStatusText(status, `Error: ${error.message}`);
    }
  } finally {
    if (current()) {
      clearWait();
      afRunning = false;
      btn.textContent = 'Scan';
      btn.disabled = false;
    }
  }
}

function distance(f) {
  if (!afRefMS || f.sx == null) return null;
  return Math.round(Math.hypot(f.sx - afRefMS.x, f.sy - afRefMS.y));
}

// Recommended fleet to clear a field in REC_CYCLES cycles:
//   ships = ceil( remaining / (rate * cycles * richness) )
// Returns { count, name, shipDefId } or null when it can't be computed.
function recommend(f, withExcavatorBonus = false) {
  const spec = REC_SHIP[f.type];
  if (!spec || !f.remaining || !f.mult) return null;
  const [name, rate] = spec;
  const cap = rate * (withExcavatorBonus ? EXCAVATOR_BONUS : 1);
  const count = Math.ceil(f.remaining / (cap * REC_CYCLES * f.mult));
  const def = afAllShips.find(d => d.name === name);
  return { count, name, shipDefId: def ? def.shipDefId : null };
}

async function refreshTemplates() {
  afTemplates = await loadFleetTemplates();
  afTemplates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));   // alphabetical dropdown
  const sel = document.getElementById('af-template-select');
  const saved = await rememberedSelections();
  const want = saved['af-template-select'] || sel.value;   // survives tabs/sessions
  sel.textContent = '';
  const miningTemplates = afTemplates.filter(template => !(template.escortZones || []).length);
  if (!miningTemplates.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— none (create one in Fleets) —';
    sel.appendChild(o);
    return;
  }
  for (const t of miningTemplates) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
  if (want && miningTemplates.some(t => String(t.id) === want)) sel.value = want;
}

// Open the editable fleet dialog seeded from the ship recommendation (falling
// back to the selected template), then dispatch. Sends once — the saved
// template is left untouched.
async function sendMineMission(f) {
  const planetId = Number(document.getElementById('af-planet').value);
  const planet = afPlanets.find(p => p.id === planetId);
  const status = document.getElementById('af-progress');
  if (!planetId) { alert('Pick a source planet first.'); return; }

  setStatusText(status, 'Checking fleet…');
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) { setStatusText(status, `Error: ${av.error}`); return; }
  const avail = av.available || {};

  // Seed the editor straight from the selected template — the "Optimise Mining
  // Fleet" button in the dialog is what swaps in the recommended mining ships.
  const tpl = afTemplates.find(t => String(t.id) === document.getElementById('af-template-select').value);
  const seed = {};
  for (const [id, q] of Object.entries((tpl && tpl.ships) || {})) seed[Number(id)] = q;

  const rec = recommend(f);
  const recShips = rec && rec.shipDefId != null ? [{ shipDefId: rec.shipDefId, quantity: rec.count }] : [];
  const excavator = afAllShips.find(d => d.name === 'Excavator');
  const miningShipIds = new Set(afAllShips.filter(d => MINING_SHIPS.has(d.name)).map(d => d.shipDefId));
  const escortTemplates = f.zone && f.zone !== '—'
    ? afTemplates.filter(template => (template.escortZones || []).includes(f.zone))
    : [];
  const autoEscortTemplate = escortTemplates[0] || null;
  const savedUntilFull = localStorage.getItem('nx-af-until-full');
  const untilFullState = { untilFull: savedUntilFull == null || savedUntilFull === '1' };
  const savedRetreatThreshold = localStorage.getItem('nx-af-escort-retreat-threshold');
  const escortRetreatThresholdState = {
    threshold: savedRetreatThreshold == null
      ? 50
      : [30, 50, 70].includes(Number(savedRetreatThreshold)) ? Number(savedRetreatThreshold) : null,
  };

  const ships = await editFleetDialog({
    title: `Mine ${f.name}`,
    subtitle: `To: ${f.name} (${f.system})\nFrom: ${planet ? planet.name : planetId}`,
    avail, seed, recShips, miningShipIds, excavatorShipDefId: excavator ? excavator.shipDefId : null,
    excavatorBonus: EXCAVATOR_BONUS, escortTemplates, autoEscortTemplate, untilFullState,
    escortRetreatThresholdState,
    refreshAvailability: () => browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId }),
  });
  if (!ships || !ships.length) return;   // cancelled or emptied
  localStorage.setItem('nx-af-until-full', untilFullState.untilFull ? '1' : '0');
  if (escortRetreatThresholdState.threshold == null) {
    localStorage.removeItem('nx-af-escort-retreat-threshold');
  } else {
    localStorage.setItem('nx-af-escort-retreat-threshold', String(escortRetreatThresholdState.threshold));
  }

  setStatusText(status, `Sending to ${f.name}…`);
  const res = await browser.runtime.sendMessage({
    type: 'SEND_MINE',
    sourcePlanetId: planetId,
    targetFieldId: f.fieldId,
    ships,
    miningDuration: MINING_DURATION,
    mineUntilFull: untilFullState.untilFull,
    escortRetreatThreshold: escortRetreatThresholdState.threshold,
  });
  setStatusText(status, res.error ? `Send failed: ${res.error}` : `Fleet sent to ${f.name} ✓`);
  if (!res.error) {
    afMiningFieldIds.add(f.fieldId);   // optimistic — GET_MISSIONS can lag right after the send
    renderAsteroids();
    refreshSlots(); updateAfAvail();
  }
}

// "used/max fleet slots" and in-flight mine missions — both come from the
// missions endpoint. afMiningFieldIds drives the "already mining" row highlight.
async function refreshSlots() {
  const generation = afGeneration;
  const requestedAt = Date.now();
  const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
  if (generation !== afGeneration) return;
  if (!mi || mi.error) {
    console.warn('[NexusOverseer] Mining mission refresh failed:', mi?.error || 'No response');
    setStatusText(document.getElementById('af-slots'), `Error: ${mi?.error || 'No mission response'}`);
    return;
  }
  if (mi.maxFleetSlots != null) {
    document.getElementById('af-slots').textContent = `${usedFleetSlots(mi.missions)}/${mi.maxFleetSlots} fleet slots`;
  }
  afMiningFieldIds = new Set(
    (mi.missions || []).filter(m => m.missionType === 'mine' && m.targetFieldId != null).map(m => m.targetFieldId));
  afMissions = mi.missions || [];
  afMissionsAt = requestedAt;
  afFields = afFields.filter(f => (!f.missing && !f.unconfirmed) || afMiningFieldIds.has(f.fieldId));
  renderAsteroids();
}

export function renderAsteroids() {
  const tbody = document.getElementById('af-results-tbody');
  const existing = new Map([...tbody.children].map(row => [Number(row.dataset.field), row]));
  const rendered = [];
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  document.querySelectorAll('#af-results-head th.sortable').forEach(th => {
    let arrow = th.querySelector('.arrow');
    if (th.dataset.key === afSort.key) {
      if (!arrow) {
        arrow = document.createElement('span');
        arrow.className = 'arrow';
        th.appendChild(arrow);
      }
      setText(arrow, afSort.dir === -1 ? '▼' : '▲');
    } else if (arrow) arrow.remove();
  });

  let rows = afFields.map(f => {
    const rec = recommend(f);
    return {
      ...f,
      distance: distance(f),
      leftPct: f.total ? Math.round((f.remaining / f.total) * 100) : null,
      rec, recShips: rec ? rec.count : null,
    };
  });
  const config = readLsConfig();
  rows = visibleAsteroidFields(rows, config, afMiningFieldIds);
  const { key, dir } = afSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    let cmp;
    if (va == null && vb == null) cmp = 0;
    else if (va == null) cmp = 1;
    else if (vb == null) cmp = -1;
    else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb));
    return cmp * dir;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / AF_PER_PAGE));
  afPage = Math.min(Math.max(1, afPage), totalPages);
  document.getElementById('af-page-info').textContent = `Page ${afPage} / ${totalPages}`;
  document.getElementById('af-btn-prev').disabled = afPage <= 1;
  document.getElementById('af-btn-next').disabled = afPage >= totalPages;
  const pageRows = rows.slice((afPage - 1) * AF_PER_PAGE, afPage * AF_PER_PAGE);

  for (const f of pageRows) {
    let tr = existing.get(f.fieldId);
    if (!tr) {
      tr = document.createElement('tr');
      for (let i = 0; i < 12; i++) tr.appendChild(document.createElement('td'));
      const ship = document.createElement('span');
      ship.textContent = '🚀';
      ship.className = 'asteroids-fleet-ship';
      tr.children[0].appendChild(ship);
      const system = document.createElement('span');
      const note = document.createElement('span');
      note.className = 'af-mission-note';
      const badge = document.createElement('span');
      badge.className = 'af-mission-badge';
      badge.style.cssText = 'display:inline-block;margin-left:5px;font-size:0.7rem;padding:1px 5px;border-radius:4px;background:#f0883e22;border:1px solid var(--orange);color:var(--orange);vertical-align:middle;';
      tr.children[1].append(system, note, badge);
      tr.children[2].appendChild(listBadge('', 'asteroids-type-badge'));
      tr.children[3].appendChild(document.createElement('span'));
      tr.children[6].appendChild(zoneBadge(f.zone));
      const fieldId = document.createElement('button');
      fieldId.type = 'button';
      fieldId.className = 'asteroids-copy-id';
      fieldId.textContent = String(f.fieldId);
      fieldId.title = 'Copy field ID';
      fieldId.onclick = async () => {
        try {
          await navigator.clipboard.writeText(String(f.fieldId));
          fieldId.title = 'Copied';
          setStatusText(document.getElementById('af-progress'), `Copied ID ${f.fieldId}`);
        } catch (error) {
          console.warn('[NexusOverseer] Copying asteroid field ID failed:', error);
          fieldId.title = 'Copy failed';
          setStatusText(document.getElementById('af-progress'), `Copy failed: ${error.message}`);
        }
      };
      tr.children[7].appendChild(fieldId);
      const owner = document.createElement('span');
      const alliance = allianceBadge('');
      tr.children[8].append(owner, alliance);
      tr.children[10].className = 'af-fuel';
      tr.children[10].textContent = '…';
    }
    tr.dataset.system = f.systemId;
    tr.dataset.field = f.fieldId;
    tr.dataset.unavailable = String(!!f.missing || !!f.unconfirmed);
    tr.style.background = (afMyUsername && f.minerPresent === afMyUsername) || afMiningFieldIds.has(f.fieldId)
      ? 'rgba(63,185,80,0.15)' : '';
    const ship = tr.children[0].children[0];
    ship.title = f.missing || f.unconfirmed ? 'Field is not confirmed; cannot send another fleet.' : 'Send mining fleet here';
    ship.onclick = !f.missing && !f.unconfirmed ? () => sendMineMission(f) : null;

    const content = f.remaining == null ? '—'
      : `${fmt(f.remaining)} / ${fmt(f.total ?? 0)}`;
    const tag = f.ownerName ? allianceTagCache[f.ownerName] : null;
    const owner = f.ownerName || '—';
    const cells = [
      f.system, String(f.type).replace(/_/g, ' '),
      f.mult == null ? '—' : `×${f.mult}`,
      content,
      f.leftPct == null ? '—' : `${f.leftPct}%`,
      f.zone,
      String(f.fieldId),
      owner,
      f.distance == null ? '—' : String(f.distance),
      '…',   // fuel cost, filled async
      f.rec ? `${f.rec.count}× ${f.rec.name}` : '—',
    ];
    cells.forEach((v, i) => {
      const td = tr.children[i + 1];
      if (i === 0) setText(td.children[0], v);
      else if (i === 1) {
        setText(td.children[0], v);
        td.children[0].style.color = TYPE_COLOR[f.type] || 'var(--text-muted)';
        td.children[0].style.borderColor = TYPE_COLOR[f.type] || 'var(--border-strong)';
      }
      else if (i === 2) {
        setText(td.children[0], v);
        td.children[0].className = f.mult == null ? '' : 'finder-badge asteroids-mult-badge';
      }
      else if (i === 5) {
        zoneBadge(f.zone, td.children[0]);
      }
      else if (i === 6) setText(td.children[0], v);
      else if (i === 7) {
        setText(td.children[0], owner);
        td.children[0].className = f.ownerName ? 'finder-badge' : '';
        setText(td.children[1], tag ? `[${tag}]` : '');
        td.children[1].hidden = !tag;
      }
      else if (i !== 9) setText(td, v);
    });
    const own = afMiningFieldIds.has(f.fieldId);
    const note = own ? (f.missing ? 'Field no longer present - own mining mission still active'
        : f.unconfirmed ? 'Field not rechecked - own mining mission still active'
          : !asteroidMatches(f, config) ? 'Own mining mission - outside filters' : '') : '';
    const label = tr.children[1].children[1];
    setText(label, note ? ` · ${note}` : '');
    label.hidden = !note;
    const missions = afMissions.filter(m => m.missionType === 'mine' && m.targetFieldId === f.fieldId);
    const badge = tr.children[1].children[2];
    setText(badge, missions.length > 1 ? `⛏ ×${missions.length}` : '⛏');
    badge.hidden = !missions.length;
    badge.style.display = missions.length ? 'inline-block' : 'none';
    badge.title = missions.map(m => `Fleet: ${missionProgress(m).label}`).join('\n');
    tr.style.borderLeft = missions.length ? '3px solid #f0883e' : '';
    tr.title = f.observedAt ? `Field data checked: ${new Date(f.observedAt).toLocaleString()}` : '';
    rendered.push(tr);
  }
  reconcileAsteroidRows(tbody, rendered);
  const systems = new Set(rows.map(row => row.systemId)).size;
  const exceptions = rows.filter(row => row.missing || row.unconfirmed || !asteroidMatches(row, config)).length;
  document.getElementById('af-count').textContent = `${rows.length} field${rows.length === 1 ? '' : 's'} in ${systems} system${systems === 1 ? '' : 's'}` +
    (exceptions ? ` (${exceptions} own mission exception${exceptions === 1 ? '' : 's'})` : '');
  computeFuel();
  return rows.length;
}

// Fill the Fuel Cost column: one fuel-estimate per visible row for the selected
// template's ships, from the chosen planet. A generation guard discards results
// from a superseded render/selection.
let afFuelGen = 0;
async function computeFuel() {
  const gen = ++afFuelGen;
  const planetId = Number(document.getElementById('af-planet').value);
  const cells = () => document.querySelectorAll('#af-results-tbody td.af-fuel');
  const tpl = afTemplates.find(t => String(t.id) === document.getElementById('af-template-select').value);
  const ships = Object.entries(tpl ? tpl.ships : {})
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }))
    .filter(s => s.quantity > 0);
  if (!ships.length) {
    cells().forEach(c => {
      if (c.textContent !== '—') c.textContent = '—';
      c.style.color = '';
      c.title = tpl ? 'Template has no ships' : 'No template selected';
    });
    return;
  }
  for (const tr of document.querySelectorAll('#af-results-tbody tr')) {
    if (gen !== afFuelGen) return;
    const cell = tr.querySelector('.af-fuel');
    if (tr.dataset.unavailable === 'true') {
      if (cell) {
        if (cell.textContent !== '—') cell.textContent = '—';
        cell.style.color = '';
        cell.title = 'Field is not confirmed';
      }
      continue;
    }
    const sysId = Number(tr.dataset.system);
    if (!cell || !sysId) continue;
    const est = await fuelEstimate(planetId, sysId, ships, 'mine');
    if (gen !== afFuelGen) return;
    if (est.error) {
      if (cell.textContent !== '—') cell.textContent = '—';
      cell.style.color = '';
      cell.title = est.error;
      continue;
    }
    if (cell.textContent !== `${est.fuelCost}`) cell.textContent = `${est.fuelCost}`;
    cell.style.color = est.inRange === false ? '#ff6b7a' : '';
    cell.title = est.inRange === false ? 'Out of range' : `distance ${est.distance.toFixed(1)} ly`;
  }
}
