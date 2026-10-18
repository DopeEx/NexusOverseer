// Fleets tab: named fleet templates, reusable by any task (mining a field,
// collecting gas, future jobs). A template is planet-agnostic — ship quantities
// keyed by shipDefId. Stored under `fleet_templates`.

import { ALL_RES_COLORS, setStatusText, ZONE_COLORS, ZONE_DEFS } from '../common.js';

let inited = false;
let templates = [];          // [{ id, name, ships: { shipDefId: qty } }]
let shipDefs = [];           // catalog: [{ shipDefId, name, shipClass, miningCargo, attack, ... }]
let currentId = null;        // template open in the editor

// Grouping mirrors the simulator's attacker fleet.
const GROUP_ORDER = ['combat', 'special', 'recon', 'utility'];
const GROUP_LABELS = { combat: 'Combat', special: 'Special', recon: 'Recon', utility: 'Utility' };

// Colour + "what it mines" per mining ship (keyed by ship key), so the template
// editor shows at a glance which fields each hauler works. Colours match the
// asteroid field-type palette.
const MINING_SHIPS = {
  miner:         { name: 'Mining Vessel', color: ALL_RES_COLORS.ore, mines: 'Ore, Plasma Core' },
  gas_collector: { name: 'Gas Collector', color: ALL_RES_COLORS.hydrogen, mines: 'Hydrogen, Quantum Dust' },
  ice_drill:     { name: 'Ice Drill',     color: ALL_RES_COLORS.cryo_ice, mines: 'Cryo-Ice, Dark Matter' },
  excavator:     { name: 'Excavator',     color: '#ffc070', mines: '+20% fleet mining yield (all)' },
  freighter:     { name: 'Freighter',     color: '#c0cce0', mines: 'Ore, Cryo-Ice (basic)' },
};
function statText(s) {
  return `ATK ${s.attack} · HP ${s.hp} · SH ${s.shieldHp}` +
    (s.weaponType ? ` · ${s.weaponType}` : '') +
    (s.armorType ? ` · ${s.armorType}` : '') +
    (s.miningCargo ? ` · cargo ${s.miningCargo}` : '');
}

// Load templates, migrating the legacy single `mining_template` if present.
// Exported so other tabs (Asteroids) read the same list without duplicating
// the storage key or migration.
export async function loadFleetTemplates() {
  const { fleet_templates, mining_template } =
    await browser.storage.local.get(['fleet_templates', 'mining_template']);
  if (fleet_templates && fleet_templates.length) return fleet_templates;
  if (mining_template && Object.keys(mining_template.ships || {}).length) {
    const seeded = [{ id: Date.now(), name: 'Mining', ships: mining_template.ships }];
    await browser.storage.local.set({ fleet_templates: seeded });
    return seeded;
  }
  return [];
}

async function save() {
  await browser.storage.local.set({ fleet_templates: templates });
}

// Mining-ship colour legend (built once).
function renderLegend() {
  const box = document.getElementById('ft-legend');
  if (!box || box.childElementCount) return;
  for (const { name, color, mines } of Object.values(MINING_SHIPS)) {
    const item = document.createElement('span');
    item.className = 'fleet-legend-item';
    const sw = document.createElement('span');
    sw.className = 'fleet-legend-swatch';
    sw.style.background = color;
    const label = document.createElement('span');
    label.className = 'fleet-legend-text';
    label.innerHTML = `<b>${name}</b> <span>${mines}</span>`;
    item.append(sw, label);
    box.appendChild(item);
  }
}

export async function renderFleetsTab() {
  if (inited) return;
  inited = true;
  renderLegend();

  document.getElementById('ft-new').addEventListener('click', () => {
    const t = { id: Date.now(), name: 'New template', ships: {} };
    templates.push(t);
    currentId = t.id;
    save();
    fillSelect();
    fillEditor();
  });
  document.getElementById('ft-delete').addEventListener('click', () => {
    if (currentId == null) return;
    templates = templates.filter(t => t.id !== currentId);
    currentId = templates[0] ? templates[0].id : null;
    save();
    fillSelect();
    fillEditor();
  });
  document.getElementById('ft-select').addEventListener('change', e => {
    currentId = Number(e.target.value);
    fillEditor();
  });
  document.getElementById('ft-name').addEventListener('input', e => {
    const t = current();
    if (!t) return;
    t.name = e.target.value;
    document.getElementById('ft-box-title').textContent = t.name || 'Fleet';
    save();
    fillSelect();
  });
  templates = await loadFleetTemplates();
  currentId = templates[0] ? templates[0].id : null;
  fillSelect();
  fillEditor();

  const status = document.getElementById('ft-status');
  setStatusText(status, 'Loading ships…');
  const res = await browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' });
  setStatusText(status, res.error ? `Error: ${res.error}` : '');
  shipDefs = res.ships || [];
  fillShips();
}

function current() {
  return templates.find(t => t.id === currentId) || null;
}

function fillSelect() {
  const sel = document.getElementById('ft-select');
  sel.textContent = '';
  for (const t of templates) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    if (t.id === currentId) o.selected = true;
    sel.appendChild(o);
  }
}

function fillEditor() {
  const t = current();
  document.getElementById('ft-name').value = t ? t.name : '';
  document.getElementById('ft-name').disabled = !t;
  document.getElementById('ft-delete').disabled = !t;
  document.getElementById('ft-box-title').textContent = t ? (t.name || 'Fleet') : 'Fleet';
  fillShips();
  fillEscortZones();
}

// Ship rows for the open template, grouped + styled like the simulator's
// attacker fleet: name, stat line, quantity input.
function fillShips() {
  const groups = document.getElementById('ft-ships');
  groups.textContent = '';
  const t = current();
  if (!t) { groups.textContent = 'Create a template to begin.'; return; }
  if (!shipDefs.length) { groups.textContent = 'No ships found on your planets.'; return; }

  const ships = shipDefs.slice().sort((a, b) =>
    GROUP_ORDER.indexOf(a.shipClass) - GROUP_ORDER.indexOf(b.shipClass) || a.sortOrder - b.sortOrder);

  let lastGroup = null;
  let tbody;
  for (const s of ships) {
    if (s.shipClass !== lastGroup) {
      lastGroup = s.shipClass;
      const table = document.createElement('table');
      table.className = 'fleet-table';
      const columns = document.createElement('colgroup');
      for (const name of ['fleet-name-column', 'fleet-stats-column', 'fleet-quantity-column']) {
        const column = document.createElement('col');
        column.className = name;
        columns.appendChild(column);
      }
      table.appendChild(columns);
      tbody = document.createElement('tbody');
      table.appendChild(tbody);
      groups.appendChild(table);
      const gtr = document.createElement('tr');
      gtr.className = 'ship-group';
      const gtd = document.createElement('td');
      gtd.colSpan = 3;
      gtd.textContent = GROUP_LABELS[s.shipClass] || s.shipClass;
      gtr.appendChild(gtd);
      tbody.appendChild(gtr);
    }
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'ship-name';
    tdName.textContent = s.name;
    const mine = MINING_SHIPS[s.key];
    if (mine) { tdName.style.color = mine.color; tdName.title = `Mines: ${mine.mines}`; }
    else if (s.miningCargo) tdName.style.color = '#ffc070';   // any other hauler with mining cargo

    const tdStats = document.createElement('td');
    tdStats.className = 'ship-stats';
    tdStats.textContent = statText(s);

    const tdInput = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.5';
    input.value = t.ships[s.shipDefId] != null ? String(t.ships[s.shipDefId]) : '';
    input.addEventListener('input', () => {
      const v = parseFloat(input.value) || 0;
      if (v > 0) t.ships[s.shipDefId] = v; else delete t.ships[s.shipDefId];
      save();
    });
    tdInput.appendChild(input);

    tr.append(tdName, tdStats, tdInput);
    tbody.appendChild(tr);
  }
}

function fillEscortZones() {
  const box = document.getElementById('ft-escort-zones');
  box.textContent = '';
  const t = current();
  if (!t) return;

  const escortZones = t.escortZones || [];
  for (const zone of ZONE_DEFS) {
    const active = escortZones.includes(zone.key);
    const color = ZONE_COLORS[zone.key];
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = zone.label;
    button.className = 'fleet-escort-zone';
    button.style.borderColor = color;
    button.style.background = active ? color : 'transparent';
    button.style.color = active ? '#1b2030' : color;
    button.title = `Tag this template as an escort fleet for ${zone.label} zone`;
    button.addEventListener('click', () => {
      t.escortZones = active
        ? escortZones.filter(key => key !== zone.key)
        : [...escortZones, zone.key];
      save();
      fillEscortZones();
    });
    box.append(button);
  }

  const separator = document.createElement('span');
  separator.className = 'fleet-escort-separator';
  box.append(separator);

  const label = document.createElement('label');
  label.className = 'fleet-escort-ratio';
  label.title = 'Treat ship quantities as ratios per mining ship.';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!t.escortPerMiner;
  checkbox.addEventListener('change', () => {
    t.escortPerMiner = checkbox.checked;
    save();
  });
  label.append(checkbox, document.createTextNode('Per mining ship'));
  box.append(label);
}
