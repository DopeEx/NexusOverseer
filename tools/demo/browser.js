import { createDemoData, demoResponse, DEMO_NOW } from './fixtures.js';

const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(DEMO_NOW);
  }
  static now() { return DEMO_NOW; }
};

const data = createDemoData();
const listeners = new Set();
const onChanged = {
  addListener(fn) { listeners.add(fn); },
  removeListener(fn) { listeners.delete(fn); },
};
function notify(changes) {
  if (Object.keys(changes).length) {
    for (const fn of listeners) fn(changes, 'local');
  }
}
const local = {
  onChanged,
  async get(keys) {
    if (keys == null) return structuredClone(data.storage);
    const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list
      .filter(key => Object.hasOwn(data.storage, key) || Object.hasOwn(defaults, key))
      .map(key => [key, structuredClone(Object.hasOwn(data.storage, key) ? data.storage[key] : defaults[key])]));
  },
  async set(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: structuredClone(data.storage[key]), newValue: structuredClone(value) };
      data.storage[key] = structuredClone(value);
    }
    notify(changes);
  },
  async remove(keys) {
    const changes = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!Object.hasOwn(data.storage, key)) continue;
      changes[key] = { oldValue: structuredClone(data.storage[key]) };
      delete data.storage[key];
    }
    notify(changes);
  },
  async clear() { await local.remove(Object.keys(data.storage)); },
};
globalThis.browser = {
  storage: { local, onChanged },
  runtime: {
    getManifest: () => ({ version: '2.1.0-demo' }),
    getURL: path => new URL(`/${path}`, location.origin).href,
    async sendMessage(message) {
      const response = demoResponse(data, message);
      if (response.error) console.warn(response.error);
      return response;
    },
  },
};
const server = { key: 'demo', name: 'Demo Universe (fictional)', origin: location.origin };
globalThis.nexusStorage = {
  onChanged,
  getActiveServer: async () => ({ ...server }),
  async setActiveServer(key) {
    if (key !== 'demo') throw new Error('Only the fictional demo universe is available.');
  },
  getSettings: async () => structuredClone(data.storage.nexus_settings || {}),
  setSettings: values => local.set({ nexus_settings: values }),
  exportFullStorage: () => local.get(null),
};
