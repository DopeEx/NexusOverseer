// Expeditions tab. Wormhole runs have their own tab (tabs/wormholes.js) —
// both kinds share one background store (exp_*), tagged per-record by `kind`.

import { loadFleetTemplates } from './fleets.js';
import { usedFleetSlots } from '../mission-state.js';
import { pauseAutomationsForHumanVerification } from '../human-verification.js';
import { RESOURCE_SERIES, appendExtraResourceCards, applySort, attachSortable, clearAvailStrip, computeRawLossCost, computeSeries, createMissionRefresh, editFleetDialog, fillResourceCards, filterZone, fmt, missionCountdown, fuelForMode, getLabelKey, getMode, inWindowRange, missionProgress, makeResourceDoughnut, makeResourceLineChart, makeStatCard, periodLabelFor, renderAvailStrip, renderPagedTable, rememberSelection, rememberedSelections, store, windowActive, zeroCell, zoneCell, setStatusText } from '../common.js';

export let chartExpeditions, chartExpComp;

export let expPage = 1;

// ── Launch expedition ───────────────────────────────────────────────────────
// POST /api/fleet/expedition { sourcePlanetId, ships, zone, depth }, routed
// through the game tab like every other mission dispatch (background.js's
// gamePost). "Scout Rift" is a known-broken combo per the player, left out.
const EXPEDITION_PRESETS = {
  balanced:       { label: 'Balanced (Rift)',      zone: 'rift', depth: 2, ships: [['stealth_ship', 1], ['scout', 10], ['freighter', 5]] },
  loot_run:       { label: 'Loot Run (Dead)',       zone: 'dead', depth: 2, ships: [['stealth_ship', 2], ['scout', 10], ['hacker_ship', 1], ['freighter', 4]] },
  combat_rift:    { label: 'Combat Rift (Rift)',    zone: 'rift', depth: 3, ships: [['scout', 5]] },
  deep_dead_dive: { label: 'Deep Dead Dive (Dead)', zone: 'dead', depth: 3, ships: [['stealth_ship', 5], ['scout', 2], ['hacker_ship', 3]] },
  lean_dead_run:  { label: 'Lean Dead Run (Dead)',  zone: 'dead', depth: 1, ships: [['stealth_ship', 2], ['scout', 2], ['hacker_ship', 1]] },
};
// Valid depth range per zone — Rift starts at 2, both cap at 4.
const DEPTH_RANGE = {
  dead: [1, 4],
  rift: [2, 4],
};

let eLaunchInited = false;
let eInitPromise = null;
let ePlanets = [];    // [{ id, name, isHomeworld }]
let eTemplates = [];
let eAllShips = [];   // every ship def: [{ shipDefId, key, name, imageUrl }]

export function initExpeditionsTab() {
  if (!eInitPromise) {
    eInitPromise = initExpeditionLaunch().catch(error => {
      eInitPromise = null;
      eLaunchInited = false;
      throw error;
    });
  }
  return eInitPromise;
}

async function initExpeditionLaunch() {
  if (eLaunchInited) return;
  eLaunchInited = true;

  const [planets, ships] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_PLANETS' }),
    browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' }),
  ]);
  ePlanets = planets.planets || [];
  eAllShips = ships.ships || [];

  const pSel = document.getElementById('e-launch-planet');
  pSel.textContent = '';
  for (const p of ePlanets) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    if (p.isHomeworld) o.selected = true;
    pSel.appendChild(o);
  }
  const saved = await rememberedSelections();
  if (saved['e-launch-planet'] && ePlanets.some(p => String(p.id) === saved['e-launch-planet'])) {
    pSel.value = saved['e-launch-planet'];
  }
  if (saved['e-launch-preset']) document.getElementById('e-launch-preset').value = saved['e-launch-preset'];
  if (saved['e-launch-zone']) document.getElementById('e-launch-zone').value = saved['e-launch-zone'];

  const autoBox = document.getElementById('e-auto');
  autoBox.checked = saved['e-auto'] === true;
  autoBox.addEventListener('change', e => rememberSelection('e-auto', e.target.checked));

  await refreshExpeditionTemplates();
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fleet_templates) refreshExpeditionTemplates();
  });

  applyPresetToControls();
  if (saved['e-launch-depth']) {
    document.getElementById('e-launch-depth').value = saved['e-launch-depth'];
    applyDepthRange();
  }
  updateExpeditionAvail();
  refreshExpeditionMissions();

  const refreshMissionsIfDue = createMissionRefresh(refreshExpeditionMissions);
  setInterval(() => {
    if (document.getElementById('expeditions-content').style.display === 'none') return;
    for (const upd of eTicks) upd();
    refreshMissionsIfDue(eMissions);
  }, 1000);

  document.getElementById('e-launch-planet').addEventListener('change', e => {
    rememberSelection('e-launch-planet', e.target.value);
    updateExpeditionAvail();
  });
  document.getElementById('e-launch-preset').addEventListener('change', e => {
    rememberSelection('e-launch-preset', e.target.value);
    applyPresetToControls();
    updateExpeditionAvail();
  });
  document.getElementById('e-launch-template').addEventListener('change', e => {
    rememberSelection('e-launch-template', e.target.value);
    updateExpeditionAvail();
  });
  document.getElementById('e-launch-zone').addEventListener('change', e => {
    rememberSelection('e-launch-zone', e.target.value);
    applyDepthRange();
  });
  document.getElementById('e-launch-depth').addEventListener('change', e => {
    applyDepthRange();
    rememberSelection('e-launch-depth', e.target.value);
  });
  document.getElementById('e-launch-btn').addEventListener('click', launchExpedition);
}

async function refreshExpeditionTemplates() {
  eTemplates = await loadFleetTemplates();
  eTemplates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sel = document.getElementById('e-launch-template');
  const saved = await rememberedSelections();
  const want = saved['e-launch-template'] || sel.value;
  sel.textContent = '';
  if (!eTemplates.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— none (create in Fleet Templates) —';
    sel.appendChild(o);
  } else {
    for (const t of eTemplates) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      sel.appendChild(o);
    }
    if (want && eTemplates.some(t => String(t.id) === want)) sel.value = want;
  }
  updateExpeditionAvail();
}

// A preset fills zone/depth (still editable) and hides the template picker,
// which only applies to "Custom".
function applyPresetToControls() {
  const presetKey = document.getElementById('e-launch-preset').value;
  const preset = EXPEDITION_PRESETS[presetKey];
  document.getElementById('e-launch-template-row').style.display = preset ? 'none' : '';
  if (preset) {
    document.getElementById('e-launch-zone').value = preset.zone;
    document.getElementById('e-launch-depth').value = preset.depth;
  }
  applyDepthRange();
}

// Clamp the depth input to the selected zone's valid range (Rift: 2-4, Dead: 1-4).
function applyDepthRange() {
  const zone = document.getElementById('e-launch-zone').value;
  const depthInp = document.getElementById('e-launch-depth');
  const [min, max] = DEPTH_RANGE[zone] || [1, 4];
  depthInp.min = String(min); depthInp.max = String(max);
  const v = parseInt(depthInp.value, 10) || min;
  depthInp.value = String(Math.min(max, Math.max(min, v)));
}

// Resolve the currently selected preset/template to ships, capped to what the
// planet actually has. Returns { ships, short, name } or { error }.
async function resolveExpeditionShips(planetId) {
  const presetKey = document.getElementById('e-launch-preset').value;
  const preset = EXPEDITION_PRESETS[presetKey];
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) return { error: av.error };

  let wanted, name;
  if (preset) {
    wanted = preset.ships
      .map(([key, quantity]) => ({ shipDefId: (eAllShips.find(s => s.key === key) || {}).shipDefId, quantity }))
      .filter(s => s.shipDefId != null);
    name = preset.label;
  } else {
    const tpl = eTemplates.find(t => String(t.id) === document.getElementById('e-launch-template').value);
    if (!tpl) return { error: 'No fleet template selected — create one in Fleet Templates.' };
    wanted = Object.entries(tpl.ships || {}).map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }));
    name = tpl.name;
  }
  wanted = wanted.filter(s => s.quantity > 0);
  if (!wanted.length) return { error: `"${name}" has no ships.` };

  const seed = Object.fromEntries(wanted.map(s => [s.shipDefId, s.quantity]));
  const ships = wanted
    .map(s => ({ shipDefId: s.shipDefId, quantity: Math.min(s.quantity, av.available[s.shipDefId] || 0) }))
    .filter(s => s.quantity > 0);
  if (!ships.length) return { error: `None of "${name}"'s ships are on this planet.` };
  return { ships, seed, avail: av.available, name };
}

async function updateExpeditionAvail() {
  const box = document.getElementById('e-launch-avail');
  const planetId = Number(document.getElementById('e-launch-planet').value);
  if (!planetId || !eAllShips.length) { clearAvailStrip(box); return; }
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) { clearAvailStrip(box, av.error); return; }
  renderAvailStrip(box, eAllShips, av.available, 'No ships on this planet.');
}

// In-flight expedition fleets, refreshed alongside the "X/2 active" count —
// the send itself is what the game actually enforces the cap on, this just
// saves a guaranteed-to-fail attempt.
let eMissions = [];
let eFleetSlots = { used: 0, max: null };
let eTicks = [];   // progress-bar updaters for the current renderExpeditionTransit()

async function refreshExpeditionMissions() {
  const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
  if (mi.error) {
    console.error('[NexusOverseer] Expedition mission refresh failed:', mi.error);
    setStatusText(document.getElementById('e-launch-status'), `Mission refresh failed: ${mi.error}`, 'error');
    return false;
  }
  eFleetSlots = { used: usedFleetSlots(mi.missions), max: mi.maxFleetSlots ?? null };
  eMissions = (mi.missions || []).filter(m => m.missionType === 'expedition');
  const activeEl = document.getElementById('e-launch-active');
  if (activeEl) activeEl.textContent = `${eMissions.length}/${MAX_EXPEDITION_SLOTS} expeditions active · ${eFleetSlots.used}/${eFleetSlots.max ?? '?'} fleet slots`;
  renderExpeditionTransit();
  return true;
}

// Keep the existing expedition concurrency cap in addition to normal fleet slots.
const MAX_EXPEDITION_SLOTS = 2;
let eAutoRunning = false;
let eLastLaunch = { at: 0, count: 0 };

export async function runExpeditionAutomations() {
  if (!eInitPromise) return;
  await eInitPromise.catch(() => {});
  const box = document.getElementById('e-auto');
  if (!box?.checked || eAutoRunning) return;
  eAutoRunning = true;
  const status = document.getElementById('e-auto-status');
  try {
    if (!await refreshExpeditionMissions()) {
      setStatusText(status, 'Cannot launch: mission refresh failed.', 'error');
      return;
    }
    let active = eMissions.length;
    // The missions list can lag behind a fresh launch; count it until it shows up.
    if (Date.now() - eLastLaunch.at < 20_000 && active <= eLastLaunch.count) active = eLastLaunch.count + 1;
    if (active >= MAX_EXPEDITION_SLOTS) {
      setStatusText(status, `Waiting… ${active}/${MAX_EXPEDITION_SLOTS} expeditions active.`);
      return;
    }
    const used = eFleetSlots.used + Math.max(0, active - eMissions.length);
    if (eFleetSlots.max != null && used >= eFleetSlots.max) {
      setStatusText(status, `Waiting… ${used}/${eFleetSlots.max} fleet slots in use.`);
      return;
    }
    const planetId = Number(document.getElementById('e-launch-planet').value);
    if (!planetId) { setStatusText(status, 'Select a planet first.'); return; }
    const zone = document.getElementById('e-launch-zone').value;
    const [depthMin, depthMax] = DEPTH_RANGE[zone] || [1, 4];
    const depth = Math.min(depthMax, Math.max(depthMin, parseInt(document.getElementById('e-launch-depth').value, 10) || depthMin));

    const r = await resolveExpeditionShips(planetId);
    if (r.error) { setStatusText(status, r.error, 'warning'); return; }
    const missing = r.ships.some(s => s.quantity < (r.seed[s.shipDefId] || 0))
      || Object.keys(r.seed).some(id => !r.ships.some(s => String(s.shipDefId) === id));
    if (missing) { setStatusText(status, `Waiting for ships: "${r.name}" is not complete on this planet.`, 'warning'); return; }

    const res = await browser.runtime.sendMessage({
      type: 'SEND_EXPEDITION', sourcePlanetId: planetId, ships: r.ships, zone, depth,
    });
    if (res.error) {
      if (String(res.error).includes('Human verification')) {
        setStatusText(status, `Launch failed: ${res.error}`, 'error');
        pauseAutomationsForHumanVerification(res.error);
      } else {
        setStatusText(status, `Launch failed: ${res.error}`, 'warning');
      }
      return;
    }
    eLastLaunch = { at: Date.now(), count: eMissions.length };
    setStatusText(status, `Expedition launched (${zone}, depth ${depth}) ✓`);
    updateExpeditionAvail();
    if (!await refreshExpeditionMissions()) return;
  } catch (error) {
    console.error('[NexusOverseer] Expedition automation failed:', error);
    setStatusText(status, error.message, 'error');
  } finally {
    eAutoRunning = false;
  }
}

function renderExpeditionTransit() {
  const box = document.getElementById('e-transit-list');
  if (!box) return;
  box.textContent = '';
  eTicks = [];
  document.getElementById('e-transit-count').textContent = `${eMissions.length} in flight`;
  if (!eMissions.length) {
    const d = document.createElement('div');
    d.className = 'sc-transit-empty';
    d.textContent = 'No expeditions in transit.';
    box.appendChild(d);
    return;
  }
  for (const m of eMissions) {
    const exp = m.raidParams?.expedition || {};
    const zone = exp.zone || m.zone;
    const depth = exp.depth ?? m.depth;
    const source = m.sourcePlanetName || m.sourceSystemName;
    const zoneText = zone ? `${zone[0].toUpperCase()}${zone.slice(1)} zone` : `Expedition #${m.id}`;
    const target = source ? `${source} → ${zoneText}` : zoneText;
    const ships = (m.fleetComposition || []).reduce((n, s) => n + (s.quantity || 0), 0);
    const details = [
      depth != null ? `Depth ${depth}` : null,
      ships ? `${ships} ships` : null,
      m.cargo?._cargoCapacity ? `Cargo ${fmt(m.cargo._cargoCapacity)}` : null,
    ].filter(Boolean).join(' · ');
    const shipList = (m.fleetComposition || [])
      .map(s => `${s.quantity}× ${s.shipName || s.shipKey || s.shipDefId}`).join('\n');
    const row = document.createElement('div');
    row.className = 'sc-transit-card';

    const main = document.createElement('div');
    main.className = 'sc-mission-main sc-transit-main';
    const left = document.createElement('div');
    left.className = 'sc-transit-left';
    const icon = document.createElement('span');
    icon.className = 'sc-transit-icon';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'sc-transit-text';
    const title = document.createElement('div');
    title.className = 'sc-transit-title';
    title.textContent = target;
    const meta = document.createElement('div');
    meta.className = 'sc-transit-meta';
    const status = document.createElement('span');
    status.className = 'sc-transit-status';
    meta.append(status);
    if (details) {
      const info = document.createElement('span');
      info.className = 'sc-transit-status';
      info.style.marginLeft = '10px';
      info.style.color = '#8b93c9';
      info.textContent = details;
      info.title = shipList;
      meta.append(info);
    }
    text.append(title, meta);
    left.append(icon, text);
    const eta = document.createElement('div');
    eta.className = 'sc-transit-eta';
    main.append(left, eta);

    const track = document.createElement('div');
    track.className = 'mission-progress-track sc-transit-track';
    const fill = document.createElement('div');
    fill.className = 'mission-progress-fill sc-transit-fill';
    track.appendChild(fill);
    row.append(main, track);
    box.appendChild(row);

    const upd = () => {
      const p = missionProgress(m);
      fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
      fill.style.background = p.gradient || p.color;
      status.textContent = p.label;
      status.style.color = p.color;
      eta.textContent = missionCountdown(p);
    };
    upd();
    eTicks.push(upd);
  }
}

async function launchExpedition() {
  const status = document.getElementById('e-launch-status');
  try {
    if (!await refreshExpeditionMissions()) return;
  } catch (error) {
    console.error('[NexusOverseer] Expedition mission refresh failed:', error);
    setStatusText(status, error.message, 'error');
    return;
  }
  if (eFleetSlots.max != null && eFleetSlots.used >= eFleetSlots.max) {
    setStatusText(status, `Cannot launch expedition: ${eFleetSlots.used}/${eFleetSlots.max} fleet slots in use.`, 'warning');
    return;
  }
  const planetId = Number(document.getElementById('e-launch-planet').value);
  const planet = ePlanets.find(p => p.id === planetId);
  const zone = document.getElementById('e-launch-zone').value;
  const [depthMin, depthMax] = DEPTH_RANGE[zone] || [1, 4];
  const depth = Math.min(depthMax, Math.max(depthMin, parseInt(document.getElementById('e-launch-depth').value, 10) || depthMin));

  const r = await resolveExpeditionShips(planetId);
  if (r.error) { setStatusText(status, r.error, 'warning'); return; }

  const ships = await editFleetDialog({
    title: 'Launch expedition',
    subtitle: `From: ${planet ? planet.name : planetId}\nZone: ${zone} · Depth: ${depth}\nFleet: ${r.name}`,
    avail: r.avail, seed: r.seed,
  });
  if (!ships || !ships.length) return;   // cancelled or emptied

  setStatusText(status, 'Launching…');
  const res = await browser.runtime.sendMessage({
    type: 'SEND_EXPEDITION', sourcePlanetId: planetId, ships, zone, depth,
  });
  if (res.error) { setStatusText(status, `Launch failed: ${res.error}`); return; }
  setStatusText(status, 'Expedition launched ✓');
  updateExpeditionAvail();
  refreshExpeditionMissions();
  setTimeout(refreshExpeditionMissions, 2000);   // retry for post-POST API lag
}

// Expedition-kind records for the current view + zone filter.
export function expRecordsForMode(mode) {
  const filtered = filterZone((store.exp_recent_reports || []).filter(r => r.kind === 'expedition'));
  if (mode === 'all' && !windowActive()) return filtered;
  return inWindowRange(filtered);
}

// Per-report records carry the full loot map, so all resources (rares included)
// work in every view mode + zone. No combined-totals fast path here (unlike
// the pre-split tab) since store.exp_totals mixes in wormhole runs too.
export function getExpTotalsForMode(mode) {
  const t = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0 };
  for (const r of expRecordsForMode(mode)) {
    for (const [k, v] of Object.entries(r.loot || {})) {
      if (k in t && k !== 'rare' && k !== 'missions' && k !== 'ships_lost') t[k] += v;
      else if (!['ore', 'silicates', 'hydrogen', 'alloys'].includes(k)) t.rare[k] = (t.rare[k] || 0) + v;
    }
    t.missions += 1;
    t.ships_lost += r.ships_lost || 0;
  }
  return t;
}

// Loot-over-time series; loot lives in r.loot (full map per record).
export function getExpSeriesForMode(mode) {
  const getters = { missions: () => 1 };
  for (const d of RESOURCE_SERIES) getters[d.field] = r => (r.loot && r.loot[d.field]) || 0;
  return computeSeries(filterZone((store.exp_recent_reports || []).filter(r => r.kind === 'expedition')), mode, getters);
}

export function renderExpeditionsTab() {
  initExpeditionsTab();
}

export function renderExpeditionStatsTab() {
  const mode = getMode();
  const periodLabel = periodLabelFor(mode);
  const t = getExpTotalsForMode(mode);
  const el = document.getElementById('e-stats-collected');
  el.textContent = '';
  if (!t.missions) {
    const p = document.createElement('p');
    p.className = 'mission-empty-state';
    p.textContent = 'No expedition reports recorded yet.';
    el.appendChild(p);
  } else {
    el.append(
      makeStatCard(`Ore${periodLabel}`, fmt(t.ore), 'ore'),
      makeStatCard(`Silicates${periodLabel}`, fmt(t.silicates), 'silicates'),
      makeStatCard(`Hydrogen${periodLabel}`, fmt(t.hydrogen), 'hydrogen'),
    );
    appendExtraResourceCards(el, t, periodLabel);
    el.append(
      makeStatCard(`Missions${periodLabel}`, fmt(t.missions), 'missions'),
      makeStatCard(`Ships lost${periodLabel}`, fmt(t.ships_lost), '', 'color:var(--error)'),
      makeStatCard(`Fuel spent${periodLabel}`, fmt(fuelForMode('expedition', mode)), 'hydrogen'),
    );
  }

  const lost = computeRawLossCost(expRecordsForMode(mode), store.ships || {});
  fillResourceCards('e-stats-lost', lost, '');

  if (chartExpeditions) chartExpeditions.destroy();
  chartExpeditions = makeResourceLineChart('chart-expeditions', getExpSeriesForMode(mode),
    getLabelKey(mode), { field: 'missions', label: 'Missions' });

  if (chartExpComp) chartExpComp.destroy();
  chartExpComp = makeResourceDoughnut('chart-expeditions-comp', t);

  renderExpTable();
}

export const expSort = { key: 'created_at', dir: -1 };
attachSortable('e-reports-head', expSort, () => { expPage = 1; renderExpTable(); });

export function renderExpTable() {
  const reports = applySort('e-reports-head', filterZone((store.exp_recent_reports || []).filter(r => r.kind === 'expedition')), expSort);
  renderPagedTable(reports, expPage, 'e-page-info', 'e-btn-prev', 'e-btn-next', 'e-reports-tbody', r => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(r.created_at).toLocaleString();
    const tdLoc = document.createElement('td');
    tdLoc.textContent = r.location || '—';
    const tdEvent = document.createElement('td');
    tdEvent.textContent = r.event ? String(r.event).replace(/_/g, ' ') : '—';
    const loot = r.loot || {};
    const tdOre = zeroCell(loot.ore); tdOre.className = 'ore';
    const tdSil = zeroCell(loot.silicates); tdSil.className = 'silicates';
    const tdHyd = zeroCell(loot.hydrogen); tdHyd.className = 'hydrogen';
    const tdAll = zeroCell(loot.alloys); tdAll.className = 'alloys';
    tr.append(tdDate, tdLoc, zoneCell(r.zone), tdEvent,
              tdOre, tdSil, tdHyd, tdAll,
              zeroCell(loot.cryo_ice), zeroCell(loot.quantum_dust), zeroCell(loot.plasma_core),
              zeroCell(loot.dark_matter), zeroCell(loot.antimatter),
              zeroCell(r.ships_lost));
    return tr;
  });
}

document.getElementById('e-btn-prev').addEventListener('click', () => { expPage--; renderExpTable(); });
document.getElementById('e-btn-next').addEventListener('click', () => { expPage++; renderExpTable(); });

export function setExpPage(n) { expPage = n; }
