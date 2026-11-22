// Xeno tab: scans outward from a source planet for the nearest system holding
// an "Ancient" moon and launches a ruins survey there.
//
// Ruins survey: POST /api/fleet/xeno-survey { sourcePlanetId, targetMoonId, ships }
// (confirmed against a live send).
//
// Eligibility: Ancient moons outside credited and in-flight survey systems,
// regardless of ownership, with matching filters and no server-reported cooldown.
// Check each candidate through the scheduler-backed Xeno moon endpoint.

import { loadGalaxyScans, getSystemPlanets } from '../galaxy-client.js';
import { loadFleetTemplates } from './fleets.js';
import { usedFleetSlots } from '../mission-state.js';
import { XENO_SURVEY_LIMIT, campaignFromInFlightSurveys, findAvailableAncientMoon, hasClassifiedMissions, xenoMissionStatusesChanged, xenoSearchSystems, xenoSurveyCount, xenoSurveyFleetError, xenoSurveyLimitError, xenoTargetExclusions } from '../xeno-moon-search.js';
import { compareXenoResults, prepareXenoDig, xenoCandidates, xenoDefender, xenoEntrances, xenoLeadershipFingerprint, xenoSimulationResult, xenoTemplateCandidate } from '../xeno-dig-planner.js';
import { getSetting, onSettingsChange } from '../settings.js';
import { xenoTotals } from '../xeno-reports.js';
import { createPaginationFooter, paginate } from '../pagination.js';
import { RESOURCE_SERIES, applySort, attachSortable, clearAvailStrip, combatOutcomeBadge, computeRawLossCost, computeSeries, confirmDialog, createMissionRefresh, fillResourceCards, filterZone, fmt, fmtCountdown, formatBadgeLabel, fuelForMode, getLabelKey, getMode, inWindowRange, listBadge, makeResourceDoughnut, makeResourceLineChart, makeStatCard, missionCountdown, missionProgress, periodLabelFor, renderAvailStrip, renderPagedTable, rememberSelection, rememberedSelections, resourceVal, store, windowActive, setStatusText, xenoTraceBadge, zeroCell, zoneBadge, zoneCell } from '../common.js';

const XENO_CACHE_TTL = 60 * 60 * 1000;
const XENO_LOOT_SERIES = RESOURCE_SERIES.filter(resource =>
  ['silicates', 'alloys', 'precursor_fragments', 'artifact'].includes(resource.field));

let inited = false;
let xnPlanets = [];
let xnTemplates = [];
let xnMap = null;          // { systems, byId } from GET_GALAXY_MAP, cached
let xnRunning = false;
let xnSurveyLaunching = false;
let xnMissions = [];       // in-flight xeno_survey and xeno_dig missions
let xnMissionsLoaded = false;
let xnOverviewMissions = null;
let xnOverviewRequest = null;
let xnOverviewNeedsRefresh = false;
let xnTabWasVisible = false;
let xnMissionTimer;
let xnGeneration = 0;
const xnMoonDetails = new Map();
const xnMoonDetailsLoading = new Set();
let xnTicks = [];
let xnCampaignTick = null;
let xnOverview = null;
let xnDigMissions = {};
const expandedDigReports = new Set();
const CODEX_SETS = [['stone', 'Stone'], ['voice', 'Voice'], ['gaze', 'Gaze'], ['memory', 'Memory']];
const CODEX_ENTRIES = ['I', 'II', 'III', 'IV', 'V', 'VI'];
let digComparisonBound = false;
let digComparisonRunning = false;
let digLaunchRunning = false;
let pendingDigLaunch = null;
let digComparisonSnapshot = null;
let dispatchedComparison = null;
let digComparisonSaved = false;
let digComparisonPage = 0;
let digPageSize = getSetting('general.tablePageSize');
onSettingsChange(settings => {
  if (settings['general.tablePageSize'] === digPageSize) return;
  digPageSize = settings['general.tablePageSize'];
  if (digComparisonSnapshot) renderDigComparison(digComparisonSnapshot, digComparisonSaved);
});
const XENO_DIG_RESULTS = 'xeno_dig_comparison';
const firstArchiveSelection = { trace: '', zone: '' };

export function resetXenoTab() {
  xnGeneration++;
  inited = false;
  xnPlanets = [];
  xnTemplates = [];
  xnMap = null;
  xnRunning = false;
  xnSurveyLaunching = false;
  xnMissions = [];
  xnMissionsLoaded = false;
  xnOverviewMissions = null;
  xnOverviewRequest = null;
  xnOverviewNeedsRefresh = false;
  xnTabWasVisible = false;
  clearInterval(xnMissionTimer);
  xnMoonDetails.clear();
  xnMoonDetailsLoading.clear();
  xnTicks = [];
  xnCampaignTick = null;
  xnOverview = null;
  xnDigMissions = {};
  expandedDigReports.clear();
  digComparisonRunning = false;
  pendingDigLaunch = null;
  digComparisonSnapshot = null;
  dispatchedComparison = null;
  digComparisonPage = 0;
  const digButton = document.getElementById('xn-dig-simulate');
  if (digButton) digButton.disabled = false;
  const digResults = document.getElementById('xn-dig-results');
  if (digResults) digResults.replaceChildren();
  const digStatus = document.getElementById('xn-dig-status');
  if (digStatus) digStatus.textContent = '';
  const launchStatus = document.getElementById('xn-dig-launch-status');
  if (launchStatus) launchStatus.textContent = '';
  const digContext = document.getElementById('xn-dig-context');
  if (digContext) digContext.textContent = '';
  renderXenoOverview();
  updateSurveyLaunchState();
  const status = document.getElementById('xn-overview-status');
  if (status) status.textContent = 'Loading Xeno account…';
}

function formatXenoName(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function xenoMissionTargetMoonId(mission) {
  if (mission?.missionType === 'xeno_dig') {
    return mission.targetMoonId ?? mission.cargo?._xenoDig?.moonId ?? null;
  }
  return mission?.targetMoonId
    ?? mission?.cargo?._targetMoonId
    ?? mission?.cargo?._xenoClue?.moonId
    ?? null;
}

function isXenoTransitMission(mission) {
  return mission?.missionType === 'xeno_survey' || mission?.missionType === 'xeno_dig';
}

function activeXenoCampaign() {
  if (xnOverview?.chain) {
    const chain = xnOverview.chain;
    return typeof chain.trace === 'string' && typeof chain.zone === 'string'
      ? chain
      : { unavailable: true };
  }
  const surveys = xnMissions.filter(mission => mission.missionType === 'xeno_survey');
  if (surveys.some(mission => xenoMissionTargetMoonId(mission) == null)) return { unavailable: true };
  const targets = surveys.map(mission => xenoMissionTargetMoonId(mission));
  if (!targets.length) return null;
  const details = targets.map(id => xnMoonDetails.get(String(id)));
  if (details.some(info => !info)) return { pending: true };
  if (details.some(info => info.error || !info.trace || !info.zone)) return { unavailable: true };
  const unique = new Map(details.map(info => [`${info.trace}\u0000${info.zone}`, info]));
  if (unique.size > 1) return { ambiguous: true };
  return details[0];
}

function updateCampaignSelection() {
  const campaign = activeXenoCampaign();
  for (const key of Object.keys(firstArchiveSelection)) {
    const control = document.getElementById(`xn-${key}-control`);
    const select = document.getElementById(`xn-${key}`);
    const label = document.getElementById(`xn-${key}-label`);
    if (!control || !select || !label) continue;
    control.hidden = !xnOverview;
    select.disabled = !xnOverview || !!campaign;
    label.textContent = `${campaign ? 'Campaign' : 'First archive'} ${key}`;
    const value = campaign ? campaign[key] || '' : firstArchiveSelection[key];
    if (value && !Array.from(select.options).some(option => option.value === value)) {
      select.add(new Option(formatXenoName(value), value));
    }
    if (campaign && !value) select.selectedIndex = -1;
    else select.value = value;
  }
  const active = document.getElementById('xn-active-trace');
  if (!active) return;
  active.hidden = !campaign || !!(campaign.trace && campaign.zone);
  if (campaign?.pending) {
    active.textContent = 'Checking in-flight survey trace and zone…';
  } else if (campaign?.ambiguous) {
    active.textContent = 'In-flight surveys report different traces or zones.';
  } else if (campaign?.unavailable) {
    active.textContent = 'Could not verify the campaign trace and zone.';
  }
}

function renderXenoOverview() {
  updateCampaignSelection();
  updateDigComparisonVisibility();
  const statsEl = document.getElementById('xn-overview-stats');
  const campaignStatsEl = document.getElementById('xn-campaign-stats');
  const archiveEl = document.getElementById('xn-overview-archive');
  const codexEl = document.getElementById('xn-overview-codex');
  const reportsEl = document.getElementById('xn-overview-reports');
  if (!statsEl || !campaignStatsEl || !archiveEl || !codexEl || !reportsEl) return;
  xnCampaignTick = null;
  const chain = xnOverview?.chain;
  const clues = Array.isArray(chain?.clues) ? chain.clues : null;
  const siteClues = chain?.siteClues ?? xnOverview?.config?.siteClues;
  const clueCount = clues ? fmt(clues.length) : null;
  const clueProgress = clueCount === null ? null
    : !chain.site && Number.isInteger(siteClues) && siteClues > 0 && clues.length <= siteClues
      ? `${clueCount} / ${fmt(siteClues)} clues`
      : `${clueCount} ${clues.length === 1 ? 'clue' : 'clues'}`;
  archiveEl.hidden = !chain;
  const archiveDetails = archiveEl.querySelector('p');
  const clueList = archiveEl.querySelector('ol');
  archiveDetails.textContent = '';
  clueList.replaceChildren();
  const layout = document.getElementById('xn-campaign-layout');
  if (layout) layout.hidden = !chain;
  const context = document.getElementById('xn-campaign-context');
  if (context) context.hidden = !chain;
  const empty = document.getElementById('xn-campaign-empty');
  if (empty) {
    empty.hidden = !!chain;
    empty.textContent = !xnOverview ? 'Loading Xeno campaign…'
      : hasActiveDig() ? 'A dig fleet is in transit. Follow its progress in the fleet list above.'
        : xnOverview.hasResearch === false ? 'Research Xeno archaeology before surveying Ancient moons.'
          : 'No active campaign. Survey an Ancient moon to open an archive channel.';
  }
  renderClueMilestones(chain, clues, siteClues);
  if (chain) {
    archiveDetails.textContent = clues ? 'Credited survey locations; surveys in flight are not included.' : 'Credited clue data unavailable.';
    for (const clue of (clues || []).slice().sort((a, b) => a.index - b.index)) {
      const item = document.createElement('li');
      if (Number.isInteger(clue.index) && clue.index > 0) item.value = clue.index;
      const system = document.createElement('strong');
      system.textContent = clue.systemName || 'System unavailable';
      const moon = document.createElement('span');
      moon.textContent = clue.moonName || 'Moon unavailable';
      item.append(system, moon);
      const at = Date.parse(clue.at);
      if (Number.isFinite(at)) {
        const time = document.createElement('time');
        time.dateTime = clue.at;
        time.textContent = new Date(at).toLocaleString();
        item.appendChild(time);
      }
      clueList.appendChild(item);
    }
  }
  renderXenoSite(chain);
  if (!xnOverview) {
    for (const element of [statsEl, campaignStatsEl, codexEl, reportsEl]) element.replaceChildren();
    const accountDetails = document.getElementById('xn-account-details');
    if (accountDetails) accountDetails.hidden = true;
    document.getElementById('xn-overview-monuments')?.replaceChildren();
    return;
  }
  renderCampaignAndAccount(statsEl, campaignStatsEl, codexEl, reportsEl, clueProgress, chain);
}

function renderClueMilestones(chain, clues, siteClues) {
  const milestones = document.getElementById('xn-clue-milestones');
  if (!milestones) return;
  milestones.replaceChildren();
  if (!chain) return;
  const maxClues = chain.maxClues ?? xnOverview?.config?.maxClues;
  if (!Number.isInteger(maxClues) || maxClues <= 0 || !Number.isInteger(siteClues) || siteClues <= 0 || siteClues > maxClues) {
    milestones.appendChild(listBadge('Milestones unavailable'));
    return;
  }
  for (let step = 1; step <= maxClues; step++) {
    const label = step === siteClues ? 'Dig site' : step > siteClues ? `Side ${step - siteClues}` : `Clue ${step}`;
    const complete = step === siteClues ? !!chain.site
      : step > siteClues ? Array.isArray(chain.sideEntrances) && chain.sideEntrances.length >= step - siteClues
        : clues !== null && clues.length >= step;
    const known = step === siteClues ? chain.site !== undefined
      : step > siteClues ? Array.isArray(chain.sideEntrances) : clues !== null;
    const badge = listBadge(`${step} · ${label}`, complete ? 'badge-success' : '');
    badge.title = `${label}: ${complete ? 'unlocked' : known ? 'not unlocked' : 'unavailable'}`;
    milestones.appendChild(badge);
  }
}

function renderXenoSite(chain) {
  const section = document.getElementById('xn-site-details');
  const location = document.getElementById('xn-site-location');
  const list = document.getElementById('xn-site-entrances');
  const select = document.getElementById('xn-dig-entrance');
  if (!section || !location || !list || !select) return;
  const entries = xenoEntrances(chain);
  section.hidden = !chain;
  location.textContent = chain?.site
    ? [chain.site.moonName, chain.site.systemName].filter(Boolean).join(' · ') || 'Site location unavailable'
    : chain?.site === null ? 'Dig site not located yet.' : 'Site status unavailable.';
  const requirements = document.getElementById('xn-site-requirements');
  if (requirements) {
    const zone = xnOverview?.config?.zones?.[chain?.zone];
    requirements.hidden = !chain?.site;
    requirements.textContent = `${Number.isInteger(zone?.excavators) ? fmt(zone.excavators) : 'Unknown'} Excavators`
      + ` · Mass limit: ${Number.isInteger(zone?.massLimit) ? fmt(zone.massLimit) : 'unknown'} · No capital or huge ships`;
  }
  list.replaceChildren();
  for (const entrance of entries) {
    const row = document.createElement('div');
    row.className = 'xeno-entrance';
    const heading = document.createElement('div');
    heading.className = 'xeno-entrance-heading';
    heading.append(listBadge(entrance.id === 'main' ? 'Main entrance' : 'Side entrance'), xenoTraceBadge(entrance.trace));
    const guards = document.createElement('p');
    guards.textContent = Array.isArray(entrance.garrison)
      ? entrance.garrison.map(guard => `${Number.isInteger(guard?.quantity) && guard.quantity >= 0 ? fmt(guard.quantity) : 'Unknown'}× ${formatXenoName(guard?.key) || 'Unknown guardian'}`).join(' · ') || 'No guardians reported'
      : 'Garrison unavailable';
    row.append(heading, guards);
    list.appendChild(row);
  }
  if (chain?.site && !entries.length) {
    const unavailable = document.createElement('p');
    unavailable.textContent = 'Entrance and garrison data unavailable.';
    list.appendChild(unavailable);
  }
  const previous = select.value;
  select.replaceChildren(new Option('All unlocked entrances', 'all'));
  for (const entrance of entries) select.add(new Option(entrance.label, entrance.id));
  select.value = entries.some(entry => entry.id === previous) ? previous : 'all';
}

function hasActiveDig() {
  return !!xnOverview?.liveDig || xnMissions.some(mission => mission.missionType === 'xeno_dig')
    || !!pendingDigLaunch && pendingDigLaunch.chainId === xnOverview?.chain?.id;
}

function xenoCampaignStatusLabel() {
  if (hasActiveDig()) return 'Dig in progress';
  const site = xnOverview?.chain?.site;
  return site ? 'Site located' : site === null ? 'Site not located' : 'Site status unknown';
}

function canCompareDigFleets() {
  const chain = xnOverview?.chain;
  const expires = Date.parse(chain?.expiresAt);
  return xnMissionsLoaded && !!chain?.site && !chain.paused
    && (!Number.isFinite(expires) || expires > Date.now()) && !hasActiveDig();
}

function updateDigComparisonVisibility() {
  const panel = document.getElementById('xn-dig-panel');
  const results = document.getElementById('xn-dig-results');
  const context = document.getElementById('xn-dig-context');
  const campaignStatus = document.getElementById('xn-campaign-state');
  if (campaignStatus) campaignStatus.textContent = xenoCampaignStatusLabel();
  const visible = canCompareDigFleets();
  if (panel) panel.hidden = !visible;
  const snapshot = digComparisonSnapshot;
  const matches = !!snapshot && snapshot.chainId === xnOverview?.chain?.id
    && snapshot.siteMoonId === xnOverview?.chain?.site?.moonId;
  if (matches && hasActiveDig()) dispatchedComparison = snapshot;
  const showResults = visible && matches && !!snapshot?.results?.length
    && snapshot.launchedMissionId == null && snapshot !== dispatchedComparison;
  if (results) results.hidden = !showResults;
  if (context) context.textContent = showResults
    ? `${digComparisonSaved ? 'Saved comparison' : 'Comparison'} · ${snapshot.planet} · ${snapshot.zone} · channel ${snapshot.chainId} · ${new Date(snapshot.at).toLocaleString()}. Each row is a single simulation. Recheck fleet availability and mass in the game.`
    : '';
}

export function renderDigComparison(snapshot, saved = false) {
  const results = document.getElementById('xn-dig-results');
  if (!results) return;
  if (snapshot !== digComparisonSnapshot) digComparisonPage = 0;
  digComparisonSnapshot = snapshot;
  digComparisonSaved = saved;
  results.replaceChildren();
  updateDigComparisonVisibility();
  if (!snapshot?.results?.length) return;
  const panel = document.createElement('div');
  panel.className = 'dashboard-panel explore-military-table-panel';
  const scroll = document.createElement('div');
  scroll.className = 'xeno-dig-comparison-scroll dashboard-table-scroll explore-military-table-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'Dig fleet comparison results');
  const table = document.createElement('table');
  table.className = 'xeno-dig-comparison-table';
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  for (const label of ['Result', 'Entrance', 'Fleet', 'Leadership vessel', 'Mode', 'Excavators survived', 'Estimated mass', 'Destroyed', 'Damaged', 'Action']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    header.appendChild(cell);
  }
  head.appendChild(header);
  const body = document.createElement('tbody');
  const sorted = snapshot.results.slice().sort(compareXenoResults);
  const result = paginate(sorted, digComparisonPage);
  digComparisonPage = result.page;
  for (const entry of result.rows) {
    const row = document.createElement('tr');
    const resultCell = document.createElement('td');
    const outcome = entry.result.outcome;
    const badge = combatOutcomeBadge(outcome);
    if (outcome === 'attacker_won' && !entry.result.viable) {
      badge.className = 'badge badge-warning';
      badge.textContent += ' · too few excavators';
    }
    badge.className += ' xeno-dig-outcome';
    resultCell.appendChild(badge);
    if (entry.result.scaled) {
      const scaled = document.createElement('div');
      scaled.className = 'xeno-dig-result-note';
      scaled.textContent = 'Scaled estimate';
      resultCell.appendChild(scaled);
    }
    const entranceCell = document.createElement('td');
    const entranceMatch = /^(Main|Side) \(([^)]+)\)$/.exec(entry.entrance);
    if (entranceMatch) entranceCell.append(entranceMatch[1], xenoTraceBadge(entranceMatch[2]));
    else entranceCell.textContent = entry.entrance;
    const fleetCell = document.createElement('td');
    fleetCell.textContent = entry.candidate.label;
    const leadershipCell = document.createElement('td');
    leadershipCell.textContent = snapshot.leadership === true ? 'Yes'
      : snapshot.leadership === false ? 'No' : 'Unknown';
    const modeCell = document.createElement('td');
    modeCell.appendChild(listBadge(formatBadgeLabel(snapshot.launchSimulation?.mode ?? snapshot.mode)));
    modeCell.title = 'Recorded dig mode. Dig duration and collapse chance are not part of the combat simulation.';
    const excavatorCell = document.createElement('td');
    excavatorCell.textContent = fmt(entry.result.excavators);
    const massCell = document.createElement('td');
    massCell.textContent = `${fmt(entry.candidate.mass)} / ${fmt(snapshot.massLimit)}`;
    const destroyedCell = document.createElement('td');
    destroyedCell.textContent = fmt(entry.result.destroyed);
    const damagedCell = document.createElement('td');
    damagedCell.textContent = fmt(entry.result.damaged);
    const actionCell = document.createElement('td');
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'toolbar-button primary-button';
    send.textContent = 'Send dig';
    send.disabled = !snapshot.complete || !snapshot.serverKey || snapshot.launchAttempted
      || !entry.result.viable || !entry.entranceId
      || !Array.isArray(entry.garrison) || !snapshot.siteMoonId || digLaunchRunning;
    if (send.disabled) send.title = 'A completed new comparison with a suitable entrance result is required.';
    send.addEventListener('click', () => { void sendDigFleet(snapshot, entry); });
    actionCell.appendChild(send);
    row.append(resultCell, entranceCell, fleetCell, leadershipCell, modeCell, excavatorCell, massCell, destroyedCell, damagedCell, actionCell);
    body.appendChild(row);
  }
  table.append(head, body);
  scroll.appendChild(table);
  panel.appendChild(scroll);
  panel.appendChild(createPaginationFooter(result, `${result.total} comparison${result.total === 1 ? '' : 's'}`, page => {
    digComparisonPage = page;
    renderDigComparison(snapshot, saved);
    const buttons = results.children[0].children[1].children[1].children;
    const next = page > result.page;
    const focus = buttons[next ? 2 : 0];
    (focus.disabled ? buttons[next ? 0 : 2] : focus).focus();
  }));
  results.appendChild(panel);
}

async function sendDigFleet(snapshot, entry) {
  if (digLaunchRunning || !snapshot.complete || snapshot.launchAttempted) return;
  const status = document.getElementById('xn-dig-launch-status');
  if (digComparisonRunning) {
    setStatusText(status, 'Wait for the current comparison to finish.', 'warning');
    return;
  }
  const compareButton = document.getElementById('xn-dig-simulate');
  const generation = xnGeneration;
  const mode = document.getElementById('xn-dig-mode').value;
  let dispatchStarted = false;
  digLaunchRunning = true;
  compareButton.disabled = true;
  renderDigComparison(snapshot);
  try {
    const server = await globalThis.nexusStorage?.getSelectedServer?.();
    if (!server?.key || server.key !== snapshot.serverKey || generation !== xnGeneration) {
      throw new Error('The selected server changed. Run a new comparison.');
    }
    const confirmed = await confirmDialog(
      `Send dig fleet?\n\nFrom: ${snapshot.planet}\nSite: ${snapshot.siteName}\n` +
      `Entrance: ${entry.entrance}\nFleet: ${entry.candidate.label}\n` +
      `Leadership vessel: ${snapshot.leadership ? 'assigned' : 'not assigned'}\n` +
      `Mode: ${mode}\nEstimated mass: ${fmt(entry.candidate.mass)} / ${fmt(snapshot.massLimit)}\n\n` +
      '⚠ One simulation is not a guarantee. Collapse is not simulated; mass is estimated. ' +
      'The fleet cannot be recalled underground. Verify the fleet and mass in the game.');
    if (!confirmed) return;
    if (generation !== xnGeneration) throw new Error('The selected server changed. No dig was sent.');
    setStatusText(status, 'Checking the active channel and fleet…');
    const [overview, inventory, bootstrap, leadership] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_XENO_OVERVIEW', source: 'xeno', priority: 'interactive' }),
      browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId: snapshot.planetId, priority: 'interactive' }),
      browser.runtime.sendMessage({ type: 'SIM_BOOTSTRAP', priority: 'interactive' }),
      snapshot.leadership ? browser.runtime.sendMessage({ type: 'GET_XENO_LEADERSHIP', priority: 'interactive' }) : Promise.resolve(null),
    ]);
    for (const response of [overview, inventory, bootstrap, ...(snapshot.leadership ? [leadership] : [])]) {
      if (!response || response.error) throw new Error(response?.error || 'Required game data is unavailable.');
    }
    const selected = await globalThis.nexusStorage?.getSelectedServer?.();
    if (generation !== xnGeneration || selected?.key !== snapshot.serverKey) {
      throw new Error('The selected server changed. No dig was sent.');
    }
    xnOverview = overview;
    xnOverviewMissions = xnMissions;
    renderXenoOverview();
    const payload = prepareXenoDig(snapshot, entry, overview, inventory.available, bootstrap.playerShips, leadership, mode);
    snapshot.launchAttempted = true;
    snapshot.launchSimulation = { ...entry, mode };
    await globalThis.nexusStorage.forServer(snapshot.serverKey).set({ [XENO_DIG_RESULTS]: snapshot });
    if (generation !== xnGeneration) throw new Error('The selected server changed. No dig was sent.');
    setStatusText(status, 'Sending dig fleet…');
    dispatchStarted = true;
    const response = await browser.runtime.sendMessage({ type: 'SEND_XENO_DIG', serverKey: snapshot.serverKey,
      chainId: snapshot.chainId, comparisonAt: snapshot.at, ...payload });
    if (!response?.ok || !Number.isSafeInteger(response.data?.missionId)
      || !Number.isFinite(Date.parse(response.data?.arrivesAt))) {
      throw new Error(`${response?.error || 'The launch response was incomplete.'} Check the game for an active mission before trying again.`);
    }
    if (generation !== xnGeneration) return;
    snapshot.launchedMissionId = response.data.missionId;
    pendingDigLaunch = { chainId: snapshot.chainId, missionId: response.data.missionId };
    updateDigComparisonVisibility();
    setStatusText(status, `Dig fleet sent. Arrival: ${new Date(response.data.arrivesAt).toLocaleString()}.`);
    const warnings = response.archiveError ? [`simulation archive: ${response.archiveError}`] : [];
    try {
      await globalThis.nexusStorage.forServer(snapshot.serverKey).set({ [XENO_DIG_RESULTS]: snapshot });
    } catch (error) {
      console.error('[NexusOverseer] Confirmed dig comparison could not be saved:', error);
      warnings.push(`comparison state: ${error.message}`);
    }
    if (warnings.length && generation === xnGeneration) {
      setStatusText(status, `Dig fleet sent, but data could not be saved (${warnings.join('; ')}). Do not resend.`, 'error');
    }
    void refreshXenoOverview();
    void refreshMissions();
  } catch (error) {
    if (generation === xnGeneration) {
      const suffix = dispatchStarted && !String(error.message).includes('Check the game')
        ? ' Check the game for an active mission before trying again.' : '';
      setStatusText(status, `Dig launch failed: ${error.message}${suffix}`, 'error');
    }
  } finally {
    digLaunchRunning = false;
    if (generation === xnGeneration) {
      compareButton.disabled = false;
      renderDigComparison(snapshot);
    }
  }
}

async function loadSavedDigComparison() {
  const generation = xnGeneration;
  try {
    const saved = await browser.storage.local.get(XENO_DIG_RESULTS);
    if (generation === xnGeneration) renderDigComparison(saved[XENO_DIG_RESULTS], true);
  } catch (error) {
    if (generation === xnGeneration) {
      setStatusText(document.getElementById('xn-dig-status'), `Could not load saved comparison: ${error.message}`, 'error');
    }
  }
}

async function compareDigFleets() {
  if (digComparisonRunning || digLaunchRunning) return;
  const status = document.getElementById('xn-dig-status');
  const button = document.getElementById('xn-dig-simulate');
  if (!canCompareDigFleets()) {
    setStatusText(status, 'A located active site with no dig fleet in transit is required.', 'warning');
    return;
  }
  const chain = xnOverview?.chain;
  const entries = xenoEntrances(chain);
  const selected = document.getElementById('xn-dig-entrance').value;
  const chosen = selected === 'all' ? entries : entries.filter(entry => entry.id === selected);
  const planet = xnPlanets.find(item => String(item.id) === document.getElementById('xn-planet').value);
  const useLeadership = document.getElementById('xn-dig-leadership').value === 'yes';
  const mode = document.getElementById('xn-dig-mode').value;
  const templateId = document.getElementById('xn-dig-template').value;
  const template = templateId ? xnTemplates.find(item => String(item.id) === templateId) : null;
  const zone = xnOverview?.config?.zones?.[chain?.zone];
  if (!chain?.site || !chosen.length || !planet) {
    setStatusText(status, 'A located site, available entrance and source planet are required.', 'warning');
    return;
  }
  if (templateId && !template) {
    setStatusText(status, 'The selected fleet template is unavailable.', 'error');
    return;
  }
  const generation = xnGeneration;
  const chainSnapshot = JSON.stringify({ id: chain.id, site: chain.site, entries, zone });
  const current = () => generation === xnGeneration && canCompareDigFleets() && chainSnapshot === JSON.stringify({
    id: xnOverview?.chain?.id, site: xnOverview?.chain?.site,
    entries: xenoEntrances(xnOverview?.chain), zone: xnOverview?.config?.zones?.[xnOverview?.chain?.zone],
  });
  digComparisonRunning = true;
  button.disabled = true;
  setStatusText(status, 'Loading fleet and simulator data…');
  try {
    const server = await globalThis.nexusStorage?.getSelectedServer?.();
    const storage = server?.key && globalThis.nexusStorage?.forServer
      ? globalThis.nexusStorage.forServer(server.key) : browser.storage.local;
    const [available, boot, leadership] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId: planet.id }),
      browser.runtime.sendMessage({ type: 'SIM_BOOTSTRAP' }),
      useLeadership ? browser.runtime.sendMessage({ type: 'GET_XENO_LEADERSHIP' }) : Promise.resolve(null),
    ]);
    if (!current()) throw new Error('The active campaign changed; start a new comparison.');
    if (!available || available.error) throw new Error(available?.error || 'Fleet inventory unavailable.');
    if (!boot || boot.error) throw new Error(boot?.error || 'Simulator data unavailable.');
    if (!Array.isArray(boot.playerShips) || !Array.isArray(boot.npcShips) || !available.available) {
      throw new Error('The fleet or simulator response is incomplete.');
    }
    let leadershipMass = 0;
    if (useLeadership) {
      if (!leadership || leadership.error) throw new Error(leadership?.error || 'Leadership data unavailable.');
      if (leadership.vessel?.status !== 'ready' || leadership.vessel.currentPlanetId !== planet.id) {
        throw new Error('The leadership vessel is not ready at the selected source planet.');
      }
      leadershipMass = leadership.combatStats?.maxHull;
      if (!Number.isFinite(leadershipMass) || leadershipMass <= 0
        || leadership.combatStats.currentHull !== leadershipMass) {
        throw new Error('Leadership mass is unknown or the vessel is damaged; verify it in the game.');
      }
    }
    const candidates = template
      ? [xenoTemplateCandidate(boot.playerShips, available.available, zone, leadershipMass, template)]
      : xenoCandidates(boot.playerShips, available.available, zone, leadershipMass);
    const excavator = boot.playerShips.find(ship => ship.key === 'excavator');
    const plans = chosen.flatMap(entrance => {
      const defender = xenoDefender(entrance, boot.npcShips);
      return candidates.map(candidate => ({ entrance, defender, candidate }));
    });
    const snapshot = {
      at: Date.now(), chainId: chain.id, planet: planet.name, planetId: planet.id,
      siteMoonId: chain.site.moonId, siteName: [chain.site.moonName, chain.site.systemName].filter(Boolean).join(' · '),
      serverKey: server?.key, zone: chain.zone, massLimit: zone.massLimit, leadership: useLeadership, mode,
      leadershipFingerprint: useLeadership ? xenoLeadershipFingerprint(leadership) : null, results: [],
    };
    for (const [index, plan] of plans.entries()) {
      if (!current()) throw new Error('The active campaign changed; start a new comparison.');
      setStatusText(status, `Simulating ${index + 1} / ${plans.length}: ${plan.entrance.label} · ${plan.candidate.label}`);
      const response = await browser.runtime.sendMessage({
        type: 'SIM_JOB',
        attacker: { type: 'player', fleet: plan.candidate.fleet, useOwnBonuses: true,
          attachLeadership: useLeadership, hangarAssignments: {} },
        defender: plan.defender,
      });
      if (!current()) throw new Error('The active campaign changed; start a new comparison.');
      if (!response?.ok) throw new Error(response?.error || 'Combat simulation failed.');
      snapshot.results.push({
        entrance: plan.entrance.label, entranceId: plan.entrance.id,
        garrison: plan.entrance.garrison, candidate: plan.candidate,
        result: xenoSimulationResult(response.data, excavator.id, zone.excavators),
      });
      renderDigComparison(snapshot);
    }
    snapshot.complete = true;
    await storage.set({ [XENO_DIG_RESULTS]: snapshot });
    renderDigComparison(snapshot);
    setStatusText(status, 'Comparison saved. Check the fleet and mass in the game before sending.');
  } catch (error) {
    if (generation === xnGeneration) setStatusText(status, `Comparison failed: ${error.message}`, 'error');
  } finally {
    if (generation === xnGeneration) {
      digComparisonRunning = false;
      button.disabled = false;
    }
  }
}

function xenoReportLoot(loot) {
  if (!loot || typeof loot !== 'object') return 'unavailable';
  const resources = Object.entries(loot.resources || {})
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .map(([key, amount]) => `${fmt(amount)} ${key.replace(/_/g, ' ')}`);
  if (Number.isFinite(loot.fragments) && loot.fragments > 0) resources.push(`${fmt(loot.fragments)} fragments`);
  if (loot.artifactTier) resources.push(`Artifact: ${loot.artifactTier}`);
  return resources.join(', ') || 'none reported';
}

function xenoSummaryItem(label, value) {
  const item = document.createElement('span');
  item.className = 'xeno-summary-item';
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('strong');
  amount.textContent = value;
  item.append(name, amount);
  return item;
}

function renderCampaignAndAccount(statsEl, campaignStatsEl, codexEl, reportsEl, clueProgress, chain) {
  campaignStatsEl.replaceChildren();
  if (chain) {
    const state = listBadge(xenoCampaignStatusLabel());
    state.setAttribute('id', 'xn-campaign-state');
    campaignStatsEl.append(
      xenoSummaryItem('Archive clues', clueProgress ?? 'Unknown'),
      xenoTraceBadge(chain.trace), zoneBadge(chain.zone),
      state,
    );
    const expiry = listBadge(chain.paused ? 'Paused' : 'Expiry unavailable', chain.paused ? 'badge-warning' : '');
    const expires = Date.parse(chain.expiresAt);
    if (!chain.paused && Number.isFinite(expires)) {
      expiry.title = `Expires ${new Date(expires).toLocaleString()}`;
      xnCampaignTick = () => {
        const remaining = expires - Date.now();
        expiry.textContent = remaining > 0 ? `Expires in ${fmtCountdown(remaining)}` : 'Expired';
        expiry.className = remaining > 0 ? 'badge' : 'badge badge-warning';
        if (remaining <= 0) updateDigComparisonVisibility();
      };
      xnCampaignTick();
    }
    campaignStatsEl.appendChild(expiry);
  }

  const accountStats = xnOverview.stats || {};
  const count = value => Number.isInteger(value) && value >= 0 ? fmt(value) : 'Unknown';
  statsEl.replaceChildren(
    xenoSummaryItem('Research', xnOverview.hasResearch === true ? 'Unlocked' : xnOverview.hasResearch === false ? 'Not researched' : 'Unknown'),
    xenoSummaryItem('Successful digs', `${count(accountStats.successfulDigs)} / ${count(accountStats.totalDigs)}`),
  );
  const accountDetails = document.getElementById('xn-account-details');
  if (accountDetails) accountDetails.hidden = false;
  codexEl.replaceChildren();
  for (const [key, label] of CODEX_SETS) {
    const entries = xnOverview.codex?.[key];
    const known = Array.isArray(entries) && entries.every(entry => Number.isInteger(entry) && entry >= 1 && entry <= CODEX_ENTRIES.length);
    const unlocked = new Set(known ? entries : []);
    const card = document.createElement('section');
    card.className = 'xeno-codex-set';
    const heading = document.createElement('div');
    heading.className = 'xeno-section-heading';
    const name = document.createElement('strong');
    name.textContent = label;
    heading.append(name, listBadge(known ? `${unlocked.size} / ${CODEX_ENTRIES.length}` : 'Unknown'));
    const slots = document.createElement('div');
    slots.className = 'xeno-codex-entries';
    for (const [index, numeral] of CODEX_ENTRIES.entries()) {
      const found = unlocked.has(index + 1);
      const slot = listBadge(numeral, found ? 'badge-success' : '');
      slot.title = `${label} ${numeral}: ${!known ? 'unavailable' : found ? 'unlocked' : 'not found'}`;
      slot.setAttribute('aria-label', slot.title);
      slots.appendChild(slot);
    }
    card.append(heading, slots);
    codexEl.appendChild(card);
  }

  const monumentsEl = document.getElementById('xn-overview-monuments');
  const monumentCount = document.getElementById('xn-monument-count');
  const monuments = Array.isArray(xnOverview.monuments) ? xnOverview.monuments : null;
  if (monumentCount) monumentCount.textContent = monuments?.every(item => typeof item?.key === 'string' && item.key)
    ? `${fmt(new Set(monuments.map(item => item.key)).size)} / 12` : 'Unknown';
  if (monumentsEl) {
    monumentsEl.replaceChildren();
    if (!monuments?.length) {
      const empty = document.createElement('p');
      empty.textContent = monuments ? 'No monuments reported.' : 'Monument inventory unavailable.';
      monumentsEl.appendChild(empty);
    }
    for (const item of monuments || []) {
      const card = document.createElement('div');
      card.className = 'xeno-monument';
      const name = document.createElement('strong');
      name.textContent = formatXenoName(item?.key) || 'Unknown monument';
      const copies = listBadge(`${count(item?.copies)} ${item?.copies === 1 ? 'copy' : 'copies'}`);
      card.append(name, copies);
      if (item?.untouched === true) card.appendChild(listBadge('Untouched'));
      monumentsEl.appendChild(card);
    }
  }

  reportsEl.replaceChildren();
  const reports = (Array.isArray(xnOverview.reports) ? xnOverview.reports : [])
    .slice()
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, 5);
  if (!reports.length) {
    const empty = document.createElement('p');
    empty.className = 'mission-empty-state';
    empty.textContent = 'No dig reports recorded.';
    reportsEl.appendChild(empty);
    return;
  }
  for (const item of reports) {
    const row = document.createElement('article');
    row.className = 'xeno-dig-report';
    const header = document.createElement('div');
    header.className = 'xeno-dig-report-header';
    const title = document.createElement('strong');
    title.textContent = [item.report?.moonName, item.report?.systemName].filter(Boolean).join(' · ') || 'Site unavailable';
    const date = document.createElement('time');
    const at = Date.parse(item.createdAt);
    date.textContent = Number.isFinite(at) ? new Date(at).toLocaleString() : 'Date unavailable';
    if (Number.isFinite(at)) date.dateTime = item.createdAt;
    header.append(title, listBadge(formatBadgeLabel(item.outcome),
      item.outcome === 'success' ? 'badge-success' : item.outcome === 'collapse' ? 'badge-warning' : ''), date);
    const meta = document.createElement('div');
    meta.className = 'xeno-dig-report-meta';
    meta.append(zoneBadge(item.zone), listBadge(formatBadgeLabel(item.mode)));
    for (const [label, trace] of [['Channel', item.trace], ['Entrance', item.entranceTrace]]) {
      const tag = document.createElement('span');
      tag.className = 'xeno-report-tag';
      tag.append(`${label}: `, xenoTraceBadge(trace));
      meta.appendChild(tag);
    }
    const delivered = document.createElement('p');
    delivered.textContent = `Delivered: ${xenoReportLoot(item.report?.delivered)}`;
    row.append(header, meta, delivered);

    const reward = item.report?.monument;
    const codex = item.report?.codex;
    if (reward?.key || codex?.set) {
      const rewards = document.createElement('p');
      rewards.textContent = [
        reward?.key ? `Monument: ${formatXenoName(reward.key)} · copies: ${count(reward.copies)}` : null,
        codex?.set ? `Codex: ${formatXenoName(codex.set)} ${CODEX_ENTRIES[codex.entry - 1] ?? count(codex.entry)}` : null,
      ].filter(Boolean).join(' · ');
      row.appendChild(rewards);
    }
    const details = document.createElement('details');
    details.className = 'xeno-dig-report-details';
    const key = item.id ?? item.missionId ?? item.createdAt;
    details.open = key != null && expandedDigReports.has(key);
    details.addEventListener('toggle', () => {
      if (key == null) return;
      if (details.open) expandedDigReports.add(key);
      else expandedDigReports.delete(key);
    });
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    details.appendChild(summary);

    const detailCount = value => Number.isInteger(value) && value >= 0 ? fmt(value) : 'unknown';
    const excavators = document.createElement('p');
    excavators.textContent = `Excavators: ${detailCount(item.excavatorsSent)} sent · ${detailCount(item.excavatorsLost)} lost`;
    details.appendChild(excavators);

    const losses = document.createElement('p');
    if (Array.isArray(item.report?.shipsLost)) {
      losses.textContent = item.report.shipsLost.length
        ? `Ship losses: ${item.report.shipsLost.map(ship =>
          `${ship?.name || formatXenoName(ship?.key) || 'Unknown ship'}: ${detailCount(ship?.destroyed)} destroyed, ${detailCount(ship?.damaged)} damaged`).join('; ')}`
        : 'Ship losses: none reported';
    } else {
      losses.textContent = 'Ship losses: unavailable';
    }
    details.appendChild(losses);

    const overflow = document.createElement('p');
    overflow.textContent = `Overflow: ${xenoReportLoot(item.report?.overflow)}`;
    details.appendChild(overflow);
    const monument = document.createElement('p');
    monument.textContent = reward?.key
      ? `Monument: ${formatXenoName(reward.key)} · copies: ${detailCount(reward.copies)}`
      : reward === null ? 'Monument: none reported' : 'Monument: unavailable';
    details.appendChild(monument);
    const codexLine = document.createElement('p');
    codexLine.textContent = codex?.set ? `Codex: ${formatXenoName(codex.set)} ${CODEX_ENTRIES[codex.entry - 1] ?? detailCount(codex.entry)}`
      : codex === null ? 'Codex: none reported' : 'Codex: unavailable';
    details.appendChild(codexLine);
    const location = document.createElement('p');
    location.textContent = `Site: ${[item.report?.moonName, item.report?.systemName].filter(Boolean).join(' · ') || 'unavailable'}`;
    details.appendChild(location);
    const battle = document.createElement('p');
    battle.textContent = `Battle report: ${Number.isSafeInteger(item.battleReportId) ? `#${item.battleReportId}` : 'unavailable'} · Rounds: ${detailCount(item.report?.rounds)}`;
    details.appendChild(battle);
    const simulation = xnDigMissions[item.missionId]?.simulation;
    const comparison = document.createElement('p');
    if (simulation) {
      const actualLosses = item.report?.shipsLost;
      const total = key => Array.isArray(actualLosses) && actualLosses.every(ship => Number.isInteger(ship?.[key]) && ship[key] >= 0)
        ? actualLosses.reduce((sum, ship) => sum + ship[key], 0) : null;
      const surviving = Number.isInteger(item.excavatorsSent) && Number.isInteger(item.excavatorsLost)
        && item.excavatorsSent >= item.excavatorsLost && item.excavatorsLost >= 0
        ? item.excavatorsSent - item.excavatorsLost : null;
      comparison.textContent = `Simulated combat: ${formatXenoName(simulation.result.outcome)} · Actual dig: ${formatXenoName(item.outcome) || 'unknown'}. `
        + 'Simulation / actual: '
        + `excavators survived ${detailCount(simulation.result.excavators)} / ${detailCount(surviving)}; `
        + `destroyed ${detailCount(simulation.result.destroyed)} / ${detailCount(total('destroyed'))}; `
        + `damaged ${detailCount(simulation.result.damaged)} / ${detailCount(total('damaged'))}. Collapse is not simulated.`;
    } else {
      comparison.textContent = 'No simulation archived for this mission.';
    }
    details.appendChild(comparison);
    row.appendChild(details);
    reportsEl.appendChild(row);
  }
}

function refreshXenoOverview() {
  if (xnOverviewRequest) return xnOverviewRequest;
  xnOverviewNeedsRefresh = true;
  const request = loadXenoOverview(() => xnOverviewRequest === request);
  xnOverviewRequest = request;
  void request.finally(() => {
    if (xnOverviewRequest === request) xnOverviewRequest = null;
  }).catch(error => console.error('[NexusOverseer] Xeno overview refresh failed:', error));
  return request;
}

async function loadXenoOverview(isCurrent) {
  const status = document.getElementById('xn-overview-status');
  if (!status) return false;
  const missions = xnMissions;
  status.textContent = 'Loading Xeno account…';
  let response;
  try {
    const [overview, saved] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_XENO_OVERVIEW', source: 'xeno' }),
      browser.storage.local.get('xeno_dig_missions'),
    ]);
    response = overview;
    if (isCurrent()) xnDigMissions = saved.xeno_dig_missions || {};
  } catch (error) {
    if (!isCurrent()) return false;
    setStatusText(status, `Could not load Xeno account: ${error.message}`, 'error');
    return false;
  }
  if (!isCurrent()) return false;
  if (!response || response.error) {
    setStatusText(status, `Could not load Xeno account: ${response?.error || 'No response.'}`, 'error');
    return false;
  }
  xnOverview = response;
  if (pendingDigLaunch && (response.chain?.id !== pendingDigLaunch.chainId
    || Array.isArray(response.reports) && response.reports.some(report => report.missionId === pendingDigLaunch.missionId))) {
    pendingDigLaunch = null;
  }
  xnOverviewMissions = missions;
  xnOverviewNeedsRefresh = false;
  renderXenoOverview();
  status.textContent = '';
  return true;
}

// ── Historical stats/charts/table (mirrors tabs/expeditions.js) ────────────
export let chartXeno, chartXenoComp;
export let xnReportPage = 1;

export function xnRecordsForMode(mode) {
  const filtered = filterZone(store.xeno_history?.length ? store.xeno_history : (store.xeno_recent_reports || []));
  if (mode === 'all' && !windowActive()) return filtered;
  return inWindowRange(filtered);
}

export function getXnTotalsForMode(mode) {
  return xenoTotals(xnRecordsForMode(mode));
}

export function getXnSeriesForMode(mode) {
  const getters = { missions: () => 1 };
  for (const d of XENO_LOOT_SERIES) getters[d.field] = r => (r.loot && r.loot[d.field]) || 0;
  return computeSeries(xnRecordsForMode(mode), mode, getters);
}

function renderXnLootCards(containerId, totals, suffix) {
  const el = document.getElementById(containerId);
  el.textContent = '';
  for (const resource of XENO_LOOT_SERIES) {
    const cls = ['silicates', 'alloys'].includes(resource.field) ? resource.field : 'rare';
    el.appendChild(makeStatCard(`${resource.label}${suffix}`, fmt(resourceVal(totals, resource.field)), cls));
  }
}

export function renderXenoStatsTab() {
  const mode = getMode();
  const periodLabel = periodLabelFor(mode);
  const t = getXnTotalsForMode(mode);
  const el = document.getElementById('xn-stats-collected');
  if (!el) return;   // dashboard.html not loaded yet on first call
  el.textContent = '';
  if (!t.missions) {
    const p = document.createElement('p');
    p.className = 'mission-empty-state';
    p.textContent = 'No Xeno reports recorded yet. Open the Xeno overview or run a scrape to import available dig reports.';
    el.appendChild(p);
  } else {
    renderXnLootCards('xn-stats-collected', t, periodLabel);
  }

  const results = document.getElementById('xn-stats-results');
  results.textContent = '';
  results.append(
    makeStatCard(`Digs${periodLabel}`, fmt(t.digs), 'missions'),
    makeStatCard(`Successful digs${periodLabel}`, fmt(t.successful_digs), 'missions'),
    makeStatCard(`Other outcomes${periodLabel}`, fmt(t.digs - t.successful_digs), ''),
    makeStatCard(`Careful / Fast${periodLabel}`, `${fmt(t.careful)} / ${fmt(t.fast)}`, ''),
    makeStatCard(`Excavators sent / lost${periodLabel}`, `${fmt(t.excavators_sent)} / ${fmt(t.excavators_lost)}`, ''),
    makeStatCard(`Ships destroyed / damaged${periodLabel}`, `${fmt(t.ships_lost)} / ${fmt(t.ships_damaged)}`, ''),
    makeStatCard(`Battle rounds${periodLabel}`, fmt(t.rounds), ''),
    makeStatCard(`Fuel spent${periodLabel}`, fmt(fuelForMode('xeno', windowActive() ? 'daily' : mode)), 'hydrogen'),
  );
  if (t.missions !== t.digs) results.appendChild(makeStatCard('Legacy surveys', fmt(t.missions - t.digs), ''));
  if (t.incomplete_reports) results.appendChild(makeStatCard('Reports with unavailable details (partial totals)', fmt(t.incomplete_reports), ''));
  const knownShipKeys = new Set(Object.values(store.ships || {}).map(ship => ship.key).filter(Boolean));
  const unvalued = xnRecordsForMode(mode).some(record =>
    [...(record.ships_destroyed_raw || []), ...(record.ships_damaged_raw || [])].some(ship =>
      !store.ships?.[ship.shipDefId] && !knownShipKeys.has(ship.key)));
  if (unvalued) results.appendChild(makeStatCard('Ship-cost valuation', 'Incomplete: sync ship catalog', ''));
  const rewards = document.getElementById('xn-stats-rewards');
  rewards.textContent = '';
  for (const [tier, amount] of Object.entries(t.artifact_tiers)) {
    rewards.appendChild(makeStatCard(`${formatBadgeLabel(tier)} artifacts${periodLabel}`, fmt(amount), 'rare'));
  }
  for (const [key, copies] of Object.entries(t.monuments)) {
    rewards.appendChild(makeStatCard(`${formatBadgeLabel(key)}${periodLabel}`, fmt(copies), 'rare'));
  }
  rewards.appendChild(makeStatCard(`Codex entries awarded${periodLabel}`, fmt(t.codex_entries), 'rare'));
  renderXnLootCards('xn-stats-overflow', t.overflow, periodLabel);
  const lost = computeRawLossCost(xnRecordsForMode(mode), store.ships || {});
  const repair = computeRawLossCost(xnRecordsForMode(mode), store.ships || {}, 'ships_damaged_raw', 0.5);
  fillResourceCards('xn-stats-lost', lost, '');
  fillResourceCards('xn-stats-repair', repair, '');

  if (chartXeno) chartXeno.destroy();
  chartXeno = makeResourceLineChart('chart-xeno', getXnSeriesForMode(mode),
    getLabelKey(mode), { field: 'missions', label: 'Reports' }, XENO_LOOT_SERIES);

  if (chartXenoComp) chartXenoComp.destroy();
  chartXenoComp = makeResourceDoughnut('chart-xeno-comp', {
    silicates: t.silicates, alloys: t.alloys,
    rare: { precursor_fragments: resourceVal(t, 'precursor_fragments'), artifact: resourceVal(t, 'artifact') },
  });

  renderXnReportTable();
}

export const xnReportSort = { key: 'created_at', dir: -1 };
attachSortable('xn-reports-head', xnReportSort, () => { xnReportPage = 1; renderXnReportTable(); });

export function renderXnReportTable() {
  const resourceKeys = XENO_LOOT_SERIES.map(resource => resource.field);
  const rows = xnRecordsForMode(getMode()).map(record => {
    const row = { ...record };
    for (const key of resourceKeys) row[key] = record.loot?.[key] || 0;
    const result = record.report?.report;
    row.monument_copies = result?.monument === null ? 0 : result?.monument?.copies ?? null;
    row.codex_count = result?.codex === null ? 0 : result?.codex ? 1 : null;
    const excavatorsInLosses = (record.ships_destroyed_raw || [])
      .filter(ship => (ship.key || store.ships?.[ship.shipDefId]?.key) === 'excavator')
      .reduce((sum, ship) => sum + (ship.quantity ?? ship.lost ?? 0), 0);
    row.total_losses = record.ships_lost == null || record.kind === 'dig' && record.excavators_lost == null
      ? null : record.ships_lost + Math.max(0, (record.excavators_lost || 0) - excavatorsInLosses);
    return row;
  });
  const reports = applySort('xn-reports-head', rows, xnReportSort);
  xnReportPage = renderPagedTable(reports, xnReportPage, 'xn-report-page-info', 'xn-report-btn-prev', 'xn-report-btn-next', 'xn-reports-tbody', r => {
    const tr = document.createElement('tr');
    const text = value => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
      return td;
    };
    const badgeCell = badge => {
      const td = document.createElement('td');
      td.appendChild(badge);
      tr.appendChild(td);
    };
    text(new Date(r.created_at).toLocaleString());
    text(r.location || 'Unknown');
    tr.appendChild(zoneCell(r.zone));
    badgeCell(xenoTraceBadge(r.trace));
    badgeCell(xenoTraceBadge(r.entrance));
    badgeCell(listBadge(r.kind === 'dig' ? formatBadgeLabel(r.mode) : 'Legacy survey'));
    badgeCell(listBadge(formatBadgeLabel(r.event),
      r.event === 'success' ? 'badge-success' : r.event === 'collapse' ? 'badge-warning' : ''));
    for (const key of resourceKeys) {
      const td = zeroCell(r[key]);
      td.className = ['silicates', 'alloys'].includes(key) ? key : 'rare';
      if (key === 'artifact' && r.artifact_tier) td.title = formatBadgeLabel(r.artifact_tier);
      tr.appendChild(td);
    }
    const monument = r.report?.report?.monument;
    const codex = r.report?.report?.codex;
    for (const [value, title] of [
      [r.monument_copies, monument?.key ? formatBadgeLabel(monument.key) : ''],
      [r.codex_count, codex ? `${formatBadgeLabel(codex.set)} / ${codex.entry}` : ''],
    ]) {
      const td = value == null ? document.createElement('td') : zeroCell(value);
      if (value == null) td.textContent = 'Unknown';
      td.className = 'rare';
      if (title) td.title = title;
      tr.appendChild(td);
    }
    if (r.total_losses == null) text('Unknown');
    else tr.appendChild(zeroCell(r.total_losses));
    return tr;
  });
}

document.getElementById('xn-report-btn-prev').addEventListener('click', () => { xnReportPage--; renderXnReportTable(); });
document.getElementById('xn-report-btn-next').addEventListener('click', () => { xnReportPage++; renderXnReportTable(); });

export function setXnReportPage(n) { xnReportPage = n; }

export async function initXenoTab() {
  if (inited) return;
  inited = true;
  updateSurveyLaunchState();
  const status = document.getElementById('xn-progress');
  setStatusText(status, 'Loading…');

  const planets = await browser.runtime.sendMessage({ type: 'GET_PLANETS' });
  if (planets.error) { setStatusText(status, `Error: ${planets.error}`); inited = false; return; }
  xnPlanets = (planets.planets || []).filter(p => p.systemId != null);

  const pSel = document.getElementById('xn-planet');
  pSel.textContent = '';
  for (const p of xnPlanets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.systemName ? `${p.name} (${p.systemName})` : p.name;
    if (p.isHomeworld) o.selected = true;
    pSel.appendChild(o);
  }
  const saved = await rememberedSelections();
  if (saved['xn-planet'] && xnPlanets.some(p => String(p.id) === saved['xn-planet'])) {
    pSel.value = saved['xn-planet'];
  }
  for (const key of Object.keys(firstArchiveSelection)) {
    const id = `xn-${key}`;
    const select = document.getElementById(id);
    firstArchiveSelection[key] = Array.from(select.options).some(option => option.value === saved[id]) ? saved[id] : '';
    select.onchange = () => {
      firstArchiveSelection[key] = select.value;
      void rememberSelection(id, select.value);
    };
  }

  await refreshTemplates();
  if (!digComparisonBound) {
    document.getElementById('xn-dig-simulate').addEventListener('click', compareDigFleets);
    digComparisonBound = true;
  }
  await loadSavedDigComparison();
  browser.storage.local.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fleet_templates) refreshTemplates();
    if (area === 'local' && changes.nexus_active_server) {
      resetXenoTab();
      void initXenoTab();
    }
  });

  document.getElementById('xn-planet').addEventListener('change', e => {
    rememberSelection('xn-planet', e.target.value);
    updateAvail();
  });
  document.getElementById('xn-template').addEventListener('change', e => rememberSelection('xn-template', e.target.value));
  document.getElementById('xn-scan').addEventListener('click', launchRuinsSurvey);

  const refreshMissionsIfDue = createMissionRefresh(refreshMissions);
  xnTabWasVisible = document.getElementById('xeno-content').style.display !== 'none';
  xnMissionTimer = setInterval(() => {
    if (document.getElementById('xeno-content').style.display === 'none') {
      xnTabWasVisible = false;
      return;
    }
    if (!xnTabWasVisible) xnOverviewNeedsRefresh = true;
    xnTabWasVisible = true;
    for (const upd of xnTicks) upd();
    xnCampaignTick?.();
    refreshMissionsIfDue(xnMissions);
  }, 1000);

  setStatusText(status, '');
  updateAvail();
  void refreshMissions();
}

async function refreshTemplates() {
  xnTemplates = await loadFleetTemplates();
  xnTemplates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const digSelect = document.getElementById('xn-dig-template');
  const digValue = digSelect.value;
  digSelect.replaceChildren(new Option('Automatic escort comparison', ''));
  for (const template of xnTemplates) digSelect.add(new Option(template.name, String(template.id)));
  digSelect.value = xnTemplates.some(template => String(template.id) === digValue) ? digValue : '';
  const sel = document.getElementById('xn-template');
  const saved = await rememberedSelections();
  const want = saved['xn-template'] || sel.value;
  sel.textContent = '';
  if (!xnTemplates.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— none (create in Fleet Templates) —';
    sel.appendChild(o);
  } else {
    for (const t of xnTemplates) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      sel.appendChild(o);
    }
    if (want && xnTemplates.some(t => String(t.id) === want)) sel.value = want;
  }
}

async function templateShips(templateId, planetId) {
  const tpl = xnTemplates.find(t => String(t.id) === templateId);
  if (!tpl) return { error: 'No fleet template selected — create one in Fleet Templates.' };
  const wanted = Object.entries(tpl.ships || {})
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }));
  if (wanted.some(ship => !Number.isSafeInteger(ship.quantity) || ship.quantity < 0)) {
    return { error: `Template "${tpl.name}" contains invalid ship quantities.` };
  }
  const ships = wanted.filter(ship => ship.quantity > 0);
  const fleetError = xenoSurveyFleetError(ships);
  if (fleetError) return { error: `Template "${tpl.name}": ${fleetError}` };

  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  const shipError = xenoSurveyFleetError(ships, av ?? null);
  if (shipError) return { error: `Template "${tpl.name}": ${shipError}` };
  return { ships, name: tpl.name };
}

async function updateAvail() {
  const box = document.getElementById('xn-avail');
  const planetId = Number(document.getElementById('xn-planet').value);
  if (!planetId) { clearAvailStrip(box); return; }
  const [av, defs] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId }),
    browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' }),
  ]);
  if (av.error) { clearAvailStrip(box, av.error); return; }
  renderAvailStrip(box, defs.ships || [], av.available, 'No ships on this planet.');
}

async function loadMap() {
  if (xnMap) return xnMap;
  const res = await browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' });
  if (res.error) throw new Error(res.error);
  const systems = res.systems || [];
  const byId = {};
  for (const s of systems) byId[s.id] = s;
  xnMap = { systems, byId };
  return xnMap;
}

async function refreshMissions() {
  const generation = xnGeneration;
  try {
    const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
    if (generation !== xnGeneration) return;
    if (!hasClassifiedMissions(mi)) throw new Error(mi?.error || 'Invalid mission response.');
    applyMissionSnapshot(mi);
  } catch (error) {
    if (generation !== xnGeneration) return;
    xnMissionsLoaded = false;
    updateSurveyLaunchState();
    updateDigComparisonVisibility();
    console.error('[NexusOverseer] Ruins mission refresh failed:', error);
  }
  if (generation !== xnGeneration) return;
  if (xnOverviewNeedsRefresh || !xnOverviewMissions || xenoMissionStatusesChanged(xnOverviewMissions, xnMissions)) {
    await refreshXenoOverview();
  }
}

function applyMissionSnapshot(mi) {
  if (mi.maxFleetSlots != null) {
    document.getElementById('xn-slots').textContent = `${usedFleetSlots(mi.missions)}/${mi.maxFleetSlots} fleet slots`;
  }
  xnMissions = (mi.missions || []).filter(isXenoTransitMission);
  xnMissionsLoaded = true;
  updateSurveyLaunchState();
  if (pendingDigLaunch && xnMissions.some(mission => mission.id === pendingDigLaunch.missionId)) {
    pendingDigLaunch = null;
  }
  updateCampaignSelection();
  updateDigComparisonVisibility();
  renderTransit();
  void loadTransitMoonDetails(xnMissions);
}

async function loadTransitMoonDetails(missions) {
  const pending = missions.filter(m => m.missionType === 'xeno_survey').filter(m => {
    const moonId = xenoMissionTargetMoonId(m);
    return moonId != null && !xnMoonDetails.has(String(moonId)) && !xnMoonDetailsLoading.has(String(moonId));
  });
  if (!pending.length) return;
  for (const mission of pending) xnMoonDetailsLoading.add(String(xenoMissionTargetMoonId(mission)));

  let cache;
  try {
    cache = await loadGalaxyScans();
  } catch (error) {
    for (const mission of pending) {
      const moonId = String(xenoMissionTargetMoonId(mission));
      xnMoonDetailsLoading.delete(moonId);
      xnMoonDetails.set(moonId, { error: error.message });
    }
    updateCampaignSelection();
    renderTransit();
    return;
  }

  await Promise.all(pending.map(async mission => {
    const moonId = xenoMissionTargetMoonId(mission);
    const key = String(moonId);
    try {
      if (mission.targetSystemId == null) throw new Error('Target system is missing from the mission.');
      const [details, system] = await Promise.all([
        browser.runtime.sendMessage({ type: 'GET_XENO_MOON', moonId }),
        getSystemPlanets(mission.targetSystemId, cache, {
          group: 'moons', maxAge: XENO_CACHE_TTL, source: 'xeno-transit',
        }),
      ]);
      if (!details || details.error) throw new Error(details?.error || 'No Xeno moon detail response.');
      const moon = (system.moons || []).find(item => String(item.id) === key);
      if (!moon?.name) throw new Error('Moon name is missing from the galaxy scan.');
      if (!details.trace) throw new Error('Xeno trace is missing from the moon detail response.');
      xnMoonDetails.set(key, { name: moon.name, trace: details.trace, zone: details.zone });
    } catch (error) {
      console.warn(`[NexusOverseer] Xeno transit details failed for moon ${moonId}:`, error);
      xnMoonDetails.set(key, { error: error.message });
    } finally {
      xnMoonDetailsLoading.delete(key);
    }
  }));
  updateCampaignSelection();
  renderTransit();
}

function renderTransit() {
  const box = document.getElementById('xn-transit-list');
  box.textContent = '';
  xnTicks = [];
  document.getElementById('xn-transit-count').textContent = `${xnMissions.length} in flight`;
  if (!xnMissions.length) {
    const d = document.createElement('div');
    d.className = 'mission-empty-state';
    d.textContent = 'No Xeno fleets in transit.';
    box.appendChild(d);
    return;
  }
  for (const m of xnMissions) {
    const target = m.targetSystemName || `#${m.targetSystemId ?? m.id}`;
    const source = m.sourcePlanetName || m.sourceSystemName;
    const titleText = source ? `${source} → ${target}` : target;
    const ships = (m.fleetComposition || []).reduce((n, ship) => n + (ship.quantity || 0), 0);
    const moonId = xenoMissionTargetMoonId(m);
    const moonInfo = moonId == null ? null : xnMoonDetails.get(String(moonId));
    const entranceTrace = m.cargo?._xenoDig?.entranceTrace;
    const moonText = moonInfo?.name
      ? moonInfo.name
      : moonId != null ? (moonInfo?.error ? 'Moon details unavailable' : 'Loading moon details…') : null;
    const details = [
      m.missionType === 'xeno_dig'
        ? `Dig · Entrance: ${entranceTrace ? formatXenoName(entranceTrace) : 'unknown'}`
        : moonText,
      ships ? `${fmt(ships)} ships` : null,
    ].filter(Boolean).join(' · ');
    const shipList = (m.fleetComposition || [])
      .map(ship => `${ship.quantity}× ${ship.shipName || ship.shipKey || ship.shipDefId}`).join('\n');
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
    title.textContent = titleText;
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
      if (m.missionType !== 'xeno_dig' && moonInfo?.name && moonInfo.trace) {
        info.append(moonInfo.name, ' · Trace:', xenoTraceBadge(moonInfo.trace));
        if (ships) info.append(` · ${fmt(ships)} ships`);
      } else {
        info.textContent = details;
      }
      info.title = [moonInfo?.error, shipList].filter(Boolean).join('\n');
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
      const progress = missionProgress(m);
      fill.style.width = `${(progress.frac * 100).toFixed(1)}%`;
      fill.style.background = progress.gradient || progress.color;
      status.textContent = progress.label;
      status.style.color = progress.color;
      eta.textContent = missionCountdown(progress);
    };
    upd();
    xnTicks.push(upd);
  }
}

// Search outwards from `src`, reusing the shared per-system cache.
async function findNearestAncientMoon(src, srcSystemId, exclusions, criteria, onProgress, generation) {
  const searching = () => xnRunning && generation === xnGeneration;
  const map = await loadMap();
  const targets = map.systems
    .filter(s => s.id !== srcSystemId && !exclusions.systemIds.has(s.id) &&
      (s.visibility === 'full' || s.visibility === 'partial'))
    .map(s => ({ s, d: Math.hypot(s.x - src.x, s.y - src.y) }))
    .sort((a, b) => a.d - b.d);

  const cache = await loadGalaxyScans();

  let scanned = 0;
  const getSectorSystems = sectorId => browser.runtime.sendMessage({
    type: 'GET_SECTOR_SYSTEMS', sectorId, priority: 'bulk', source: 'xeno-search',
  });
  for await (const { s: sys, d } of xenoSearchSystems(targets, criteria.zone, getSectorSystems, searching)) {
    if (!searching()) break;
    let data;
    try {
      data = await getSystemPlanets(sys.id, cache, { purpose: 'static', group: 'moons', source: 'xeno-search' });
    } catch (error) {
      console.warn(`[NexusOverseer] Xeno search skipped system ${sys.id}:`, error);
      scanned++; continue;
    }
    if (!searching()) break;
    const moon = await findAvailableAncientMoon(data.moons || [], exclusions.moonIds, async moonId => {
      const details = await browser.runtime.sendMessage({ type: 'GET_XENO_MOON', moonId });
      const candidate = (data.moons || []).find(item => String(item.id) === String(moonId));
      if (generation === xnGeneration && !details?.error && details?.trace) {
        xnMoonDetails.set(String(moonId), {
          ...xnMoonDetails.get(String(moonId)),
          name: candidate?.name || null, trace: details.trace, zone: details.zone,
        });
      }
      return details;
    }, searching, criteria);
    if (!searching()) break;
    scanned++;
    if (moon) return { moon, system: sys, distance: Math.round(d) };
    if (scanned % 10 === 0) onProgress(scanned);
    if (scanned % 25 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return null;
}

function updateSurveyLaunchState() {
  const btn = document.getElementById('xn-scan');
  const counter = document.getElementById('xn-survey-limit');
  const count = xenoSurveyCount(xnMissions);
  if (counter) counter.replaceChildren(listBadge(
    `Surveys: ${xnMissionsLoaded ? count : 'unknown'} / ${XENO_SURVEY_LIMIT}`,
    xnMissionsLoaded && count >= XENO_SURVEY_LIMIT ? 'badge-warning' : '',
  ));
  if (!btn) return;
  btn.disabled = !xnRunning && (xnSurveyLaunching || !xnMissionsLoaded || count >= XENO_SURVEY_LIMIT);
  btn.textContent = xnRunning ? 'Stop' : 'Launch Xeno Survey';
  btn.title = xnRunning ? 'Stop the moon search'
    : xnSurveyLaunching ? 'A survey launch is being checked or sent'
      : !xnMissionsLoaded ? 'Fleet status unavailable. Waiting for the automatic fleet check.'
        : xenoSurveyLimitError(xnMissions) || 'Launch a Xeno survey';
}

async function launchRuinsSurvey() {
  if (xnRunning) {
    xnRunning = false;
    updateSurveyLaunchState();
    return;
  }
  const status = document.getElementById('xn-progress');
  if (xnSurveyLaunching) {
    setStatusText(status, 'A survey launch is already being checked or sent.', 'warning');
    return;
  }
  const generation = xnGeneration;
  xnSurveyLaunching = true;
  setStatusText(status, 'Checking survey fleet…');
  updateSurveyLaunchState();
  try {
    await launchRuinsSurveyChecked(generation);
  } catch (error) {
    if (generation === xnGeneration) setStatusText(status, `Could not launch Xeno survey: ${error.message}`, 'error');
  } finally {
    if (generation === xnGeneration) {
      xnSurveyLaunching = false;
      updateSurveyLaunchState();
    }
  }
}

async function launchRuinsSurveyChecked(generation) {
  const status = document.getElementById('xn-progress');
  const planetId = Number(document.getElementById('xn-planet').value);
  const templateId = document.getElementById('xn-template').value;
  const planet = xnPlanets.find(p => p.id === planetId);
  if (!planet) {
    setStatusText(status, 'Select a source planet before launching a survey.', 'warning');
    return;
  }
  const server = await (globalThis.nexusStorage?.getSelectedServer?.()
    ?? globalThis.nexusStorage?.getActiveServer?.());
  if (generation !== xnGeneration) return;
  if (!server?.key) throw new Error('The selected server could not be verified.');

  let mi;
  try {
    mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
    if (generation !== xnGeneration) return;
    if (!hasClassifiedMissions(mi)) throw new Error(mi?.error || 'Invalid mission response.');
  } catch (error) {
    if (generation !== xnGeneration) return;
    xnMissionsLoaded = false;
    updateSurveyLaunchState();
    setStatusText(status, `Could not check active surveys: ${error.message}`, 'error');
    return;
  }
  applyMissionSnapshot(mi);
  const limitError = xenoSurveyLimitError(xnMissions);
  if (limitError) {
    setStatusText(status, limitError, 'warning');
    return;
  }
  const r = await templateShips(templateId, planetId);
  if (generation !== xnGeneration) return;
  if (r.error) { setStatusText(status, r.error, 'error'); return; }
  if (!await refreshXenoOverview() || generation !== xnGeneration) return;

  const chain = xnOverview?.chain;
  let campaign = chain;
  if (!campaign && xnMissions.length) {
    try {
      campaign = await campaignFromInFlightSurveys(xnMissions, async moonId => {
        const details = await browser.runtime.sendMessage({ type: 'GET_XENO_MOON', moonId });
        if (generation === xnGeneration && details && !details.error) {
          const key = String(moonId);
          xnMoonDetails.set(key, { ...xnMoonDetails.get(key), trace: details.trace, zone: details.zone });
        }
        return details;
      });
    } catch (error) {
      if (generation !== xnGeneration) return;
      setStatusText(status, `Could not determine the active campaign: ${error.message}`, 'error');
      updateCampaignSelection();
      return;
    }
    if (generation !== xnGeneration) return;
    updateCampaignSelection();
  }
  let criteria;
  if (campaign) {
    if (typeof campaign.trace !== 'string' || typeof campaign.zone !== 'string') {
      setStatusText(status, 'Active campaign is missing its trace or zone. Refresh Xeno account and try again.', 'error');
      return;
    }
    criteria = { trace: campaign.trace, zone: campaign.zone };
  } else {
    criteria = { ...firstArchiveSelection };
  }

  setStatusText(status, 'Loading galaxy map…');
  let map;
  try {
    map = await loadMap();
  } catch (error) {
    if (generation === xnGeneration) setStatusText(status, `Error: ${error.message}`, 'error');
    return;
  }
  if (generation !== xnGeneration) return;
  const src = map.byId[planet.systemId];
  if (!src) { setStatusText(status, 'Source system not on the map.'); return; }

  const exclusions = xenoTargetExclusions(chain, xnMissions);

  xnRunning = true;
  updateSurveyLaunchState();
  const targetDescription = criteria.trace
    ? `${formatXenoName(criteria.trace)} Ancient moon`
    : 'the nearest eligible Ancient moon';
  setStatusText(status, `Scanning for ${targetDescription}${criteria.zone ? ` in ${formatXenoName(criteria.zone)}` : ''}…`);
  let found;
  let stopped;
  try {
    found = await findNearestAncientMoon(src, planet.systemId, exclusions, criteria,
      scanned => { setStatusText(status, `Scanning… ${scanned} systems checked.`); }, generation);
    stopped = !xnRunning;
  } catch (error) {
    if (generation !== xnGeneration) return;
    setStatusText(status, `Could not search for Xeno moons: ${error.message}`, 'error');
    return;
  } finally {
    if (generation === xnGeneration) {
      xnRunning = false;
      updateSurveyLaunchState();
    }
  }
  if (generation !== xnGeneration) return;
  if (!found) {
    setStatusText(status, stopped ? 'Search stopped.' : 'No eligible Ancient moon found nearby.');
    return;
  }

  const sysName = found.system.name || `#${found.system.id}`;
  const target = `${found.moon.name} (${sysName})`;
  setStatusText(status, `Launching survey to ${target} using "${r.name}"…`);
  let res;
  try {
    res = await browser.runtime.sendMessage({
      type: 'SEND_XENO_SURVEY', serverKey: server.key, sourcePlanetId: planetId, targetMoonId: found.moon.id, ships: r.ships,
    });
  } catch (error) {
    if (generation !== xnGeneration) return;
    xnMissionsLoaded = false;
    updateSurveyLaunchState();
    setStatusText(status, `Could not confirm survey launch: ${error.message}. Check the game before retrying.`, 'error');
    return;
  }
  if (generation !== xnGeneration) return;
  if (res?.missionSnapshot) applyMissionSnapshot(res.missionSnapshot);
  if (res?.missionCheckFailed || !res?.ok && !res?.error) {
    xnMissionsLoaded = false;
    updateSurveyLaunchState();
  }
  if (res?.error || !res?.ok) {
    setStatusText(status, `Launch failed: ${res?.error || 'Unconfirmed response. Check the game before retrying.'}`,
      res?.surveyLimitReached ? 'warning' : 'error');
    return;
  }
  setStatusText(status, `Fleet sent to ${target} using "${r.name}" ✓`);
  updateAvail();
  await refreshMissions();
}
