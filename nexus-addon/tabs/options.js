// Options tab: binds the controls declared in dashboard.html to settings.js.
// Every control with data-setting reads and writes one option immediately.

import { DEFAULTS, getSetting, onSettingsChange, resetSettings, setSettings } from '../settings.js';
import { initDeveloperTab } from './developer.js';

let bound = false;
let activeSection = 'general';
let selected = false;

function selectSection(section) {
  if (!['general', 'dashboard', 'data', 'developer'].includes(section)) return;
  const changed = !selected || activeSection !== section;
  selected = true;
  activeSection = section;
  for (const button of document.querySelectorAll('[data-option-section]')) {
    const active = button.dataset.optionSection === section;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(`opt-${button.dataset.optionSection}`);
    panel.hidden = !active;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
  }
  if (section === 'developer' && changed) initDeveloperTab();
}

async function save(action) {
  try { await action(); }
  catch (error) { alert(`Options could not be saved: ${error.message}`); syncControls(); }
}

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
  const sectionButtons = [...document.querySelectorAll('[data-option-section]')];
  for (const [index, button] of sectionButtons.entries()) {
    button.addEventListener('click', () => selectSection(button.dataset.optionSection));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % sectionButtons.length;
      if (event.key === 'ArrowLeft') next = (index + sectionButtons.length - 1) % sectionButtons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = sectionButtons.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      sectionButtons[next].focus();
      selectSection(sectionButtons[next].dataset.optionSection);
    });
  }
  for (const ctl of document.querySelectorAll('#options-content [data-setting]')) {
    ctl.addEventListener('change', () => { void save(() => setSettings({ [ctl.dataset.setting]: readControl(ctl) })); });
  }
  for (const btn of document.querySelectorAll('#options-content [data-reset-prefix]')) {
    btn.addEventListener('click', () => { void save(() => resetSettings(btn.dataset.resetPrefix)); });
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
  selectSection(section || activeSection);
  if (section) document.getElementById(`opt-${section}`)?.scrollIntoView({ block: 'start' });
}
