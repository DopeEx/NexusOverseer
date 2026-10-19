// Dashboard orchestrator: storage load, status bar, tab switching and
// global controls. Tab rendering lives in tabs/*.js, shared helpers in
// common.js (load order matters — this file comes last).

// ── Storage ────────────────────────────────────────────────────────────────

import { activeTab, appendStatusText, confirmDialog, dayKey, fuelForMode, getLabelKey, getMode, infoDialog, periodLabelFor, renderMarkdown, renderNetCards, setActiveTab, setStore, store } from './common.js';
import { bindServerSelector } from './server-switch.js';
import { initReleaseStatus } from './release-status.js';
import { changelogForVersion } from './common.js';
import { initSimulatorTab } from './tabs/simulator.js';
import { renderBattlesTab } from './tabs/battles.js';
import { renderDebrisTab } from './tabs/debris.js';
import { initExpeditionsTab, renderExpeditionStatsTab, renderExpeditionsTab, runExpeditionAutomations, setExpPage } from './tabs/expeditions.js';
import { renderWormholesTab, setWhPage } from './tabs/wormholes.js';
import { initAsteroidsTab } from './tabs/asteroids.js';
import { renderFleetsTab } from './tabs/fleets.js';
import { initScoutingTab, runScoutingAutomations } from './tabs/scouting.js';
import { initXenoTab, renderXenoStatsTab, setXnReportPage } from './tabs/xeno.js';
import { initFinderTab } from './tabs/finder.js';
import { initMarketTab } from './tabs/market.js';
import { registerAutomationTask, startAutomationScheduler } from './automation-scheduler.js';
import { initHumanVerificationBanner } from './human-verification.js';
import { renderGlobalTab } from './tabs/global.js';
import { renderMiningTab, setMiningPage } from './tabs/mining.js';
import { initPiratesTab, renderPirateStatsTab, renderPiratesTab, runPirateAutomations, setPirateCurrentPage } from './tabs/pirates.js';
import { getEventBreakdownForMode, getResourcesLostForMode, getSeriesForMode, getTotalsForMode, populateEventOptions, renderByEventChart, renderCollected, renderEventsChart, renderLost, renderResourceChart, renderTable, setCurrentPage } from './tabs/surveys.js';
import { renderTechTreeTab } from './tabs/techtree.js';
import { initDashboardTab } from './tabs/dashboard.js';
import { initOptionsTab } from './tabs/options.js';
import { initGuideTab } from './tabs/guide.js';
import { getSetting, loadSettings } from './settings.js';

export async function loadAll() {
  const activeServer = await globalThis.nexusStorage?.getActiveServer?.() || { key: 's0' };
  const serverSelect = document.getElementById('server-select');
  if (serverSelect) {
    await populateServerOptions(serverSelect, activeServer);
    serverSelect.value = activeServer.key || 's0';
  }

  setStore(await browser.storage.local.get([
    'totals', 'daily', 'hourly', 'resources_lost', 'event_breakdown',
    'recent_reports', 'ships', 'last_scrape', 'last_error', 'records_cap',
    'last_alarm_fire_at',
    'pirate_totals', 'pirate_daily', 'pirate_resources_lost',
    'pirate_outcomes', 'pirate_debris_total', 'pirate_recent_reports',
    'mining_totals', 'mining_daily', 'mining_resources_lost', 'mining_recent_reports',
    'debris_fields', 'debris_last_check',
    'debris_collected', 'debris_active_runs', 'debris_collection_log', 'debris_resources_lost',
    'exp_totals', 'expedition_totals', 'wormhole_totals', 'exp_daily', 'exp_recent_reports',
    'expedition_resources_lost', 'wormhole_resources_lost', 'stats_drift',
    'xeno_totals', 'xeno_daily', 'xeno_recent_reports', 'xeno_resources_lost',
    'pvp_recent_reports',
    'research', 'research_speed_mult', 'active_research', 'fuel_log',
  ]));

  const cap = store.records_cap ?? 5000;
  document.getElementById('records-cap').value = cap === Infinity ? 0 : cap;
  updateStatus(store.last_scrape, store.last_error);
  renderAll();
  updateStorageFooter();
}

async function populateServerOptions(select, activeServer) {
  let universes = [];
  try {
    universes = await browser.runtime.sendMessage({ type: 'GET_UNIVERSES' });
  } catch (error) {
    console.warn('[NexusOverseer] Could not load the universe list:', error.message);
  }
  if (!Array.isArray(universes) || !universes.length) return;

  const options = new Map(
    [...(select.options || [])].map(option => [option.value, option.textContent]),
  );
  for (const universe of universes) {
    if (typeof universe?.key === 'string') {
      options.set(universe.key, universe.name || universe.key.toUpperCase());
    }
  }
  if (!options.has(activeServer.key)) {
    options.set(activeServer.key, activeServer.name || activeServer.key.toUpperCase());
  }

  select.textContent = '';
  for (const [key, name] of options) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = name;
    select.appendChild(option);
  }
}

// Archived record counts + rough storage size, shown in Options > Data.
export async function updateStorageFooter() {
  const el = document.getElementById('storage-info');
  if (!el) return;
  const all = await browser.storage.local.get(null);
  const idx = all.archive_index || {};
  const reports = (idx.survey?.count || all.recent_reports?.length || 0) +
    (idx.pirate?.count || all.pirate_recent_reports?.length || 0) +
    (idx.mining?.count || all.mining_recent_reports?.length || 0) +
    (idx.exp?.count || all.exp_recent_reports?.length || 0) +
    (idx.xeno?.count || all.xeno_recent_reports?.length || 0);
  let bytes = 0;
  try { bytes = JSON.stringify(all).length; } catch { /* ignore */ }
  const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  const backup = all.last_backup ? new Date(all.last_backup).toLocaleDateString() : 'never';
  el.textContent = `${reports.toLocaleString()} reports archived · ~${size} stored · last backup: ${backup}`;
}

export function updateStatus(lastScrape, lastError) {
  const el = document.getElementById('status-text');
  const alarmEl = document.getElementById('status-alarm-text');
  el.textContent = '';
  if (lastError) {
    appendStatusText(el, `Error: ${lastError}`, 'error');
  } else if (lastScrape) {
    el.textContent = `Last scrape: ${new Date(lastScrape).toLocaleString()}`;
  } else {
    el.textContent = 'Never scraped.';
  }
  if (store.stats_drift) {
    const warn = appendStatusText(
      el,
      '⚠ Stats drift detected — use Options > Data > Rebuild stats.',
      'warning',
    );
    if (warn) warn.style.marginLeft = '10px';
    if (warn) warn.title = `Fields out of sync: ${(store.stats_drift.fields || []).join(', ')}`;
  }

  if (alarmEl) {
    if (expertModeEnabled) {
      alarmEl.style.display = 'inline';
      alarmEl.textContent = store.last_alarm_fire_at
        ? `Last alarm: ${new Date(store.last_alarm_fire_at).toLocaleString()}`
        : 'Last alarm: never';
    } else {
      alarmEl.style.display = 'none';
      alarmEl.textContent = '';
    }
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

export function renderAll() {
  if (activeTab === 'dashboard') {
    initDashboardTab();
    return;
  }
  if (activeTab === 'options') {
    initOptionsTab();
    void updateStorageFooter();
    return;
  }
  if (activeTab === 'guide') {
    initGuideTab();
    return;
  }
  if (activeTab === 'global' || activeTab === 'statistics') {
    renderGlobalTab();
    return;
  }
  if (activeTab === 'pirates') {
    renderPiratesTab();
    return;
  }
  if (activeTab === 'pirates-stats') {
    renderPirateStatsTab();
    return;
  }
  if (activeTab === 'mining') {
    renderMiningTab();
    return;
  }
  if (activeTab === 'battles') {
    renderBattlesTab();
    return;
  }
  if (activeTab === 'debris') {
    renderDebrisTab();
    return;
  }
  if (activeTab === 'expeditions') {
    renderExpeditionsTab();
    return;
  }
  if (activeTab === 'expeditions-stats') {
    renderExpeditionStatsTab();
    return;
  }
  if (activeTab === 'wormholes') {
    renderWormholesTab();
    return;
  }
  if (activeTab === 'finder') {
    initFinderTab();
    return;
  }
  if (activeTab === 'asteroids') {
    initAsteroidsTab();
    return;
  }
  if (activeTab === 'fleets') {
    renderFleetsTab();
    return;
  }
  if (activeTab === 'scouting') {
    initScoutingTab();
    return;
  }
  if (activeTab === 'xeno') {
    initXenoTab();
    return;
  }
  if (activeTab === 'xeno-stats') {
    renderXenoStatsTab();
    return;
  }
  if (activeTab === 'market') {
    initMarketTab();
    return;
  }
  if (activeTab === 'techtree') {
    renderTechTreeTab();
    return;
  }
  if (activeTab === 'simulator') {
    initSimulatorTab();
    return;
  }
  populateEventOptions();
  const mode = getMode();
  const t = getTotalsForMode();
  const rl = getResourcesLostForMode();
  const events = getEventBreakdownForMode();
  const series = getSeriesForMode();
  const labelKey = getLabelKey(mode);
  const periodLabel = periodLabelFor(mode);

  renderCollected(t, periodLabel);
  renderLost(rl, periodLabel);
  renderNetCards('stats-net', t, rl, periodLabel, fuelForMode('survey', getMode()));
  renderResourceChart(series, labelKey);
  renderEventsChart(events);
  renderByEventChart(events);
  renderTable();
}

// ── Tabs ───────────────────────────────────────────────────────────────────

export const TAB_CONTENT = {
  dashboard: 'dashboard-content',
  options: 'options-content',
  guide: 'guide-content',
  global: 'global-content',
  surveys: 'main-content',
  pirates: 'pirates-content',
  'pirates-stats': 'pirates-stats-content',
  mining: 'mining-content',
  battles: 'battles-content',
  debris: 'debris-content',
  expeditions: 'expeditions-content',
  'expeditions-stats': 'expeditions-stats-content',
  wormholes: 'wormholes-content',
  finder: 'finder-content',
  asteroids: 'asteroids-content',
  fleets: 'fleets-content',
  scouting: 'scouting-content',
  xeno: 'xeno-content',
  'xeno-stats': 'xeno-stats-content',
  market: 'market-content',
  techtree: 'techtree-content',
  simulator: 'simulator-content',
};

const EXPERT_MODE_KEY = 'expert_mode_enabled';
const EXPERT_TABS = new Set(['scouting', 'expeditions', 'xeno']);
const HIDE_GLOBAL_CONTROLS_TABS = new Set([
  'dashboard', 'options', 'guide', 'pirates', 'finder', 'asteroids', 'fleets', 'scouting', 'techtree', 'market', 'simulator', 'xeno',
]);
let expertModeEnabled = false;

function isExpertTab(tab) {
  return EXPERT_TABS.has(tab);
}

function syncVisibleTabContent() {
  for (const [tabName, id] of Object.entries(TAB_CONTENT)) {
    document.getElementById(id).style.display = tabName === activeTab ? '' : 'none';
  }
}

function enforceAllowedTab() {
  if (!expertModeEnabled && (isExpertTab(activeTab) || isExpertTab(activeMainTab))) {
    setActiveTab('dashboard');
    activeMainTab = 'dashboard';
  }
}

function applyExpertModeVisibility() {
  document.body.classList.toggle('expert-mode', expertModeEnabled);
  enforceAllowedTab();
  updateTabNavigation();
  syncVisibleTabContent();
  updateGlobalControlsVisibility();
  updateStatus(store.last_scrape, store.last_error);
}

function updateGlobalControlsVisibility() {
  // View mode and records cap are hidden only on tabs that do not use Statistics filters.
  const usesGlobalFilters = activeTab !== 'expeditions' && activeTab !== 'xeno'
    && !HIDE_GLOBAL_CONTROLS_TABS.has(activeTab);
  document.getElementById('global-controls').style.display = usesGlobalFilters ? '' : 'none';
}

function openHashTab() {
  if (!location.hash) return;
  const hashTab = location.hash.slice(1);
  if (!isExpertTab(hashTab) || expertModeEnabled) {
    document.querySelector(`.tab[data-tab="${hashTab}"]`)?.click();
  }
}

async function initExpertModeToggle() {
  const toggle = document.getElementById('expert-toggle');
  if (!toggle) return;
  const got = await browser.storage.local.get(EXPERT_MODE_KEY);
  expertModeEnabled = got[EXPERT_MODE_KEY] === true;
  toggle.setAttribute('aria-pressed', expertModeEnabled ? 'true' : 'false');
  applyExpertModeVisibility();
  toggle.addEventListener('click', async () => {
    expertModeEnabled = !expertModeEnabled;
    toggle.setAttribute('aria-pressed', expertModeEnabled ? 'true' : 'false');
    await browser.storage.local.set({ [EXPERT_MODE_KEY]: expertModeEnabled });
    applyExpertModeVisibility();
    positionControls();
    renderAll();
  });
}

const SUBTAB_TABS = ['global', 'surveys', 'pirates-stats', 'mining', 'battles', 'debris', 'expeditions-stats', 'xeno-stats', 'wormholes'];
let activeMainTab = (activeTab === 'global' || SUBTAB_TABS.includes(activeTab)) ? 'statistics' : activeTab;

function updateTabNavigation() {
  const isStatisticsContext = activeMainTab === 'statistics';
  document.querySelectorAll('.main-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeMainTab);
  });
  document.querySelectorAll('.subtab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });
  document.querySelector('.subtabs')?.classList.toggle('show', isStatisticsContext);
  document.getElementById('statistics-status').classList.toggle('show', isStatisticsContext);
  document.getElementById('dashboard-status').classList.toggle('show', activeMainTab === 'dashboard');
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (!expertModeEnabled && isExpertTab(tab)) return;
    if (SUBTAB_TABS.includes(tab)) {
      setActiveTab(tab);
      activeMainTab = 'statistics';
    } else if (tab === 'statistics') {
      setActiveTab('global');
      activeMainTab = 'statistics';
    } else {
      setActiveTab(tab);
      activeMainTab = tab;
    }
    enforceAllowedTab();
    updateTabNavigation();
    syncVisibleTabContent();
    updateGlobalControlsVisibility();
    positionControls();
    renderAll();
  });
});

updateTabNavigation();

const navEl = document.getElementById('main-nav');
const navToggle = document.getElementById('nav-toggle');
const navBackdrop = document.getElementById('nav-backdrop');
function setNavOpen(open) {
  navEl.classList.toggle('open', open);
  navBackdrop.classList.toggle('show', open);
  navToggle.setAttribute('aria-expanded', String(open));
}
navToggle.addEventListener('click', () => setNavOpen(!navEl.classList.contains('open')));
navBackdrop.addEventListener('click', () => setNavOpen(false));
navEl.addEventListener('click', e => { if (e.target.closest('.main-tab')) setNavOpen(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setNavOpen(false); });
window.matchMedia('(min-width: 901px)').addEventListener('change', e => { if (e.matches) setNavOpen(false); });

// Keep the shared View/Window/Zone bar at the top of the active tab's content.
export function positionControls() {
  const bar = document.getElementById('global-controls');
  const content = document.getElementById(TAB_CONTENT[activeTab]);
  if (!content) return;
  const globalContent = document.getElementById('global-content');
  globalContent.parentElement.insertBefore(bar, globalContent);
}

// ── Controls ───────────────────────────────────────────────────────────────

const serverSelect = document.getElementById('server-select');
if (serverSelect) {
  bindServerSelector(serverSelect, {
    onChange: async () => {
      await loadAll();
      renderAll();
      if (typeof window !== 'undefined' && window.location && !window.location.href.includes('nexuslegacy.space')) {
        window.location.reload();
      }
    },
  });
}

browser.storage.local.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.nexus_active_server) {
    loadAll().catch(() => {});
  }
});

document.getElementById('btn-scrape').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = 'Scraping…';
  try {
    const selectedServer = (document.getElementById('server-select')?.value ||
      (await globalThis.nexusStorage?.getActiveServer?.())?.key || 's0');
    const res = await browser.runtime.sendMessage({ type: 'SCRAPE_NOW', serverKey: selectedServer });
    if (res?.error || res?.ok === false) {
      throw new Error(res?.error || 'Scrape failed');
    }
    await loadAll();
    this.textContent = 'Done ✓';
  } catch (err) {
    const msg = err?.message || 'Error';
    try {
      updateStatus(store.last_scrape, msg);
    } catch {
      // Keep button feedback even if status rendering fails.
    }
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Scrape Now'; }, 2000);
  }
});

export function onViewChange() {
  setCurrentPage(1);
  setPirateCurrentPage(1);
  setMiningPage(1);
  setExpPage(1);
  setWhPage(1);
  setXnReportPage(1);
  renderAll();
}

// Switching View fills the Days picker: All time clears it (= all history),
// Daily/Hourly = today, Yesterday = the previous day, Last N = a trailing range.
// The user can still edit it.
document.getElementById('mode-select').addEventListener('change', () => {
  const mode = getMode();
  const from = document.getElementById('window-from');
  const to = document.getElementById('window-to');
  const span = { last3: 3, last7: 7, last30: 30 }[mode];
  if (mode === 'all') {
    from.value = ''; to.value = '';
  } else {
    const now = Date.now() - (mode === 'yesterday' ? 86400000 : 0);
    to.value = dayKey(now);
    from.value = dayKey(now - ((span || 1) - 1) * 86400000);
  }
  onViewChange();
});
document.getElementById('zone-select').addEventListener('change', onViewChange);
document.getElementById('window-from').addEventListener('change', onViewChange);
document.getElementById('window-to').addEventListener('change', onViewChange);
document.getElementById('event-select').addEventListener('change', () => { setCurrentPage(1); renderAll(); });

document.getElementById('btn-reset').addEventListener('click', async function () {
  if (!confirm('Delete all recorded stats and reports? Your options are kept. A backup is written to Downloads/NexusOverseer first.')) return;
  await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'pre-reset' });
  const recordsCap = globalThis.nexusStorage?.get ? (await globalThis.nexusStorage.get('records_cap')).records_cap : undefined;
  const settings = await globalThis.nexusStorage?.getSettings?.();
  if (globalThis.nexusStorage?.clearAllStorage) {
    await globalThis.nexusStorage.clearAllStorage();
  } else {
    await browser.storage.local.clear();
  }
  if (settings && Object.keys(settings).length) await globalThis.nexusStorage.setSettings(settings);
  if (recordsCap !== undefined) {
    await browser.storage.local.set({ records_cap: recordsCap });
  }
  await loadAll();
});

document.getElementById('records-cap').addEventListener('input', function () {
  const raw = this.value.trim();
  const n = parseInt(raw, 10);
  const invalid = raw === '' || isNaN(n) || n < 0 || String(n) !== raw;
  this.style.borderColor = invalid ? '#ff6b7a' : '#15263b';
  this.style.color = invalid ? '#ff6b7a' : '#f1f6ff';
  document.getElementById('cap-warning').style.display = invalid ? '' : 'none';
});

document.getElementById('btn-save-cap').addEventListener('click', async function () {
  const input = document.getElementById('records-cap');
  const raw = parseInt(input.value.trim(), 10);
  if (isNaN(raw) || raw < 0) return;
  await browser.storage.local.set({ records_cap: raw });
  input.value = raw;
  input.style.borderColor = '#15263b';
  input.style.color = '#f1f6ff';
  document.getElementById('cap-warning').style.display = 'none';
  this.textContent = 'Saved ✓';
  setTimeout(() => { this.textContent = 'Save'; }, 1500);
});

// ── Rebuild aggregates ─────────────────────────────────────────────────────

document.getElementById('btn-backup-now').addEventListener('click', async function () {
  this.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'manual' });
    if (res?.error) throw new Error(res.error);
    this.textContent = 'Saved ✓';
    void updateStorageFooter();
  } catch {
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Back up now'; }, 2000);
  }
});

document.getElementById('btn-purge').addEventListener('click', async function () {
  if (!await confirmDialog('Delete archived reports older than 3 days?\n\nTotals are kept. A backup is written to Downloads/NexusOverseer first.')) return;
  this.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'pre-purge' });
    await browser.runtime.sendMessage({ type: 'PURGE_OLD', days: 3 });
    await loadAll();
    this.textContent = 'Purged ✓';
  } catch {
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Purge old reports'; }, 2000);
  }
});

document.getElementById('btn-rebuild').addEventListener('click', async function () {
  const s = await browser.storage.local.get([
    'archive_index',
    'recent_reports', 'pirate_recent_reports', 'mining_recent_reports', 'exp_recent_reports', 'xeno_recent_reports',
  ]);
  const idx = s.archive_index || {};
  const n = (idx.survey?.count || (s.recent_reports || []).length) +
            (idx.pirate?.count || (s.pirate_recent_reports || []).length) +
            (idx.mining?.count || (s.mining_recent_reports || []).length) +
            (idx.exp?.count || (s.exp_recent_reports || []).length) +
            (idx.xeno?.count || (s.xeno_recent_reports || []).length);
  if (!confirm(
    `Recompute all aggregated stats from the ${n} archived report records?\n\n` +
    'Mining alloys/rares, stolen-cargo breakdown and mining loss valuation ' +
    'cannot be reconstructed and will reset.')) return;

  this.disabled = true;
  this.textContent = 'Rebuilding…';
  try {
    await browser.runtime.sendMessage({ type: 'REBUILD_AGGREGATES' });
    await loadAll();
    this.textContent = 'Rebuilt ✓';
  } catch {
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Rebuild stats'; }, 2000);
  }
});

// ── Export / Import ────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async function () {
  const data = globalThis.nexusStorage?.exportFullStorage ? await globalThis.nexusStorage.exportFullStorage() : await browser.storage.local.get(null);
  // JSON cannot represent Infinity (unlimited records cap) — store as 0.
  if (data.records_cap === Infinity) data.records_cap = 0;
  const payload = {
    nexus_overseer_backup: 1,
    exported_at: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nexus-overseer-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  this.textContent = 'Exported ✓';
  setTimeout(() => { this.textContent = 'Export JSON'; }, 2000);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

// Shape checks on a backup before anything is cleared. Catches truncated or
// hand-edited files; unknown keys are allowed through untouched.
export function validateBackupData(data) {
  const arrays = [
    'recent_reports', 'daily', 'hourly', 'event_breakdown', 'seen_ids',
    'pirate_recent_reports', 'pirate_seen_ids', 'pirate_daily', 'pirate_outcomes',
    'mining_recent_reports', 'mining_seen_ids', 'mining_daily',
    'exp_recent_reports', 'exp_seen_ids', 'exp_daily',
    'xeno_recent_reports', 'xeno_seen_ids', 'xeno_daily',
    'survey_archive', 'pirate_archive', 'mining_archive', 'exp_archive', 'xeno_archive',
    'spy_reports', 'camp_scout_reports', 'debris_fields',
  ];
  const objects = [
    'totals', 'pirate_totals', 'mining_totals', 'exp_totals', 'xeno_totals',
    'expedition_totals', 'wormhole_totals', 'ships',
    'resources_lost', 'pirate_resources_lost', 'mining_resources_lost',
    'expedition_resources_lost', 'wormhole_resources_lost', 'xeno_resources_lost',
    'pirate_debris_total', 'archive_index',
  ];
  for (const k of arrays) {
    if (k in data && !Array.isArray(data[k])) throw new Error(`backup field "${k}" should be a list`);
  }
  for (const k of objects) {
    if (k in data && (typeof data[k] !== 'object' || data[k] === null || Array.isArray(data[k]))) {
      throw new Error(`backup field "${k}" should be an object`);
    }
  }
  if ('records_cap' in data && typeof data.records_cap !== 'number') {
    throw new Error('backup field "records_cap" should be a number');
  }
}

document.getElementById('import-file').addEventListener('change', async function () {
  const file = this.files[0];
  this.value = '';                    // allow re-selecting the same file
  if (!file) return;

  const btn = document.getElementById('btn-import');
  try {
    const payload = JSON.parse(await file.text());
    // `nexus_accounting_backup` is the marker written before the rename.
    const isBackup = payload && (payload.nexus_overseer_backup === 1 || payload.nexus_accounting_backup === 1);
    if (!isBackup || !payload.data || Array.isArray(payload.data) || typeof payload.data !== 'object') {
      throw new Error('not a Nexus Overseer backup file');
    }
    validateBackupData(payload.data);
    const exportedAt = payload.exported_at ? new Date(payload.exported_at).toLocaleString() : 'unknown date';
    if (!confirm(`Replace ALL current data with backup from ${exportedAt}?\n\nA snapshot of the current data is written to Downloads/NexusOverseer first.`)) return;

    await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'pre-import' });
    const data = payload.data;
    if (globalThis.nexusStorage?.restoreFullStorage) {
      await globalThis.nexusStorage.restoreFullStorage(data);
    } else {
      await browser.storage.local.clear();
      await browser.storage.local.set(data);
    }
    await loadAll();
    btn.textContent = 'Imported ✓';
  } catch (e) {
    alert(`Import failed: ${e.message}`);
    btn.textContent = 'Error';
  } finally {
    setTimeout(() => { btn.textContent = 'Import JSON'; }, 2000);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

// On launch, if the stored report count is very large, offer a one-click purge
// down to the last 3 days. Runs once (not on every scrape-driven reload).
const PURGE_WARN_THRESHOLD = 10000;
async function maybeWarnStorage() {
  const all = await browser.storage.local.get([
    'archive_index', 'recent_reports', 'pirate_recent_reports', 'mining_recent_reports', 'exp_recent_reports', 'xeno_recent_reports',
  ]);
  const idx = all.archive_index || {};
  const total = (idx.survey?.count || all.recent_reports?.length || 0) +
    (idx.pirate?.count || all.pirate_recent_reports?.length || 0) +
    (idx.mining?.count || all.mining_recent_reports?.length || 0) +
    (idx.exp?.count || all.exp_recent_reports?.length || 0) +
    (idx.xeno?.count || all.xeno_recent_reports?.length || 0);
  if (total <= PURGE_WARN_THRESHOLD) return;
  if (!await confirmDialog(`⚠ Large storage: ${total.toLocaleString()} reports kept.\n\n` +
    'Purge old data and keep only the last 3 days?')) return;
  await browser.runtime.sendMessage({ type: 'PURGE_OLD', days: 3 });
  await loadAll();
}

positionControls();
registerAutomationTask('scouting', () => {
  if (expertModeEnabled) return runScoutingAutomations();
});
registerAutomationTask('pirates', () => {
  if (expertModeEnabled) return runPirateAutomations();
});
registerAutomationTask('expeditions', () => {
  if (expertModeEnabled) return runExpeditionAutomations();
});
initExpertModeToggle()
  .then(() => loadSettings())
  .then(() => initHumanVerificationBanner())
  .then(() => loadAll())
  .then(() => {
    openHashTab();
    const startTab = getSetting('general.defaultTab');
    if (!location.hash && startTab !== 'dashboard') document.querySelector(`.main-tab[data-tab="${startTab}"]`)?.click();
    startAutomationScheduler();
    void initExpeditionsTab().catch(error => {
      console.error('[NexusOverseer] Could not initialize expedition automations:', error);
    });
    // Load scouting data once so its automations do not depend on the visible tab.
    void initScoutingTab().catch(error => {
      console.error('[NexusOverseer] Could not initialize scouting automations:', error);
    });
    void initPiratesTab().catch(error => {
      console.error('[NexusOverseer] Could not initialize pirate automations:', error);
    });
    return maybeWarnStorage();
  });
maybeShowWhatsNew();

// Show the latest changelog section once after an update (flag set by the
// background's onInstalled handler).
async function maybeShowWhatsNew() {
  const { whatsnew_pending, whatsnew_read_version } =
    await browser.storage.local.get(['whatsnew_pending', 'whatsnew_read_version']);
  if (!whatsnew_pending) return;
  if (whatsnew_pending === whatsnew_read_version) {
    await browser.storage.local.remove('whatsnew_pending');
    return;
  }
  await showWhatsNew(whatsnew_pending);
  await browser.storage.local.set({ whatsnew_read_version: whatsnew_pending });
  await browser.storage.local.remove('whatsnew_pending');
}

// Each "### Added/Changed/…" block becomes its own card so wide screens show
// them side by side instead of one long column.
async function showWhatsNew(version) {
  let body = 'See CHANGELOG.md for details.';
  try {
    const response = await fetch(browser.runtime.getURL('CHANGELOG.md'));
    if (!response.ok) throw new Error(`Changelog request failed (HTTP ${response.status})`);
    const notes = changelogForVersion(await response.text(), version);
    if (notes) {
      body = document.createElement('div');
      body.className = 'whatsnew-sections';
      for (const part of notes.split(/\r?\n(?=### )/)) {
        const section = document.createElement('section');
        section.className = 'whatsnew-section';
        section.append(renderMarkdown(part.trim()));
        body.append(section);
      }
    } else {
      console.warn(`[NexusOverseer] No changelog content for version ${version}.`);
    }
  } catch (error) {
    console.error('[NexusOverseer] Could not load release notes:', error);
  }
  await infoDialog(`What's new in v${version}`, body, { width: 1100 });
}

const versionLink = document.getElementById('footer-version');
if (versionLink) {
  const version = browser.runtime.getManifest().version;
  versionLink.textContent = `v${version}`;
  versionLink.addEventListener('click', e => { e.preventDefault(); void showWhatsNew(version); });
  void initReleaseStatus({
    versionLink,
    statusLink: document.getElementById('footer-release-status'),
    checkButton: document.getElementById('footer-check-updates'),
    runtime: browser.runtime,
    storage: browser.storage.local,
  });
}

browser.storage.local.onChanged.addListener((changes, area) => {
  if (area === 'local' && (
    changes.last_scrape || changes.last_error || changes.last_alarm_fire_at ||
    changes.totals || changes.pirate_totals
  )) loadAll();
});
