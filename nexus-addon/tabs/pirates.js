// Pirates tab.

import { loadFleetTemplates } from './fleets.js';
import { usedFleetSlots } from '../mission-state.js';
import { suggestAttackFleet } from '../pirate-planner.js';
import { pauseAutomationsForHumanVerification } from '../human-verification.js';
import { appendExtraResourceCards, applySort, attachSortable, computeResourcesLost, computeSeries, createMissionRefresh, cssVar, editFleetDialog, emptyResources, EXTRA_RES_KEYS_UI, filterZone, fmt, missionCountdown, fuelForMode, getLabelKey, getMode, isUnfiltered, makeResourceLineChart, makeStatCard, missionProgress, PER_PAGE, periodLabelFor, recordsForMode, rememberedSelections, rememberSelection, renderLostCards, renderNetCards, SERIES_GETTERS, setStatusText, store, windowActive, ZONE_COLORS, zoneCell } from '../common.js';

export let chartPirateLoot, chartPirateOutcomes;

export let pirateCurrentPage = 1;

// ── Pirates tab ────────────────────────────────────────────────────────────

export function getPirateTotalsForMode() {
  const mode = getMode();
  if (mode === 'all' && isUnfiltered() && !windowActive()) return store.pirate_totals || {};
  return recordsForMode(store.pirate_recent_reports, mode).reduce((t, r) => ({
    ore: t.ore + (r.ore || 0),
    hydrogen: t.hydrogen + (r.hydrogen || 0),
    silicates: t.silicates + (r.silicates || 0),
    raids: t.raids + 1,
    ships_destroyed: t.ships_destroyed + (r.ships_lost || 0),
    ships_damaged: t.ships_damaged + (r.ships_damaged || 0),
    pirates_destroyed: t.pirates_destroyed + (r.pirates_destroyed || 0),
    ...Object.fromEntries(EXTRA_RES_KEYS_UI.map(k => [k, (t[k] || 0) + (r[k] || 0)])),
  }), { ore: 0, hydrogen: 0, silicates: 0, raids: 0, ships_destroyed: 0, ships_damaged: 0, pirates_destroyed: 0 });
}

export function getPirateLostForMode() {
  const mode = getMode();
  if (mode === 'all' && isUnfiltered() && !windowActive()) return store.pirate_resources_lost || emptyResources();
  return computeResourcesLost(recordsForMode(store.pirate_recent_reports, mode), store.ships || {});
}

export function getPirateDebrisForMode() {
  const mode = getMode();
  if (mode === 'all' && isUnfiltered() && !windowActive()) return store.pirate_debris_total || { ore: 0, alloys: 0, silicates: 0 };
  return recordsForMode(store.pirate_recent_reports, mode).reduce((t, r) => ({
    ore: t.ore + (r.debris_ore || 0),
    alloys: t.alloys + (r.debris_alloys || 0),
    silicates: t.silicates + (r.debris_silicates || 0),
  }), { ore: 0, alloys: 0, silicates: 0 });
}

export function getPirateOutcomesForMode() {
  const mode = getMode();
  if (mode === 'all' && isUnfiltered() && !windowActive()) return store.pirate_outcomes || [];
  const map = {};
  for (const r of recordsForMode(store.pirate_recent_reports, mode)) {
    const o = r.outcome || 'unknown';
    if (!map[o]) map[o] = { outcome: o, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    map[o].count += 1;
    map[o].ore += r.ore || 0;
    map[o].hydrogen += r.hydrogen || 0;
    map[o].silicates += r.silicates || 0;
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

export function getPirateSeriesForMode() {
  const mode = getMode();
  if (mode !== 'hourly' && isUnfiltered() && !windowActive()) return store.pirate_daily || [];
  return computeSeries(filterZone(store.pirate_recent_reports || []), mode,
    { ...SERIES_GETTERS, raids: () => 1 });
}

export function renderPiratesTab() {
  initPiratesTab().then(() => refreshPirateData());
}

let pcReports = [];

async function refreshPirateReports(priority = 'interactive') {
  const res = await browser.runtime.sendMessage({ type: 'GET_PIRATE_REPORTS', priority });
  pcReports = res.error ? [] : (res.reports || []);
  renderPirateReports(res.error);
}

const fleetText = list => (list || []).filter(s => s.quantity ?? s.lost)
  .map(s => `${s.quantity ?? s.lost}× ${s.name}`).join(', ') || '—';
const lossText = list => (list || []).filter(s => s.lost)
  .map(s => `${s.lost}× ${s.name}`).join(', ') || '—';
const resText = o => Object.entries(o || {}).filter(([, v]) => v)
  .map(([k, v]) => `${fmt(v)} ${k}`).join(', ') || '—';

function renderPirateReports(error) {
  const tbody = document.getElementById('pr-tbody');
  tbody.textContent = '';
  document.getElementById('pr-count').textContent = error ? '' : `${pcReports.length} reports`;
  if (error || !pcReports.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'mission-empty-state';
    td.textContent = error ? `Could not load reports: ${error}` : 'No pirate reports yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  const campName = id => (pcCamps.find(c => c.id === id) || {}).name || `#${id}`;
  for (const r of pcReports) {
    const won = r.outcome === 'attacker_won';
    const cells = [
      r.createdAt ? new Date(r.createdAt).toLocaleString() : '—',
      campName(r.campId),
      won ? 'Victory' : 'Defeat',
      (r.rounds || []).length,
      fleetText(r.attackerFleet),
      fleetText(r.pirateFleet),
      lossText(r.attackerLosses),
      lossText(r.pirateLosses),
      resText(r.loot),
      resText(r.debris),
    ];
    const tr = document.createElement('tr');
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 2) td.style.color = won ? '#7ed957' : '#ff6b7a';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

let pcInited = false;
let pcCamps = [];
let pcPlanets = [];

let pcInitPromise = null;
let pcAutoRunning = false;
let pcLastRefreshAt = 0;
let pcSlots = { max: null, used: 0 };
const pcJustScouted = new Map();

export function initPiratesTab() {
  if (!pcInitPromise) {
    pcInitPromise = initPirateCamps().then(() => refreshPirateData()).catch(error => {
      pcInitPromise = null;
      throw error;
    });
  }
  return pcInitPromise;
}

async function refreshPirateData(priority = 'interactive') {
  await Promise.allSettled([refreshPirateCamps(true), refreshPirateMissions(), refreshPirateReports(priority)]);
  pcLastRefreshAt = Date.now();
}

export async function runPirateAutomations() {
  if (!pcInitPromise) return;
  await pcInitPromise.catch(() => {});
  if (!pcInited) return;
  if (Date.now() - pcLastRefreshAt >= 30_000) await refreshPirateData('check');
  if (document.getElementById('pc-auto')?.checked) await automatePirateScouting();
  if (document.getElementById('pc-auto-attack')?.checked) await automatePirateAttacks();
}

const campReportsSince = c => pcReports.filter(r => r.campId === c.id
  && new Date(r.createdAt) > new Date(c.lastScoutedAt || 0));

// Intel is stale after a respawn or after a fight that did not destroy the camp.
const campNeedsScout = c => !c.destroyedAt && (!c.hasFleetIntel || !c.lastScoutedAt
  || (c.lastSpawnedAt && new Date(c.lastSpawnedAt) > new Date(c.lastScoutedAt))
  || campReportsSince(c).some(r => r.outcome !== 'attacker_won'));

const campReadyToAttack = c => !c.destroyedAt && c.hasFleetIntel && (c.fleetIntel || []).length
  && !campNeedsScout(c) && !campReportsSince(c).length;

let pcAttackRunning = false;
const pcJustAttacked = new Map();

function attackLossGuard(since) {
  let lost = 0;
  let defeats = 0;
  for (const r of pcReports) {
    if (!r.createdAt || new Date(r.createdAt) < new Date(since)) continue;
    lost += (r.attackerLosses || []).reduce((t, l) => t + (Number(l.lost) || 0), 0);
    if (r.outcome !== 'attacker_won') defeats += 1;
  }
  return { lost, defeats };
}

// The reason is persisted so it is still visible after a reload.
function stopAttackAutomation(reason, lock = false) {
  const box = document.getElementById('pc-auto-attack');
  box.checked = false;
  if (lock) box.disabled = true;
  rememberSelection('pc-auto-attack', false);
  rememberSelection('pc-attack-stop-reason', reason);
  setStatusText(document.getElementById('pc-attack-status'), reason, 'error');
}

async function automatePirateAttacks() {
  if (pcAttackRunning) return;
  pcAttackRunning = true;
  const autoStatus = document.getElementById('pc-attack-status');
  try {
    await refreshPirateReports('check');
    const since = (await rememberedSelections())['pc-attack-since'] || new Date().toISOString();
    const limit = Math.max(1, Number(document.getElementById('pc-loss-limit').value) || 1);
    const { lost, defeats } = attackLossGuard(since);
    if (lost >= limit || defeats > 0) {
      stopAttackAutomation(defeats
        ? 'Stopped: an attack was lost.'
        : `Stopped: ${lost} ship(s) lost since enabling (limit ${limit}).`);
      return;
    }

    await refreshPirateMissions();
    const now = Date.now();
    for (const [id, t] of pcJustAttacked) {
      if (now - t > 30_000 || pcMissions.some(m => m.raidParams?.campId === id)) pcJustAttacked.delete(id);
    }
    const busy = new Set(pcMissions.map(m => m.raidParams?.campId));
    for (const id of pcJustAttacked.keys()) busy.add(id);

    const maxVal = Number(document.getElementById('pc-max-attack').value);
    const maxAttacks = Number.isInteger(maxVal) && maxVal > 0 ? maxVal : 1;
    const attacking = pcMissions.filter(m => m.missionType === 'attack_pirates').length
      + [...pcJustAttacked.keys()].filter(id => !pcMissions.some(m => m.raidParams?.campId === id)).length;
    if (attacking >= maxAttacks) {
      setStatusText(autoStatus, `Waiting… ${attacking}/${maxAttacks} attack fleets in flight.`);
      return;
    }
    if (pcSlots.max != null && pcSlots.used >= pcSlots.max) {
      setStatusText(autoStatus, `Cannot attack: ${pcSlots.used}/${pcSlots.max} fleet slots in use.`, 'warning');
      return;
    }
    if (!pcPlanets.length) { setStatusText(autoStatus, 'Select a planet first.'); return; }
    const targets = pcCamps
      .filter(c => campReadyToAttack(c) && !busy.has(c.id))
      .sort((a, b) => (a.systemName || '').localeCompare(b.systemName || ''))
      .slice(0, 3);
    if (!targets.length) { setStatusText(autoStatus, 'No scouted camps to attack.'); return; }

    setStatusText(autoStatus, 'Calculating attack fleet…');
    let lastError = '';
    const shipsCache = new Map();
    for (const target of targets) {
      const pick = await pickSourcePlanet(target, async available => {
        const plan = await suggestAttackFleet(target, available, {
          ...attackPlannerOptions(),
          onProgress: text => setStatusText(autoStatus, `${target.name}: ${text}`),
        });
        return plan;
      }, shipsCache);
      if (pick.error) {
        lastError = `${target.name}: ${pick.error}`;
        if (pick.status === 429) {
          setStatusText(autoStatus, lastError, 'warning');
          return;
        }
        continue;
      }
      const { planet: source, result: plan } = pick;
      const planetId = source.id;
      const ships = Object.entries(plan.ships).map(([id, quantity]) => ({ shipDefId: Number(id), quantity }));
      const res = await browser.runtime.sendMessage({
        type: 'SEND_ATTACK_PIRATES', sourcePlanetId: planetId, campId: target.id, ships,
      });
      if (res.error) {
        if (String(res.error).includes('Human verification')) {
          pauseAutomationsForHumanVerification(res.error);
          stopAttackAutomation(`Attack failed: ${res.error}`, true);
        } else {
          setStatusText(autoStatus, `Attack failed: ${res.error}`, 'warning');
        }
        return;
      }
      pcJustAttacked.set(target.id, Date.now());
      setStatusText(autoStatus, `Attack sent to ${target.name} from ${source.name} ✓ — ${plan.note.split('\n')[0]}`);
      await refreshPirateMissions();
      return;
    }
    setStatusText(autoStatus, lastError || 'No suitable fleet found.', 'warning');
  } finally {
    pcAttackRunning = false;
  }
}

async function automatePirateScouting() {
  if (pcAutoRunning) return;
  pcAutoRunning = true;
  const autoStatus = document.getElementById('pc-auto-status');
  try {
    await refreshPirateMissions();
    const now = Date.now();
    for (const [id, t] of pcJustScouted) {
      if (now - t > 30_000 || pcMissions.some(m => m.raidParams?.campId === id)) pcJustScouted.delete(id);
    }
    const busy = new Set(pcMissions.map(m => m.raidParams?.campId));
    for (const id of pcJustScouted.keys()) busy.add(id);

    const maxEl = Number(document.getElementById('pc-max-scout').value);
    const maxScouts = Number.isInteger(maxEl) && maxEl > 0 ? maxEl : 1;
    const scouting = pcMissions.filter(m => m.missionType === 'scout_camp').length
      + [...pcJustScouted.keys()].filter(id => !pcMissions.some(m => m.raidParams?.campId === id)).length;
    if (scouting >= maxScouts) {
      setStatusText(autoStatus, `Waiting… ${scouting}/${maxScouts} scouting fleets in flight.`);
      return;
    }
    if (pcSlots.max != null && pcSlots.used >= pcSlots.max) {
      setStatusText(autoStatus, `Cannot scout: ${pcSlots.used}/${pcSlots.max} fleet slots in use.`, 'warning');
      return;
    }
    const target = pcCamps
      .filter(c => campNeedsScout(c) && !busy.has(c.id))
      .sort((a, b) => (a.systemName || '').localeCompare(b.systemName || ''))[0];
    if (!target) { setStatusText(autoStatus, 'No camps need scouting.'); return; }

    const pick = await pickSourcePlanet(target, available => scoutTemplateShips(available));
    if (pick.error) { setStatusText(autoStatus, pick.error, 'warning'); return; }
    const planetId = pick.planet.id;
    const planet = pick.planet;

    const res = await browser.runtime.sendMessage({
      type: 'SEND_SCOUT_CAMP', sourcePlanetId: planetId, campId: target.id, ships: pick.result.ships,
    });
    if (res.error) {
      if (String(res.error).includes('Human verification')) {
        setStatusText(autoStatus, `Scout failed: ${res.error}`, 'error');
        pauseAutomationsForHumanVerification(res.error);
      } else {
        setStatusText(autoStatus, `Scout failed: ${res.error}`, 'warning');
      }
      return;
    }
    pcJustScouted.set(target.id, Date.now());
    setStatusText(autoStatus, `Scout sent to ${target.name} (${planet ? planet.name : planetId}) ✓`);
    await refreshPirateMissions();
  } finally {
    pcAutoRunning = false;
  }
}

async function initPirateCamps() {
  if (pcInited) return;
  pcInited = true;
  document.getElementById('pc-refresh').addEventListener('click', () => {
    refreshPirateCamps();
    refreshPirateReports();
  });
  const autoBox = document.getElementById('pc-auto');
  const savedSel = await rememberedSelections();
  autoBox.checked = savedSel['pc-auto'] === true;
  autoBox.addEventListener('change', e => rememberSelection('pc-auto', e.target.checked));
  const maxScout = document.getElementById('pc-max-scout');
  maxScout.value = savedSel['pc-max-scout'] ?? 1;
  maxScout.addEventListener('change', e => rememberSelection('pc-max-scout', e.target.value));
  const attackBox = document.getElementById('pc-auto-attack');
  attackBox.checked = savedSel['pc-auto-attack'] === true;
  attackBox.addEventListener('change', e => {
    rememberSelection('pc-auto-attack', e.target.checked);
    if (e.target.checked) {
      rememberSelection('pc-attack-since', new Date().toISOString());
      rememberSelection('pc-attack-stop-reason', '');
    }
  });
  if (!attackBox.checked && savedSel['pc-attack-stop-reason']) {
    setStatusText(document.getElementById('pc-attack-status'), savedSel['pc-attack-stop-reason'], 'error');
  }
  if (attackBox.checked && !savedSel['pc-attack-since']) rememberSelection('pc-attack-since', new Date().toISOString());
  for (const [id, fallback] of [['pc-max-attack', 1], ['pc-loss-limit', 3]]) {
    const input = document.getElementById(id);
    input.value = savedSel[id] ?? fallback;
    input.addEventListener('change', e => rememberSelection(id, e.target.value));
  }

  const planets = await browser.runtime.sendMessage({ type: 'GET_PLANETS' });
  pcPlanets = planets.planets || [];
  const sel = document.getElementById('pc-planet');
  sel.textContent = '';
  for (const p of pcPlanets) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    if (p.isHomeworld) o.selected = true;
    sel.appendChild(o);
  }
  const saved = await rememberedSelections();
  if (saved['pc-planet'] && pcPlanets.some(p => String(p.id) === saved['pc-planet'])) sel.value = saved['pc-planet'];
  sel.addEventListener('change', e => rememberSelection('pc-planet', e.target.value));
  for (const id of ['pc-scout-template', 'pc-attack-template']) {
    document.getElementById(id).addEventListener('change', e => rememberSelection(id, e.target.value));
  }
  const nearestBox = document.getElementById('pc-nearest');
  nearestBox.checked = saved['pc-nearest'] === true;
  nearestBox.addEventListener('change', e => {
    rememberSelection('pc-nearest', e.target.checked);
    sel.disabled = e.target.checked;
  });
  sel.disabled = nearestBox.checked;
  await refreshPirateTemplates();
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fleet_templates) refreshPirateTemplates();
  });

  const refreshMissionsIfDue = createMissionRefresh(refreshPirateMissions);
  setInterval(() => {
    if (document.getElementById('pirates-content').style.display === 'none') return;
    for (const upd of pcCardTicks) upd();
    refreshMissionsIfDue(pcMissions);
  }, 1000);
}

let pcTemplates = [];

async function refreshPirateTemplates() {
  pcTemplates = await loadFleetTemplates();
  pcTemplates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sel = document.getElementById('pc-scout-template');
  const atkSel = document.getElementById('pc-attack-template');
  const saved = await rememberedSelections();
  const want = saved['pc-scout-template'] || sel.value;
  const wantAtk = saved['pc-attack-template'] ?? atkSel.value;
  sel.textContent = '';
  atkSel.textContent = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = 'All ships (strongest)';
  atkSel.appendChild(all);
  for (const t of pcTemplates) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    atkSel.appendChild(o);
  }
  if (wantAtk && pcTemplates.some(t => String(t.id) === wantAtk)) atkSel.value = wantAtk;
  if (!pcTemplates.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— none (create in Fleet Templates) —';
    sel.appendChild(o);
    return;
  }
  for (const t of pcTemplates) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
  if (want && pcTemplates.some(t => String(t.id) === want)) sel.value = want;
}

// A chosen template only releases ship types (quantity ≥ 1); the planner picks the count.
function attackPlannerOptions() {
  const tpl = pcTemplates.find(t => String(t.id) === document.getElementById('pc-attack-template').value);
  if (!tpl) return {};
  const ids = Object.entries(tpl.ships || {}).filter(([, q]) => Number(q) >= 1).map(([id]) => id);
  return ids.length ? { allowedShipIds: ids } : {};
}

function scoutTemplateShips(available) {
  const tpl = pcTemplates.find(t => String(t.id) === document.getElementById('pc-scout-template').value);
  if (!tpl) return { error: 'No scout template selected — create one in Fleet Templates.' };
  const ships = Object.entries(tpl.ships || {})
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity: Math.min(quantity, available[shipDefId] || 0) }))
    .filter(s => s.quantity > 0);
  if (!ships.length) return { error: `None of template "${tpl.name}"'s ships are on this planet.` };
  return { ships };
}

let pcSystems = null;

async function loadPirateSystems() {
  if (pcSystems) return pcSystems;
  const map = await browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' });
  if (map.error) return {};
  pcSystems = {};
  for (const s of (map.systems || [])) pcSystems[s.id] = { x: s.x, y: s.y };
  return pcSystems;
}

// Planets to launch from, in order of preference: with "Nearest planet" on, all
// owned planets by straight-line distance to the camp; otherwise the selected one.
async function sourceCandidates(camp) {
  const selected = pcPlanets.find(p => p.id === Number(document.getElementById('pc-planet').value));
  if (!document.getElementById('pc-nearest').checked) return selected ? [selected] : [];
  const systems = await loadPirateSystems();
  const target = systems[camp.systemId];
  if (!target) return selected ? [selected] : [];
  const dist = p => {
    const s = systems[p.systemId];
    return s ? Math.hypot(s.x - target.x, s.y - target.y) : Infinity;
  };
  return pcPlanets.filter(p => p.systemId != null).sort((a, b) => dist(a) - dist(b));
}

// First candidate planet whose ships satisfy `check(available)` (returns an object
// with `error` when unsuitable). Resolves to { planet, av, result } or { error }.
async function pickSourcePlanet(camp, check, shipsCache = new Map()) {
  const candidates = await sourceCandidates(camp);
  if (!candidates.length) return { error: 'Select a planet first.' };
  let firstError = '';
  for (const planet of candidates) {
    let av = shipsCache.get(planet.id);
    if (!av) {
      av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId: planet.id, priority: 'action' });
      shipsCache.set(planet.id, av);
    }
    if (av.error) { firstError ||= av.error; continue; }
    const result = await check(av.available, planet);
    if (!result.error) return { planet, av, result };
    if (result.status === 429) return result;
    firstError ||= result.error;
  }
  return { error: firstError || 'No suitable planet found.' };
}

function attackShipsPresent(available) {
  const { allowedShipIds } = attackPlannerOptions();
  const ids = allowedShipIds || Object.keys(available);
  return ids.some(id => (available[id] || 0) > 0)
    ? {}
    : { error: 'No suitable ships on this planet.' };
}

async function sendCampFleet(camp, { title, messageType, doneText, useTemplate }) {
  const status = document.getElementById('pc-status');
  const isAttack = messageType === 'SEND_ATTACK_PIRATES';
  const pick = await pickSourcePlanet(camp, available => (useTemplate
    ? scoutTemplateShips(available)
    : (isAttack ? attackShipsPresent(available) : {})));
  if (pick.error) { setStatusText(status, pick.error, 'warning'); return; }
  const { planet, av } = pick;
  const planetId = planet.id;

  let ships;
  if (useTemplate) {
    ships = pick.result.ships;
  } else {
    const planner = isAttack
      ? {
        label: 'Calculate fleet',
        run: onProgress => suggestAttackFleet(camp, av.available, { ...attackPlannerOptions(), onProgress }),
      }
      : null;
    ships = await editFleetDialog({
      title,
      subtitle: `From: ${planet.name}${document.getElementById('pc-nearest').checked ? ' (nearest)' : ''}\nCamp: ${camp.name} (${camp.systemName})`,
      avail: av.available, planner,
    });
  }
  if (!ships || !ships.length) return;

  setStatusText(status, 'Sending…');
  const res = await browser.runtime.sendMessage({
    type: messageType, sourcePlanetId: planetId, campId: camp.id, ships,
  });
  if (res.error) { setStatusText(status, `Failed: ${res.error}`); return; }
  setStatusText(status, `${doneText} ${camp.name} ✓`);
  refreshPirateMissions();
  setTimeout(refreshPirateMissions, 2000);
}

const PIRATE_MISSION_LABELS = { scout_camp: 'Scout', attack_pirates: 'Attack' };
let pcMissions = [];
let pcCardTicks = [];
let pcCampsLoaded = false;

async function refreshPirateMissions() {
  const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS', priority: 'check' });
  if (mi.error) { console.error('[NexusOverseer] Pirate mission refresh failed:', mi.error); return; }
  pcSlots = { max: mi.maxFleetSlots ?? null, used: usedFleetSlots(mi.missions) };
  pcMissions = (mi.missions || []).filter(m => PIRATE_MISSION_LABELS[m.missionType]);
  if (pcCampsLoaded) renderPirateCamps();
}

const scoutCamp = camp => sendCampFleet(camp, {
  title: 'Scout pirate camp', messageType: 'SEND_SCOUT_CAMP', doneText: 'Scout fleet sent to', useTemplate: true,
});
const attackCamp = camp => sendCampFleet(camp, {
  title: 'Attack pirate camp', messageType: 'SEND_ATTACK_PIRATES', doneText: 'Attack fleet sent to',
});

async function refreshPirateCamps(silent = false) {
  const res = await browser.runtime.sendMessage({ type: 'GET_PIRATE_CAMPS' });
  if (res.error) {
    if (!silent) renderPirateCamps(res.error);
    return;
  }
  pcCamps = res.camps || [];
  pcCampsLoaded = true;
  renderPirateCamps();
}

function campIntelText(c) {
  if (!c.hasFleetIntel || !(c.fleetIntel || []).length) return '—';
  return c.fleetIntel.map(s => `${s.quantity}× ${s.name}`).join(', ');
}

function campStatus(c) {
  if (c.destroyedAt) {
    return c.respawnsAt ? `Destroyed — respawns ${new Date(c.respawnsAt).toLocaleString()}` : 'Destroyed';
  }
  return 'Active';
}

function renderPirateCamps(error) {
  const list = document.getElementById('pc-list');
  list.textContent = '';
  pcCardTicks = [];
  document.getElementById('pc-count').textContent = error ? '' : `${pcCamps.length} camps`;
  if (error || !pcCamps.length) {
    const d = document.createElement('div');
    d.className = 'sc-transit-empty';
    d.textContent = error ? `Could not load camps: ${error}` : 'No pirate camps visible.';
    list.appendChild(d);
    return;
  }
  const makeMetaItem = (label, value, color) => {
    const item = document.createElement('div');
    item.className = 'sc-debris-meta-item';
    const key = document.createElement('span');
    key.className = 'sc-debris-meta-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'sc-debris-meta-val';
    val.textContent = value;
    val.title = value;
    if (color) val.style.color = color;
    item.append(key, val);
    return item;
  };
  const makeBtn = (cls, label, onClick) => {
    const b = document.createElement('button');
    b.className = `pc-icon-btn ${cls}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };
  const rows = [...pcCamps].sort((a, b) => Number(!!a.destroyedAt) - Number(!!b.destroyedAt)
    || (a.systemName || '').localeCompare(b.systemName || ''));
  for (const c of rows) {
    const hp = c.scoutHpPercent ?? c.currentHpPercent;
    const card = document.createElement('div');
    card.className = 'sc-debris-card';
    if (c.destroyedAt) card.style.opacity = '0.45';

    const action = document.createElement('div');
    action.className = 'sc-debris-action';
    const busy = pcMissions.some(x => x.raidParams?.campId === c.id);
    if (!c.destroyedAt) {
      const sb = makeBtn('pc-btn-scout', 'Scout camp', () => scoutCamp(c));
      const ab = makeBtn('pc-btn-attack', 'Attack camp', () => attackCamp(c));
      if (busy) {
        for (const b of [sb, ab]) {
          b.disabled = true;
          b.title = 'A fleet is already active at this camp';
        }
      }
      action.append(sb, ab);
    }

    const meta = document.createElement('div');
    meta.className = 'sc-debris-meta-grid pc-meta-grid';
    const etaItem = makeMetaItem('Progress ETA', '—');
    etaItem.classList.add('sc-eta-grid-item');
    const etaVal = etaItem.querySelector('.sc-debris-meta-val');
    etaVal.classList.add('sc-debris-progress-eta');
    etaVal.title = '';
    const campItem = makeMetaItem('Camp', c.name || `#${c.id}`);
    meta.append(
      campItem,
      makeMetaItem('System', c.systemName || String(c.systemId)),
      makeMetaItem('Zone', c.securityZone || '—', ZONE_COLORS[c.securityZone] || ZONE_COLORS.unknown),
      makeMetaItem('Tier', c.tier || '—'),
      makeMetaItem('Loot', c.lootTier || '—'),
      makeMetaItem('HP', hp == null ? '—' : `${hp}%`),
      makeMetaItem('Status', campStatus(c)),
      makeMetaItem('Last scouted', c.lastScoutedAt ? new Date(c.lastScoutedAt).toLocaleString() : 'never'),
      makeMetaItem('Fleet intel', campIntelText(c)),
      etaItem,
    );

    const body = document.createElement('div');
    body.className = 'sc-mission-main sc-debris-main';
    body.append(action, meta);

    const progress = document.createElement('div');
    progress.className = 'sc-debris-progress';
    mountCardProgress(pcMissions.find(x => x.raidParams?.campId === c.id), progress, campItem, etaVal);

    card.append(body, progress);
    list.appendChild(card);
  }
}

function mountCardProgress(m, host, systemItem, etaVal) {
  const track = document.createElement('div');
  track.className = 'mission-progress-track sc-transit-track sc-debris-progress-track';
  const fill = document.createElement('div');
  fill.className = 'mission-progress-fill sc-transit-fill sc-debris-progress-fill';
  track.appendChild(fill);
  host.appendChild(track);
  const status = document.createElement('span');
  status.className = 'sc-transit-status sc-debris-system-status';
  status.textContent = '—';
  systemItem.appendChild(status);
  if (!m) { fill.style.width = '0%'; return; }

  const kind = m.missionType === 'scout_camp' ? 'Scouting' : 'Attack';
  const upd = () => {
    const p = missionProgress(m);
    fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
    fill.style.background = p.gradient || p.color;
    status.textContent = `${p.label} · ${kind}`;
    status.style.color = p.color;
    etaVal.textContent = missionCountdown(p);
  };
  upd();
  pcCardTicks.push(upd);
}

export function renderPirateStatsTab() {
  const mode = getMode();
  const periodLabel = periodLabelFor(mode);
  const t = getPirateTotalsForMode();
  const rl = getPirateLostForMode();
  const debris = getPirateDebrisForMode();
  const outcomes = getPirateOutcomesForMode();
  const series = getPirateSeriesForMode();
  const labelKey = getLabelKey(mode);

  const collected = document.getElementById('p-stats-collected');
  collected.textContent = '';
  if (!store.pirate_totals || !store.pirate_totals.raids) {
    const p = document.createElement('p');
    p.className = 'mission-empty-state';
    p.textContent = 'No pirate raids recorded yet — click Scrape Now after raiding a camp.';
    collected.appendChild(p);
  } else {
    collected.append(
      makeStatCard(`Ore${periodLabel}`,       fmt(t.ore),       'ore'),
      makeStatCard(`Silicates${periodLabel}`, fmt(t.silicates), 'silicates'),
      makeStatCard(`Hydrogen${periodLabel}`,  fmt(t.hydrogen),  'hydrogen'),
    );
    appendExtraResourceCards(collected, t, periodLabel);
    collected.append(
      makeStatCard(`Raids${periodLabel}`,     fmt(t.raids),     'missions'),
      makeStatCard(`Ships destroyed${periodLabel}`, fmt(t.ships_destroyed), '', 'color:var(--error)'),
      makeStatCard(`Pirates destroyed${periodLabel}`, fmt(t.pirates_destroyed), '', 'color:var(--success)'),
      makeStatCard(`Fuel spent${periodLabel}`, fmt(fuelForMode('pirate', getMode())), 'hydrogen'),
    );
  }

  renderLostCards('p-stats-lost', 'p-stats-repair', rl, periodLabel);
  renderNetCards('p-stats-net', t, rl, periodLabel, fuelForMode('pirate', getMode()));

  const debrisEl = document.getElementById('p-stats-debris');
  debrisEl.textContent = '';
  debrisEl.append(
    makeStatCard(`Debris ore${periodLabel}`,       fmt(debris.ore),       'ore'),
    makeStatCard(`Debris alloys${periodLabel}`,    fmt(debris.alloys),    'alloys'),
    makeStatCard(`Debris silicates${periodLabel}`, fmt(debris.silicates), 'silicates'),
  );

  renderPirateLootChart(series, labelKey);
  renderPirateOutcomesChart(outcomes);
  renderPirateTable();
}

export function renderPirateLootChart(series, labelKey) {
  if (chartPirateLoot) chartPirateLoot.destroy();
  chartPirateLoot = makeResourceLineChart('chart-pirate-loot', series, labelKey, { field: 'raids', label: 'Raids' });
}

export function renderPirateOutcomesChart(outcomes) {
  const total = outcomes.reduce((s, o) => s + o.count, 0);
  const labels = outcomes.map(o => {
    const pct = total ? (o.count / total * 100).toFixed(1) : 0;
    return `${o.outcome.replace(/_/g, ' ')} — ${o.count} (${pct}%)`;
  });
  const colors = ['#7ed957', '#ff6b7a', '#ffc070', '#7ed4ff', '#c0cce0'];
  if (chartPirateOutcomes) chartPirateOutcomes.destroy();
  chartPirateOutcomes = new Chart(document.getElementById('chart-pirate-outcomes'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: outcomes.map(o => o.count), backgroundColor: colors }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text'), font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = total ? (ctx.parsed / total * 100).toFixed(1) : 0;
              return ` ${ctx.parsed} raids (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

export const pirateSort = { key: 'created_at', dir: -1 };
attachSortable('p-reports-head', pirateSort, () => { pirateCurrentPage = 1; renderPirateTable(); });

export function renderPirateTable() {
  const allReports = applySort('p-reports-head', filterZone(store.pirate_recent_reports || []), pirateSort);
  const totalPages = Math.ceil(allReports.length / PER_PAGE);
  document.getElementById('p-page-info').textContent = `Page ${pirateCurrentPage} / ${Math.max(1, totalPages)} (${allReports.length} total)`;
  document.getElementById('p-btn-prev').disabled = pirateCurrentPage <= 1;
  document.getElementById('p-btn-next').disabled = pirateCurrentPage >= totalPages;

  const slice = allReports.slice((pirateCurrentPage - 1) * PER_PAGE, pirateCurrentPage * PER_PAGE);
  const tbody = document.getElementById('p-reports-tbody');
  tbody.textContent = '';

  function zeroTd(v) {
    const td = document.createElement('td');
    if (v) {
      td.textContent = fmt(v);
    } else {
      const span = document.createElement('span');
      span.className = 'zero';
      span.textContent = '—';
      td.appendChild(span);
    }
    return td;
  }

  for (const r of slice) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(r.created_at).toLocaleString();

    const tdCamp = document.createElement('td');
    tdCamp.textContent = r.camp_id != null ? `#${r.camp_id}` : '—';

    const tdOutcome = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${r.outcome}`;
    badge.textContent = (r.outcome || 'unknown').replace(/_/g, ' ');
    tdOutcome.appendChild(badge);

    const tdOre = zeroTd(r.ore);       tdOre.className = 'ore';
    const tdHyd = zeroTd(r.hydrogen);  tdHyd.className = 'hydrogen';
    const tdSil = zeroTd(r.silicates); tdSil.className = 'silicates';
    const tdAll = zeroTd(r.alloys);    tdAll.className = 'alloys';

    tr.append(tdDate, tdCamp, zoneCell(r.zone), tdOutcome, tdOre, tdHyd, tdSil, tdAll,
              zeroTd(r.cryo_ice), zeroTd(r.quantum_dust), zeroTd(r.plasma_core),
              zeroTd(r.dark_matter), zeroTd(r.antimatter),
              zeroTd(r.ships_lost), zeroTd(r.ships_damaged), zeroTd(r.pirates_destroyed));
    tbody.appendChild(tr);
  }
}

export function changePiratePage(delta) {
  pirateCurrentPage += delta;
  renderPirateTable();
}

document.getElementById('p-btn-prev').addEventListener('click', () => changePiratePage(-1));

document.getElementById('p-btn-next').addEventListener('click', () => changePiratePage(1));

export function setPirateCurrentPage(n) { pirateCurrentPage = n; }
