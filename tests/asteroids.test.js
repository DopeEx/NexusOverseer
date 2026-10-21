import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { createGalaxyCache, restoreGalaxyCache, saveSystem } from '../nexus-addon/galaxy-cache.js';
import { fuelEstimate } from '../nexus-addon/common.js';
import { retainMiningFields, visibleAsteroidFields } from '../nexus-addon/galaxy-client.js';
import { makeBrowserStub } from './helpers.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const field = (id, type = 'ore', extra = {}) => ({
  id, fieldType: type, richness: 2, remainingResources: 1000, totalResources: 2000, ...extra,
});

test('Asteroids shares the Galaxy Scout list presentation without changing its columns', async () => {
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const panel = html.slice(html.indexOf('<div class="dashboard-panel dashboard-list-panel asteroids-results-panel">'),
    html.indexOf('<div id="scouting-content"'));
  assert.ok(panel.includes('dashboard-table-scroll'));
  assert.ok(panel.includes('dashboard-list-status'));
  assert.ok(panel.includes('dashboard-list-footer'));
  assert.ok(!panel.includes('statistics-list-panel'), 'only the table scrolls, not its heading and navigation');
  assert.deepEqual([...panel.matchAll(/data-key="([^"]+)"/g)].map(match => match[1]),
    ['system', 'type', 'mult', 'remaining', 'leftPct', 'zone', 'fieldId', 'ownerName', 'distance', 'recShips']);
  assert.equal((panel.match(/<th(?:\s|>)/g) || []).length, 12);
  assert.equal((panel.match(/<button type="button">/g) || []).length, 10,
    'sortable headings use keyboard-accessible buttons like Galaxy Scout');
  assert.ok(html.includes('dashboard-panel dashboard-list-panel finder-results-panel'));
});

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.classList = { toggle() {} };
  }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  appendChild(child) {
    child.remove();
    child.parent = this;
    this.children.push(child);
    if (child.selected || this.value === '') this.value = String(child.value || '');
    return child;
  }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    child.remove();
    child.parent = this;
    this.children.splice(this.children.indexOf(before), 0, child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  querySelector(selector) { return this.children.find(child => selector === `.${child.className}`); }
  async click() { return this.listeners.click?.({ target: this }); }
}

async function harness(t, { store = {}, size = 15, data = {}, respond, fetchSystem } = {}) {
  await restoreGalaxyCache();
  makeBrowserStub(store);
  const { browser } = globalThis;
  browser.storage.local.onChanged = browser.storage.onChanged;
  browser.alarms.get = async () => null;
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (run, interval) => { timers.push({ run, interval }); return timers.length; });
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const rows = () => el('af-results-tbody').children;
  globalThis.document = {
    getElementById: el,
    createElement: () => new Element(),
    querySelectorAll: selector => selector === '#af-results-tbody tr' ? rows()
      : selector === '#af-results-tbody td.af-fuel' ? rows().map(row => row.querySelector('.af-fuel')) : [],
  };
  el('af-near').value = '10';
  const systems = Array.from({ length: size + 1 }, (_, id) => ({
    id: id + 1, sectorId: id + 1, x: id, y: 0, visibility: 'full',
    name: `System ${id + 1}`, planetCount: 1, securityZone: 'open',
  }));
  const messages = [], requests = [];
  const cache = createGalaxyCache({
    storage: { get: async () => ({}), remove: async () => {} },
    fetcher: async path => {
      const id = Number(/systems\/(\d+)/.exec(path)[1]);
      requests.push(id);
      return fetchSystem ? fetchSystem(id) : {
        visibility: 'full', included: { planets: true, moons: true, fields: true },
        planets: [], moons: [], ...(data[id] || { asteroidFields: [field(id)] }),
      };
    },
  });
  browser.runtime.sendMessage = async message => {
    messages.push(message);
    const response = await respond?.(message);
    if (response !== undefined) return response;
    if (message.type === 'GET_PLANETS') return { planets: [{ id: 1, systemId: 1, name: 'Home', isHomeworld: true }] };
    if (message.type === 'GET_AUTH_ME') return { user: { username: 'Commander' } };
    if (message.type === 'GET_SHIP_DEFS') return { ships: [] };
    if (message.type === 'GET_MISSIONS') return { missions: [] };
    if (message.type === 'GET_GALAXY_MAP') return { systems };
    if (message.type === 'GET_SECTOR_SYSTEMS') return { systems: systems.filter(s => s.sectorId === message.sectorId) };
    if (message.type === 'GET_GALAXY_SCANS') return { scans: await cache.scans('s0') };
    if (message.type === 'GET_PLAYER_ALLIANCE_TAG') return { tag: 'TEAM' };
    if (message.type === 'SET_LIVE_SEARCH') {
      await browser.storage.local.set({ live_search: message.config });
      return { ok: true };
    }
    if (message.type === 'GET_SYSTEM_PLANETS') {
      try { return await cache.system('s0', message.systemId, message); }
      catch (error) { return { error: error.message, status: error.status, code: error.code }; }
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };
  const module = await import(`../nexus-addon/tabs/asteroids.js?test=${crypto.randomUUID()}`);
  await module.initAsteroidsTab();
  await settle();
  return { el, systems, messages, requests, store, module, rows, timers, scan: () => el('af-scan').click() };
}

test('type-filter scan interleaves sector/detail reads, shows and saves the first match before the next reply', async t => {
  const held = deferred();
  const h = await harness(t, {
    store: { template_selections: { 'af-type-filter': ['ore', 'gas'], 'af-near': '2' } },
    data: { 2: { asteroidFields: [field(20, 'ice')] }, 3: { asteroidFields: [field(30), field(31, 'gas')] } },
    respond: message => message.type === 'GET_SYSTEM_PLANETS' && message.systemId === 4 ? held.promise : undefined,
  });
  const scan = h.scan();
  try {
    for (let i = 0; i < 100 && !h.messages.some(m => m.type === 'GET_SYSTEM_PLANETS' && m.systemId === 4); i++) await settle();
    const calls = h.messages.filter(m => ['GET_SECTOR_SYSTEMS', 'GET_SYSTEM_PLANETS'].includes(m.type));
    assert.deepEqual(calls.map(m => m.type), [
      'GET_SECTOR_SYSTEMS', 'GET_SYSTEM_PLANETS', 'GET_SECTOR_SYSTEMS',
      'GET_SYSTEM_PLANETS', 'GET_SECTOR_SYSTEMS', 'GET_SYSTEM_PLANETS',
    ]);
    assert.equal(h.rows().length, 2, 'first matching system is rendered before the next response');
    assert.equal(h.store.asteroid_scan_results.fields.length, 2, 'partial matches are persisted');
    assert.equal(h.store.asteroid_scan_results.incomplete, true);
    assert.equal(h.el('af-progress').dataset.apiPath, '/api/galaxy/systems/4/planets');
  } finally {
    held.resolve({ asteroidFields: [field(40, 'gas')] });
    await scan;
  }
  assert.equal(h.rows().length, 3, 'two matching systems can contain more than two field rows');
  assert.equal(h.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').length, 3);
  assert.equal(h.messages.filter(m => m.type === 'GET_SECTOR_SYSTEMS').length, 3, 'distant sectors stay unloaded');
  assert.match(h.el('af-progress').textContent, /Target 2\/2 · Checked 3 · Fields 3/);
  assert.equal(h.store.asteroid_scan_results.incomplete, false);
  assert.equal(h.el('af-progress').dataset.apiPath, undefined);
});

test('alliance tags are optional enrichment and never hold up results or scan completion', async t => {
  const held = deferred();
  const h = await harness(t, {
    store: { template_selections: { 'af-near': '1' } },
    data: { 2: { asteroidFields: [field(2, 'ore', { controllerName: 'Owner', outpostShieldMaxHp: 50 })] } },
    respond: message => message.type === 'GET_PLAYER_ALLIANCE_TAG' ? held.promise : undefined,
  });
  await h.scan();
  try {
    assert.equal(h.rows().length, 1);
    assert.match(h.el('af-progress').textContent, /^Done:/);
    assert.equal(h.el('af-scan').textContent, 'Scan');
    assert.equal(h.rows()[0].children[8].textContent, 'Owner');
  } finally {
    held.resolve({ tag: 'TEAM' });
    await settle();
  }
  assert.equal(h.rows()[0].children[8].children[0].textContent, 'Owner');
  assert.equal(h.rows()[0].children[8].children[1].textContent, '[TEAM]');
  assert.equal(h.rows()[0].children[8].children[1].className, 'finder-badge finder-alliance');
});

for (const status of [429, 401]) {
  test(`HTTP ${status} stops the scan, clears wait hints and retains partial matches`, async t => {
    t.mock.method(console, 'warn', () => {});
    const h = await harness(t, {
      respond: message => message.type === 'GET_SYSTEM_PLANETS' && message.systemId === 3
        ? { error: 'Server refused request', status } : undefined,
    });
    await h.scan();
    assert.deepEqual(h.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').map(m => m.systemId), [2, 3]);
    assert.equal(h.rows().length, 1);
    assert.equal(h.store.asteroid_scan_results.fields.length, 1);
    assert.equal(h.store.asteroid_scan_results.incomplete, true);
    assert.match(h.el('af-progress').textContent, status === 429 ? /Stopped: API rate limit \(429\)/ : /Please log in/);
    assert.equal(h.el('af-search-issues').hidden, false);
    assert.match(h.el('af-search-issues-list').textContent, new RegExp(`HTTP ${status}`));
    assert.equal(h.el('af-progress').dataset.apiPath, undefined);
    assert.equal(h.el('af-api-wait').textContent, '');
    assert.equal(h.el('af-scan').disabled, false);
  });
}

test('sector 429 stops before fetching details or further sectors', async t => {
  t.mock.method(console, 'warn', () => {});
  const h = await harness(t, {
    respond: message => message.type === 'GET_SECTOR_SYSTEMS' ? { error: 'Limited', status: 429 } : undefined,
  });
  await h.scan();
  assert.equal(h.messages.filter(m => m.type === 'GET_SECTOR_SYSTEMS').length, 1);
  assert.equal(h.requests.length, 0);
  assert.match(h.el('af-progress').textContent, /Stopped: API rate limit \(429\)/);
});

test('fresh saved fields avoid network reads and a repeated scan reuses observations', async t => {
  const h = await harness(t, { store: { template_selections: { 'af-near': '2' } } });
  await saveSystem('s0', 2, { asteroidFields: [field(2)] });
  await saveSystem('s0', 3, { asteroidFields: [field(3)] }, Date.now() - 16 * 60000);
  await h.scan();
  assert.deepEqual(h.requests, [3]);
  assert.equal(h.rows().length, 2);
  await h.scan();
  assert.deepEqual(h.requests, [3]);
});

test('default target is 10, while saved manual and live targets are preserved', async t => {
  const h = await harness(t);
  await h.scan();
  assert.equal(h.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').length, 10);
  const saved = await harness(t, {
    store: { template_selections: { 'af-near': '25' }, live_search: { near: 25 } }, size: 30,
  });
  assert.equal(saved.el('af-near').value, '25');
  await saved.scan();
  assert.equal(saved.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').length, 25);
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /id="af-near"[^>]*value="10"/);
  assert.doesNotMatch(html, /id="ls-(?:near|planet|type|zone|left-min|qty-min|mult-min)"/);
});

test('zone filtering retains distance order without counting excluded systems', async t => {
  const h = await harness(t, {
    store: { template_selections: { 'af-near': '2', 'af-zone-filter': ['rift'] } },
  });
  h.systems[2].securityZone = h.systems[4].securityZone = 'rift';
  await h.scan();
  assert.deepEqual(h.requests, [3, 5]);
  assert.equal(h.rows().length, 2);
});

test('type search stops at 500 detail checks even if no matching type exists', async t => {
  const h = await harness(t, {
    size: 510, store: { template_selections: { 'af-type-filter': ['dark'] } },
  });
  await h.scan();
  assert.equal(h.requests.length, 500);
  assert.equal(h.messages.filter(m => m.type === 'GET_SECTOR_SYSTEMS').length, 500);
  assert.equal(h.rows().length, 0);
});

test('Stop during a queued read does not start another scan and retains the returning match', async t => {
  const held = deferred();
  const h = await harness(t, { respond: message => message.type === 'GET_SYSTEM_PLANETS' ? held.promise : undefined });
  const scan = h.scan();
  for (let i = 0; i < 100 && !h.messages.some(m => m.type === 'GET_SYSTEM_PLANETS'); i++) await settle();
  await h.el('af-scan').click();
  assert.equal(h.el('af-scan').disabled, true);
  held.resolve({ asteroidFields: [field(2)] });
  await scan;
  assert.equal(h.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').length, 1);
  assert.equal(h.store.asteroid_scan_results.fields.length, 1);
  assert.match(h.el('af-progress').textContent, /^Stopped:/);
  assert.equal(h.el('af-scan').disabled, false);
});

test('reset ignores late responses from the previous universe', async t => {
  const held = deferred();
  const h = await harness(t, { respond: message => message.type === 'GET_SYSTEM_PLANETS' ? held.promise : undefined });
  const scan = h.scan();
  for (let i = 0; i < 100 && !h.messages.some(m => m.type === 'GET_SYSTEM_PLANETS'); i++) await settle();
  h.module.resetAsteroidsTab();
  held.resolve({ asteroidFields: [field(2)] });
  await scan;
  assert.equal(h.store.asteroid_scan_results, undefined);
  assert.equal(h.rows().length, 0);
});

test('repeated renders share pending fuel estimates, cache success and retry explicit errors', async () => {
  makeBrowserStub();
  const { browser } = globalThis;
  let held = deferred();
  let calls = 0;
  browser.runtime.sendMessage = () => { calls++; return held.promise; };
  const estimate = () => fuelEstimate(917, 918, [{ shipDefId: 1, quantity: 10 }], 'mine');
  const first = estimate(), second = estimate();
  assert.equal(calls, 1);
  held.resolve({ error: 'Limited' });
  await Promise.all([first, second]);
  held = deferred();
  const retry = estimate();
  assert.equal(calls, 2);
  held.resolve({ fuelCost: 10 });
  assert.deepEqual(await retry, { fuelCost: 10 });
  assert.deepEqual(await estimate(), { fuelCost: 10 });
  assert.equal(calls, 2);
});

test('live button and Scan reuse the single filter set and live snapshots replace the displayed rows', async t => {
  const h = await harness(t, { store: { template_selections: {
    'af-type-filter': ['ore', 'gas'], 'af-zone-filter': ['open'], 'af-near': '3',
    'af-mult-min': '2', 'af-qty-min': '100', 'af-left-min': '40',
  } } });
  await h.el('ls-search').click();
  assert.equal(h.el('ls-search').textContent, 'Stop Auto Scan');
  const config = h.messages.find(m => m.type === 'SET_LIVE_SEARCH').config;
  assert.deepEqual(config, { enabled: true, planetId: 1, multMin: 2, qtyMin: 100,
    leftMin: 40, near: 3, types: ['ore', 'gas'], zones: ['open'] });
  await h.scan();
  assert.equal(h.messages.filter(m => m.type === 'SET_LIVE_SEARCH').length, 2);
  assert.equal(h.messages.filter(m => m.type === 'GET_SYSTEM_PLANETS').length, 0,
    'Scan while live is active requests a live pass instead of launching a competing manual loop');
  const snapshot = { config, planetId: 1, at: Date.now(), referenceSystem: { x: 0, y: 0 },
    fields: [{ fieldId: 21, systemId: 2, system: 'S2', type: 'ore', zone: 'open',
      mult: 2, remaining: 1000, total: 2000 }], missions: [] };
  await globalThis.browser.storage.local.set({ asteroid_scan_results: snapshot });
  await settle();
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].dataset.field, 21);
  assert.equal(h.el('af-count').textContent, '1 field in 1 system');
  await globalThis.browser.storage.local.set({ asteroid_scan_results: { ...snapshot, fields: [] } });
  await settle();
  assert.equal(h.rows().length, 0, 'removed live fields cannot survive a replacement snapshot');
  h.el('af-left-min').value = '60';
  await h.el('af-left-min').listeners.change({ target: h.el('af-left-min') });
  await settle();
  assert.equal(h.messages.filter(m => m.type === 'SET_LIVE_SEARCH').at(-1).config.leftMin, 60);
  await h.el('ls-search').click();
  assert.equal(h.messages.at(-1).config.enabled, false);
  assert.equal(h.el('ls-search').textContent, 'Auto Scan');
});

test('active legacy live configuration migrates into shared controls without a second filter row', async t => {
  const h = await harness(t, { store: {
    template_selections: { 'af-near': '25', 'af-left-min': '20' },
    live_search: { enabled: true, planetId: 1, near: 5, leftMin: 70, types: ['gas'], zones: ['open'] },
  } });
  assert.equal(h.el('af-near').value, '5');
  assert.equal(h.el('af-left-min').value, '70');
  await h.scan();
  assert.deepEqual(h.messages.find(m => m.type === 'SET_LIVE_SEARCH').config.types, ['gas']);
});

test('Auto Scan status distinguishes target systems, checked systems, filtered fields and mission exceptions', async t => {
  const h = await harness(t, { store: { live_search: {
    enabled: true, planetId: 1, near: 10, types: ['ore'],
  } } });
  const status = {
    state: 'idle', at: Date.now(), target: 10, targetProgress: 10, typeFiltered: true,
    matchingSystems: 10, scanned: 83, found: 17, matchingFields: 16, missionExceptions: 1,
  };
  await globalThis.browser.storage.local.set({ live_search_status: status });
  await settle();
  assert.match(h.el('ls-status').textContent, /Target 10\/10 · Checked 83 · Fields 16 \+ 1 mission/);
  assert.ok(h.el('ls-status').textContent.length < 100, 'routine status stays compact');
  assert.match(h.el('ls-status').title, /up to 15 minutes/);
  await globalThis.browser.storage.local.set({ live_search_status: {
    ...status, targetProgress: 7, matchingSystems: 7, scanned: 500, matchingFields: 3, missionExceptions: 0,
  } });
  await settle();
  assert.match(h.el('ls-status').textContent, /Target 7\/10 \(not reached\) · Checked 500 · Fields 3/);
  await globalThis.browser.storage.local.set({ live_search_status: {
    ...status, state: 'scanning', phase: 'Scanning systems…', targetProgress: 4, scanned: 28,
  } });
  assert.match(h.el('ls-status').textContent, /Target 4\/10 · Checked 28/);
  await globalThis.browser.storage.local.set({ live_search_status: {
    ...status, state: 'error', error: 'Rate limit', targetProgress: 4,
  } });
  assert.match(h.el('ls-status').textContent, /Target 4\/10 \(not reached\)/);
  await globalThis.browser.storage.local.set({ live_search_status: { state: 'idle', at: Date.now(), scanned: 83, found: 16 } });
  await settle();
  assert.match(h.el('ls-status').textContent, /Target —/);
});

test('Auto Scan updates keep matching row, controls and cells attached while changing values and removing only obsolete fields', async t => {
  const h = await harness(t);
  const { browser } = globalThis;
  await h.el('ls-search').click();
  const config = h.store.live_search;
  const fields = [21, 22].map(fieldId => ({
    fieldId, systemId: fieldId, system: `S${fieldId}`, type: 'ore', mult: fieldId === 21 ? 0.9 : 0.76,
    remaining: 100, total: 200, sx: fieldId, sy: 0,
  }));
  const snapshot = { config, planetId: 1, referenceSystem: { x: 0, y: 0 }, fields };
  await browser.storage.local.set({ asteroid_scan_results: snapshot });
  await settle();
  const row = h.rows()[0];
  const cells = [...row.children];
  const ship = cells[0].children[0];
  h.el('af-mult-min').value = '0.8';
  await h.el('af-mult-min').listeners.change({ target: h.el('af-mult-min') });
  await settle();
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0], row);
  await browser.storage.local.set({ asteroid_scan_results: {
    ...snapshot, config: h.store.live_search, updating: true,
    fields: [{ ...fields[0], remaining: 80 }],
  } });
  await settle();
  assert.equal(h.rows()[0], row);
  assert.deepEqual(row.children, cells, 'all cells remain attached, including the fuel cell');
  assert.equal(row.children[0].children[0], ship, 'the focused launch control is not replaced');
  assert.equal(row.children[4].textContent, '80 / 200');
  assert.equal(h.el('af-progress').textContent, 'Updating…');
  h.module.renderAsteroids();
  h.module.renderAsteroids();
  assert.equal(h.rows()[0], row);
  assert.equal(row.children[1].children.length, 3, 'mission badges and notes never accumulate');
});

test('Asteroids uses Scout badges for zones, resource types and alliances and updates badges in place', async t => {
  const h = await harness(t);
  const { zoneBadge } = await import('../nexus-addon/common.js');
  await h.el('ls-search').click();
  const config = h.store.live_search;
  const fields = ['sentinel', 'open', 'dead', 'rift', 'unknown'].map((zone, i) => ({
    fieldId: 100 + i, systemId: i + 2, system: `S${i}`, zone, type: 'ore',
    mult: 1, remaining: 100, total: 200, sx: i, sy: 0,
  }));
  const snapshot = { config, referenceSystem: { x: 0, y: 0 }, fields };
  await globalThis.browser.storage.local.set({ asteroid_scan_results: snapshot });
  await settle();
  h.rows().forEach((row, i) => {
    assert.equal(row.children[6].children[0].className, zoneBadge(fields[i].zone).className);
    assert.equal(row.children[6].children[0].textContent, fields[i].zone);
    assert.equal(row.children[2].children[0].className, 'finder-badge asteroids-type-badge');
    assert.equal(row.children[2].children[0].textContent, 'ore');
    assert.equal(row.children[3].children[0].className, 'finder-badge asteroids-mult-badge');
    assert.equal(row.children[3].children[0].textContent, '×1');
    assert.equal(row.children[8].children[0].className, '');
    assert.equal(row.children[8].children[0].textContent, '—');
    assert.equal(row.children[8].children[1].hidden, true);
  });
  const row = h.rows()[0], badge = row.children[6].children[0], type = row.children[2].children[0];
  await globalThis.browser.storage.local.set({ asteroid_scan_results: {
    ...snapshot, fields: [{ ...fields[0], zone: 'rift', type: 'gas' }, ...fields.slice(1)],
  } });
  await settle();
  assert.equal(h.rows()[0], row);
  assert.equal(row.children[6].children[0], badge);
  assert.equal(badge.className, 'finder-badge finder-zone-rift');
  assert.equal(row.children[2].children[0], type);
  assert.equal(type.textContent, 'gas');
  const mult = row.children[3].children[0];
  await globalThis.browser.storage.local.set({ asteroid_scan_results: {
    ...snapshot, fields: [{ ...fields[0], mult: null }],
  } });
  await settle();
  assert.equal(row.children[3].children[0], mult);
  assert.equal(mult.textContent, '—');
  assert.equal(mult.className, '', 'unknown multipliers do not get a highlighted badge');
});

test('external live filter changes update shared controls and ignore older mission snapshots', async t => {
  const h = await harness(t);
  const config = { enabled: true, planetId: 1, near: 5, types: ['gas'], leftMin: 90 };
  await globalThis.browser.storage.local.set({ live_search: config });
  await settle();
  assert.equal(h.el('af-near').value, '5');
  assert.equal(h.el('af-left-min').value, '90');
  await globalThis.browser.storage.local.set({ asteroid_scan_results: {
    config, referenceSystem: { x: 0, y: 0 }, missionsAt: 1,
    missions: [{ missionType: 'mine', targetFieldId: 21 }],
    fields: [{ fieldId: 21, systemId: 2, type: 'gas', missing: true }],
  } });
  await settle();
  assert.equal(h.rows().length, 0, 'old pass missions cannot revive a returned mission');
});

test('field ID button copies its ID, survives updates and explicitly reports clipboard errors', async t => {
  const h = await harness(t, { store: { template_selections: { 'af-near': '1' } } });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  const copied = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true,
    value: { writeText: async value => { copied.push(value); } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis.navigator, 'clipboard', descriptor);
    else delete globalThis.navigator.clipboard;
  });
  await h.scan();
  const button = h.rows()[0].children[7].children[0];
  assert.equal(button.type, 'button');
  assert.equal(button.title, 'Copy field ID');
  await button.onclick();
  assert.deepEqual(copied, ['2']);
  assert.equal(button.textContent, '2', 'copy feedback never replaces the ID');
  assert.equal(button.title, 'Copied');
  assert.equal(h.el('af-progress').textContent, 'Copied ID 2');
  h.module.renderAsteroids();
  assert.equal(h.rows()[0].children[7].children[0], button);
  globalThis.navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); };
  await button.onclick();
  assert.equal(button.title, 'Copy failed');
  assert.equal(h.el('af-progress').textContent, 'Copy failed: Permission denied');
});

test('refresh removes normal filtered and absent fields but retains own missions with explicit missing/unknown states', () => {
  const fields = [1, 2, 3, 4].map(fieldId => ({
    fieldId, systemId: fieldId, type: 'ore', zone: 'open', remaining: 80, total: 100, mult: 2,
  }));
  const config = { leftMin: 50 };
  const missions = new Set([2, 3, 4]);
  const changed = fields.slice(0, 2).map(f => ({ ...f, remaining: 20 }));
  const observations = new Map([
    [1, { fields: [changed[0]], at: 100 }], [2, { fields: [changed[1]], at: 100 }],
    [3, { fields: [], at: 100 }],
  ]);
  const reconciled = retainMiningFields(changed, fields, missions, observations);
  const pending = retainMiningFields(changed, fields, missions, observations, true);
  assert.equal(pending.find(f => f.fieldId === 4), fields[3],
    'pending own fields keep their row data until checked instead of flashing empty values');
  assert.deepEqual(visibleAsteroidFields(reconciled, config, missions).map(f => f.fieldId), [2, 3, 4]);
  const missing = reconciled.find(f => f.fieldId === 3);
  assert.equal(missing.missing, true);
  assert.equal(missing.remaining, null);
  const unknown = reconciled.find(f => f.fieldId === 4);
  assert.equal(unknown.missing, false, 'a failed/unperformed request is not proof of absence');
  assert.equal(unknown.unconfirmed, true);
  assert.equal(unknown.remaining, null);
  assert.deepEqual(visibleAsteroidFields(reconciled, config, new Set()), [],
    'all exceptions end when own missions end');
});

test('manual refresh retains below-filter mining fields, removes vanished normal fields and clears exceptions after return', async t => {
  let missions = [{ missionType: 'mine', targetFieldId: 22 }];
  let currentFields = [field(21), field(22)];
  const h = await harness(t, { store: { template_selections: { 'af-near': '1', 'af-left-min': '40' } },
    respond: message => message.type === 'GET_MISSIONS' ? { missions } : undefined,
    fetchSystem: () => ({ asteroidFields: currentFields, included: { fields: true } }),
  });
  await h.scan();
  assert.equal(h.rows().length, 2);
  currentFields = [field(22, 'ore', { remainingResources: 100 })];
  await saveSystem('s0', 2, { asteroidFields: currentFields, included: { fields: true } });
  await h.scan();
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].dataset.field, 22);
  assert.match(h.rows()[0].textContent, /Own mining mission - outside filters/);
  missions = [];
  h.timers.find(timer => timer.interval === 10000).run();
  await settle();
  await settle();
  assert.equal(h.rows().length, 0);
});

test('vanished field with own mission stays marked without resource values or launch action', async t => {
  const missions = [{ missionType: 'mine', targetFieldId: 22 }];
  const h = await harness(t, { store: { template_selections: { 'af-near': '1' } },
    respond: message => message.type === 'GET_MISSIONS' ? { missions } : undefined,
    data: { 2: { asteroidFields: [field(22)] } },
  });
  await h.scan();
  await saveSystem('s0', 2, { asteroidFields: [], included: { fields: true } });
  await h.scan();
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].textContent, /Field no longer present/);
  assert.equal(h.rows()[0].children[4].textContent, '—');
  assert.equal(h.rows()[0].children[0].children[0].listeners.click, undefined);
  assert.equal(h.rows()[0].children[0].children[0].onclick, null);
});
