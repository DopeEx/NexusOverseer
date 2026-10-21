import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { makeBrowserStub } from './helpers.js';

class Element {
  constructor(tag = '') {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute() {}
  addEventListener() {}
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  get isConnected() { return this.tag === 'body' || !!this.parent?.isConnected; }
  find(predicate) {
    return this.children.flatMap(child => [child, ...child.find(predicate)]).filter(predicate);
  }
}

async function overlay(t, { duringLoad } = {}) {
  const config = { enabled: true, planetId: 1, multMin: 0.75 };
  const matches = [0.76, 0.79, 0.8, 0.9].map((mult, id) => ({
    id: id + 1, systemId: id + 1, system: `S${id}`, type: 'ore', zone: 'open',
    mult, remaining: 100, total: 200,
  }));
  const store = makeBrowserStub({ live_search: config, live_search_last_matches: matches });
  const { browser } = globalThis;
  const body = new Element('body');
  const document = { body, createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element(); node.textContent = text; return node; } };
  let missions = [];
  const timers = [];
  const requests = [];
  const source = await readFile(new URL('../nexus-addon/sidebar-inject.js', import.meta.url), 'utf8');
  const panelSource = source.slice(source.indexOf('let fieldsPanel = null;'),
    source.indexOf("ext.runtime.onMessage.addListener(msg =>"));
  const create = new Function('ext', 'rt', 'document', 'localStorage', 'setInterval',
    'fieldsRequest', 'recommend', 'MINING_SHIPS', 'TYPE_COLOR', 'makeDraggable', 'openFieldsPanelSafe',
    `${panelSource}\nreturn openFieldsPanel;`);
  const open = create(browser,
    { getURL: name => new URL(`../nexus-addon/${name}`, import.meta.url).href },
    document, { getItem: () => null }, run => { timers.push(run); return timers.length; },
    async message => {
      requests.push(message);
      if (message.type === 'GET_MISSIONS') return { missions };
      if (message.type === 'GET_PLANETS') {
        await duringLoad?.(browser);
        return { planets: [] };
      }
      return { ships: [], available: {} };
    },
    () => null, new Set(), {}, () => {}, () => assert.fail('filter edits must not rebuild the panel'));
  await open();
  t.after(() => body.children.forEach(child => child.remove()));
  const rows = () => body.find(node => node.tag === 'tr');
  return { store, browser, rows, body, requests, timers, setMissions: value => { missions = value; } };
}

test('game overlay immediately applies 0.75 → 0.8 without waiting for another scan or making game requests', async t => {
  const h = await overlay(t);
  assert.equal(h.rows().length, 4);
  const requests = h.requests.length;
  const panel = h.body.children[0];
  await h.browser.storage.local.set({ live_search: { ...h.store.live_search, multMin: 0.8 } });
  assert.equal(h.body.children[0], panel, 'keep the open panel and fleet edits');
  assert.deepEqual(h.rows().map(row => row.children[4].textContent), ['×0.8', '×0.9']);
  assert.equal(h.requests.length, requests);
  await h.browser.storage.local.set({ live_search_last_matches: h.store.live_search_last_matches });
  assert.equal(h.rows().length, 2, 'late old results must still respect the current filter');
  await h.browser.storage.local.set({ live_search: { ...h.store.live_search, multMin: 0.75 } });
  assert.equal(h.rows().length, 4, 'relaxing the filter reveals saved matches without a new scan');
});

test('game overlay keeps only active own missions outside edited filters and recomputes exception labels', async t => {
  const h = await overlay(t);
  h.setMissions([{ missionType: 'mine', targetFieldId: 1 }]);
  await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  await h.browser.storage.local.set({ live_search: { ...h.store.live_search, multMin: 0.8 } });
  assert.equal(h.rows().length, 3);
  assert.match(h.rows()[0].textContent, /Own mining mission - outside filters/);
  await h.browser.storage.local.set({ live_search: { ...h.store.live_search, multMin: 0.75 } });
  assert.doesNotMatch(h.rows()[0].textContent, /outside filters/);
  await h.browser.storage.local.set({ live_search: { ...h.store.live_search, multMin: 0.8 } });
  h.setMissions([]);
  await h.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows().length, 2);
});

test('game overlay catches filter changes that occur while its source data is loading', async t => {
  const h = await overlay(t, { duringLoad: browser => browser.storage.local.set({
    live_search: { enabled: true, planetId: 1, multMin: 0.8 },
  }) });
  assert.equal(h.rows().length, 2);
});

test('shared asteroid filters are shipped and accessible to the game overlay', async () => {
  const manifest = JSON.parse(await readFile(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  const files = JSON.parse(await readFile(new URL('../tools/windows-updater/addon-files.json', import.meta.url), 'utf8'));
  assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.includes('asteroid-search.js')));
  assert.ok(files.includes('asteroid-search.js'));
});

test('game Auto Scan panel is disabled for opening paths and absent from the sidebar', async () => {
  const source = await readFile(new URL('../nexus-addon/sidebar-inject.js', import.meta.url), 'utf8');
  const build = source.slice(source.indexOf('function buildSection()'), source.indexOf('// Floating, draggable'));
  const section = new Function('document', 'DASH_URL', 'ICON', 'GUIDE_ICON',
    `${build}\nreturn buildSection();`)({ createElement: () => ({}) }, '', '', '');
  assert.doesNotMatch(section.innerHTML, /data-nexus-lsbelts|Auto Scan Belts/);
  const safe = source.slice(source.indexOf('function openFieldsPanelSafe()'), source.indexOf("document.addEventListener('click'"));
  const disabled = /const AUTO_SCAN_PANEL_ENABLED = (false|true);/.exec(source)[1] === 'false';
  assert.equal(disabled, true);
  new Function('AUTO_SCAN_PANEL_ENABLED', 'openFieldsPanel',
    `${safe}\nopenFieldsPanelSafe();`)(!disabled, () => assert.fail('disabled panel must not open'));
});
