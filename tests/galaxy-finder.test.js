import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { createGalaxyCache, saveSystem, readSystem, restoreGalaxyCache, savePublicGalaxy, saveCatalog, readSavedCatalog } from '../nexus-addon/galaxy-cache.js';
import { emptyPublicGalaxy } from '../nexus-addon/galaxy-public.js';
import { makeBrowserStub } from './helpers.js';

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.width = 1100;
    this.height = 640;
    const classes = new Set();
    this.classList = {
      toggle(name, selected) { if (selected) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    };
  }
  set id(value) { this.elementId = value; this.registerId?.(value, this); }
  get id() { return this.elementId; }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
  get offsetWidth() { return this.measuredWidth ?? this.textContent.length * 7 + 8; }
  set offsetWidth(value) { this.measuredWidth = value; }
  get offsetHeight() { return this.measuredHeight ?? 20; }
  set offsetHeight(value) { this.measuredHeight = value; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
  removeAttribute(name) { delete this.attributes?.[name]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  remove() {}
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return this.rect || { width: 1100, height: 640, left: 0, top: 0 }; }
  getContext() {
    return {
      fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {},
      moveTo() {}, lineTo() {}, closePath() {},
      measureText: text => ({ width: text.length * 6 }),
      setTransform() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    };
  }
  async fire(type = 'click') { return this.listeners[type]?.call(this, { target: this }); }
}

async function harness(store = {}, account = {}) {
  await restoreGalaxyCache();
  makeBrowserStub(store);
  globalThis.nexusStorage = {
    getActiveServer: async () => ({ key: 's0', origin: 'https://s0.nexuslegacy.space' }),
    withServer: async (key, run) => run(),
  };
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = {
    getElementById: el,
    createElement: () => {
      const element = new Element();
      element.registerId = (id, node) => elements.set(id, node);
      return element;
    },
    createTextNode: text => ({ textContent: text }),
    querySelectorAll: () => [],
    documentElement: new Element(),
    body: new Element(),
  };
  const windowListeners = {};
  const densityQueries = [];
  let resizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObserver = this; }
    observe(target) { this.target = target; }
  };
  globalThis.window = {
    addEventListener(type, callback) { windowListeners[type] = callback; },
    matchMedia(query) {
      const media = { query, addEventListener(type, callback, options) { Object.assign(this, { type, callback, options }); } };
      densityQueries.push(media);
      return media;
    },
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.browser.storage.local.onChanged = globalThis.browser.storage.onChanged;
  const systems = account.systems || [1, 2, 3, 4].map(id => ({
    id, name: `Alpha-${id}`, armId: 1, sectorId: id, x: id * 10, y: id * 20, visibility: 'full',
    securityZone: ['open', 'sentinel', 'dead', 'sentinel'][id - 1],
    starType: ['orange', 'blue_giant', 'white_dwarf', undefined][id - 1],
  }));
  const planet = (id, type = 'terra', size = 220, userId = 55) => ({
    id, name: `P${id}`, planetType: type, size, temperature: 20, userId,
    ownerName: userId == null ? null : 'Former owner', ownerAllianceTag: userId == null ? null : 'OLD',
  });
  const data = {
    1: { planets: [planet(11), planet(12)], moons: [11, 12].flatMap(id =>
      [1, 2, 3].map(n => ({ id: id * 10 + n, planetId: id, moonType: 'barren', buildingSlots: 5, userId: null }))) },
    2: { planets: [planet(21, 'ice')], moons: [] },
    3: { planets: [planet(31, 'terra', 180)], moons: [] },
    4: { planets: [planet(41)], moons: [] },
  };
  const at = Date.now() - 30 * 86400000;
  for (const [id, contents] of Object.entries(data)) await saveSystem('s0', Number(id), contents, at);
  if (account.publicData) await savePublicGalaxy('s0', account.publicData, 'a'.repeat(64));
  const calls = [];
  const deltas = [];
  const requests = [];
  const cache = createGalaxyCache({
    storage: { get: async () => ({}), remove: async () => {} },
    fetcher: async path => {
      requests.push(path);
      return data[Number(/systems\/(\d+)/.exec(path)[1])];
    },
  });
  globalThis.browser.runtime.sendMessage = async message => {
    calls.push(message);
    if (message.type === 'GET_ARMS') return { arms: [{ id: 1, name: 'Alpha', sectorCount: 50 }] };
    if (message.type === 'GET_GALAXY_MAP') {
      if (account.publicData) {
        await saveCatalog('s0', '/api/galaxy/map', { systems });
        return readSavedCatalog('s0', '/api/galaxy/map');
      }
      return { systems };
    }
    if (message.type === 'GET_GALAXY_DELTAS') return { deltas };
    if (message.type === 'GET_AUTH_ME') return { user: { id: 7, username: 'Test Commander' }, planets: [], ...account.me };
    if (message.type === 'GET_ALLIANCE') return account.alliance || {};
    if (message.type === 'GET_HUBS') return {};
    if (message.type === 'GET_STATION_INDEX') return account.stationResponse || { stations: [{
      stationId: 1, stationName: 'Test Station', systemId: 2, systemName: 'Alpha-2',
      systemX: 20, systemY: 40, ownedByViewerAlliance: true, ownerAllianceId: 1,
      ownerAllianceName: 'Team', ownerAllianceTag: 'TEAM', capturingAllianceTag: 'OTHER',
    }] };
    if (message.type === 'GET_GALAXY_SCANS') return { scans: await cache.scans('s0') };
    if (message.type === 'GET_SYSTEM_PLANETS') return cache.system('s0', message.systemId, message);
    if (message.type === 'GET_PLAYER_RANK') return { military: 9 };
    if (message.type === 'GET_PUBLIC_GALAXY_STATUS') return account.publicStatus || {};
    if (message.type === 'UPDATE_PUBLIC_GALAXY') return account.publicStatus || { message: 'Up to date.' };
    if (message.type === 'EXPORT_PUBLIC_GALAXY') return account.publicExport || { data: emptyPublicGalaxy('s0') };
    assert.fail(`Unexpected ${message.type}`);
  };
  const finder = await import(`../nexus-addon/tabs/finder.js?test=${crypto.randomUUID()}`);
  await finder.initFinderTab();
  const initialArm = el('f-arm').value;
  const initialSectorDisabled = el('f-sector').disabled;
  await finder.selectFinderView('search');
  el('f-arm').value = '1';
  await el('f-types').children.find(button => button.dataset.value === 'terra').fire();
  el('f-min-size').value = '200';
  el('f-min-moons').value = '3';
  calls.length = 0;
  return { el, calls, requests, finder, data, store, initialArm, initialSectorDisabled, deltas,
    windowListeners, densityQueries, resizeObserver };
}

test('map uses CSS coordinates and a device-density backing buffer without scaling text or navigation', async () => {
  const h = await harness({}, { me: { planets: [{ systemId: 1, isHomeworld: true }] } });
  const canvas = h.el('f-map');
  canvas.rect = { width: 825.25, height: 480.125, left: 40, top: 60 };
  const context = canvas.getContext();
  const transforms = [];
  context.setTransform = (...args) => transforms.push(args);
  canvas.getContext = () => context;
  globalThis.window.devicePixelRatio = 2;
  h.finder.drawGalaxyMap();
  assert.equal(canvas.width, 1651);
  assert.equal(canvas.height, 960);
  assert.deepEqual(transforms.at(-1), [1651 / 825.25, 0, 0, 960 / 480.125, 0, 0]);
  assert.ok(h.el('f-map-labels').children.some(label => label.textContent === 'Test Commander'));
  h.finder.focusSystem(1);
  const projected = () => ({
    x: h.finder.mapBaseX(canvas, 10) * h.finder.mapView.scale + h.finder.mapView.ox,
    y: h.finder.mapBaseY(canvas, 20) * h.finder.mapView.scale + h.finder.mapView.oy,
  });
  assert.deepEqual(projected(), { x: 825.25 / 2, y: 480.125 / 2 });
  assert.deepEqual(h.finder.mapCursor(canvas, { clientX: 140, clientY: 160 }),
    { x: 100, y: 100, rect: canvas.rect });
  await h.el('f-map-zoom-in').fire();
  assert.deepEqual(projected(), { x: 825.25 / 2, y: 480.125 / 2 });
  const before = projected();
  const beforeView = { ...h.finder.mapView };
  globalThis.window.devicePixelRatio = 1.25;
  h.densityQueries.at(-1).callback();
  assert.equal(canvas.width, Math.round(825.25 * 1.25));
  assert.equal(canvas.height, Math.round(480.125 * 1.25));
  assert.deepEqual(projected(), before);
  assert.deepEqual(h.finder.mapView, beforeView);
  assert.equal(h.densityQueries.at(-1).query, '(resolution: 1.25dppx)');
  assert.deepEqual(h.densityQueries[0].options, { once: true });
  assert.deepEqual(h.requests, []);
});

test('public-only planets produce local search matches without scanning or treating unknown owners as unclaimed', async () => {
  const publicData = { ...emptyPublicGalaxy('s0'), systems: [{
    id: 5, name: 'Shared System', x: 50, y: 100, armId: 1, sectorId: 5, securityZone: 'open',
    planets: [{ id: 51, planetType: 'terra', size: 220 }], moons: [],
  }] };
  const h = await harness({}, { publicData });
  h.el('f-min-moons').value = '0';
  await h.el('f-search').fire();
  const shared = h.finder.finderHits.find(hit => hit.systemId === 5);
  assert.ok(shared);
  assert.equal(shared.ownershipKnown, false);
  assert.equal(shared.planet, 'Planet #51');
  assert.ok(!h.calls.some(call => call.type === 'GET_SYSTEM_PLANETS' && call.systemId === 5));
  assert.equal(h.finder.galaxySystems.find(system => system.id === 5).visibility, 'unknown');
  h.finder.focusSystem(5);
  const canvas = h.el('f-map');
  canvas.listeners.click({ currentTarget: canvas,
    clientX: h.finder.mapBaseX(canvas, 50) * h.finder.mapView.scale + h.finder.mapView.ox,
    clientY: h.finder.mapBaseY(canvas, 100) * h.finder.mapView.scale + h.finder.mapView.oy });
  await h.el('f-map-info-overview').fire();
  assert.match(h.el('f-system-body').textContent, /Includes public base data/);
  assert.match(h.el('f-system-body').textContent, /Ownership checked: unknown/);
});

test('missing public moon slots are resolved only for game-visible systems, never unlocked by imported data', async () => {
  const publicData = { ...emptyPublicGalaxy('s0'), systems: [{
    id: 5, name: 'Shared System', x: 50, y: 100, armId: 1, sectorId: 5,
    planets: [{ id: 51, planetType: 'terra', size: 220 }],
    moons: [{ id: 52, planetId: 51, moonType: 'icy' }],
  }] };
  const visible = await harness({}, { publicData, systems: [{ id: 5, name: 'Visible', x: 50, y: 100,
    armId: 1, sectorId: 5, visibility: 'full' }] });
  visible.data[5] = { planets: [{ id: 51, planetType: 'terra', size: 220, userId: null }],
    moons: [{ id: 52, planetId: 51, moonType: 'icy', buildingSlots: 5, userId: null }] };
  visible.el('f-min-moons').value = '0';
  visible.el('f-min-moon-slots').value = '5';
  await visible.el('f-search').fire();
  assert.equal(visible.finder.finderHits.length, 1);
  assert.equal(visible.requests.length, 1);
  const unknown = await harness({}, { publicData, systems: [] });
  unknown.el('f-min-moons').value = '0';
  unknown.el('f-min-moon-slots').value = '5';
  await unknown.el('f-search').fire();
  assert.deepEqual(unknown.finder.finderHits, []);
  assert.deepEqual(unknown.requests, []);
});

test('map resize preserves the world-space center and zoom, including hidden panels and container-only changes', async () => {
  const h = await harness();
  const canvas = h.el('f-map');
  h.finder.focusSystem(2);
  const scale = h.finder.mapView.scale;
  canvas.rect = { width: 600, height: 400, left: 10, top: 20 };
  assert.equal(h.resizeObserver.target, canvas);
  h.resizeObserver.callback();
  const centered = () => ({
    x: h.finder.mapBaseX(canvas, 20) * scale + h.finder.mapView.ox,
    y: h.finder.mapBaseY(canvas, 40) * scale + h.finder.mapView.oy,
  });
  assert.ok(Math.abs(centered().x - 300) < 1e-9);
  assert.ok(Math.abs(centered().y - 200) < 1e-9);
  assert.equal(h.finder.mapView.scale, scale);
  const before = { ...h.finder.mapView };
  canvas.rect = { width: 0, height: 0, left: 0, top: 0 };
  h.resizeObserver.callback();
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 400);
  assert.deepEqual(h.finder.mapView, before);
  canvas.rect = { width: 900, height: 500, left: 10, top: 20 };
  h.windowListeners.resize();
  assert.ok(Math.abs(centered().x - 450) < 1e-9);
  assert.ok(Math.abs(centered().y - 250) < 1e-9);
  assert.equal(h.finder.mapView.scale, scale);
  assert.deepEqual(h.requests, []);
});

test('native labels use measured boxes, stay collision-free, do not accumulate and clear on universe reset', async () => {
  const h = await harness({}, { me: { planets: [{ systemId: 1 }] } });
  const canvas = h.el('f-map');
  const context = canvas.getContext();
  context.fillText = () => assert.fail('Text must not be rasterized into the map canvas');
  canvas.getContext = () => context;
  h.finder.galaxyHubs.push({ name: '<img src=x onerror=alert(1)>', x: 10, y: 20 });
  h.finder.focusSystem(1);
  const layer = h.el('f-map-labels');
  const count = layer.children.length;
  assert.equal(count, 2);
  assert.equal(layer.children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(layer.children[1].children.length, 0, 'names remain plain text');
  const visible = layer.children.filter(label => label.style.visibility !== 'hidden');
  assert.equal(visible.length, 2);
  const boxes = visible.map(label => ({
    x: parseFloat(label.style.left), y: parseFloat(label.style.top),
    width: label.offsetWidth, height: label.offsetHeight,
  }));
  for (const box of boxes) {
    assert.equal(Number.isInteger(box.x) && Number.isInteger(box.y), true);
    assert.ok(box.x >= 0 && box.x + box.width <= 1100);
    assert.ok(box.y >= 0 && box.y + box.height <= 640);
  }
  const [a, b] = boxes;
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  h.finder.drawGalaxyMap();
  assert.equal(layer.children.length, count, 'redraw replaces rather than accumulates labels');
  h.finder.resetFinderTab();
  assert.equal(layer.children.length, 0);
  assert.deepEqual(h.requests, []);
});

test('own systems show the player name and allied brackets plus an additional own chevron', async () => {
  const h = await harness({}, { me: { user: { id: 7, username: 'My Commander' },
    planets: [{ systemId: 1 }] }, alliance: { memberIds: [55] } });
  const context = h.el('f-map').getContext();
  const colors = [];
  context.stroke = () => colors.push(context.strokeStyle);
  h.el('f-map').getContext = () => context;
  h.finder.focusSystem(1);
  const label = h.el('f-map-labels').children.find(label => label.textContent.includes('My Commander'));
  assert.equal(label.textContent, 'My Commander, Former owner');
  assert.equal(label.style.color, '#7ee787');
  assert.equal(label.style.visibility, '');
  const systemY = h.finder.mapBaseY(h.el('f-map'), 20) * h.finder.mapView.scale + h.finder.mapView.oy;
  assert.equal(parseFloat(label.style.top), Math.round(systemY + 15),
    'the name sits directly below the selected system, independently of the chevron above');
  assert.ok(colors.includes('#7ee787'));
  assert.ok(colors.includes('#38bdf8'));
  assert.deepEqual(h.requests, []);
});

test('HiDPI hover, dragging and cursor-anchored wheel zoom stay in CSS coordinates', async () => {
  const h = await harness();
  const canvas = h.el('f-map');
  canvas.rect = { width: 550, height: 320, left: 20, top: 30 };
  globalThis.window.devicePixelRatio = 2;
  h.finder.drawGalaxyMap();
  const point = () => ({
    x: h.finder.mapBaseX(canvas, 20) * h.finder.mapView.scale + h.finder.mapView.ox,
    y: h.finder.mapBaseY(canvas, 40) * h.finder.mapView.scale + h.finder.mapView.oy,
  });
  const start = point();
  const event = { currentTarget: canvas, clientX: start.x + 20, clientY: start.y + 30 };
  canvas.listeners.mousemove(event);
  assert.ok(h.el('f-tooltip').textContent.includes('Alpha-2'));
  assert.equal(h.el('f-tooltip').style.display, 'block');
  let prevented = false;
  canvas.listeners.wheel({ ...event, deltaY: -1, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(Math.abs(point().x - start.x) < 1e-9);
  assert.ok(Math.abs(point().y - start.y) < 1e-9);
  canvas.listeners.mousedown({ ...event, button: 0 });
  canvas.listeners.mousemove({ ...event, clientX: event.clientX + 35, clientY: event.clientY + 25 });
  assert.ok(Math.abs(point().x - start.x - 35) < 1e-9);
  assert.ok(Math.abs(point().y - start.y - 25) < 1e-9);
  h.windowListeners.mouseup();
  assert.equal(h.finder.mapPan, null);
  assert.deepEqual(h.requests, []);
});

test('map clicks show saved information and open overview locally; dragging and empty clicks do not open it', async () => {
  const h = await harness();
  const canvas = h.el('f-map');
  const click = id => canvas.listeners.click({
    currentTarget: canvas, clientX: h.finder.mapBaseX(canvas, id * 10) * h.finder.mapView.scale + h.finder.mapView.ox,
    clientY: h.finder.mapBaseY(canvas, id * 20) * h.finder.mapView.scale + h.finder.mapView.oy,
  });
  click(2);
  assert.deepEqual(h.finder.mapView, { scale: 1, ox: 0, oy: 0 }, 'clicking selects without moving the map');
  assert.equal(h.el('f-map-info').hidden, false);
  assert.equal(h.el('f-map-search').value, 'Alpha-2');
  assert.match(h.el('f-map-info-title').textContent, /Alpha-2.*#2/);
  assert.match(h.el('f-map-info-details').textContent, /Planets: 1 saved · Moons: 0 saved/);
  await h.el('f-map-info-overview').fire();
  assert.equal(h.el('f-map-info').hidden, true);
  assert.match(h.el('f-system-title').textContent, /Alpha-2/);
  await h.el('f-system-close').fire();
  click(1);
  h.windowListeners.keydown({ key: 'Escape' });
  assert.equal(h.el('f-map-info').hidden, true);
  click(1);
  h.windowListeners.mousedown({ target: {} });
  assert.equal(h.el('f-map-info').hidden, true);
  const event = { currentTarget: canvas, button: 0, clientX: 200, clientY: 200 };
  canvas.listeners.mousedown(event);
  canvas.listeners.mousemove({ ...event, clientX: 220 });
  h.windowListeners.mouseup();
  click(1);
  assert.equal(h.el('f-map-info').hidden, true);
  canvas.listeners.click({ currentTarget: canvas, clientX: -100, clientY: -100 });
  assert.equal(h.el('f-map-info').hidden, true);
  click(1);
  h.finder.resetFinderTab();
  assert.equal(h.el('f-map-info').hidden, true);
  assert.deepEqual(h.requests, []);
});

test('station layer loads only on demand, renders own-alliance stations and includes last-known capture details', async () => {
  const h = await harness();
  assert.ok(!h.calls.some(call => call.type === 'GET_STATION_INDEX'));
  const button = h.el('f-map-stations'), canvas = h.el('f-map');
  await button.fire();
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.classList.contains('is-selected'), true);
  assert.equal(h.calls.filter(call => call.type === 'GET_STATION_INDEX').length, 1);
  h.finder.focusSystem(2);
  assert.ok(h.el('f-map-labels').children.some(label => label.textContent === 'Test Station [TEAM]'));
  const click = () => canvas.listeners.click({ currentTarget: canvas,
    clientX: h.finder.mapBaseX(canvas, 20) * h.finder.mapView.scale + h.finder.mapView.ox,
    clientY: h.finder.mapBaseY(canvas, 40) * h.finder.mapView.scale + h.finder.mapView.oy });
  click();
  assert.match(h.el('f-map-info-details').textContent, /Test Station.*TEAM.*Capture: \[OTHER\].*last known/);
  await button.fire();
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.ok(!h.el('f-map-labels').children.some(label => label.textContent.includes('Test Station')));
  h.finder.resetFinderTab();
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-selected'), false);
  assert.deepEqual(h.requests, []);
});

test('station request failures are visible and do not enable the layer', async () => {
  const h = await harness({}, { stationResponse: { error: 'Offline' } });
  await h.el('f-map-stations').fire();
  assert.match(h.el('f-map-navigation-status').textContent, /Stations could not be loaded: Offline/);
  assert.equal(h.el('f-map-stations').attributes['aria-pressed'], 'false');
  assert.equal(h.el('f-map-stations').disabled, false);
});

test('index-only station coordinates are clickable without implying explored contents or scanning', async () => {
  const h = await harness({}, { stationResponse: { stations: [{
    stationId: 2, stationName: 'Distant Station', systemId: 99, systemName: 'Distant',
    systemX: 25, systemY: 50, ownedByViewerAlliance: false, ownerAllianceId: null,
    ownerAllianceName: null, ownerAllianceTag: null, capturingAllianceTag: null,
  }] } });
  await h.el('f-map-stations').fire();
  h.finder.focusSystem(99);
  const canvas = h.el('f-map');
  canvas.listeners.click({ currentTarget: canvas,
    clientX: h.finder.mapBaseX(canvas, 25) * h.finder.mapView.scale + h.finder.mapView.ox,
    clientY: h.finder.mapBaseY(canvas, 50) * h.finder.mapView.scale + h.finder.mapView.oy });
  assert.match(h.el('f-map-info-title').textContent, /Distant/);
  assert.match(h.el('f-map-info-details').textContent, /Visibility: unknown/);
  assert.match(h.el('f-map-info-details').textContent, /Distant Station.*Unclaimed/);
  assert.equal(h.el('f-map-search').value, 'Distant');
  assert.deepEqual(h.requests, []);
});

test('a station response after a universe reset cannot restore the old layer', async () => {
  const h = await harness();
  let resolve;
  globalThis.browser.runtime.sendMessage = () => new Promise(done => { resolve = done; });
  const pending = h.el('f-map-stations').fire();
  assert.equal(h.el('f-map-stations').disabled, true);
  h.finder.resetFinderTab();
  resolve({ stations: [] });
  await pending;
  assert.equal(h.el('f-map-stations').attributes['aria-pressed'], 'false');
  assert.equal(h.el('f-map-stations').disabled, false);
});

test('live system colony hints update an open overview without changing views, results or cached body ownership', async () => {
  const h = await harness();
  await h.finder.selectFinderView('systems');
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  assert.equal(h.el('f-system-overview').open, true);
  const systemBody = h.el('f-system-body').children;
  const before = await readSystem('s0', 1);
  h.calls.length = 0;
  h.deltas.push({ type: 'colonized', systemId: 1, hasColonies: true, at: Date.now() });
  globalThis.browser.storage.onChanged.notify({ galaxy_delta_revision: { newValue: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.finder.galaxySystems[0].hasColonies, true);
  assert.match(h.el('f-system-colony-state').textContent, /Colonies reported/);
  assert.match(h.el('f-system-colony-state').title, /Does not identify a planet or owner/);
  assert.equal(h.el('f-system-overview').open, true);
  assert.equal(h.el('f-system-body').children, systemBody, 'do not reopen dialog or lose row highlights');
  assert.equal(h.el('f-tab-systems').attributes['aria-selected'], 'true');
  assert.deepEqual(await readSystem('s0', 1), before);
  assert.deepEqual(h.calls.map(call => call.type), ['GET_GALAXY_DELTAS']);
  assert.deepEqual(h.requests, []);
});

test('live hints arriving after a universe reset cannot repopulate the previous universe', async () => {
  const h = await harness();
  let release;
  globalThis.browser.runtime.sendMessage = message => {
    assert.equal(message.type, 'GET_GALAXY_DELTAS');
    return new Promise(resolve => { release = resolve; });
  };
  globalThis.browser.storage.onChanged.notify({ galaxy_delta_revision: { newValue: {} } });
  h.finder.resetFinderTab();
  release({ deltas: [{ type: 'colonized', systemId: 1, hasColonies: true, at: Date.now() }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.finder.galaxySystems, null);
  assert.equal(h.el('f-system-overview').open, undefined);
  assert.deepEqual(h.requests, []);
});

test('a live-hint read failure is visible without discarding saved galaxy knowledge', async () => {
  const h = await harness();
  const systems = h.finder.galaxySystems;
  globalThis.browser.runtime.sendMessage = async () => ({ error: 'Database unavailable' });
  globalThis.browser.storage.onChanged.notify({ galaxy_delta_revision: { newValue: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.el('f-search-storage-status').textContent, /Galaxy live state could not be loaded: Database unavailable/);
  assert.equal(h.finder.galaxySystems, systems);
  assert.deepEqual(h.requests, []);
});

test('HTTP data refreshed after a live hint updates saved views and search ownership without another game request', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  await h.finder.selectFinderView('planets');
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  const selected = h.el('f-system-body').textContent;
  assert.ok(selected.length > 0);
  h.calls.length = 0;
  await saveSystem('s0', 1, {
    ...h.data[1], planets: h.data[1].planets.map(planet => ({ ...planet, userId: 999, ownerName: 'New owner' })),
  });
  globalThis.browser.storage.onChanged.notify({ galaxy_system_revision: { newValue: { systemId: 1, at: Date.now() } } });
  for (let i = 0; i < 100 && h.finder.finderHits[0].userId !== 999; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.finder.finderHits[0].userId, 999);
  assert.match(h.el('f-system-body').textContent, /New owner/);
  assert.equal(h.el('f-system-overview').open, true);
  assert.equal(h.el('f-tab-planets').attributes['aria-selected'], 'true');
  const highlighted = [];
  const visit = element => {
    if ((element.className || '').split(' ').includes('finder-system-selected')) highlighted.push(element.dataset.bodyId);
    for (const child of element.children || []) visit(child);
  };
  visit(h.el('f-system-body'));
  assert.deepEqual(highlighted, ['11']);
  assert.deepEqual(h.calls.map(call => call.type), ['GET_GALAXY_SCANS']);
  assert.deepEqual(h.requests, []);
});

test('a saved-data refresh arriving after switching universes cannot restore old results', async () => {
  const h = await harness();
  let release;
  globalThis.browser.runtime.sendMessage = message => {
    assert.equal(message.type, 'GET_GALAXY_SCANS');
    return new Promise(resolve => { release = resolve; });
  };
  globalThis.browser.storage.onChanged.notify({ galaxy_system_revision: { newValue: { systemId: 1, at: Date.now() } } });
  h.finder.resetFinderTab();
  release({ scans: { 1: { data: h.data[1], at: Date.now() } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.finder.galaxySystems, null);
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-system-body').children.length, 0);
});

test('Terra / Alpha / size 200 / three moons uses old base data without ownership or rank requests', async () => {
  const h = await harness();
  const pending = h.el('f-search').fire();
  assert.match(h.el('f-progress').textContent, /Searching saved data/);
  await pending;
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.calls.map(call => call.type), ['GET_GALAXY_SCANS']);
  assert.equal(h.el('f-check-ownership').disabled, false);
  assert.equal(h.el('f-results-tbody').children.length, 2);
});

for (const blockedType of ['GET_GALAXY_SCANS', 'GET_SYSTEM_PLANETS']) {
  test(`stopping during ${blockedType} allows an identical search and ignores the old result`, async () => {
    const h = await harness();
    if (blockedType === 'GET_SYSTEM_PLANETS') {
      await restoreGalaxyCache();
      await saveSystem('s0', 1, h.data[1]);
    }
    const send = globalThis.browser.runtime.sendMessage;
    let release;
    globalThis.browser.runtime.sendMessage = message => {
      if (message.type === blockedType && !release) {
        return new Promise(resolve => { release = resolve; });
      }
      return send(message);
    };
    const first = h.el('f-search').fire();
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    assert.equal(h.finder.finderRunning, true);
    await h.el('f-search').fire();
    assert.equal(h.finder.finderRunning, false);
    assert.equal(h.el('f-search').disabled, false);
    assert.equal(h.el('f-search').textContent, 'Search');
    assert.match(h.el('f-progress').textContent, /Stopped/);
    assert.equal(h.store.galaxy_last_search.phase, 'stopped');
    await h.el('f-search').fire();
    assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
    const status = h.el('f-progress').textContent;
    release(blockedType === 'GET_GALAXY_SCANS' ? { scans: {} } : { error: 'Too many requests', status: 429 });
    await first;
    assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
    assert.equal(h.el('f-progress').textContent, status);
    assert.equal(h.store.galaxy_last_search.phase, 'complete');
    if (blockedType === 'GET_GALAXY_SCANS') assert.deepEqual(h.requests, []);
  });
}

test('zone buttons allow multiple zones and no selection searches all zones', async () => {
  const h = await harness();
  h.el('f-min-moons').value = '0';
  const toggle = async zone => h.el('f-zone').children.find(button => button.textContent === zone).fire();
  await toggle('open');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  await toggle('sentinel');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12, 41]);
  await toggle('open');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [41]);
  await toggle('sentinel');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12, 41]);
  assert.deepEqual(h.requests, []);
});

test('new searches default to all arms and planet types support multiple selections or all when empty', async () => {
  const h = await harness();
  assert.equal(h.initialArm, 'all');
  assert.equal(h.initialSectorDisabled, true);
  h.el('f-min-moons').value = '0';
  h.el('f-min-size').value = '0';
  const toggle = type => h.el('f-types').children.find(button => button.dataset.value === type).fire();
  await toggle('ice');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12, 21, 31, 41]);
  await toggle('terra');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [21]);
  await toggle('ice');
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12, 21, 31, 41]);
  assert.deepEqual(h.requests, []);
});

test('search offers exactly the six planet types and six distinct moon types from the game guide', async () => {
  const h = await harness();
  assert.deepEqual(h.el('f-types').children.map(button => button.dataset.value),
    ['rocky', 'crystalline', 'gas_giant', 'ice', 'terra', 'volcanic']);
  assert.deepEqual(h.el('f-moon-types').children.map(button => button.dataset.value),
    ['barren', 'metallic', 'icy', 'volcanic', 'hollow', 'ancient']);
});

test('maximum distance excludes systems before requests, includes its boundary and rejects missing origins', async () => {
  const h = await harness();
  h.el('f-max-distance').value = '22';
  await h.el('f-search').fire();
  assert.match(h.el('f-progress').textContent, /origin/);
  assert.deepEqual(h.calls, []);
  h.finder.myPlanets.push({ id: 7, systemX: 0, systemY: 0 });
  h.el('f-origin').value = '7';
  await h.el('f-origin').fire('change');
  await restoreGalaxyCache();
  await h.el('f-search').fire();
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.ok(h.finder.finderHits.every(hit => hit.distance === 22));
  h.el('f-max-distance').value = '21';
  h.requests.length = 0;
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.deepEqual(h.requests, []);
  assert.doesNotMatch(h.el('f-progress').textContent, /unexplored/);
});

test('minimum planet capacity reuses the slot calculation and avoids loading moons for nonmatching planets', async () => {
  const h = await harness();
  await h.el('f-types').children.find(button => button.dataset.value === 'terra').fire();
  h.data[1].planets[0].maxBuildingSlots = 30;
  h.data[1].planets[1].planetType = 'gas_giant';
  h.data[1].planets[1].size = 299;
  h.data[4].planets[0].size = undefined;
  h.el('f-min-planet-slots').value = '23';
  h.el('f-min-moons').value = '0';
  h.el('f-min-moon-slots').value = '5';
  await restoreGalaxyCache();
  for (const [id, data] of Object.entries(h.data)) await saveSystem('s0', Number(id), { planets: data.planets });
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11]);
  assert.equal(h.finder.finderHits[0].slots, 30);
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  h.el('f-min-planet-slots').value = '31';
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits, []);
  h.el('f-min-moon-slots').value = '0';
  h.el('f-min-size').value = '0';
  h.el('f-min-planet-slots').value = '0';
  await h.el('f-search').fire();
  assert.ok(!h.finder.finderHits.some(hit => hit.planetId === 41), 'unknown capacity does not satisfy an explicit zero limit');
  h.el('f-min-planet-slots').value = '';
  await h.el('f-search').fire();
  assert.ok(h.finder.finderHits.some(hit => hit.planetId === 41), 'empty capacity limit does not exclude unknown capacity');
});

test('moon type and slot filters require the same free moon, including after ownership updates and in moon results', async () => {
  const h = await harness();
  h.el('f-min-moon-slots').value = '6';
  h.data[1].moons = [
    { id: 111, planetId: 11, moonType: 'icy', buildingSlots: 4, userId: null },
    { id: 112, planetId: 11, moonType: 'metallic', buildingSlots: 10, userId: null },
    { id: 113, planetId: 11, moonType: 'icy', buildingSlots: 12, userId: 55 },
    { id: 121, parentPlanetId: 12, moonType: 'icy', buildingSlots: 6, userId: null },
    { id: 122, planetId: 12, moonType: 'metallic', buildingSlots: 10, userId: null },
    { id: 123, planetId: 12, moonType: 'ancient', buildingSlots: 2, userId: null },
  ];
  await saveSystem('s0', 1, h.data[1]);
  await h.el('f-moon-types').children.find(button => button.dataset.value === 'icy').fire();
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [12]);
  assert.deepEqual(h.finder.finderHits[0].slotMoons.map(moon => moon.id), [121]);
  await h.finder.selectFinderView('moons');
  assert.equal(h.el('f-directory-body').children.length, 1);
  await h.finder.selectFinderView('search');
  h.data[1].moons[3].userId = 55;
  await h.el('f-check-ownership').fire();
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.deepEqual(Object.keys(h.finder.hitSystems), []);
  h.data[1].moons[3].userId = null;
  await h.el('f-check-ownership').fire();
  assert.equal(h.el('f-results-tbody').children.length, 1);
  assert.ok(h.calls.filter(call => call.type === 'GET_SYSTEM_PLANETS').every(call => call.group === 'both'));
});

test('moon types without slots match any selected type regardless of ownership and fetch only missing relevant moons', async () => {
  const h = await harness();
  h.el('f-min-moons').value = '0';
  h.data[1].moons[0] = { id: 111, planetId: 11, moonType: 'icy', buildingSlots: 3, userId: 55 };
  h.data[1].moons[3] = { id: 121, planetId: 12, moonType: 'ancient', buildingSlots: 2 };
  await restoreGalaxyCache();
  for (const [id, data] of Object.entries(h.data)) await saveSystem('s0', Number(id), { planets: data.planets });
  for (const type of ['icy', 'ancient']) await h.el('f-moon-types').children.find(button => button.dataset.value === type).fire();
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets', '/api/galaxy/systems/4/planets']);
  assert.ok(h.calls.filter(call => call.type === 'GET_SYSTEM_PLANETS').every(call => call.purpose === 'static'));
  await h.finder.selectFinderView('moons');
  assert.equal(h.el('f-directory-body').children.length, 2);
});

test('unknown ownership is resolved only for moons satisfying both selected type and slot threshold', async () => {
  const h = await harness();
  h.el('f-min-moons').value = '0';
  h.el('f-min-moon-slots').value = '6';
  h.data[1].moons = [
    { id: 111, planetId: 11, moonType: 'metallic', buildingSlots: 20 },
    { id: 121, planetId: 12, moonType: 'icy', buildingSlots: 6, userId: null },
  ];
  const unknown = structuredClone(h.data[1]);
  delete unknown.moons[1].userId;
  await restoreGalaxyCache();
  for (const id of [2, 3, 4]) await saveSystem('s0', id, h.data[id]);
  await saveSystem('s0', 1, unknown);
  h.data[1].moons[0].userId = 55;
  await h.el('f-moon-types').children.find(button => button.dataset.value === 'icy').fire();
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [12]);
  assert.equal(h.el('f-results-tbody').children.length, 1);
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  await h.el('f-search').fire();
  assert.equal(h.requests.length, 1);
});

test('invalid search bounds are visible and never start requests or replace the last saved search', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  const saved = structuredClone(h.store.galaxy_last_search);
  for (const [id, value] of [['f-max-distance', '-1'], ['f-min-planet-slots', '1.2'], ['f-max-distance', 'nope']]) {
    h.el(id).value = value;
    await h.el('f-search').fire();
    assert.match(h.el('f-progress').textContent, /non-negative whole numbers/);
    assert.deepEqual(h.store.galaxy_last_search, saved);
    h.el(id).value = '';
  }
  h.el('f-max-distance').validity = { badInput: true };
  await h.el('f-search').fire();
  assert.match(h.el('f-progress').textContent, /non-negative whole numbers/);
  assert.deepEqual(h.requests, []);
});

test('last started search restores filters, sorting and cached results without system or ownership requests', async () => {
  const h = await harness();
  h.el('f-min-planet-slots').value = '20';
  await h.el('f-search').fire();
  await h.el('f-results-head').listeners.click({ target: { closest: () => ({ dataset: { key: 'planet' } }) } });
  h.el('f-exclude-mine').checked = true;
  await h.el('f-exclude-mine').fire('change');
  h.el('f-min-size').value = '999';
  h.finder.resetFinderTab();
  h.calls.length = 0;
  await h.finder.initFinderTab();
  assert.equal(h.el('f-min-size').value, '200', 'unstarted filter edits do not replace the saved search');
  assert.equal(h.el('f-min-planet-slots').value, '20');
  assert.equal(h.el('f-arm').value, '1');
  assert.equal(h.el('f-sector').disabled, false);
  assert.equal(h.el('f-exclude-mine').checked, true);
  assert.equal(h.finder.finderSort.key, 'planet');
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.match(h.el('f-progress').textContent, /Saved search/);
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.calls.filter(call => call.type === 'GET_GALAXY_SCANS').length, 1);
  assert.equal(h.calls.filter(call => call.type === 'GET_SYSTEM_PLANETS').length, 0);
  assert.deepEqual(h.requests, []);
});

test('new searches replace the saved snapshot and Clear search removes it without deleting galaxy knowledge', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  h.el('f-min-size').value = '999';
  await h.el('f-search').fire();
  assert.deepEqual(h.store.galaxy_last_search.hits, []);
  assert.equal(h.store.galaxy_last_search.config.minSize, 999);
  await h.el('f-clear-search').fire();
  assert.equal(h.store.galaxy_last_search, undefined);
  assert.equal(h.el('f-arm').value, 'all');
  assert.equal(h.el('f-sector').disabled, true);
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.equal(h.el('f-directory-scope').value, 'all');
  assert.deepEqual(h.finder.hitSystems, {});
  assert.equal((await readSystem('s0', 1)).data.planets.length, 2);
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-arm').value, 'all');
});

test('a fresh finder module restores saved results without automatically fetching system contents', async () => {
  const first = await harness();
  await first.el('f-search').fire();
  const second = await harness(structuredClone(first.store));
  assert.deepEqual(second.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.match(second.el('f-progress').textContent, /Saved search/);
  assert.deepEqual(second.requests, []);
});

test('saved searches use the real universe-scoped adapter and clearing one universe leaves the other intact', async () => {
  const h = await harness();
  globalThis.browser.storage.onChanged.listeners.length = 0;
  delete globalThis.nexusStorage;
  await import(`../nexus-addon/server-storage.js?finder=${crypto.randomUUID()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  await h.el('f-search').fire();
  const s0 = structuredClone(h.store['nexus_server:s0:galaxy_last_search']);
  assert.equal(s0.hits.length, 5);
  await storage.setActiveServer('beta');
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-arm').value, 'all');
  assert.equal(h.el('f-min-planet-slots').value, '');
  await h.el('f-search').fire();
  assert.equal(h.store['nexus_server:beta:galaxy_last_search'].hits.length, 5);
  await h.el('f-clear-search').fire();
  assert.equal(h.store['nexus_server:beta:galaxy_last_search'], undefined);
  assert.deepEqual(h.store['nexus_server:s0:galaxy_last_search'], s0);
  await storage.setActiveServer('s0');
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  assert.equal(h.finder.finderHits.length, 5);
  assert.deepEqual(h.requests, []);
});

test('clearing during an in-flight search prevents the reply from restoring results or the saved search', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  const send = globalThis.browser.runtime.sendMessage;
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_SYSTEM_PLANETS') {
      started();
      await new Promise(resolve => { release = resolve; });
      return h.data[1];
    }
    return send(message);
  };
  const pending = h.el('f-search').fire();
  await ready;
  await h.el('f-clear-search').fire();
  release();
  await pending;
  assert.equal(h.store.galaxy_last_search, undefined);
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-search').disabled, false);
});

test('persistence errors and invalid saved searches are reported explicitly', async () => {
  const h = await harness();
  globalThis.browser.storage.local.set = async () => { throw new Error('Storage full'); };
  await h.el('f-search').fire();
  assert.match(h.el('f-search-storage-status').textContent, /Search could not be saved: Storage full/);
  h.finder.resetFinderTab();
  h.store.galaxy_last_search = { version: 100 };
  await h.finder.initFinderTab();
  assert.match(h.el('f-search-storage-status').textContent, /Invalid saved search/);
  assert.deepEqual(h.requests, []);
});

test('old saved searches with invalid planet types are reported instead of silently selecting all types', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  for (const type of ['ancient', 'metallic']) {
    h.store.galaxy_last_search.config.types = [type];
    h.finder.resetFinderTab();
    await h.finder.initFinderTab();
    assert.match(h.el('f-search-storage-status').textContent, /unsupported planet or moon types/);
    assert.deepEqual(h.finder.finderHits, []);
    assert.ok(h.el('f-types').children.every(button => button.attributes['aria-pressed'] === 'false'));
  }
  assert.deepEqual(h.requests, []);
  await h.el('f-clear-search').fire();
  assert.equal(h.store.galaxy_last_search, undefined);
});
test('map system lookup supports names and IDs, handles ambiguity and opens saved overviews without requests', async () => {
  const h = await harness();
  await h.finder.selectFinderView('map');
  const input = h.el('f-map-search');
  input.value = 'alpha';
  await input.fire('input');
  assert.equal(h.el('f-map-systems').children.length, 4);
  const enter = () => input.listeners.keydown({ key: 'Enter', target: input, preventDefault() {} });
  enter();
  assert.equal(h.finder.selectedSystemId, null);
  assert.match(h.el('f-map-navigation-status').textContent, /Multiple systems/);
  input.value = '#3';
  enter();
  assert.equal(h.finder.selectedSystemId, 3);
  assert.equal(input.value, 'Alpha-3');
  assert.equal(h.el('f-map-navigation-status').textContent, '');
  const canvas = h.el('f-map');
  canvas.listeners.click({ currentTarget: canvas,
    clientX: h.finder.mapBaseX(canvas, 30) * h.finder.mapView.scale + h.finder.mapView.ox,
    clientY: h.finder.mapBaseY(canvas, 60) * h.finder.mapView.scale + h.finder.mapView.oy });
  await h.el('f-map-info-overview').fire();
  assert.match(h.el('f-system-title').textContent, /Alpha-3/);
  await h.el('f-system-close').fire();
  input.value = 'alpha';
  await input.fire('input');
  await h.el('f-map-systems').children[1].fire();
  assert.equal(h.finder.selectedSystemId, 2);
  input.value = 'missing system';
  enter();
  assert.match(h.el('f-map-navigation-status').textContent, /No known system/);
  assert.equal(h.finder.selectedSystemId, 2);
  input.value = 'ALPHA-1';
  enter();
  assert.equal(h.finder.selectedSystemId, 1);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.requests, []);
});

test('combined map lookup supports arrow selection, Escape, clear, empty results and reset', async () => {
  const h = await harness();
  const input = h.el('f-map-search'), list = h.el('f-map-systems');
  const key = value => input.listeners.keydown({ key: value, target: input, preventDefault() {} });
  input.value = 'alpha';
  await input.fire('input');
  assert.equal(input.attributes['aria-expanded'], 'true');
  assert.equal(list.hidden, false);
  assert.equal(list.children[0].attributes.role, 'option');
  assert.match(list.children[0].textContent, /Alpha-1#1 · open/);
  key('ArrowDown');
  assert.equal(input.attributes['aria-activedescendant'], list.children[0].id);
  assert.equal(list.children[0].attributes['aria-selected'], 'true');
  key('ArrowDown');
  key('Enter');
  assert.equal(h.finder.selectedSystemId, 2);
  assert.equal(input.value, 'Alpha-2');
  assert.equal(list.hidden, true);
  assert.equal(input.attributes['aria-activedescendant'], undefined);
  input.value = 'alpha';
  await input.fire('input');
  key('ArrowUp');
  key('Enter');
  assert.equal(h.finder.selectedSystemId, 4);
  await input.fire('focus');
  key('Escape');
  assert.equal(input.attributes['aria-expanded'], 'false');
  assert.equal(input.value, 'Alpha-4');
  await h.el('f-map-search-clear').fire();
  assert.equal(input.value, '');
  assert.equal(list.hidden, true);
  assert.equal(h.el('f-map-search-clear').hidden, true);
  assert.equal(h.finder.selectedSystemId, 4, 'clearing lookup does not reset the map selection or search results');
  input.value = 'no match';
  await input.fire('input');
  key('ArrowDown');
  assert.match(list.textContent, /No known system/);
  assert.equal(input.attributes['aria-activedescendant'], undefined);
  h.finder.resetFinderTab();
  assert.equal(list.hidden, true);
  assert.equal(input.value, '');
  assert.equal(input.attributes['aria-expanded'], 'false');
  assert.deepEqual(h.requests, []);
});

test('combined map lookup bounds large result lists and closes on focus leaving the widget', async () => {
  const h = await harness({}, { systems: Array.from({ length: 80 }, (_, i) => ({
    id: i + 1, name: `System ${i + 1}`, x: i, y: i, visibility: 'full',
  })) });
  const input = h.el('f-map-search');
  globalThis.window.innerHeight = 390;
  input.rect = { left: 0, top: 150, width: 400, height: 36 };
  input.value = 'System';
  await input.fire('input');
  assert.equal(h.el('f-map-systems').style.maxHeight, '192px');
  assert.equal(h.el('f-map-systems').children.length, 50);
  assert.match(h.el('f-map-match-status').textContent, /80 matches.*first 50/);
  const lookup = h.el('f-map-lookup'), outside = {};
  lookup.contains = node => node === input;
  lookup.listeners.focusout({ currentTarget: lookup, relatedTarget: input });
  assert.equal(h.el('f-map-systems').hidden, false);
  lookup.listeners.focusout({ currentTarget: lookup, relatedTarget: outside });
  assert.equal(h.el('f-map-systems').hidden, true);
  assert.equal(input.attributes['aria-expanded'], 'false');
  assert.deepEqual(h.requests, []);
});

test('map Home uses the actual homeworld rather than the search origin, with zoom and whole-galaxy controls', async () => {
  const h = await harness({}, { me: { planets: [
    { id: 1, name: 'Colony', systemId: 1, systemX: 10, systemY: 20 },
    { id: 2, name: 'Home', systemId: 3, systemX: 30, systemY: 60, isHomeworld: true },
  ] } });
  h.el('f-origin').value = '1';
  await h.el('f-origin').fire('change');
  assert.equal(h.el('f-map-home').disabled, false);
  await h.el('f-map-home').fire();
  assert.equal(h.finder.selectedSystemId, 3);
  assert.equal(h.el('f-map-search').value, 'Alpha-3');
  assert.equal(h.el('f-map-systems').hidden, true);
  assert.equal(h.el('f-map-search-clear').hidden, false);
  assert.equal(h.el('f-map-navigation-status').textContent, '');
  h.finder.focusSystem(2);
  assert.equal(h.el('f-map-search').value, 'Alpha-2', 'direct list focus updates the same input');
  await h.el('f-map-home').fire();
  const canvas = h.el('f-map');
  assert.equal(h.finder.mapBaseX(canvas, 30) * h.finder.mapView.scale + h.finder.mapView.ox, canvas.width / 2);
  assert.equal(h.finder.mapBaseY(canvas, 60) * h.finder.mapView.scale + h.finder.mapView.oy, canvas.height / 2);
  await h.el('f-map-zoom-in').fire();
  assert.equal(h.finder.mapView.scale, 6);
  await h.el('f-map-zoom-out').fire();
  assert.equal(h.finder.mapView.scale, 4);
  await h.el('f-map-reset').fire();
  assert.deepEqual(h.finder.mapView, { scale: 1, ox: 0, oy: 0 });
  const dx = h.finder.mapBaseX(canvas, 20) - h.finder.mapBaseX(canvas, 10);
  const dy = h.finder.mapBaseY(canvas, 30) - h.finder.mapBaseY(canvas, 20);
  assert.ok(Math.abs(dx - dy) < 0.0001, 'map preserves spatial aspect ratio');
  h.finder.resetFinderTab();
  assert.equal(h.el('f-map-home').disabled, true);
  assert.equal(h.el('f-map-search').value, '');
  assert.deepEqual(h.requests, []);
});

test('map alliance markers use all saved bodies independently of search filters and remove abandoned owners', async () => {
  const h = await harness({}, { alliance: { tag: 'TEAM', memberIds: [55] } });
  h.finder.drawGalaxyMap();
  assert.deepEqual(Object.keys(h.finder.allianceSystems), ['1', '2', '3', '4']);
  h.el('f-ownership').value = 'unowned';
  await h.el('f-ownership').fire('change');
  h.finder.drawGalaxyMap();
  assert.deepEqual(Object.keys(h.finder.allianceSystems), ['1', '2', '3', '4']);
  await saveSystem('s0', 1, { ...h.data[1],
    planets: h.data[1].planets.map(planet => ({ ...planet, userId: null })),
    moons: h.data[1].moons.map((moon, index) => index === 0
      ? { ...moon, userId: 88, ownerName: 'Moon ally', ownerAllianceTag: 'TEAM' } : moon),
  });
  await h.finder.selectFinderView('systems');
  h.finder.drawGalaxyMap();
  assert.equal(h.finder.allianceSystems[1], 'Moon ally');
  await saveSystem('s0', 1, { ...h.data[1], planets: h.data[1].planets.map(planet => ({ ...planet, userId: null })) });
  await h.finder.selectFinderView('systems');
  h.finder.drawGalaxyMap();
  assert.equal(h.finder.allianceSystems[1], undefined);
  assert.deepEqual(h.requests, []);
});

test('map star fills and zone rings remain independent of the more prominent navigation markers', async () => {
  const h = await harness({}, { alliance: { memberIds: [55] }, me: { planets: [{ systemId: 1 }] } });
  const context = h.el('f-map').getContext();
  const fills = [], strokes = [];
  context.fill = () => fills.push(context.fillStyle);
  context.stroke = () => strokes.push(context.strokeStyle);
  h.el('f-map').getContext = () => context;
  h.finder.drawGalaxyMap();
  assert.deepEqual(fills, ['#f97316', '#60a5fa', '#e2e8f0', '#9ca3af']);
  for (const zone of ['#f59e0b', '#22c55e', '#ef4444']) assert.ok(strokes.includes(zone));
  assert.ok(strokes.includes('#38bdf8'));
  assert.ok(strokes.includes('#7ee787'));
  await h.el('f-search').fire();
  assert.ok(strokes.includes('#f0883e'));
  assert.deepEqual(h.requests, []);
});

test('zone toggle removes only zone rings, preserves stars and all special markers across zoom levels and tab changes', async () => {
  const h = await harness({}, { alliance: { memberIds: [55] }, me: { planets: [{ systemId: 1 }] } });
  h.finder.galaxyHubs.push({ name: 'Test Hub', x: 20, y: 40 });
  await h.el('f-search').fire();
  const context = h.el('f-map').getContext();
  const fills = [], strokes = [], labels = [], operations = [];
  context.fill = () => { fills.push(context.fillStyle); operations.push('fill'); };
  context.stroke = () => { strokes.push(context.strokeStyle); operations.push('stroke'); };
  context.fillText = () => assert.fail('Map labels must use native HTML, not canvas text');
  h.el('f-map').getContext = () => context;
  const draw = () => {
    fills.length = strokes.length = labels.length = operations.length = 0;
    h.finder.drawGalaxyMap();
    labels.push(...h.el('f-map-labels').children.filter(label => label.style.visibility !== 'hidden').map(label => label.textContent));
    return { fills: [...fills], strokes: [...strokes], labels: [...labels], operations: [...operations] };
  };
  const on = draw();
  await h.el('f-map-zones').fire();
  const off = draw();
  assert.deepEqual(off.fills, on.fills);
  assert.deepEqual(off.labels, on.labels);
  assert.equal(h.el('f-map-zones').attributes['aria-pressed'], 'false');
  assert.equal(h.el('f-map-zones').classList.contains('is-selected'), false);
  for (const zone of ['#f59e0b', '#22c55e', '#ef4444']) {
    assert.ok(on.strokes.includes(zone));
    assert.ok(!off.strokes.includes(zone));
  }
  for (const special of ['#38bdf8', '#7ee787', '#f0883e', '#f5d90a']) {
    assert.ok(off.strokes.includes(special));
  }
  assert.equal(off.operations.slice(0, 4).every(operation => operation === 'fill'), true,
    'navigation markers must be rendered after the entire star layer');
  assert.ok(off.labels.includes('Test Hub'));
  assert.ok(off.labels.some(text => text.startsWith('Test Commander')));
  await h.finder.selectFinderView('map');
  await h.finder.selectFinderView('search');
  assert.equal(h.el('f-map-zones').attributes['aria-pressed'], 'false');
  for (const scale of [1, 4, 12]) {
    h.finder.mapView.scale = scale;
    h.finder.mapView.ox = 550 - h.finder.mapBaseX(h.el('f-map'), 10) * scale;
    h.finder.mapView.oy = 320 - h.finder.mapBaseY(h.el('f-map'), 20) * scale;
    assert.ok(draw().strokes.includes('#38bdf8'), `own marker must survive zoom ${scale}`);
  }
  h.finder.focusSystem(1);
  assert.ok(draw().strokes.includes('#ffffff'), 'selection remains visible with zones off');
  await h.el('f-map-zones').fire();
  assert.equal(h.el('f-map-zones').attributes['aria-pressed'], 'true');
  assert.equal(h.el('f-map-zones').classList.contains('is-selected'), true);
  assert.ok(draw().strokes.includes('#ffffff'), 'selection remains visible with zones on');
  h.finder.resetFinderTab();
  assert.equal(h.el('f-map-zones').classList.contains('is-selected'), true);
  assert.deepEqual(h.requests, []);
});

test('all six star types use the verified game palette regardless of system zone', async () => {
  const colors = ['#fbbf24', '#ef4444', '#60a5fa', '#f97316', '#e2e8f0', '#c084fc'];
  const types = ['yellow', 'red_dwarf', 'blue_giant', 'orange', 'white_dwarf', 'neutron'];
  const h = await harness({}, { systems: types.map((starType, index) => ({
    id: index + 1, x: index * 100, y: 0, starType, securityZone: 'dead', visibility: 'full',
  })) });
  const context = h.el('f-map').getContext();
  const fills = [], strokes = [];
  context.fill = () => fills.push(context.fillStyle);
  context.stroke = () => strokes.push(context.strokeStyle);
  h.el('f-map').getContext = () => context;
  h.finder.drawGalaxyMap();
  assert.deepEqual(fills, colors);
  assert.deepEqual(strokes, Array(6).fill('#ef4444'));
  assert.deepEqual(h.requests, []);
});

test('hub and alliance icon toggles independently hide markers and names without fetching or hiding own colonies', async () => {
  const h = await harness({}, { alliance: { memberIds: [55] }, me: { planets: [{ systemId: 1 }] } });
  h.finder.galaxyHubs.push({ name: 'Test Hub', x: 20, y: 40 });
  await h.el('f-search').fire();
  const context = h.el('f-map').getContext();
  const strokes = [];
  context.stroke = () => strokes.push(context.strokeStyle);
  h.el('f-map').getContext = () => context;
  const draw = () => {
    strokes.length = 0;
    h.finder.drawGalaxyMap();
    return h.el('f-map-labels').children.map(label => label.textContent);
  };
  assert.ok(draw().includes('Test Hub'));
  assert.ok(strokes.includes('#7ee787'));
  await h.el('f-map-hubs').fire();
  assert.ok(!draw().includes('Test Hub'));
  assert.ok(!strokes.includes('#f5d90a'));
  assert.ok(strokes.includes('#7ee787'));
  assert.equal(h.el('f-map-hubs').attributes['aria-pressed'], 'false');
  assert.equal(h.el('f-map-hubs').classList.contains('is-selected'), false);
  await h.el('f-map-alliance').fire();
  const labels = draw();
  assert.ok(!strokes.includes('#7ee787'));
  assert.ok(strokes.includes('#38bdf8'), 'own chevrons stay visible');
  assert.ok(strokes.includes('#f0883e'), 'search markers stay visible');
  assert.ok(labels.includes('Test Commander'), 'own name stays visible');
  assert.ok(!labels.some(label => label.includes('Former owner')));
  assert.equal(h.el('f-map-alliance').attributes['aria-pressed'], 'false');
  assert.equal(h.el('f-map-alliance').classList.contains('is-selected'), false);
  await h.finder.selectFinderView('map');
  await h.finder.selectFinderView('search');
  assert.ok(!draw().includes('Test Hub'));
  assert.ok(!strokes.includes('#7ee787'));
  await h.el('f-map-hubs').fire();
  assert.ok(draw().includes('Test Hub'));
  assert.ok(!strokes.includes('#7ee787'));
  await h.el('f-map-alliance').fire();
  draw();
  assert.ok(strokes.includes('#7ee787'));
  await h.el('f-map-hubs').fire();
  await h.el('f-map-alliance').fire();
  h.finder.resetFinderTab();
  for (const id of ['f-map-hubs', 'f-map-alliance']) {
    assert.equal(h.el(id).attributes['aria-pressed'], 'true');
    assert.equal(h.el(id).classList.contains('is-selected'), true);
  }
  assert.ok(h.calls.every(call => call.type === 'GET_GALAXY_SCANS'), 'view switches only read local saved data');
  assert.deepEqual(h.requests, []);
});

test('map layer buttons are accessible icon-only controls and overview is available only in the map info box', async () => {
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="f-map-overview"'));
  assert.ok(html.includes('id="f-map-info-overview"'));
  for (const [id, label] of [['hubs', 'Market hubs'], ['alliance', 'Alliance markers'], ['stations', 'Stations']]) {
    const button = html.match(new RegExp(`<button id="f-map-${id}"[^>]*>[\\s\\S]*?</button>`))?.[0];
    assert.ok(button);
    assert.ok(button.includes(`aria-label="${label}"`));
    assert.ok(button.includes('title="'));
    assert.ok(button.includes('<svg'));
    assert.equal(button.replace(/<[^>]*>/g, '').trim(), '');
  }
});

test('map hover identifies nonmatching known systems without loading system details', async () => {
  const h = await harness();
  const canvas = h.el('f-map');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height });
  h.el('f-tooltip').offsetWidth = 200;
  h.el('f-tooltip').offsetHeight = 60;
  h.finder.drawGalaxyMap();
  canvas.listeners.mousemove({
    currentTarget: canvas, clientX: h.finder.mapBaseX(canvas, 20), clientY: h.finder.mapBaseY(canvas, 40),
  });
  assert.match(h.el('f-tooltip').textContent, /Alpha-2.*sentinel.*Visibility: full/);
  assert.ok(!h.el('f-tooltip').textContent.includes('#2'), 'hover omits the system ID; click info retains it');
  assert.equal(h.el('f-tooltip').style.display, 'block');
  await canvas.fire('mouseleave');
  assert.equal(h.el('f-tooltip').style.display, 'none');
  assert.deepEqual(h.calls, []);
});

test('map handles single-coordinate and empty catalogs without invalid projection or false Home navigation', async () => {
  const h = await harness({}, { systems: [{ id: 1, name: 'Only system', x: 0, y: 0, securityZone: 'rift', visibility: 'outline' }] });
  const canvas = h.el('f-map');
  assert.equal(h.finder.mapBaseX(canvas, 0), canvas.width / 2);
  assert.equal(h.finder.mapBaseY(canvas, 0), canvas.height / 2);
  const context = canvas.getContext();
  const points = [];
  let current;
  context.arc = (x, y) => { current = { x, y, color: context.fillStyle, alpha: context.globalAlpha }; };
  context.fill = () => points.push(current);
  canvas.getContext = () => context;
  h.finder.drawGalaxyMap();
  assert.equal(points[0].color, '#9ca3af');
  assert.equal(points[0].alpha, 0.45);
  assert.ok(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.equal(h.el('f-map-home').disabled, true);
  h.finder.galaxySystems[0].x = null;
  h.finder.focusSystem(1);
  assert.match(h.el('f-map-navigation-status').textContent, /Cannot locate/);
  const empty = await harness({}, { systems: [] });
  empty.finder.drawGalaxyMap();
  assert.equal(empty.finder.mapBounds, null);
  assert.equal(empty.el('f-map-home').disabled, true);
  assert.deepEqual(empty.requests, []);
});

test('map appearance ignores unstarted search filters and uses only the last started search region', async () => {
  const h = await harness();
  h.finder.galaxySystems[3].armId = 2;
  h.finder.galaxySystems[3].sectorId = 51;
  const canvas = h.el('f-map');
  const context = canvas.getContext();
  const points = [];
  let current;
  context.arc = (x, y, radius) => { current = { x, y, radius, color: context.fillStyle, alpha: context.globalAlpha }; };
  context.fill = () => points.push(current);
  canvas.getContext = () => context;
  const draw = () => {
    points.length = 0;
    h.finder.drawGalaxyMap();
    return structuredClone(points);
  };
  const knownGalaxy = draw();
  assert.equal(knownGalaxy.length, 4);
  assert.deepEqual(knownGalaxy.map(point => point.color), ['#f97316', '#60a5fa', '#e2e8f0', '#9ca3af']);
  assert.ok(knownGalaxy.every(point => point.radius > 0 && point.radius < 2));
  h.el('f-arm').value = '2';
  await h.el('f-arm').fire('change');
  h.el('f-sector').value = '1';
  await h.el('f-sector').fire('input');
  await h.el('f-zone').children.find(button => button.textContent === 'open').fire();
  h.el('f-min-size').value = '900';
  h.el('f-ownership').value = 'free';
  await h.el('f-ownership').fire('change');
  await h.finder.selectFinderView('map');
  assert.deepEqual(draw(), knownGalaxy, 'without a search all known systems have the same base styling');
  await h.finder.selectFinderView('search');
  await h.el('f-zone').children.find(button => button.textContent === 'open').fire();
  h.el('f-min-size').value = '200';
  h.el('f-min-moons').value = '0';
  await h.el('f-search').fire();
  const searchedGalaxy = draw();
  assert.notDeepEqual(searchedGalaxy, knownGalaxy);
  assert.equal(searchedGalaxy[0].color, '#f97316');
  assert.equal(searchedGalaxy[0].alpha, 0.25);
  h.el('f-arm').value = '1';
  await h.el('f-arm').fire('change');
  h.el('f-sector').value = '2';
  await h.el('f-sector').fire('input');
  assert.deepEqual(draw(), searchedGalaxy, 'draft criteria do not recolor an existing search');
  await h.el('f-clear-search').fire();
  assert.deepEqual(draw(), knownGalaxy, 'clearing results restores the independent known-galaxy view');
  assert.deepEqual(h.requests, []);
});

test('map and search are separate panels that retain filters, sorting, results and map position without requests', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  const hits = h.finder.finderHits;
  const sort = h.finder.finderSort;
  h.finder.mapView.scale = 3;
  h.finder.mapView.ox = 123;
  h.calls.length = 0;
  await h.finder.selectFinderView('map');
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.el('f-search-panel').hidden, true);
  assert.equal(h.el('f-directory').hidden, true);
  assert.match(h.el('f-map-status').textContent, /2 matching planets in 1 systems/);
  await h.finder.selectFinderView('search');
  assert.equal(h.el('f-map-panel').hidden, true);
  assert.equal(h.el('f-search-panel').hidden, false);
  assert.equal(h.el('f-directory').hidden, true);
  assert.equal(h.el('f-tab-search').attributes['aria-selected'], 'true');
  assert.equal(h.el('f-tab-map').attributes['aria-selected'], 'false');
  assert.equal(h.finder.finderHits, hits);
  assert.equal(h.finder.finderSort, sort);
  assert.equal(h.el('f-types').children.find(button => button.dataset.value === 'terra').attributes['aria-pressed'], 'true');
  assert.equal(h.el('f-min-moons').value, '3');
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.equal(h.finder.mapView.scale, 3);
  assert.equal(h.finder.mapView.ox, 123);
  await h.finder.initFinderTab();
  h.finder.renderFinderResults();
  assert.equal(h.el('f-search-panel').hidden, false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.requests, []);
  h.el('f-tab-map').listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(h.el('f-search-panel').hidden, false);
  h.el('f-tab-search').listeners.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(h.el('f-map-panel').hidden, false);
  h.finder.resetFinderTab();
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.el('f-search-panel').hidden, true);
});

test('search reports missing data and can continue while viewing the map without switching back', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  const send = globalThis.browser.runtime.sendMessage;
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_SYSTEM_PLANETS' && message.systemId === 1) {
      if (!release) {
        started();
        await new Promise(resolve => { release = resolve; });
      }
      return h.data[1];
    }
    return send(message);
  };
  h.el('f-sector').value = '1';
  const pending = h.el('f-search').fire();
  await ready;
  assert.match(h.el('f-progress').textContent, /Loading missing data/);
  assert.equal(h.el('f-search-panel').hidden, false);
  await h.finder.selectFinderView('map');
  release();
  await pending;
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.el('f-search-panel').hidden, true);
  assert.equal(h.finder.finderHits.length, 2);
  await h.finder.selectFinderView('search');
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.match(h.el('f-progress').textContent, /Done:/);
});

test('five direct views retain the shared search and project cached matches without system requests', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  await h.finder.selectFinderView('systems');
  assert.equal(h.el('f-map-panel').hidden, true);
  assert.equal(h.el('f-search-panel').hidden, true);
  assert.equal(h.el('f-directory').hidden, false);
  assert.equal(h.el('f-directory-body').children.length, 1);
  assert.equal(h.el('f-directory-summary').textContent, '1 systems');
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-body').children.length, 2);
  h.el('f-directory-filter').value = 'P11';
  await h.el('f-directory-filter').fire('input');
  assert.equal(h.el('f-directory-body').children.length, 1);
  await h.finder.selectFinderView('moons');
  assert.equal(h.el('f-directory-filter').value, '');
  assert.equal(h.el('f-directory-body').children.length, 6);
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-filter').value, 'P11');
  assert.equal(h.el('f-directory-body').children.length, 1);
  const show = h.el('f-directory-body').children[0].children.at(-1).children[0].children[0];
  await show.fire();
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.el('f-search-panel').hidden, true);
  assert.equal(h.el('f-directory').hidden, true);
  assert.equal(h.finder.selectedSystemId, 1);
  assert.equal(h.el('f-types').children.find(button => button.dataset.value === 'terra').attributes['aria-pressed'], 'true');
  assert.equal(h.el('f-min-moons').value, '3');
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.deepEqual(h.requests, []);
  assert.ok(h.calls.every(call => call.type === 'GET_GALAXY_SCANS'));
  await h.finder.selectFinderView('systems');
  await h.finder.initFinderTab();
  assert.equal(h.el('f-map-panel').hidden, true, 'background initialization preserves the selected list');
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
});

test('repeated background initialization preserves each directory view, filters and an open overview', async () => {
  const h = await harness();
  for (const view of ['systems', 'planets', 'moons']) {
    await h.finder.selectFinderView(view);
    h.el('f-directory-filter').value = view === 'systems' ? 'Alpha-1' : 'P11';
    await h.el('f-directory-filter').fire('input');
    const rows = h.el('f-directory-body').children;
    await rows[0].children.at(-1).children[0].children[1].fire();
    const title = h.el('f-system-title').textContent;
    h.calls.length = 0;
    await h.finder.initFinderTab();
    await h.finder.initFinderTab();
    assert.equal(h.el('f-map-panel').hidden, true);
    assert.equal(h.el('f-search-panel').hidden, true);
    assert.equal(h.el('f-directory').hidden, false);
    assert.equal(h.el('f-directory-body').children, rows);
    assert.equal(h.el('f-directory-filter').value, view === 'systems' ? 'Alpha-1' : 'P11');
    assert.equal(h.el('f-system-overview').open, true);
    assert.equal(h.el('f-system-title').textContent, title);
    assert.deepEqual(h.calls, []);
  }
  assert.deepEqual(h.requests, []);
});

test('without a search directory views default to all data; a search selects results and server reset restores all', async () => {
  const h = await harness();
  assert.equal(h.el('f-directory-scope').value, 'all');
  for (const [view, count] of [['systems', 4], ['planets', 5], ['moons', 6]]) {
    await h.finder.selectFinderView(view);
    assert.equal(h.el('f-directory-scope').value, 'all');
    assert.equal(h.el('f-directory-body').children.length, count);
  }
  await h.finder.selectFinderView('map');
  await h.el('f-search').fire();
  assert.equal(h.el('f-directory-scope').value, 'matches');
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-body').children.length, 2);
  h.finder.resetFinderTab();
  assert.equal(h.el('f-directory-scope').value, 'all');
});

test('all known data bypasses the search without discarding it and local load failures are visible', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  await h.finder.selectFinderView('planets');
  h.el('f-directory-scope').value = 'all';
  await h.el('f-directory-scope').fire('change');
  assert.equal(h.el('f-directory-body').children.length, 5);
  h.el('f-directory-scope').value = 'matches';
  await h.el('f-directory-scope').fire('change');
  assert.equal(h.el('f-directory-body').children.length, 2);
  globalThis.browser.runtime.sendMessage = async () => ({ error: 'Database unavailable' });
  await h.finder.selectFinderView('systems');
  assert.match(h.el('f-directory-summary').textContent, /Local galaxy data could not be loaded: Database unavailable/);
  assert.equal(h.el('f-directory-body').children.length, 1);
  assert.deepEqual(h.requests, []);
});

test('directory zone buttons filter all three views independently and persist across switches', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  h.el('f-directory-scope').value = 'all';
  const toggle = async zone => h.el('f-directory-zones').children.find(button => button.textContent === zone).fire();
  await h.finder.selectFinderView('systems');
  await toggle('sentinel');
  assert.match(h.el('f-directory-summary').textContent, /2 systems$/);
  await toggle('dead');
  assert.match(h.el('f-directory-summary').textContent, /3 systems$/);
  await h.finder.selectFinderView('planets');
  assert.match(h.el('f-directory-summary').textContent, /5 planets$/);
  await toggle('open');
  assert.match(h.el('f-directory-summary').textContent, /2 planets$/);
  await h.finder.selectFinderView('moons');
  await toggle('dead');
  assert.match(h.el('f-directory-summary').textContent, /0 moons$/);
  await h.finder.selectFinderView('systems');
  assert.match(h.el('f-directory-summary').textContent, /3 systems$/);
  await toggle('dead');
  await toggle('sentinel');
  assert.match(h.el('f-directory-summary').textContent, /4 systems$/);
  assert.deepEqual(h.requests, []);
});

test('list-specific types, ownership and reset are local, retained per view and independent of map search', async () => {
  const h = await harness();
  const type = async value => h.el('f-directory-types').children.find(button => button.dataset.value === value).fire();
  const set = async (id, value, event = 'input') => {
    h.el(`f-directory-${id}`).value = value;
    await h.el(`f-directory-${id}`).fire(event);
  };
  await h.finder.selectFinderView('systems');
  assert.equal(h.el('f-directory-ownership-field').hidden, true);
  assert.match(h.el('f-directory-type-label').textContent, /Star type/);
  await type('orange');
  assert.match(h.el('f-directory-summary').textContent, /1 systems$/);
  await type('blue_giant');
  assert.match(h.el('f-directory-summary').textContent, /2 systems$/);
  await set('planetCount-min', '2');
  assert.match(h.el('f-directory-active').textContent, /1 active/);
  assert.match(h.el('f-directory-summary').textContent, /1 systems$/);
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-ownership-field').hidden, false);
  const fields = h.el('f-directory-extra-fields').children;
  assert.equal(fields.some(field => field.children.some(control =>
    ['f-directory-owner', 'f-directory-alliance'].includes(control.id))), false);
  assert.equal(fields.some(field => field.className === 'finder-filter-range'), false);
  assert.ok(fields.some(field => field.textContent === 'Min size'));
  assert.equal(fields.some(field => /^Max (size|slots|moons|planets)$/.test(field.textContent)), false);
  assert.ok(fields.some(field => field.textContent === 'Max distance'));
  await type('ice');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  await set('ownership', 'free', 'change');
  assert.match(h.el('f-directory-summary').textContent, /0 planets$/);
  await set('ownership', 'colonized', 'change');
  await set('filter', 'FORMER');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  await set('filter', 'old');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  await h.finder.selectFinderView('systems');
  assert.match(h.el('f-directory-summary').textContent, /1 systems$/);
  assert.equal(h.el('f-directory-ownership-field').hidden, true);
  await h.el('f-directory-reset').fire();
  assert.match(h.el('f-directory-summary').textContent, /4 systems$/);
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-filter').value, 'old');
  assert.equal(h.el('f-directory-ownership').value, 'colonized');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  assert.equal(h.el('f-types').children.find(button => button.dataset.value === 'terra').attributes['aria-pressed'], 'true');
  assert.equal(h.el('f-min-size').value, '200');
  assert.deepEqual(h.requests, []);
  assert.ok(h.calls.every(call => call.type === 'GET_GALAXY_SCANS'));
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-filter').value, '');
  assert.equal(h.el('f-directory-ownership').value, '');
});

test('advanced moon filters handle local ownership, parent types and invalid numeric bounds explicitly', async () => {
  const h = await harness();
  Object.assign(h.data[1].moons[0], { moonType: 'metallic', buildingSlots: 7 });
  Object.assign(h.data[1].moons[1], { moonType: 'icy', buildingSlots: 8, userId: 55 });
  h.data[1].moons.push({ id: 119, planetId: 11, moonType: 'ancient', buildingSlots: 10 });
  await saveSystem('s0', 1, h.data[1]);
  const set = async (id, value, event = 'input') => {
    h.el(`f-directory-${id}`).value = value;
    await h.el(`f-directory-${id}`).fire(event);
  };
  await h.finder.selectFinderView('planets');
  await set('free-moon-slots', '8');
  assert.match(h.el('f-directory-summary').textContent, /0 planets$/);
  await set('free-moon-slots', '7');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  const related = value => h.el('f-directory-related-types').children.find(button => button.dataset.value === value).fire();
  await related('icy');
  await related('ancient');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  await h.finder.selectFinderView('moons');
  await related('terra');
  await set('ownership', 'free', 'change');
  await set('slots-min', '7');
  assert.match(h.el('f-directory-summary').textContent, /1 moons$/);
  assert.equal(h.el('f-directory-body').children[0].children[3].textContent, 'metallic');
  await set('distance-min', '10');
  await set('distance-max', '6');
  assert.match(h.el('f-directory-summary').textContent, /minimum cannot exceed/);
  await set('distance-min', '');
  await set('distance-max', '');
  assert.match(h.el('f-directory-summary').textContent, /1 moons$/);
  await set('slots-min', '-1');
  assert.match(h.el('f-directory-summary').textContent, /non-negative whole numbers/);
  h.el('f-directory-slots-min').validity = { badInput: true };
  await set('slots-min', '');
  assert.match(h.el('f-directory-summary').textContent, /non-negative whole numbers/);
  h.el('f-directory-slots-min').validity = { badInput: false };
  await set('slots-min', '7');
  assert.match(h.el('f-directory-summary').textContent, /1 moons$/);
  await h.el('f-directory-reset').fire();
  assert.match(h.el('f-directory-summary').textContent, /7 moons$/);
  assert.deepEqual(h.requests, []);
});

test('directory region and distance origin are independent per list and preserve input nodes while typing', async () => {
  const h = await harness();
  h.finder.myPlanets.push({ id: 7, name: 'Home', systemId: 1, systemX: 10, systemY: 20 });
  await h.finder.selectFinderView('systems');
  const set = async (id, value, event = 'input') => {
    h.el(`f-directory-${id}`).value = value;
    await h.el(`f-directory-${id}`).fire(event);
  };
  await set('origin', '7', 'change');
  await set('arm', '1', 'change');
  await set('distance-max', '23');
  await set('sector', '2');
  const control = h.el('f-directory-sector');
  assert.match(h.el('f-directory-summary').textContent, /1 systems$/);
  await set('sector', '1-2');
  assert.equal(h.el('f-directory-sector'), control);
  assert.match(h.el('f-directory-summary').textContent, /2 systems$/);
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-origin').value, '');
  assert.equal(h.el('f-directory-sector').value, '');
  await h.finder.selectFinderView('systems');
  assert.equal(h.el('f-directory-origin').value, '7');
  assert.equal(h.el('f-directory-sector').value, '1-2');
  assert.match(h.el('f-directory-summary').textContent, /2 systems$/);
  await set('sector', '1-');
  assert.match(h.el('f-directory-summary').textContent, /Enter a sector or sector range/);
  await set('sector', '2-1');
  assert.match(h.el('f-directory-summary').textContent, /2 systems$/);
  await h.el('f-directory-reset').fire();
  assert.equal(h.el('f-directory-sector').value, '');
  assert.match(h.el('f-directory-summary').textContent, /4 systems$/);
  assert.deepEqual(h.requests, []);
});

test('main search keeps its single-sector, reversed range and empty-arm behavior with the shared parser', async () => {
  const h = await harness();
  for (const [raw, from, to] of [['2', 2, 2], [' 4 - 2 ', 2, 4], ['4–2', 2, 4], ['', 1, 50], ['0', 1, 1]]) {
    h.el('f-sector').value = raw;
    assert.deepEqual(h.finder.regionSectorIds(), { armId: 1, from, to, min: from, max: to });
  }
  assert.deepEqual(h.requests, []);
});

test('directory status is compact, ownership warnings only apply to bodies and advanced filters do not repeat them', async () => {
  const h = await harness();
  await h.finder.selectFinderView('systems');
  assert.equal(h.el('f-directory-summary').textContent, '4 systems');
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-summary').textContent, 'Ownership may be outdated · 5 planets');
  await h.el('f-search').fire();
  assert.equal(h.el('f-directory-summary').textContent, 'Ownership may be outdated · 2 planets');
  await h.finder.selectFinderView('moons');
  assert.equal(h.el('f-directory-summary').textContent, 'Ownership may be outdated · 6 moons');
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const details = html.slice(html.indexOf('<details id="f-directory-more"'), html.indexOf('</details>', html.indexOf('<details id="f-directory-more"')));
  assert.doesNotMatch(details, /Local saved data|ownership may be outdated|<p/);
  assert.deepEqual(h.requests, []);
});

test('body properties expose only minimums while all directories retain maximum distance', async () => {
  const h = await harness();
  h.data[1].planets[0].size = 1000;
  await saveSystem('s0', 1, h.data[1]);
  await h.el('f-search').fire();
  assert.ok(h.finder.finderHits.some(hit => hit.planetId === 11));
  for (const view of ['systems', 'planets', 'moons']) {
    await h.finder.selectFinderView(view);
    const fields = h.el('f-directory-extra-fields').children;
    const maxControls = fields.flatMap(field => field.children).filter(control => control.id?.endsWith('-max'));
    assert.deepEqual(maxControls.map(control => control.id), ['f-directory-distance-max']);
  }
  await h.finder.selectFinderView('planets');
  h.el('f-directory-size-min').value = '250';
  await h.el('f-directory-size-min').fire('input');
  assert.match(h.el('f-directory-summary').textContent, /1 planets$/);
  assert.deepEqual(h.requests, []);
});

test('list filters intersect search results without discarding the shared search or fetching more systems', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  await h.finder.selectFinderView('planets');
  h.el('f-directory-moons-min').value = '4';
  await h.el('f-directory-moons-min').fire('input');
  assert.match(h.el('f-directory-summary').textContent, /0 planets$/);
  await h.el('f-directory-reset').fire();
  assert.match(h.el('f-directory-summary').textContent, /2 planets$/);
  assert.equal(h.el('f-directory-scope').value, 'matches');
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.deepEqual(h.requests, []);
});

test('system stars appear in the list and overview using saved types without system requests', async () => {
  const h = await harness();
  await h.finder.selectFinderView('systems');
  const row = h.el('f-directory-body').children[0];
  const image = row.children[0].children[0].children[0];
  assert.equal(image.className, 'finder-body-image finder-star-orange');
  assert.equal(image.src, 'https://s0.nexuslegacy.space/api/images/planets/gas_giant.webp');
  assert.equal(row.children[1].textContent, 'orange');
  await row.children.at(-1).children[0].children[1].fire();
  assert.equal(h.el('f-system-title').children[0].children[0].className, 'finder-body-image finder-star-orange');
  assert.match(h.el('f-system-meta').textContent, /Star: orange/);
  const unknown = h.el('f-directory-body').children[3];
  assert.equal(unknown.children[0].children.length, 0);
  await unknown.children.at(-1).children[0].children[1].fire();
  assert.match(h.el('f-system-meta').textContent, /Star: unknown/);
  assert.equal(h.el('f-system-title').children.length, 0);
  assert.deepEqual(h.requests, []);
});

test('system overview replaces inline contents with complete cached sections and a map action', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  await h.finder.selectFinderView('systems');
  const overview = h.el('f-directory-body').children[0].children.at(-1).children[0].children[1];
  assert.equal(overview.textContent, 'System overview');
  await overview.fire();
  assert.equal(h.el('f-system-overview').open, true);
  assert.equal(h.el('f-system-title').textContent, 'System overview: Alpha-1');
  const body = h.el('f-system-body').textContent;
  assert.match(body, /Planets \(2\)/);
  assert.match(body, /Moons \(6\)/);
  assert.match(body, /Asteroid fields \(unknown\)/);
  assert.match(body, /have not been collected/);
  assert.match(body, /P11/);
  assert.match(body, /Ownership checked:/);
  const images = [];
  const collectImages = element => {
    if (element.className === 'finder-body-image') images.push(element);
    for (const child of element.children || []) collectImages(child);
  };
  collectImages(h.el('f-system-body'));
  assert.equal(images.length, 8);
  assert.equal(images.filter(image => image.src.includes('/api/images/planets/')).length, 2);
  assert.equal(images.filter(image => image.src.includes('/images/moons/')).length, 6);
  assert.doesNotMatch(h.el('f-directory-body').textContent, /Known contents/);
  await h.el('f-system-map').fire();
  assert.equal(h.el('f-system-overview').open, false);
  assert.equal(h.finder.selectedSystemId, 1);
  assert.equal(h.el('f-map-panel').hidden, false);
  await h.finder.selectFinderView('systems');
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  h.finder.resetFinderTab();
  assert.equal(h.el('f-system-overview').open, false);
  assert.equal(h.el('f-system-body').textContent, '');
  assert.deepEqual(h.requests, []);
});

test('system overview includes nonmatching bodies and asteroid resources, distinguishing empty from unknown', async () => {
  const h = await harness();
  h.data[1].planets.push({ id: 13, name: 'Unmatched ice world', planetType: 'ice', size: 90, userId: null });
  h.data[1].asteroidFields = [{
    id: 101, name: 'Ore field', fieldType: 'metallic', richness: 2,
    remainingResources: 12345, totalResources: 20000, controllerUserId: null,
  }];
  await saveSystem('s0', 1, h.data[1]);
  await h.el('f-search').fire();
  await h.finder.selectFinderView('systems');
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  assert.match(h.el('f-system-body').textContent, /Planets \(3\)/);
  assert.match(h.el('f-system-body').textContent, /Unmatched ice world/);
  assert.match(h.el('f-system-body').textContent, /Asteroid fields \(1\)/);
  assert.match(h.el('f-system-body').textContent, /12345/);
  await h.el('f-system-close').fire();
  h.el('f-directory-scope').value = 'all';
  await h.el('f-directory-scope').fire('change');
  await h.el('f-directory-body').children[1].children.at(-1).children[0].children[1].fire();
  assert.match(h.el('f-system-body').textContent, /Moons \(0\)/);
  assert.match(h.el('f-system-body').textContent, /No moons in saved data/);
  assert.match(h.el('f-system-body').textContent, /Asteroid fields \(unknown\)/);
  assert.deepEqual(h.requests, []);
});

test('system overview highlights exactly the originating planet or moon and clears it on other opens', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  const selectedRows = () => {
    const selected = [];
    const visit = element => {
      if ((element.className || '').split(' ').includes('finder-system-selected')) selected.push(element);
      for (const child of element.children || []) visit(child);
    };
    visit(h.el('f-system-body'));
    return selected;
  };
  for (const [view, expectedId] of [['planets', 11], ['moons', 111], ['systems', null]]) {
    await h.finder.selectFinderView(view);
    const overview = h.el('f-directory-body').children[0].children.at(-1).children[0].children[1];
    await overview.fire();
    const selected = selectedRows();
    assert.equal(selected.length, expectedId === null ? 0 : 1);
    if (expectedId !== null) assert.equal(selected[0].dataset.bodyId, String(expectedId));
    await h.el('f-system-close').fire();
  }
  assert.deepEqual(h.requests, []);
});

test('compact planet groups contain their own ordered moons, retain orphans and distinguish ownership states', async () => {
  const h = await harness();
  h.data[1].planets[0].position = 2;
  h.data[1].planets[1].position = 1;
  h.data[1].moons[0].position = 2;
  h.data[1].moons[1].position = 1;
  h.data[1].moons.push({ id: 999, planetId: 99, moonType: 'icy', buildingSlots: 7 });
  await saveSystem('s0', 1, h.data[1]);
  await h.finder.selectFinderView('systems');
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  const list = h.el('f-system-body').children[0].children.find(child => child.className === 'finder-system-list-scroll').children[0];
  assert.equal(list.children[0].children.length, 8);
  assert.equal(list.children[0].children[4].textContent, 'Orbit');
  assert.doesNotMatch(list.children[0].textContent, /Temp|Position/);
  const groups = list.children.filter(child => child.className === 'finder-planet-group');
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].children.map(card => card.dataset.bodyId), ['12', '121', '122', '123']);
  assert.deepEqual(groups[1].children.map(card => card.dataset.bodyId), ['11', '112', '111', '113']);
  assert.match(groups[2].textContent, /Parent planet #99 not collected/);
  const planet = groups[1].children[0];
  assert.equal(planet.children[1].children[1].textContent, '22');
  assert.equal(planet.children[1].children[2].textContent, '#2');
  assert.equal(planet.children[1].children[3].textContent, '3');
  assert.equal(groups[1].children[1].children[1].children.length, 5);
  assert.equal(groups[1].children[1].children[1].children[2].textContent, '#1');
  assert.equal(groups[1].children[1].children[1].children[3].textContent, '—');
  assert.match(planet.children[2].textContent, /Colonized/);
  assert.equal(planet.children[2].children[1].className, 'finder-badge finder-alliance');
  assert.equal(planet.children[2].children[1].textContent, '[OLD]');
  assert.match(groups[1].children[1].children[2].textContent, /Free/);
  assert.match(groups[2].children[1].children[2].textContent, /Unknown ownership/);
  assert.match(planet.children[0].children[1].children[0].className, /finder-type-neutral/);
  assert.deepEqual(h.requests, []);
});

test('system overview closes on backdrop clicks but not content or dialog padding clicks', async () => {
  const h = await harness();
  await h.finder.selectFinderView('systems');
  const open = () => h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  const dialog = h.el('f-system-overview');
  dialog.getBoundingClientRect = () => ({ left: 100, right: 900, top: 100, bottom: 700 });
  for (const [x, y] of [[50, 300], [950, 300], [300, 50], [300, 750]]) {
    await open();
    dialog.listeners.click({ currentTarget: dialog, target: h.el('f-system-body'), clientX: x, clientY: y });
    assert.equal(dialog.open, true);
    dialog.listeners.click({ currentTarget: dialog, target: dialog, clientX: 110, clientY: 110 });
    assert.equal(dialog.open, true);
    dialog.listeners.click({ currentTarget: dialog, target: dialog, clientX: x, clientY: y });
    assert.equal(dialog.open, false);
    assert.equal(h.el('f-system-body').children.length, 0);
  }
  assert.deepEqual(h.requests, []);
});

test('search displays planet slots instead of temperature while retaining cached physical data', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children[0].children[5].textContent, '22');
  assert.equal(h.el('f-results-tbody').children[0].children[10].children[0].className, 'finder-badge finder-alliance');
  assert.equal(h.finder.finderHits[0].slots, 22);
  assert.equal(Object.hasOwn(h.finder.finderHits[0], 'temp'), false);
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-key="temp"/);
  assert.match(html, /data-key="slots"/);
  assert.equal((await readSystem('s0', 1)).data.planets[0].temperature, 20);
  assert.deepEqual(h.requests, []);
});

test('map search results share directory badges and actions and open the exact planet overview locally', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  let row = h.el('f-results-tbody').children[0];
  const selectionBefore = h.finder.selectedSystemId;
  await row.fire();
  assert.equal(h.finder.selectedSystemId, selectionBefore);
  assert.equal(row.listeners.click, undefined);
  assert.notEqual(row.style.cursor, 'pointer');
  assert.notEqual(row.title, 'Show on map');
  assert.equal(row.children.length, 12);
  assert.equal(row.children[1].className, 'finder-parent-reference');
  assert.equal(row.children[3].children[0].className, 'finder-badge finder-type-neutral');
  assert.equal(row.children[7].children[0].className, 'finder-badge finder-zone-open');
  assert.equal(row.children[9].children[0].className, 'finder-badge finder-owner-colonized');
  assert.match(row.children[9].textContent, /Former owner/);
  const actions = row.children.at(-1).children[0];
  assert.equal(actions.className, 'finder-directory-actions');
  assert.deepEqual(actions.children.map(button => button.textContent), ['Show on map', 'System overview']);
  await actions.children[1].fire();
  assert.equal(h.el('f-system-overview').open, true);
  const sections = h.el('f-system-body').children;
  const list = sections[0].children.find(child => child.className === 'finder-system-list-scroll').children[0];
  const selected = list.children.flatMap(group => group.children).find(card => card.dataset?.bodyId === '11');
  assert.match(selected.className, /finder-system-selected/);
  for (const [ownershipKnown, userId, expected] of [[true, null, 'free'], [false, null, 'unknown']]) {
    Object.assign(h.finder.finderHits[0], { ownershipKnown, userId });
    h.finder.renderFinderResults();
    row = h.el('f-results-tbody').children[0];
    assert.equal(row.children[9].children[0].className, `finder-badge finder-owner-${expected}`);
  }
  await actions.children[0].fire();
  assert.equal(h.finder.selectedSystemId, 1);
  assert.equal(h.el('f-map-panel').hidden, false);
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const head = html.slice(html.indexOf('<thead id="f-results-head"'), html.indexOf('</thead>', html.indexOf('<thead id="f-results-head"')));
  assert.equal((head.match(/<button type="button">/g) || []).length, 11);
  assert.doesNotMatch(head, /rankMil|rankEco|rankRes|Mil rank|Eco rank|Res rank/);
  assert.deepEqual(h.requests, []);
  await h.el('f-check-ownership').fire();
  assert.equal(h.calls.some(call => call.type === 'GET_PLAYER_RANK'), false);
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
});

test('directory tables share type and ownership badges without confusing unknown with free', async () => {
  const h = await harness();
  h.data[1].moons.push({ id: 999, planetId: 11, moonType: 'icy' });
  await saveSystem('s0', 1, h.data[1]);
  await h.finder.selectFinderView('planets');
  const planet = h.el('f-directory-body').children[0];
  assert.match(planet.children[2].children[0].className, /finder-type-neutral/);
  assert.match(planet.children[8].children[0].className, /finder-owner-colonized/);
  assert.equal(planet.children[4].textContent, '22');
  assert.equal(planet.children[9].children[0].className, 'finder-badge finder-alliance');
  await h.finder.selectFinderView('moons');
  const moons = h.el('f-directory-body').children;
  assert.match(moons[0].children[8].children[0].className, /finder-owner-free/);
  assert.equal(moons[0].children[1].className, 'finder-parent-reference');
  assert.match(moons[6].children[8].children[0].className, /finder-owner-unknown/);
  assert.deepEqual(h.requests, []);
});

test('security zone badges follow existing zone colors in every directory and the overview', async () => {
  const h = await harness();
  for (const [view, zoneColumn] of [['systems', 2], ['planets', 6], ['moons', 6]]) {
    await h.finder.selectFinderView(view);
    const row = h.el('f-directory-body').children[0];
    assert.equal(row.children[zoneColumn].children[0].className, 'finder-badge finder-zone-open');
    assert.equal(row.children[zoneColumn].textContent, 'open');
    await row.children.at(-1).children[0].children[1].fire();
    assert.equal(h.el('f-system-meta').children.at(-1).className, 'finder-badge finder-zone-open');
    await h.el('f-system-close').fire();
  }
  await h.finder.selectFinderView('systems');
  const rows = h.el('f-directory-body').children;
  assert.equal(rows[1].children[2].children[0].className, 'finder-badge finder-zone-sentinel');
  assert.equal(rows[2].children[2].children[0].className, 'finder-badge finder-zone-dead');
  await h.finder.selectFinderView('map');
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children[0].children[7].children[0].className, 'finder-badge finder-zone-open');
  assert.deepEqual(h.requests, []);
});

test('all six game moon colors are shared by directory, overview and search markers', async () => {
  const h = await harness();
  const colors = {
    barren: '#9ca3af', metallic: '#d97706', icy: '#67e8f9',
    volcanic: '#ef4444', hollow: '#a78bfa', ancient: '#fbbf24',
  };
  h.data[1].moons = Object.keys(colors).map((moonType, index) => ({
    id: 111 + index, planetId: 11, moonType, buildingSlots: 5, userId: null,
  }));
  await saveSystem('s0', 1, h.data[1]);
  const markers = element => {
    const classes = [];
    const visit = node => {
      if ((node.className || '').includes('finder-moon-')) classes.push(node.className);
      for (const child of node.children || []) visit(child);
    };
    visit(element);
    return classes;
  };
  const expected = Object.keys(colors).map(type => `finder-badge finder-moon-${type}`);
  await h.finder.selectFinderView('moons');
  assert.deepEqual(markers(h.el('f-directory-body')), expected);
  await h.el('f-directory-body').children[0].children.at(-1).children[0].children[1].fire();
  assert.deepEqual(markers(h.el('f-system-body')), expected);
  await h.el('f-system-close').fire();
  await h.finder.selectFinderView('map');
  await h.el('f-search').fire();
  assert.deepEqual(markers(h.el('f-results-tbody')), expected);
  const css = await readFile(new URL('../nexus-addon/dashboard.css', import.meta.url), 'utf8');
  for (const [type, color] of Object.entries(colors)) {
    assert.ok(css.includes(`.finder-moon-${type} { color: ${color}; border-color: ${color}; }`));
  }
  const { ZONE_COLORS } = await import('../nexus-addon/common.js');
  const theme = await readFile(new URL('../nexus-addon/theme.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.asteroids-dashboard .asteroids-toolbar button:not(.zone-toggle) {'));
  assert.ok(css.includes('.asteroids-dashboard .asteroids-toolbar button:not(.zone-toggle):hover {'));
  for (const [zone, color] of Object.entries({ sentinel: '#22c55e', open: '#f59e0b', dead: '#ef4444', rift: '#7c3aed' })) {
    assert.equal(ZONE_COLORS[zone], color);
    assert.ok(theme.includes(`--zone-${zone}: ${color};`));
    assert.ok(css.includes(`.finder-zone-${zone} { color: var(--zone-${zone}); border-color: var(--zone-${zone}); }`));
    assert.ok(css.includes(`.zone-toggle.zone-${zone} { border-color: var(--zone-${zone}); color: var(--zone-${zone}); }`));
    assert.ok(css.includes(`.zone-toggle.is-selected.zone-${zone} { background: var(--zone-${zone});`));
  }
  assert.deepEqual(h.requests, []);
});

test('pending catalog reads cannot restore data or selection after switching servers', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  let resolve;
  globalThis.browser.runtime.sendMessage = async () => new Promise(done => { resolve = done; });
  const reading = h.finder.selectFinderView('planets');
  h.finder.resetFinderTab();
  resolve({ scans: { 1: { data: h.data[1] } } });
  await reading;
  assert.equal(h.el('f-map-panel').hidden, false);
  assert.equal(h.el('f-directory').hidden, true);
  assert.equal(h.el('f-directory-body').children.length, 0);
  assert.deepEqual(h.finder.finderHits, []);
});

test('passively updated ownership applies consistently to map hits and directory search results', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  h.el('f-ownership').value = 'unowned';
  await h.el('f-ownership').fire('change');
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-summary').textContent, 'Ownership may be outdated · 0 planets');
  h.data[1].planets = h.data[1].planets.map(planet => ({ ...planet, userId: null, ownerName: null }));
  await saveSystem('s0', 1, h.data[1]);
  await h.finder.selectFinderView('systems');
  assert.equal(h.el('f-directory-summary').textContent, '1 systems');
  assert.equal(h.el('f-directory-body').children.length, 1);
  assert.deepEqual(Object.keys(h.finder.hitSystems), ['1']);
  await h.finder.selectFinderView('planets');
  assert.equal(h.el('f-directory-body').children.length, 2);
  await h.finder.selectFinderView('map');
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.deepEqual(h.requests, []);
});

test('moon slot minimum requires one free moon at the threshold, not summed slots or owned moons', async () => {
  const h = await harness();
  h.el('f-min-moon-slots').value = '6';
  h.data[1].moons[0].buildingSlots = 6;
  h.data[1].moons[3].buildingSlots = 20;
  h.data[1].moons[3].userId = 55;
  await saveSystem('s0', 1, h.data[1]);
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11]);
  assert.equal(h.el('f-results-tbody').children.length, 1);
  assert.deepEqual(h.requests, []);
  h.el('f-min-moon-slots').value = '7';
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits, []);
});

test('moon slot filter loads missing moons only for physically matching planets without a moon-count minimum', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  for (const [id, contents] of Object.entries(h.data)) {
    await saveSystem('s0', Number(id), { planets: contents.planets });
  }
  h.el('f-min-moons').value = '0';
  h.el('f-min-moon-slots').value = '5';
  await h.el('f-search').fire();
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets', '/api/galaxy/systems/4/planets']);
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
});

test('systems without obtainable details are excluded before search rather than reported as issues', async () => {
  const h = await harness();
  const send = globalThis.browser.runtime.sendMessage;
  globalThis.browser.runtime.sendMessage = async message => message.type === 'GET_GALAXY_MAP'
    ? { systems: [1, 2, 3, 4].map(id => ({
      id, name: `Partial-${id}`, armId: 1, sectorId: id, visibility: ['fog', 'partial', 'outline', 'partial'][id - 1],
    })) } : send(message);
  h.finder.resetFinderTab();
  await h.finder.initFinderTab();
  await h.finder.selectFinderView('search');
  await restoreGalaxyCache();
  await saveSystem('s0', 1, { planets: h.data[1].planets });
  await saveSystem('s0', 2, { asteroidFields: [] });
  h.el('f-min-moons').value = '0';
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.match(h.el('f-progress').textContent, /Done: 2 matches in 1 scanned systems/);
  assert.doesNotMatch(h.el('f-progress').textContent, /unavailable|unexplored|Incomplete/);
  assert.equal(h.el('f-search-issues-list').children.length, 0);
  assert.equal(h.el('f-search-issues').hidden, true);
  h.el('f-min-moons').value = '1';
  await h.el('f-search').fire();
  assert.match(h.el('f-progress').textContent, /0 scanned systems/);
  assert.match(h.el('f-progress').textContent, /no searchable systems/);
  assert.equal(h.el('f-search-issues').hidden, true);
  await h.el('f-search').fire();
  assert.equal(h.store.galaxy_last_search.phase, 'complete');
  await saveSystem('s0', 1, { moons: h.data[1].moons });
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.match(h.el('f-progress').textContent, /Done: 2 matches in 1 scanned systems/);
  assert.deepEqual(h.requests, []);
});

test('unresolved full-system data is diagnosed and not requested again on an immediate repeat search', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  for (const [id, data] of Object.entries(h.data)) await saveSystem('s0', Number(id), { planets: data.planets });
  const cache = createGalaxyCache({
    storage: { get: async () => ({}), remove: async () => {} },
    fetcher: async path => {
      h.requests.push(path);
      const id = Number(/systems\/(\d+)/.exec(path)[1]);
      return { planets: h.data[id].planets };
    },
  });
  const send = globalThis.browser.runtime.sendMessage;
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type !== 'GET_SYSTEM_PLANETS') return send(message);
    try { return await cache.system('s0', message.systemId, message); }
    catch (error) { return { error: error.message, code: error.code, groups: error.groups }; }
  };
  for (let i = 0; i < 2; i++) {
    await h.el('f-search').fire();
    assert.match(h.el('f-progress').textContent, /Incomplete: 0 matches in 2 scanned systems/);
    assert.match(h.el('f-progress').textContent, /2 systems with unavailable details/);
    assert.match(h.el('f-search-issues-list').children[0].textContent, /moons unavailable/);
    assert.equal(h.el('f-search-issues').hidden, false);
  }
  assert.equal(h.requests.length, 2);
  assert.equal(h.store.galaxy_last_search.phase, 'stopped');
  await h.el('f-clear-search').fire();
  assert.equal(h.el('f-search-issues').hidden, true);
});

test('unknown qualifying moon ownership is resolved after base search and never treated as free', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  for (const [id, contents] of Object.entries(h.data)) {
    const moons = contents.moons.map(moon => {
      const unknown = { ...moon };
      delete unknown.userId;
      return unknown;
    });
    await saveSystem('s0', Number(id), { ...contents, moons });
  }
  h.el('f-min-moon-slots').value = '5';
  h.data[1].moons = h.data[1].moons.map(moon => ({ ...moon, userId: moon.planetId === 11 ? null : 55 }));
  const send = globalThis.browser.runtime.sendMessage;
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_SYSTEM_PLANETS') {
      assert.equal(h.el('f-results-tbody').children.length, 0);
      assert.equal(message.group, 'both');
    }
    return send(message);
  };
  await h.el('f-search').fire();
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  assert.equal(h.el('f-results-tbody').children.length, 1);
  globalThis.browser.runtime.sendMessage = send;
  h.requests.length = 0;
  await h.el('f-search').fire();
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11]);
  assert.deepEqual(h.requests, []);
});

test('known unowned status has no search expiry and passive observations update later results', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  const unowned = {
    ...h.data[1],
    planets: h.data[1].planets.map(planet => ({ ...planet, userId: null })),
  };
  for (const [id, contents] of Object.entries(h.data)) {
    await saveSystem('s0', Number(id), Number(id) === 1 ? unowned : contents, Date.now() - 30 * 86400000);
  }
  h.el('f-ownership').value = 'unowned';
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.ok(h.finder.finderHits.every(hit => hit.ownershipKnown && hit.userId === null));
  assert.deepEqual(h.requests, []);
  await saveSystem('s0', 1, h.data[1]);
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.ok(h.finder.finderHits.every(hit => hit.ownershipKnown && hit.userId === 55));
  assert.deepEqual(h.requests, []);
});

test('manual ownership refresh checks each matching system once, including hidden owned results', async () => {
  const h = await harness();
  h.el('f-ownership').value = 'unowned';
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.deepEqual(h.requests, []);
  h.data[1].planets = h.data[1].planets.map(planet => ({ ...planet, userId: null, ownerName: null, ownerAllianceTag: null }));
  await h.el('f-check-ownership').fire();
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  assert.equal(h.calls.filter(call => call.type === 'GET_SYSTEM_PLANETS').length, 1);
  assert.equal(h.calls.find(call => call.type === 'GET_SYSTEM_PLANETS').force, true);
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.ok(h.finder.finderHits.every(hit => hit.userId === null && hit.owner === null && hit.alliance === null));
  h.requests.length = 0;
  h.el('f-ownership').value = 'owned';
  await h.el('f-ownership').fire('change');
  assert.equal(h.el('f-results-tbody').children.length, 0);
  assert.deepEqual(h.requests, []);
});

test('a terminal search 429 stops before the next system and preserves already collected matches', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  await saveSystem('s0', 1, h.data[1]);
  const send = globalThis.browser.runtime.sendMessage;
  const attempted = [];
  globalThis.browser.runtime.sendMessage = message => {
    if (message.type === 'GET_SYSTEM_PLANETS') {
      attempted.push(message.systemId);
      return Promise.resolve({ error: 'Too many requests', status: 429 });
    }
    return send(message);
  };
  await h.el('f-search').fire();
  assert.deepEqual(attempted, [2]);
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
  assert.match(h.el('f-progress').textContent, /Stopped: API rate limit \(429\)/);
  assert.equal(h.el('f-search').disabled, false);
  assert.equal(h.el('f-search').textContent, 'Search');
  assert.equal(h.calls.some(call => call.type === 'GET_PLAYER_RANK'), false);
  globalThis.browser.runtime.sendMessage = send;
  await h.el('f-search').fire();
  assert.match(h.el('f-progress').textContent, /Done:/);
  assert.equal(h.store.galaxy_last_search.phase, 'complete');
});

test('a terminal ownership 429 stops further systems and ranks without losing cached ownership', async () => {
  const h = await harness();
  h.el('f-min-moons').value = '0';
  await h.el('f-search').fire();
  const owners = h.finder.finderHits.map(hit => hit.userId);
  const send = globalThis.browser.runtime.sendMessage;
  const attempted = [];
  globalThis.browser.runtime.sendMessage = message => {
    if (message.type === 'GET_SYSTEM_PLANETS') {
      attempted.push(message.systemId);
      return Promise.resolve({ error: 'Too many requests', status: 429 });
    }
    return send(message);
  };
  await h.el('f-check-ownership').fire();
  assert.deepEqual(attempted, [1]);
  assert.deepEqual(h.finder.finderHits.map(hit => hit.userId), owners);
  assert.match(h.el('f-ownership-progress').textContent, /Stopped: API rate limit \(429\)/);
  assert.equal(h.el('f-search').disabled, false);
  assert.equal(h.el('f-check-ownership').textContent, 'Check result ownership');
  assert.equal(h.calls.some(call => call.type === 'GET_PLAYER_RANK'), false);
});

test('failed ownership checks retain cached state and report failure without checking unrelated systems', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  const send = globalThis.browser.runtime.sendMessage;
  globalThis.browser.runtime.sendMessage = async message => message.type === 'GET_SYSTEM_PLANETS'
    ? { error: 'Game offline' } : send(message);
  await h.el('f-check-ownership').fire();
  assert.ok(h.finder.finderHits.every(hit => hit.userId === 55));
  assert.match(h.el('f-ownership-progress').textContent, /1 errors/);
  assert.equal(h.el('f-search').disabled, false);
});

test('missing moon data is loaded only after planet properties match, never for unrelated systems', async () => {
  const h = await harness();
  await restoreGalaxyCache();
  for (const id of [1, 2, 3, 4]) {
    await saveSystem('s0', id, { planets: h.data[id].planets }, Date.now() - 30 * 86400000);
  }
  await h.el('f-search').fire();
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets', '/api/galaxy/systems/4/planets']);
  assert.ok(h.calls.filter(call => call.type === 'GET_SYSTEM_PLANETS').every(call => call.purpose === 'static'));
  assert.deepEqual(h.finder.finderHits.map(hit => hit.planetId), [11, 12]);
});

async function seedUnknownOwnership(data) {
  await restoreGalaxyCache();
  for (const [id, contents] of Object.entries(data)) {
    const planets = contents.planets.map(planet => {
      const unknown = { ...planet };
      delete unknown.userId;
      return unknown;
    });
    await saveSystem('s0', Number(id), { ...contents, planets }, Date.now() - 30 * 86400000);
  }
}

test('unknown ownership is checked automatically after rendering base matches, then reused on repeat searches', async () => {
  const h = await harness();
  await seedUnknownOwnership(h.data);
  const send = globalThis.browser.runtime.sendMessage;
  let resolve;
  let started;
  const checkingStarted = new Promise(done => { started = done; });
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type !== 'GET_SYSTEM_PLANETS') return send(message);
    return new Promise(done => {
      resolve = async () => done(await send(message));
      started();
    });
  };
  const searching = h.el('f-search').fire();
  await checkingStarted;
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.ok(h.finder.finderHits.every(hit => !hit.ownershipKnown));
  assert.match(h.el('f-progress').textContent, /Done: 2 matches/);
  await resolve();
  await searching;
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  assert.ok(h.finder.finderHits.every(hit => hit.ownershipKnown && hit.userId === 55));
  assert.equal(h.calls.some(call => call.type === 'GET_PLAYER_RANK'), false);
  globalThis.browser.runtime.sendMessage = send;
  h.calls.length = 0;
  await h.el('f-search').fire();
  assert.deepEqual(h.calls.map(call => call.type), ['GET_GALAXY_SCANS']);
});

test('automatic ownership discovery includes unknown matches hidden by local ownership filters', async () => {
  const h = await harness();
  await seedUnknownOwnership(h.data);
  h.data[1].planets = h.data[1].planets.map(planet => ({ ...planet, userId: null }));
  h.el('f-ownership').value = 'unowned';
  await h.el('f-search').fire();
  assert.equal(h.el('f-results-tbody').children.length, 2);
  assert.deepEqual(h.requests, ['/api/galaxy/systems/1/planets']);
  assert.ok(h.finder.finderHits.every(hit => hit.ownershipKnown && hit.userId === null));
});

test('failed automatic discovery reports errors, preserves unknown state and restores controls', async () => {
  const h = await harness();
  await seedUnknownOwnership(h.data);
  const send = globalThis.browser.runtime.sendMessage;
  const checked = [];
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type !== 'GET_SYSTEM_PLANETS') return send(message);
    checked.push(message.systemId);
    return { error: 'Game offline' };
  };
  await h.el('f-search').fire();
  assert.deepEqual(checked, [1]);
  assert.ok(h.finder.finderHits.every(hit => !hit.ownershipKnown));
  assert.match(h.el('f-ownership-progress').textContent, /1 errors/);
  assert.equal(h.el('f-search').disabled, false);
  assert.equal(h.el('f-check-ownership').disabled, false);
});

test('an ownership reply arriving after a server switch cannot repopulate cleared results', async () => {
  const h = await harness();
  await h.el('f-search').fire();
  const send = globalThis.browser.runtime.sendMessage;
  let resolve;
  globalThis.browser.runtime.sendMessage = async message => message.type === 'GET_SYSTEM_PLANETS'
    ? new Promise(done => { resolve = done; }) : send(message);
  const checking = h.el('f-check-ownership').fire();
  h.finder.resetFinderTab();
  resolve(h.data[1]);
  await checking;
  assert.deepEqual(h.finder.finderHits, []);
  assert.equal(h.el('f-check-ownership').disabled, true);
  assert.equal(h.el('f-search').disabled, false);
});

test('deletion requires server-named confirmation, supports cancellation and aborts on server changes', async () => {
  const h = await harness();
  let key = 's0', reloads = 0;
  const deleted = [];
  globalThis.nexusStorage = { getActiveServer: async () => ({ key, name: `Server ${key}` }) };
  globalThis.location = { reload: () => { reloads++; } };
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_PUBLIC_GALAXY_STATUS') return {};
    deleted.push(message);
    return { ok: true };
  };
  const options = await import(`../nexus-addon/tabs/options.js?test=${crypto.randomUUID()}`);
  options.initOptionsTab();
  const choose = async (label, action) => {
    const clearing = h.el('btn-clear-galaxy-cache').fire();
    await new Promise(resolve => setImmediate(resolve));
    const overlay = globalThis.document.body.children.at(-1);
    assert.match(overlay.textContent, /WARNING: Delete all saved galaxy knowledge for Server s0 \(s0\)/);
    const buttons = overlay.children[0].children.at(-1).children;
    action?.();
    buttons.find(button => button.textContent === label).onclick();
    await clearing;
  };
  await choose('Cancel');
  assert.deepEqual(deleted, []);
  await choose('Confirm', () => { key = 'beta'; });
  assert.deepEqual(deleted, []);
  assert.match(h.el('galaxy-cache-status').textContent, /selected server changed/);
  key = 's0';
  await choose('Confirm');
  assert.deepEqual(deleted, [{ type: 'CLEAR_GALAXY_CACHE', serverKey: 's0' }]);
  assert.equal(reloads, 1);
});

test('public options export requires confirmation, downloads only a local file and offers a manual issue link', async () => {
  const data = { ...emptyPublicGalaxy('s0'), systems: [{ id: 1, name: 'System', planets: [{ id: 11, size: 200 }] }] };
  const h = await harness({}, { publicExport: { data } });
  globalThis.Blob = NodeBlob;
  const options = await import(`../nexus-addon/tabs/options.js?test=${crypto.randomUUID()}`);
  options.initOptionsTab();
  await new Promise(resolve => setImmediate(resolve));
  const nativeCreate = globalThis.document.createElement, nativeURL = URL.createObjectURL;
  let downloaded, anchor;
  globalThis.document.createElement = tag => {
    const node = nativeCreate(tag);
    if (tag === 'a') { anchor = node; node.click = () => {}; }
    return node;
  };
  URL.createObjectURL = blob => { downloaded = blob; return 'blob:public-test'; };
  try {
    const exporting = h.el('btn-export-public-galaxy').fire();
    await new Promise(resolve => setImmediate(resolve));
    const overlay = globalThis.document.body.children.at(-1);
    assert.match(overlay.textContent, /1 systems, 1 planets/);
    assert.match(overlay.textContent, /nothing is uploaded/);
    assert.equal(downloaded, undefined, 'nothing is downloaded before confirmation');
    overlay.children[0].children.at(-1).children.find(button => button.textContent === 'Confirm').onclick();
    await exporting;
    assert.deepEqual(JSON.parse(await downloaded.text()), data);
    assert.equal(anchor.download, 'nexus-galaxy-public-s0.json');
    assert.equal(h.el('public-galaxy-issue').hidden, false);
    assert.match(h.el('public-galaxy-issue').href, /issues\/new\?template=galaxy_data.md/);
    assert.match(h.el('public-galaxy-status').textContent, /Nothing was uploaded/);
    assert.ok(h.calls.every(call => ['GET_PUBLIC_GALAXY_STATUS', 'EXPORT_PUBLIC_GALAXY'].includes(call.type)));
    assert.deepEqual(h.requests, []);
  } finally {
    globalThis.document.createElement = nativeCreate;
    URL.createObjectURL = nativeURL;
  }
});

test('public update options show stored errors and allow a forced manual check', async () => {
  const h = await harness({}, { publicStatus: { error: 'Offline', message: 'Update failed: Offline', installed: 'a'.repeat(64) } });
  const options = await import(`../nexus-addon/tabs/options.js?test=${crypto.randomUUID()}`);
  options.initOptionsTab();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.el('public-galaxy-status').textContent, /Update failed: Offline/);
  await h.el('btn-update-public-galaxy').fire();
  assert.ok(h.calls.some(call => call.type === 'UPDATE_PUBLIC_GALAXY' && call.force && call.serverKey === 's0'));
  assert.equal(h.el('btn-update-public-galaxy').disabled, false);
});

test('galaxy deletion stays in Data with warning only on confirmation, and exploration refresh is removed', async () => {
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const dataPanel = html.slice(html.indexOf('id="opt-data"'), html.indexOf('id="opt-developer"'));
  assert.match(dataPanel, /id="btn-clear-galaxy-cache"/);
  assert.doesNotMatch(dataPanel, /galaxy-clear-warning|WARNING: Permanently delete/);
  const finder = html.slice(html.indexOf('id="finder-content"'), html.indexOf('id="asteroids-content"'));
  assert.doesNotMatch(finder, /Clear galaxy cache|f-clear-cache|f-refresh-ownership|f-refresh-map|Update exploration overview/);
  assert.doesNotMatch(finder, /f-temp-min|f-temp-max|Search uses saved planet/);
  assert.match(finder, /id="f-zone"[^>]*role="group"/);
  assert.match(finder, /id="f-min-moon-slots"/);
  assert.doesNotMatch(finder, /id="f-max-size"/);
  assert.match(finder, /Slots on one free moon, not the total/);
  assert.match(finder, /Check result ownership/);
  assert.ok(finder.indexOf('id="f-check-ownership"') > finder.indexOf('<h2>Matches</h2>'));
  for (const view of ['map', 'search', 'systems', 'planets', 'moons']) {
    assert.match(finder, new RegExp(`id="f-tab-${view}"[^>]*role="tab"`));
  }
  assert.match(finder, /id="f-tab-map"[^>]*aria-selected="true"/);
  assert.match(finder, /id="f-directory"[^>]*hidden/);
  const map = finder.slice(finder.indexOf('<section id="f-map-panel"'), finder.indexOf('<section id="f-search-panel"'));
  const search = finder.slice(finder.indexOf('<section id="f-search-panel"'), finder.indexOf('<section id="f-directory"'));
  assert.match(map, /id="f-map"/);
  assert.match(map, /Known galaxy/);
  assert.doesNotMatch(map, /id="f-search"|id="f-results-tbody"/);
  assert.match(search, /Completes missing data/);
  assert.match(search, /id="f-results-tbody"/);
  assert.doesNotMatch(search, /<canvas/);
  assert.match(finder, /Saved data/);
});
