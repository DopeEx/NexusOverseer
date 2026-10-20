// Options tab: binds the controls declared in dashboard.html to settings.js.
// Every control with data-setting reads and writes one option immediately.

import { DEFAULTS, getSetting, onSettingsChange, resetSettings, setSettings } from '../settings.js';
import { initDeveloperTab } from './developer.js';
import { confirmDialog, setStatusText } from '../common.js';
import { validatePublicGalaxy } from '../galaxy-public.js';

let bound = false;
let activeSection = 'general';
let selected = false;
let publicStatusRead = 0;

export async function refreshPublicGalaxyStatus() {
  const read = ++publicStatusRead;
  const element = document.getElementById('public-galaxy-status');
  try {
    const server = await globalThis.nexusStorage.getActiveServer();
    const response = await browser.runtime.sendMessage({ type: 'GET_PUBLIC_GALAXY_STATUS', serverKey: server.key });
    const current = await globalThis.nexusStorage.getActiveServer();
    if (read !== publicStatusRead || current.key !== server.key) return;
    if (response.error && !response.message) throw new Error(response.error);
    setStatusText(element, `${server.name || server.key} · ${response.message || 'Not checked yet.'} · ` +
      `Installed: ${response.installed ? response.installed.slice(0, 12) : 'none'} · ` +
      `Last check: ${response.checkedAt ? new Date(response.checkedAt).toLocaleString() : 'never'} · ` +
      `Last successful check: ${response.successAt ? new Date(response.successAt).toLocaleString() : 'never'}`);
  } catch (error) {
    if (read === publicStatusRead) setStatusText(element, `Public galaxy status unavailable: ${error.message}`);
  }
}

export async function checkPublicGalaxyUpdates(force = false) {
  const status = document.getElementById('public-galaxy-status');
  try {
    if (!force && !getSetting('data.publicGalaxyAutoUpdate')) return;
    const server = await globalThis.nexusStorage.getActiveServer();
    const result = await browser.runtime.sendMessage({ type: 'UPDATE_PUBLIC_GALAXY', serverKey: server.key, force });
    if (result.error && !result.message) throw new Error(result.error);
    if (result.error) console.warn('[NexusOverseer] Public galaxy update:', result.error);
    await refreshPublicGalaxyStatus();
  } catch (error) {
    console.warn('[NexusOverseer] Public galaxy update failed:', error);
    setStatusText(status, `Public galaxy update failed: ${error.message}`);
  }
}

function selectSection(section) {
  if (!['general', 'data', 'developer'].includes(section)) return;
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
  onSettingsChange(() => { void checkPublicGalaxyUpdates(); });

  document.getElementById('btn-update-public-galaxy').addEventListener('click', async function () {
    this.disabled = true;
    setStatusText(document.getElementById('public-galaxy-status'), 'Checking public galaxy data…');
    try { await checkPublicGalaxyUpdates(true); }
    finally { this.disabled = false; }
  });

  document.getElementById('btn-export-public-galaxy').addEventListener('click', async function () {
    this.disabled = true;
    const status = document.getElementById('public-galaxy-status');
    const issue = document.getElementById('public-galaxy-issue');
    issue.hidden = true;
    try {
      const server = await globalThis.nexusStorage.getActiveServer();
      const response = await browser.runtime.sendMessage({ type: 'EXPORT_PUBLIC_GALAXY', serverKey: server.key });
      if (response.error || !response.data) throw new Error(response.error || 'No export returned.');
      const data = validatePublicGalaxy(response.data, server.key);
      const count = group => data.systems.reduce((total, system) => total + (system[group]?.length || 0), 0);
      const summary = `${data.systems.length} systems, ${count('planets')} planets, ${count('moons')} moons, ${data.stations.length} stations, ${data.hubs.length} hubs`;
      if (!await confirmDialog(`Export public galaxy structure for ${server.name || server.key} (${server.key})?\n\n${summary}\n\nOnly approved non-personal base fields are included. No owners, colony names, resources or upgraded building slots. This only downloads a local file; nothing is uploaded.`)) return;
      const current = await globalThis.nexusStorage.getActiveServer();
      if (current.key !== server.key) throw new Error('The selected server changed. Export again for the selected universe.');
      download(`nexus-galaxy-public-${server.key}.json`, data);
      issue.href = `https://github.com/DopeEx/NexusOverseer/issues/new?template=galaxy_data.md&title=${encodeURIComponent(`[Galaxy data] ${server.key}`)}`;
      issue.hidden = false;
      setStatusText(status, `Export downloaded: ${summary}. Review the file, open a contribution issue and attach it manually. Nothing was uploaded.`);
    } catch (error) { setStatusText(status, `Public export failed: ${error.message}`); }
    finally { this.disabled = false; }
  });

  document.getElementById('btn-clear-galaxy-cache').addEventListener('click', async function () {
    const status = document.getElementById('galaxy-cache-status');
    this.disabled = true;
    try {
      const server = await globalThis.nexusStorage.getActiveServer();
      if (!await confirmDialog(`⚠ WARNING: Delete all saved galaxy knowledge for ${server.name || server.key} (${server.key})?\n\nThis permanently removes collected planet and moon data, cached ownership and installed public base data for this server. Future searches will need additional API requests to collect it again.\n\nAutomatic public updates can download the shared dataset again; disable them to keep it empty.\n\nThis is not needed when a new server opens: each server already has separate data. Reports and options are kept.\n\nExport a backup before continuing. Really delete this server's galaxy cache?`)) return;
      const selected = await globalThis.nexusStorage.getActiveServer();
      if (selected.key !== server.key) throw new Error('The selected server changed. Nothing was deleted; try again.');
      const response = await browser.runtime.sendMessage({ type: 'CLEAR_GALAXY_CACHE', serverKey: server.key });
      if (!response?.ok) throw new Error(response?.error || 'No confirmation from galaxy storage.');
      location.reload();
    } catch (error) {
      setStatusText(status, `Clear failed: ${error.message}`);
    } finally { this.disabled = false; }
  });

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
  void refreshPublicGalaxyStatus();
}
