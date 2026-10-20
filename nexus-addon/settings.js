// Addon-wide preferences. One object under a single global storage key (shared by
// all universes, untouched by "Reset stats data", included in the JSON export).
// Every option is declared once in DEFAULTS; values are read synchronously from
// a cache that loadSettings() fills and storage changes keep fresh.

import './diagnostics-core.js';

export const DEFAULTS = Object.freeze({
  'dashboard.attention.labs': true,
  'dashboard.attention.construction': true,
  'dashboard.attention.storage': true,
  'dashboard.attention.damaged': true,
  'dashboard.attention.commandRepair': true,
  'dashboard.attention.talents': true,
  'dashboard.attention.shipyards': false,
  'dashboard.attention.fleetSlots': false,
  'dashboard.attention.colonySlots': false,
  'dashboard.storageThreshold': 90,
  'dashboard.refreshSeconds': 60,
  'dashboard.show.empire': true,
  'dashboard.show.missions': true,
  'dashboard.show.moons': true,
  'dashboard.moonsAfterPlanet': false,
  'data.autoBackup': 'weekly',
  'data.publicGalaxyAutoUpdate': true,
  'general.numberFormat': 'de',
  'general.defaultTab': 'dashboard',
  'developer.logLevel': 'warn',
  'developer.recording': false,
  'developer.apiWaitRecording': false,
});

const listeners = new Set();
let cache = { ...DEFAULTS };
let started = false;

function sanitize(stored) {
  const out = { ...DEFAULTS };
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof stored[key] === typeof DEFAULTS[key]) out[key] = stored[key];
  }
  if (!['debug', 'info', 'warn', 'error'].includes(out['developer.logLevel'])) out['developer.logLevel'] = DEFAULTS['developer.logLevel'];
  return out;
}

function apply(stored) {
  cache = sanitize(stored);
  globalThis.nexusDiagnostics.setLogLevel(cache['developer.logLevel']);
  for (const fn of listeners) fn(cache);
}

export async function loadSettings() {
  if (!started) {
    started = true;
    globalThis.nexusStorage?.onChanged?.addListener(changes => {
      if (changes.nexus_settings) apply(changes.nexus_settings.newValue);
    });
  }
  apply(await globalThis.nexusStorage?.getSettings?.());
  return cache;
}

export function getSetting(key) {
  return cache[key];
}

// Only differences from DEFAULTS are stored, so new defaults reach existing users.
export async function setSettings(values) {
  const next = { ...cache, ...values };
  const stored = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (next[key] !== DEFAULTS[key]) stored[key] = next[key];
  }
  await globalThis.nexusStorage?.setSettings?.(stored);
  apply(stored);
}

export function resetSettings(prefix = '') {
  const values = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key.startsWith(prefix)) values[key] = DEFAULTS[key];
  }
  return setSettings(values);
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
