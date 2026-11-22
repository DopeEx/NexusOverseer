import assert from 'node:assert/strict';
import test from 'node:test';
import { fmt, paginateStatistics, renderPagedTable, setStore } from '../nexus-addon/common.js';
import { setSettings } from '../nexus-addon/settings.js';
import { normalizeXenoReport } from '../nexus-addon/xeno-reports.js';
import { xenoDigReports } from './helpers.js';

function element() {
  let text = '';
  const listeners = {};
  return {
    children: [], style: {}, dataset: {},
    get textContent() { return text; },
    set textContent(value) { text = value; this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    addEventListener(type, listener) { listeners[type] = listener; },
    click() { if (!this.disabled) listeners.click?.({ target: this }); },
    setAttribute() {},
    removeAttribute() {},
  };
}

test('Xeno statistics use archived digs and a compact resource/loss table with consistent filters', async t => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; setStore({}); });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  globalThis.document = { getElementById: get, createElement: element, querySelectorAll: () => [] };
  get('zone-select').value = 'all';
  get('mode-select').value = 'all';
  get('window-from').value = '';
  get('window-to').value = '';
  const reports = xenoDigReports().map(normalizeXenoReport);
  setStore({ xeno_history: reports, xeno_recent_reports: reports.slice(-1) });
  const { getXnTotalsForMode, getXnSeriesForMode, renderXnReportTable, xnReportSort } = await import('../nexus-addon/tabs/xeno.js');
  t.after(() => { xnReportSort.key = 'created_at'; xnReportSort.dir = -1; });
  assert.equal(getXnTotalsForMode('all').digs, 3);
  assert.equal(getXnTotalsForMode('all').silicates, 27332);
  assert.equal(getXnTotalsForMode('all').overflow.silicates, 101284);
  assert.equal(getXnSeriesForMode('all').reduce((sum, row) => sum + row.silicates, 0), 27332);
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children.length, 3);
  const cells = get('xn-reports-tbody').children[0].children;
  assert.equal(cells[1].textContent, 'Archive Moon · Test System');
  assert.equal(cells.length, 14, 'separate channel and mode columns alongside context, rewards and total losses');
  const badges = cell => cell.children.map(badge => [badge.textContent, badge.className]);
  assert.deepEqual(badges(cells[2]), [['Sentinel', 'badge finder-zone-sentinel']]);
  assert.deepEqual(badges(cells[3]), [['Necropolis', 'badge finder-trace finder-trace-necropolis']]);
  assert.deepEqual(badges(cells[4]), [['Spire', 'badge finder-trace finder-trace-spire']]);
  assert.deepEqual(badges(cells[5]), [['Fast', 'badge']]);
  assert.deepEqual(badges(cells[6]), [['Success', 'badge badge-success']]);
  assert.equal(cells[7].textContent, fmt(10454));
  assert.equal(cells[7].className, 'silicates');
  assert.equal(cells[10].textContent, '1');
  assert.equal(cells[10].title, 'Rare');
  assert.equal(get('xn-reports-tbody').children[1].children[11].textContent, '1');
  assert.equal(get('xn-reports-tbody').children[1].children[11].title, 'Support pillar');
  assert.equal(get('xn-reports-tbody').children[2].children[12].textContent, '1');
  assert.equal(get('xn-reports-tbody').children[2].children[12].title, 'Gaze / 1');
  assert.equal(cells[13].textContent, '1');
  const { globalRecords, sumResources } = await import('../nexus-addon/tabs/global.js');
  const global = globalRecords().filter(record => record.src === 'Xeno').map(record => record.r);
  assert.equal(sumResources(global).silicates, 27332, 'global income excludes overflow');
  const { computeRawLossCost } = await import('../nexus-addon/common.js');
  const ships = { 21: { costOre: 100 } };
  assert.equal(computeRawLossCost(global, ships).ore, 1800);
  assert.equal(computeRawLossCost(global, ships, 'ships_damaged_raw', 0.5).ore, 300);
  get('window-from').value = '2030-01-20';
  get('window-to').value = '2030-01-22';
  assert.equal(getXnTotalsForMode('all').digs, 2, 'explicit dates override All time');
  assert.equal(getXnSeriesForMode('all').reduce((sum, row) => sum + row.silicates, 0), 19565);
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children.length, 2);
  get('zone-select').value = 'dead';
  assert.equal(getXnTotalsForMode('all').digs, 0);
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children.length, 0);
  get('zone-select').value = 'all';
  get('window-from').value = '';
  get('window-to').value = '';
  const unknown = { ...reports[2], trace: null, zone: null, entrance: null,
    mode: 'future_mode', event: 'future_loss', ships_lost: null, ships_damaged: 2, report: null };
  const collapse = { ...reports[0], event: 'collapse', excavators_lost: 3 };
  setStore({ xeno_history: [unknown, collapse] });
  renderXnReportTable();
  const rows = get('xn-reports-tbody').children;
  assert.deepEqual(badges(rows[0].children[2]), [['Unknown', 'badge finder-zone-unknown']]);
  assert.deepEqual(badges(rows[0].children[3]), [['Unknown', 'badge']]);
  assert.deepEqual(badges(rows[0].children[4]), [['Unknown', 'badge']]);
  assert.deepEqual(badges(rows[0].children[5]), [['Future mode', 'badge']]);
  assert.deepEqual(badges(rows[0].children[6]), [['Future loss', 'badge']]);
  assert.equal(rows[0].children[11].textContent, 'Unknown');
  assert.equal(rows[0].children[12].textContent, 'Unknown');
  assert.equal(rows[0].children[13].textContent, 'Unknown');
  assert.deepEqual(badges(rows[1].children[6]), [['Collapse', 'badge badge-warning']]);
  assert.equal(rows[1].children[13].textContent, '14', 'include separately reported lost Excavators, exclude damage');
  setStore({ xeno_history: [{ ...collapse, ships_lost: 14,
    ships_destroyed_raw: [...collapse.ships_destroyed_raw, { key: 'excavator', quantity: 3 }] }] });
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children[0].children[13].textContent, '14', 'do not count Excavators twice');
  setStore({ xeno_history: reports });
  xnReportSort.key = 'silicates';
  xnReportSort.dir = 1;
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children[0].children[7].textContent, fmt(7767), 'sort numeric delivered resources');
  xnReportSort.key = 'monument_copies';
  xnReportSort.dir = 1;
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children[0].children[11].children[0].textContent, '—');
  xnReportSort.key = 'codex_count';
  xnReportSort.dir = -1;
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children[0].children[12].textContent, '1');
  xnReportSort.key = 'trace';
  xnReportSort.dir = 1;
  renderXnReportTable();
  assert.equal(get('xn-reports-tbody').children[0].children[3].children[0].textContent, 'Necropolis');
  xnReportSort.key = 'mode';
  renderXnReportTable();
  assert.deepEqual(badges(get('xn-reports-tbody').children[0].children[5]), [['Careful', 'badge']]);
  setStore({ xeno_history: [{ ...reports[0], kind: 'survey', mode: null }, { ...reports[1], mode: null }] });
  renderXnReportTable();
  assert.deepEqual(get('xn-reports-tbody').children.map(row => badges(row.children[5])),
    [[['Unknown', 'badge']], [['Legacy survey', 'badge']]]);
  assert.equal(unknown.event, 'future_loss', 'display formatting must not modify archived values');
});

test('Xeno loot cards and charts follow the documented reward profile while retaining ship-cost resources', async t => {
  const original = { document: globalThis.document, Chart: globalThis.Chart, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => { Object.assign(globalThis, original); setStore({}); });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  globalThis.document = { documentElement: element(), getElementById: get, createElement: element, querySelectorAll: () => [] };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  const charts = [];
  globalThis.Chart = class {
    constructor(_canvas, configuration) { charts.push(configuration); }
    destroy() {}
  };
  get('mode-select').value = 'all';
  get('zone-select').value = 'all';
  get('window-from').value = '';
  get('window-to').value = '';
  const reports = xenoDigReports();
  reports[1].zone = 'open';
  reports[1].excavatorsSent = 6;
  reports[1].report.delivered.resources = { alloys: 1200 };
  reports[1].report.delivered.fragments = 15;
  reports[1].report.overflow.resources = { alloys: 60 };
  const records = reports.map(normalizeXenoReport);
  records[0].loot.ore = 55;
  records[0].loot.hydrogen = 66;
  records[0].overflow.ore = 77;
  records[0].overflow.hydrogen = 88;
  setStore({ xeno_history: records, ships: { 21: { key: 'missile_cruiser', costOre: 100, costHydrogen: 7 } } });
  const { renderXenoStatsTab } = await import('../nexus-addon/tabs/xeno.js');
  renderXenoStatsTab();
  const labels = id => get(id).children.map(card => card.children[0].textContent);
  for (const id of ['xn-stats-collected', 'xn-stats-overflow']) {
    assert.deepEqual(labels(id), ['Silicates', 'Alloys', 'Precursor Fragments', 'Artifact']);
  }
  assert.ok(labels('xn-stats-lost').includes('Ore'));
  assert.ok(labels('xn-stats-lost').includes('Hydrogen'));
  assert.ok(labels('xn-stats-repair').includes('Hydrogen'));
  assert.deepEqual(charts[0].data.datasets.map(dataset => dataset.label),
    ['Silicates', 'Alloys', 'Precursor Fragments', 'Artifact', 'Reports']);
  assert.ok(charts[1].data.labels.every(label => !/^(ore|hydrogen)/.test(label)));
  assert.ok(charts[1].data.labels.some(label => label.startsWith('alloys')));
  const { makeResourceLineChart } = await import('../nexus-addon/common.js');
  makeResourceLineChart('other-module-chart', [], 'day');
  assert.deepEqual(charts.at(-1).data.datasets.map(dataset => dataset.label), ['Ore', 'Silicates', 'Hydrogen'],
    'other statistics retain their default chart resources');
});

test('statistics pages share the global size and clamp filtered results', async t => {
  const originalDocument = globalThis.document;
  const originalStorage = globalThis.nexusStorage;
  t.after(() => { globalThis.document = originalDocument; globalThis.nexusStorage = originalStorage; });
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    querySelectorAll: () => [],
  };
  globalThis.nexusStorage = { setSettings: async () => {} };
  const get = id => globalThis.document.getElementById(id);
  const page = (rows, index) => paginateStatistics(rows, index, 'test-page', 'test-prev', 'test-next');
  await setSettings({ 'general.tablePageSize': 25 });

  for (const length of [0, 1, 25, 26]) {
    const result = page(Array.from({ length }, (_, i) => i), 1);
    assert.equal(result.rows.length, Math.min(length, 25));
    assert.equal(get('test-page-count').textContent, `${length} ${length === 1 ? 'entry' : 'entries'}`);
    assert.equal(get('test-page-controls').hidden, length <= 25);
  }
  assert.deepEqual(page(Array.from({ length: 26 }, (_, i) => i), 2).rows, [25]);
  assert.equal(page([0], 2).page, 0);

  await setSettings({ 'general.tablePageSize': 10 });
  assert.equal(renderPagedTable(Array(26).fill('row'), 3, 'test-page', 'test-prev', 'test-next', 'test-body', () => element()), 3);
  assert.equal(get('test-body').children.length, 6);
  assert.equal(renderPagedTable(Array(1), 3, 'test-page', 'test-prev', 'test-next', 'test-body', () => element()), 1);
  assert.equal(get('test-page-controls').hidden, true);

  await setSettings({ 'general.tablePageSize': 25 });
  const { renderActiveRuns, renderCollectionLog } = await import('../nexus-addon/tabs/debris.js');
  const runs = Array.from({ length: 26 }, (_, i) => ({ system: `Run ${i}`, eta: `2030-01-${String(i + 1).padStart(2, '0')}` }));
  const log = Array.from({ length: 26 }, (_, i) => ({ system: `Collection ${i}`, collected_at: `2030-01-${String(i + 1).padStart(2, '0')}` }));
  setStore({ debris_active_runs: runs, debris_collection_log: log });
  renderActiveRuns();
  renderCollectionLog();
  assert.equal(get('d-active-tbody').children.length, 25);
  assert.equal(get('d-collected-tbody').children.length, 25);
  get('d-active-next').click();
  get('d-collected-next').click();
  assert.equal(get('d-active-tbody').children.length, 1);
  assert.equal(get('d-collected-tbody').children.length, 1);
  assert.equal(get('d-active-page-info').textContent, 'Page 2 / 2');
  assert.equal(get('d-collected-page-info').textContent, 'Page 2 / 2');

  setStore({ debris_active_runs: runs.slice(0, 1), debris_collection_log: log.slice(0, 1) });
  renderActiveRuns();
  renderCollectionLog();
  assert.equal(get('d-active-page-info').textContent, 'Page 1 / 1');
  assert.equal(get('d-collected-page-info').textContent, 'Page 1 / 1');
  assert.equal(get('d-active-page-info-controls').hidden, true);
  assert.equal(get('d-collected-page-info-count').textContent, '1 collection');
});

test('survey badges format event categories without changing filter values', async t => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; setStore({}); });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  globalThis.document = { getElementById: get, createElement: element, querySelectorAll: () => [] };
  get('zone-select').value = 'all';
  get('event-select').value = 'all';
  setStore({ recent_reports: [
    { event_type: 'pirate_base', zone: 'open', created_at: '2030-01-02T00:00:00Z' },
    { zone: 'open', created_at: '2030-01-01T00:00:00Z' },
  ] });
  const { renderTable } = await import('../nexus-addon/tabs/surveys.js');
  renderTable();
  const rows = get('reports-tbody').children;
  assert.equal(rows[0].children[3].children[0].textContent, 'Pirate base');
  assert.equal(rows[1].children[3].children[0].textContent, 'Unknown');
  get('event-select').value = 'pirate_base';
  renderTable();
  assert.equal(get('reports-tbody').children.length, 1);
  assert.equal(get('reports-tbody').children[0].children[3].children[0].textContent, 'Pirate base');
});
