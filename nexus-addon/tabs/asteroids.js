// Asteroids Fields tab: asteroid fields in the N nearest explored systems to a
// chosen planet (type, content, multiplier, security zone, distance, miner).
//
//   /api/galaxy/map                        → all systems with coords + sector id
//   /api/galaxy/sectors/{sectorId}/systems → name/zone/planetCount for a sector
//   /api/galaxy/systems/{id}/planets       → that system's asteroidFields
// Per-system scans reuse the finder's shared cache.

import { loadGalaxyScans, getSystemPlanets } from '../galaxy-client.js';
import { loadFleetTemplates } from './fleets.js';
import { usedFleetSlots } from '../mission-state.js';
import { ALL_RES_COLORS, clearAvailStrip, editFleetDialog, fmt, fuelEstimate, missionProgress, rememberSelection, rememberedSelections, renderAvailStrip, setStatusText, ZONE_COLORS, ZONE_DEFS } from '../common.js';

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
const lsTypeFilter = new Set();    // live-search type filter (independent)
const lsZoneFilter = new Set();    // live-search zone filter (independent)

let afInited = false;
let afPlanets = [];                // [{ id, name, systemId, systemName, isHomeworld }]
let afRefMS = null;                // chosen reference planet system coords
let afFields = [];                 // scanned asteroid fields
let afRunning = false;
let afSort = { key: 'distance', dir: 1 };
let afPage = 1;
const AF_PER_PAGE = 25;

export function resetAsteroidsTab() {
  afInited = false;
  afPlanets = [];
  afRefMS = null;
  afFields = [];
  afRunning = false;
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
const allianceTagCache = {};   // player name → alliance tag (or null), session cache

async function restoreCachedAsteroidResults(planetId) {
  const stored = await browser.storage.local.get(ASTEROID_RESULTS_CACHE_KEY);
  const cached = stored[ASTEROID_RESULTS_CACHE_KEY];
  const count = Math.max(1, Math.min(500, parseInt(document.getElementById('af-near').value, 10) || 25));
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
    `Showing cached scan: ${afFields.length} fields discovered, ${matchingFields} match filters (${ageMinutes} min old).`);
  return true;
}

// Resolve alliance tags for a set of player names not already cached.
async function resolveAllianceTags(names) {
  const need = [...new Set(names)].filter(n => n && !(n in allianceTagCache));
  await Promise.all(need.map(async name => {
    const res = await browser.runtime.sendMessage({ type: 'GET_PLAYER_ALLIANCE_TAG', name });
    allianceTagCache[name] = (res && res.tag) || null;
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
  const lsSel = document.getElementById('ls-planet');
  pSel.textContent = ''; lsSel.textContent = '';
  for (const p of afPlanets) {
    const label = p.systemName ? `${p.name} (${p.systemName})` : p.name;
    const o = document.createElement('option');
    o.value = p.id; o.textContent = label;
    if (p.isHomeworld) o.selected = true;
    pSel.appendChild(o);
    const o2 = document.createElement('option');
    o2.value = p.id; o2.textContent = label;
    if (p.isHomeworld) o2.selected = true;
    lsSel.appendChild(o2);
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
  await loadLiveSearch();   // populate ls-* fields + button from saved config
  await initLsStatus();
  renderLsStatus();
  refreshSlots();

  await refreshTemplates();
  const restoredCachedResults = await restoreCachedAsteroidResults(Number(pSel.value));
  // Keep the selector in sync with edits made in the Fleets tab.
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.fleet_templates) refreshTemplates();
    // Live search can be stopped from the game-page results window — reflect it.
    if (changes.live_search) {
      const en = !!(changes.live_search.newValue && changes.live_search.newValue.enabled);
      if (en !== lsRunning) { lsRunning = en; setLsButton(); }
    }
  });

  pSel.addEventListener('change', () => { rememberSelection('af-planet', pSel.value); setRefFromMap(pSel.value); renderAsteroids(); updateAfAvail(); });
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
    });
  }

  // Live-search controls.
  document.getElementById('ls-search').addEventListener('click', toggleLiveSearch);
  document.getElementById('ls-planet').addEventListener('change', saveLiveSearchIfOn);
  for (const id of ['ls-mult-min', 'ls-qty-min', 'ls-left-min', 'ls-near']) {
    document.getElementById(id).addEventListener('input', e => {
      if (parseFloat(e.target.value) < 0) e.target.value = '';   // positive only
      saveLiveSearchIfOn();
    });
  }

  // Ship catalog (names + icons) for the availability strip, then start it.
  const defs = await browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' });
  afAllShips = (defs.ships || []).map(s => ({ shipDefId: s.shipDefId, name: s.name, imageUrl: s.imageUrl }));
  updateAfAvail();
  if (!afAvailTimer) {
    afAvailTimer = setInterval(() => {
      if (document.getElementById('asteroids-content').style.display !== 'none') { updateAfAvail(); refreshSlots(); }
    }, 10000);   // catch returning mining fleets without a reload
  }

  if (!restoredCachedResults) setStatusText(status, '');
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
  const res = await browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' });
  if (res.error) throw new Error(res.error);
  const systems = res.systems || [];
  const byId = {};
  for (const s of systems) byId[s.id] = s;
  afMap = { systems, byId };
  return afMap;
}

// Systems of a sector (with name/zone/planetCount/visibility), cached.
async function sectorSystemsFor(sectorId) {
  if (sectorSystems[sectorId]) return sectorSystems[sectorId];
  const res = await browser.runtime.sendMessage({ type: 'GET_SECTOR_SYSTEMS', sectorId });
  if (res.error) throw new Error(res.error);
  sectorSystems[sectorId] = res.systems || [];
  return sectorSystems[sectorId];
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
  });
}
function drawZoneToggles() {
  drawZoneInto('af-zone', afZoneFilter, drawZoneToggles, () => {
    afPage = 1;
    rememberSelection('af-zone-filter', [...afZoneFilter]);
    renderAsteroids();
  });
}
// Live-search filter: persist config on toggle (if currently running).
function drawLsTypeIcons() { drawTypeInto('ls-type', lsTypeFilter, drawLsTypeIcons, saveLiveSearchIfOn); }
function drawLsZoneToggles() { drawZoneInto('ls-zone', lsZoneFilter, drawLsZoneToggles, saveLiveSearchIfOn); }

// ── Live search (background, every 5 min) ──────────────────────────────────
let lsRunning = false;

function readLsConfig() {
  const num = id => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? null : v; };
  return {
    enabled: lsRunning,
    planetId: Number(document.getElementById('ls-planet').value) || null,
    multMin: num('ls-mult-min'),
    qtyMin: num('ls-qty-min'),
    leftMin: num('ls-left-min'),
    near: Math.max(1, Math.min(500, parseInt(document.getElementById('ls-near').value, 10) || 25)),
    types: [...lsTypeFilter],
    zones: [...lsZoneFilter],
  };
}
function saveLiveSearch() { return browser.runtime.sendMessage({ type: 'SET_LIVE_SEARCH', config: readLsConfig() }); }
function saveLiveSearchIfOn() { if (lsRunning) saveLiveSearch(); }

let lsStatusData = null;
let lsStatusTimer = null;

async function renderLsStatus() {
  const status = document.getElementById('ls-status');
  if (!status) return;
  if (!lsRunning) { setStatusText(status, ''); return; }
  const s = lsStatusData;
  const time = t => new Date(t).toLocaleTimeString();
  if (s && s.state === 'scanning' && Date.now() - s.at < 90000) {
    const prog = s.limit ? ` ${s.scanned}/${s.limit} systems` : '';
    setStatusText(status, `🔍 ${s.phase || 'Scanning…'}${prog}${s.matchingSystems ? `, ${s.matchingSystems} with matching types` : ''}, ${s.found || 0} matches so far`);
    return;
  }
  if (s && s.state === 'error') {
    setStatusText(status, `⚠ Last scan failed at ${time(s.at)}: ${s.error}`, 'warning');
    return;
  }
  let next = '';
  try {
    const alarm = await browser.alarms.get('nexus-livesearch');
    if (alarm) {
      const mins = Math.max(0, Math.ceil((alarm.scheduledTime - Date.now()) / 60000));
      next = ` Next scan in ~${mins} min.`;
    }
  } catch { /* alarms unavailable */ }
  const noType = lsTypeFilter.size ? '' : ' ⚠ No resource type selected — every field type will match.';
  if (s && s.state === 'idle') {
    setStatusText(status, `Last scan ${time(s.at)}: ${s.scanned} systems, ${s.found} matches${s.fresh ? ` (${s.fresh} new)` : ''}.${next}${noType}`);
  } else {
    setStatusText(status, `Waiting for first scan…${next}${noType}`);
  }
}

function setLsButton() {
  const btn = document.getElementById('ls-search');
  btn.textContent = lsRunning ? 'Stop Live Search' : 'Live Search';
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
  if (!lsRunning && !document.getElementById('ls-planet').value) return;   // need a planet
  lsRunning = !lsRunning;
  setLsButton();
  await saveLiveSearch();
}

// Restore the live-search controls from the persisted config.
async function loadLiveSearch() {
  const { live_search: cfg } = await browser.storage.local.get('live_search');
  if (cfg) {
    if (cfg.planetId != null) document.getElementById('ls-planet').value = cfg.planetId;
    document.getElementById('ls-mult-min').value = cfg.multMin ?? '';
    document.getElementById('ls-qty-min').value = cfg.qtyMin ?? '';
    document.getElementById('ls-left-min').value = cfg.leftMin ?? '';
    document.getElementById('ls-near').value = cfg.near ?? 25;
    lsTypeFilter.clear(); (cfg.types || []).forEach(t => lsTypeFilter.add(t));
    lsZoneFilter.clear(); (cfg.zones || []).forEach(z => lsZoneFilter.add(z));
    lsRunning = !!cfg.enabled;
  }
  drawLsTypeIcons();
  drawLsZoneToggles();
  setLsButton();
}

async function scan() {
  const btn = document.getElementById('af-scan');
  if (afRunning) { afRunning = false; return; }

  const status = document.getElementById('af-progress');
  const planetId = Number(document.getElementById('af-planet').value);
  const p = afPlanets.find(x => x.id === planetId);
  if (!p) return;
  const count = Math.max(1, Math.min(500, parseInt(document.getElementById('af-near').value, 10) || 25));

  setStatusText(status, 'Loading galaxy map…');
  let map;
  try { map = await loadMap(); } catch (e) { setStatusText(status, `Error: ${e.message}`); return; }
  const src = map.byId[p.systemId];
  if (!src) { setStatusText(status, 'Source system not on the map.'); return; }
  afRefMS = { x: src.x, y: src.y };

  // The N nearest explored systems (asteroid fields need at least partial vis).
  // A selected zone also narrows the scan targets, rather than merely hiding
  // fields from the nearest systems after the scan completes.
  const candidates = map.systems
    .filter(s => s.id !== p.systemId && (s.visibility === 'full' || s.visibility === 'partial'))
    .map(s => ({ s, d: Math.hypot(s.x - src.x, s.y - src.y) }))
    .sort((a, b) => a.d - b.d)
    .map(o => o.s);
  if (!candidates.length) { setStatusText(status, 'No explored systems nearby.'); return; }

  let cache;
  try { cache = await loadGalaxyScans(); }
  catch (error) { setStatusText(status, `Error: ${error.message}`); return; }

  afRunning = true;
  btn.textContent = 'Stop';
  const targetZones = new Set(afZoneFilter);
  const targetTypes = new Set(afTypeFilter);
  const systemLimit = targetTypes.size ? 500 : count;
  const targets = [];
  let errors = 0;
  const targetDescription = targetZones.size
    ? `${[...targetZones].join(', ')} zone`
    : 'all zones';
  setStatusText(status, targetTypes.size
    ? `Finding up to ${systemLimit} systems in ${targetDescription} for ${[...targetTypes].join(', ')} fields…`
    : `Finding ${count} nearest systems in ${targetDescription}…`);
  for (const sys of candidates) {
    if (!afRunning || (!targetTypes.size && targets.length >= count)) break;
    let meta;
    try {
      meta = (await sectorSystemsFor(sys.sectorId)).find(s => s.id === sys.id);
    } catch {
      errors++;
      continue;
    }
    if (!meta || (targetZones.size && !targetZones.has(meta.securityZone))) continue;
    targets.push({ sys, meta });
  }
  if (!afRunning) {
    btn.textContent = 'Scan';
    return;
  }
  if (!targets.length) {
    afRunning = false;
    btn.textContent = 'Scan';
    setStatusText(status, targetZones.size
      ? `No explored systems found in ${[...targetZones].join(', ')} zone.`
      : 'No explored systems nearby.');
    return;
  }

  afFields = [];
  afPage = 1;
  let scanned = 0, matchingSystems = 0;
  try {
    for (const { sys, meta } of targets) {
      if (!afRunning || (targetTypes.size && (matchingSystems >= count || scanned >= systemLimit))) break;
      if (!meta || !meta.planetCount) continue;   // no bodies → no fields
      let data;
      try {
        data = await getSystemPlanets(sys.id, cache, { purpose: 'dynamic', maxAge: ASTEROID_CACHE_TTL, source: 'asteroid-search' });
      } catch { errors++; scanned++; continue; }
      scanned++;
      const fields = data.asteroidFields || [];
      if (targetTypes.size && !fields.some(f => targetTypes.has(f.fieldType))) {
        if (scanned % 10 === 0) {
          setStatusText(status, `Scanning… ${scanned}/${systemLimit} systems checked, ${matchingSystems}/${count} contain requested fields.`);
          renderAsteroids();
        }
        if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
        continue;
      }
      matchingSystems++;
      for (const f of fields) {
        afFields.push({
          fieldId: f.id,
          name: f.name || `#${f.id}`,
          system: meta.name || `#${sys.id}`,
          systemId: sys.id,
          type: f.fieldType || '—',
          mult: f.richness ?? null,
          remaining: f.remainingResources ?? null,
          total: f.totalResources ?? null,
          zone: meta.securityZone || '—',
          sx: sys.x, sy: sys.y,
          minerPresent: f.controllerName || null,
          ownerName: (f.outpostShieldMaxHp ?? 0) > 0 ? (f.controllerName || null) : null,
        });
      }
      if (scanned % 10 === 0) {
        setStatusText(status, targetTypes.size
          ? `Scanning… ${scanned}/${systemLimit} systems checked, ${matchingSystems}/${count} contain requested fields.`
          : `Scanning… ${scanned}/${count} systems, ${afFields.length} fields.`);
        renderAsteroids();
      }
      if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    afRunning = false;
    btn.textContent = 'Scan';
  }

  await browser.storage.local.set({
    [ASTEROID_RESULTS_CACHE_KEY]: {
      at: Date.now(),
      planetId,
      referenceSystem: { x: src.x, y: src.y },
      fields: afFields,
      near: count,
      zones: [...targetZones].sort(),
      types: [...targetTypes].sort(),
    },
  });

  await resolveAllianceTags(afFields.filter(f => f.ownerName).map(f => f.ownerName));

  const matchingFields = renderAsteroids();
  const scanSummary = targetTypes.size
    ? `${matchingSystems} systems with requested fields after checking ${scanned}/${systemLimit} systems`
    : `${scanned} systems`;
  setStatusText(status, `Done: ${afFields.length} fields discovered in ${scanSummary}; ` +
    `${matchingFields} match filters` + (errors ? ` · ${errors} skipped (errors)` : '') + '.');
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
  const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
  if (mi.maxFleetSlots != null) {
    document.getElementById('af-slots').textContent = `${usedFleetSlots(mi.missions)}/${mi.maxFleetSlots} fleet slots`;
  }
  afMiningFieldIds = new Set(
    (mi.missions || []).filter(m => m.missionType === 'mine' && m.targetFieldId != null).map(m => m.targetFieldId));
  afMissions = mi.missions || [];
  renderAsteroids();
}

function applyMissionMarkers() {
  const missionsByField = new Map();
  for (const mission of afMissions) {
    if (mission.missionType !== 'mine' || mission.targetFieldId == null) continue;
    const missions = missionsByField.get(mission.targetFieldId) || [];
    missions.push(mission);
    missionsByField.set(mission.targetFieldId, missions);
  }

  for (const row of document.querySelectorAll('#af-results-tbody tr')) {
    const missions = missionsByField.get(Number(row.dataset.field)) || [];
    if (!missions.length) continue;
    row.style.borderLeft = '3px solid #f0883e';
    const systemCell = row.children[1];
    if (!systemCell) continue;
    const badge = document.createElement('span');
    badge.className = 'af-mission-badge';
    badge.style.cssText = 'display:inline-block;margin-left:5px;font-size:0.7rem;padding:1px 5px;border-radius:4px;background:#f0883e22;border:1px solid var(--orange);color:var(--orange);vertical-align:middle;';
    badge.textContent = missions.length > 1 ? `⛏ ×${missions.length}` : '⛏';
    badge.title = missions.map(mission => `Fleet: ${missionProgress(mission).label}`).join('\n');
    systemCell.append(badge);
  }
}

export function renderAsteroids() {
  const tbody = document.getElementById('af-results-tbody');
  tbody.textContent = '';

  document.querySelectorAll('#af-results-head th.sortable').forEach(th => {
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (th.dataset.key === afSort.key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = afSort.dir === -1 ? '▼' : '▲';
      th.appendChild(arrow);
    }
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
  if (afTypeFilter.size) rows = rows.filter(f => afTypeFilter.has(f.type));
  if (afZoneFilter.size) rows = rows.filter(f => afZoneFilter.has(f.zone));

  const num = (id, dflt) => {
    const v = parseFloat(document.getElementById(id).value);
    return isNaN(v) ? dflt : v;
  };
  const multMin = num('af-mult-min', -Infinity), qtyMin = num('af-qty-min', -Infinity);
  const leftMin = num('af-left-min', -Infinity);
  rows = rows.filter(f =>
    (f.mult ?? -Infinity) >= multMin && (f.remaining ?? -Infinity) >= qtyMin
    && (f.leftPct ?? -Infinity) >= leftMin);
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
    const tr = document.createElement('tr');
    tr.dataset.system = f.systemId;
    tr.dataset.field = f.fieldId;
    if ((afMyUsername && f.minerPresent === afMyUsername) || afMiningFieldIds.has(f.fieldId)) {
      tr.style.background = 'rgba(63,185,80,0.15)';   // already mining / claimed by us
    }

    const sendTd = document.createElement('td');
    const ship = document.createElement('span');
    ship.textContent = '🚀';
    ship.title = 'Send mining fleet here';
    ship.className = 'asteroids-fleet-ship';
    ship.addEventListener('click', () => sendMineMission(f));
    sendTd.appendChild(ship);
    tr.appendChild(sendTd);

    const content = f.remaining == null ? '—'
      : `${fmt(f.remaining)} / ${fmt(f.total ?? 0)}`;
    const tag = f.ownerName ? allianceTagCache[f.ownerName] : null;
    const owner = f.ownerName ? (tag ? `${f.ownerName} [${tag}]` : f.ownerName) : '—';
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
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 1) td.style.color = TYPE_COLOR[f.type] || '#f1f6ff';
      else if (i === 2 && f.mult != null) td.style.color = '#ffc070';
      else if (i === 5) td.style.color = ZONE_COLORS[f.zone] || ZONE_COLORS.unknown;
      else if (i === 9) td.className = 'af-fuel';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  document.getElementById('af-count').textContent = `${rows.length} fields`;
  computeFuel();
  applyMissionMarkers();
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
    cells().forEach(c => { c.textContent = '—'; c.title = tpl ? 'Template has no ships' : 'No template selected'; });
    return;
  }
  for (const tr of document.querySelectorAll('#af-results-tbody tr')) {
    if (gen !== afFuelGen) return;
    const cell = tr.querySelector('.af-fuel');
    const sysId = Number(tr.dataset.system);
    if (!cell || !sysId) continue;
    const est = await fuelEstimate(planetId, sysId, ships, 'mine');
    if (gen !== afFuelGen) return;
    if (est.error) { cell.textContent = '—'; cell.title = est.error; continue; }
    cell.textContent = `${est.fuelCost}`;
    cell.style.color = est.inRange === false ? '#ff6b7a' : '';
    cell.title = est.inRange === false ? 'Out of range' : `distance ${est.distance.toFixed(1)} ly`;
  }
}
