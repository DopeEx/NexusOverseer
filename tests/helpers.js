// Shared test fixtures and the browser-API stub used to run background.js
// under node.

export function xenoDigReports() {
  return [
    [900101, 900201, '2030-01-19T10:00:00.000Z', 'observatory', 'careful', 7767, 38869, 11, 4, 7, 'celestial_chronometer'],
    [900102, 900202, '2030-01-21T10:00:00.000Z', 'ruins', 'careful', 9111, 33014, 6, 2, 7, 'support_pillar'],
    [900103, 900203, '2030-01-21T14:00:00.000Z', 'necropolis', 'fast', 10454, 29401, 1, 0, 6, null],
  ].map(([id, missionId, createdAt, trace, mode, delivered, overflow, destroyed, damaged, rounds, monument]) => ({
    id, missionId, createdAt, trace, mode, zone: 'sentinel', entranceTrace: 'spire',
    hall: false, outcome: 'success', excavatorsSent: 3, excavatorsLost: 0,
    battleReportId: id + 1000, isRead: true,
    report: {
      rounds, fleetLost: false, moonName: 'Archive Moon', systemName: 'Test System',
      shipsLost: [{ shipDefId: 21, key: 'missile_cruiser', name: 'Missile Cruiser', destroyed, damaged }],
      delivered: { resources: { silicates: delivered }, fragments: 0, artifactTier: id === 900103 ? 'rare' : null },
      overflow: { resources: { silicates: overflow }, fragments: 0, artifactTier: null },
      monument: monument ? { key: monument, copies: 1 } : null,
      codex: id === 900101 ? { set: 'gaze', entry: 1 } : null,
      garrison: [{ key: 'xeno_chorus', quantity: 43 }, { key: 'xeno_golem', quantity: 9 }],
      guardianLosses: [{ key: 'xeno_chorus', lost: 43 }, { key: 'xeno_golem', lost: 9 }],
      excavatorsRecovered: 0, hallRequested: false,
    },
  }));
}

// Real ship stats from the in-game ship screens (Stats.txt, 2026-06-22).
const SHIP_DEFS = {
  scout:           { key: 'scout',           name: 'Scout',           hp: 100,    shieldHp: 25,    attack: 15,   weaponType: 'kinetic', armorType: 'light',    shipSize: 'small',  costOre: 194,    costSilicates: 97,     costHydrogen: 0,      costAlloys: 20    },
  fighter:         { key: 'fighter',         name: 'Fighter',         hp: 250,    shieldHp: 60,    attack: 30,   weaponType: 'laser',   armorType: 'light',    shipSize: 'small',  costOre: 485,    costSilicates: 243,    costHydrogen: 49,     costAlloys: 97    },
  interceptor:     { key: 'interceptor',     name: 'Interceptor',     hp: 200,    shieldHp: 50,    attack: 35,   weaponType: 'kinetic', armorType: 'light',    shipSize: 'small',  costOre: 873,    costSilicates: 485,    costHydrogen: 194,    costAlloys: 194   },
  bomber:          { key: 'bomber',          name: 'Bomber',          hp: 650,    shieldHp: 150,   attack: 120,  weaponType: 'missile', armorType: 'heavy',    shipSize: 'large',  costOre: 2910,   costSilicates: 1940,   costHydrogen: 970,    costAlloys: 485   },
  cruiser:         { key: 'cruiser',         name: 'Cruiser',         hp: 700,    shieldHp: 200,   attack: 65,   weaponType: 'laser',   armorType: 'medium',   shipSize: 'medium', costOre: 1940,   costSilicates: 970,    costHydrogen: 485,    costAlloys: 243   },
  battleship:      { key: 'battleship',      name: 'Battleship',      hp: 1500,   shieldHp: 500,   attack: 90,   weaponType: 'plasma',  armorType: 'heavy',    shipSize: 'large',  costOre: 5820,   costSilicates: 3395,   costHydrogen: 1746,   costAlloys: 679   },
  missile_cruiser: { key: 'missile_cruiser', name: 'Missile Cruiser', hp: 1000,   shieldHp: 300,   attack: 70,   weaponType: 'missile', armorType: 'heavy',    shipSize: 'medium', costOre: 3104,   costSilicates: 1552,   costHydrogen: 776,    costAlloys: 388   },
  carrier:         { key: 'carrier',         name: 'Carrier',         hp: 2000,   shieldHp: 600,   attack: 30,   weaponType: 'laser',   armorType: 'heavy',    shipSize: 'large',  costOre: 3880,   costSilicates: 2425,   costHydrogen: 970,    costAlloys: 340   },
  torpedo_frigate: { key: 'torpedo_frigate', name: 'Torpedo Frigate', hp: 180,    shieldHp: 40,    attack: 55,   weaponType: 'missile', armorType: 'light',    shipSize: 'small',  costOre: 1164,   costSilicates: 679,    costHydrogen: 388,    costAlloys: 291   },
  dreadnought:     { key: 'dreadnought',     name: 'Dreadnought',     hp: 20000,  shieldHp: 8000,  attack: 800,  weaponType: 'ion',     armorType: 'heavy',    shipSize: 'huge',   costOre: 145500, costSilicates: 97000,  costHydrogen: 58200,  costAlloys: 38800 },
  titan:           { key: 'titan',           name: 'Titan',           hp: 200000, shieldHp: 60000, attack: 5000, weaponType: 'ion',     armorType: 'shielded', shipSize: 'huge',   costOre: 1940000, costSilicates: 1455000, costHydrogen: 727500, costAlloys: 727500 },
  gas_collector:            { key: 'gas_collector',            name: 'Gas Collector',            hp: 250,  shieldHp: 60,  attack: 0,   weaponType: null,  armorType: 'light',  shipSize: 'large',  costOre: 485,   costSilicates: 388,   costHydrogen: 194,  costAlloys: 97  },
  electronic_warfare_ship:  { key: 'electronic_warfare_ship',  name: 'Electronic Warfare Ship',  hp: 400,  shieldHp: 80,  attack: 10,  weaponType: 'ion', armorType: 'medium', shipSize: 'medium', costOre: 1455,  costSilicates: 1940,  costHydrogen: 776,  costAlloys: 291 },
};

// Stubbed browser.storage.local backed by a plain object. Returns the store
// so tests can inspect and seed it.
function makeBrowserStub(store = {}) {
  delete globalThis.nexusStorage;

  const onInstalled = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const onMessage = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const onAlarm = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const onClicked = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const onNotificationsClicked = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const onStorageChanged = {
    listeners: [],
    addListener(fn) { this.listeners.push(fn); },
    removeListener(fn) { this.listeners = this.listeners.filter(l => l !== fn); },
    notify(changes, area = 'local') {
      for (const listener of [...this.listeners]) listener(changes, area);
    },
  };

  global.browser = {
    storage: {
      onChanged: onStorageChanged,
      local: {
        get: async keys => {
          if (keys === null) return { ...store };
          const list = typeof keys === 'string' ? [keys] : keys;
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        set: async obj => {
          const before = {};
          for (const [k, v] of Object.entries(obj)) {
            if (Object.hasOwn(store, k) && store[k] !== v) before[k] = { oldValue: store[k], newValue: v };
            else if (!Object.hasOwn(store, k)) before[k] = { newValue: v };
          }
          Object.assign(store, obj);
          if (Object.keys(before).length) onStorageChanged.notify(before, 'local');
        },
        clear: async () => {
          const before = {};
          for (const [k, v] of Object.entries(store)) before[k] = { oldValue: v };
          for (const k of Object.keys(store)) delete store[k];
          if (Object.keys(before).length) onStorageChanged.notify(before, 'local');
        },
        remove: async keys => {
          const list = Array.isArray(keys) ? keys : [keys];
          const before = {};
          for (const k of list) {
            if (Object.hasOwn(store, k)) before[k] = { oldValue: store[k] };
          }
          for (const k of list) delete store[k];
          if (Object.keys(before).length) onStorageChanged.notify(before, 'local');
        },
      },
    },
    runtime: {
      onInstalled,
      onMessage,
      getManifest: () => ({ version: 'test' }),
      getURL: path => `chrome-extension://test/${path}`,
    },
    alarms: { create() {}, clear() {}, onAlarm },
    browserAction: { onClicked },
    action: { onClicked },
    cookies: {
      get: async () => null,
      getAll: async () => [],
      getAllCookieStores: async () => [],
    },
    tabs: {
      create() {},
      query: async () => [],
      update() {},
      sendMessage: async () => ({ ok: true }),
    },
    windows: { update() {} },
    notifications: { create() {}, clear() {}, onClicked: onNotificationsClicked },
    webRequest: { onCompleted: { addListener() {} }, onBeforeRequest: { addListener() {} }, filterResponseData() {} },
    downloads: { download: async () => 1 },
  };
  global.Blob = class { constructor() {} };
  if (!global.URL || global.URL.name !== 'URL') {
    global.URL = globalThis.URL;
  }
  global.setStatusText = () => {};
  return store;
}

// Imports background.js (ESM service worker) and returns its exported
// functions. Stub the browser API (makeBrowserStub) before calling. The query
// param busts the module cache so each call gets a fresh instance, matching the
// old eval-based harness (per-call isolation of any module-level state).
let _bgN = 0;
async function loadBackground() {
  return import(`../nexus-addon/background.js?n=${_bgN++}`);
}

// Stubs document + browser globally so DOM-wiring modules (the simulator
// chain) can be imported under node without a real DOM.
function setupDomStub() {
  const el = {
    addEventListener() {}, appendChild() {}, remove() {}, scrollIntoView() {},
    querySelectorAll: () => [], dataset: {}, style: {}, options: { length: 0 },
    selectedOptions: [], value: '', textContent: '', className: '', checked: false,
  };
  global.document = {
    getElementById: () => el,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {},
      appendChild() {},
      append() {},
      remove() {},
      setAttribute() {},
      addEventListener() {},
      classList: { add() {}, remove() {} },
      dataset: {},
      textContent: '',
      value: '',
      checked: false,
    }),
  };
  global.setStatusText = () => {};
  makeBrowserStub();
}

export { SHIP_DEFS, makeBrowserStub, loadBackground, setupDomStub };
