// Options tab: binds the controls declared in dashboard.html to settings.js.
// Every control with data-setting reads and writes one option immediately.

import { DEFAULTS, getSetting, onSettingsChange, resetSettings, setSettings } from '../settings.js';

let bound = false;

function readControl(ctl) {
  const key = ctl.dataset.setting;
  if (ctl.type === 'checkbox') return ctl.checked;
  return typeof DEFAULTS[key] === 'number' ? Number(ctl.value) : ctl.value;
}

function syncControls() {
  for (const ctl of document.querySelectorAll('#options-content [data-setting]')) {
    const value = getSetting(ctl.dataset.setting);
    if (ctl.type === 'checkbox') ctl.checked = value;
    else ctl.value = String(value);
  }
}

function download(name, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bind() {
  for (const ctl of document.querySelectorAll('#options-content [data-setting]')) {
    ctl.addEventListener('change', () => { void setSettings({ [ctl.dataset.setting]: readControl(ctl) }); });
  }
  for (const btn of document.querySelectorAll('#options-content [data-reset-prefix]')) {
    btn.addEventListener('click', () => { void resetSettings(btn.dataset.resetPrefix); });
  }
  onSettingsChange(syncControls);

  document.getElementById('btn-export-settings').addEventListener('click', () => {
    const settings = {};
    for (const key of Object.keys(DEFAULTS)) settings[key] = getSetting(key);
    download(`nexus-overseer-options-${new Date().toISOString().slice(0, 10)}.json`, {
      nexus_overseer_options: 1,
      exported_at: new Date().toISOString(),
      settings,
    });
  });

  const file = document.getElementById('import-settings-file');
  document.getElementById('btn-import-settings').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (payload?.nexus_overseer_options !== 1 || typeof payload.settings !== 'object' || !payload.settings) {
        throw new Error('not a Nexus Overseer options file');
      }
      const values = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof payload.settings[key] === typeof DEFAULTS[key]) values[key] = payload.settings[key];
      }
      await setSettings(values);
    } catch (e) {
      alert(`Import failed: ${e.message}`);
    }
  });
}

export function initOptionsTab() {
  if (!bound) {
    bound = true;
    bind();
  }
  syncControls();
  const section = globalThis.nexusOptionsSection;
  globalThis.nexusOptionsSection = null;
  if (section) document.getElementById(`opt-${section}`)?.scrollIntoView({ block: 'start' });
}
