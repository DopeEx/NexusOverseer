// Dashboard tab (default): empire bird's-eye view — active missions and fleet
// slots, running research, and per-colony construction, ship queues and hangar
// fleet. Data comes from the background's GET_DASHBOARD_OVERVIEW; countdowns
// tick locally every second, the data itself is re-fetched on a slower interval
// and whenever a countdown reaches zero.

import { fmt, missionProgress, usedFleetSlots, usesFleetSlot } from '../common.js';
import { getSetting, onSettingsChange } from '../settings.js';
import { AUTOMATIONS } from '../human-verification.js';

const CLASS_COLORS = { combat: '#ff6b7a', utility: '#7ed4ff', civilian: '#ffc070', recon: '#7ed957', special: '#bc8cff', other: '#8daabe' };
const RES_KEYS = [
  ['ore', 'Ore', 'ore'], ['silicates', 'Silicates', 'silicates'],
  ['hydrogen', 'Hydrogen', 'hydrogen'], ['alloys', 'Alloys', 'alloys'],
];

let started = false;
let data = null;
let loading = false;
let tickers = [];
let refreshAt = 0;

const root = () => document.getElementById('dashboard-content');
const visible = () => root() && root().style.display !== 'none';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'done';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  if (d) return `${d}d ${h}h ${p(m)}m`;
  if (h) return `${h}h ${p(m)}m ${p(sec)}s`;
  if (m) return `${m}m ${p(sec)}s`;
  return `${sec}s`;
}

function countdown(endsAt, awaitingUpdate = false) {
  const span = el('span', 'ov-countdown');
  const target = new Date(endsAt).getTime();
  const update = () => {
    const ms = target - Date.now();
    span.textContent = `⏱ ${awaitingUpdate && ms <= 0 ? 'updating…' : fmtCountdown(ms)}`;
  };
  update();
  tickers.push({ update, target });
  return span;
}

function section(title) {
  const box = el('section', 'dashboard-panel');
  box.appendChild(el('div', 'section-label dashboard-section-label', title));
  return box;
}

function kv(label, value, cls) {
  const row = el('div', 'ov-kv');
  row.append(el('span', 'ov-kv-label', label), el('span', `ov-kv-value ${cls || ''}`, value));
  return row;
}

function bar(fraction, color) {
  const track = el('div', 'ov-bar');
  const fill = el('div', 'ov-bar-fill');
  fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  fill.style.background = color;
  track.appendChild(fill);
  return track;
}

function idle(title, text) {
  const box = el('div', 'ov-idle');
  box.append(el('b', null, title));
  if (text) box.append(el('span', null, text));
  return box;
}

const RARE_KEYS = [
  ['cryoIce', 'Cryo-Ice'], ['quantumDust', 'Quantum Dust'], ['plasmaCore', 'Plasma Core'],
  ['bioExtract', 'Bio-Extract'], ['darkMatter', 'Dark Matter'], ['antimatter', 'Antimatter'],
];

function statCard(label, cls, value, rate) {
  const card = el('div', `stat-card ${cls}`);
  card.append(el('div', 'label', label), el('div', 'value', fmt(value)));
  if (rate) card.appendChild(el('div', 'ov-dim ov-res-rate',   `${rate > 0 ? '+' : ''}${fmt(rate)}/h`));
  return card;
}

// Sum of stock and hourly production across every colony.
function totalsPanel(d) {
  const all = [...d.planets, ...(d.moons || [])];
  const sum = key => all.reduce((s, p) => s + (p.resources[key] || 0), 0);
  const panel = el('section', 'dashboard-panel global-overview-panel ov-totals');
  const head = el('div', 'ov-totals-head');
  head.append(el('div', 'section-label dashboard-section-label', 'Total resources'),
    el('span', 'ov-dim', `across ${d.planets.length} planets${d.moons?.length ? ` + ${d.moons.length} moons` : ''}`));
  panel.appendChild(head);

  const row = el('div', 'stats ov-stats');
  for (const [key, label, cls] of RES_KEYS) {
    row.appendChild(statCard(label, cls, sum(key), sum(`${key}Rate`)));
  }
  for (const [key, label] of RARE_KEYS) {
    row.appendChild(statCard(label, key, sum(key), sum(`${key}Rate`)));
  }
  row.style.setProperty('--n', row.children.length);
  panel.appendChild(row);
  return panel;
}

export function missionsCard(d) {
  const card = section('Active Missions');
  card.classList.add('ov-missions');
  const missions = d.missions;
  const max = d.maxFleetSlots;
  const used = usedFleetSlots(missions);
  const patrols = missions.length - used;
  const returns = missions
    .filter(usesFleetSlot)
    .map(m => missionProgress(m))
    .filter(p => p.status === 'returning' && p.event)
    .map(p => p.event)
    .sort((a, b) => a.at - b.at);
  card.appendChild(kv('Fleet slots used', `${used} / ${max ?? '?'}`));
  card.appendChild(bar(max ? used / max : 0, '#7ed4ff'));
  const next = el('div', 'ov-kv');
  next.appendChild(el('span', 'ov-kv-label', 'Next return'));
  if (returns.length) {
    const v = el('span', 'ov-kv-value ov-warn');
    v.appendChild(countdown(returns[0].at, true));
    next.appendChild(v);
  } else {
    next.appendChild(el('span', 'ov-kv-value ov-dim', '-'));
  }
  card.appendChild(next);
  if (patrols) card.appendChild(kv('Active patrols (no fleet slot)', String(patrols)));

  if (missions.length) {
    const groups = new Map();
    for (const m of missions) {
      const g = groups.get(m.type) || { type: m.type, fleets: 0, ships: 0, stages: {}, event: null };
      g.fleets++;
      g.ships += m.ships || 0;
      const progress = missionProgress(m);
      const st = progress.label;
      g.stages[st] = (g.stages[st] || 0) + 1;
      const event = progress.event;
      if (event && (!g.event || event.at < g.event.at)) g.event = event;
      groups.set(m.type, g);
    }
    const list = el('div', 'ov-list');
    for (const g of [...groups.values()].sort((a, b) => (a.event?.at ?? Infinity) - (b.event?.at ?? Infinity))) {
      const row = el('div', 'ov-row');
      const label = el('span', 'ov-row-name', `${g.type.replace(/_/g, ' ')} · ${g.fleets} ${g.fleets === 1 ? 'fleet' : 'fleets'} · ${g.ships.toLocaleString()} ships`);
      const right = el('span', 'ov-row-right');
      right.appendChild(el('span', 'ov-dim', Object.entries(g.stages).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')));
      if (g.event) {
        right.append(el('span', 'ov-dim', `${g.event.label}:`), countdown(g.event.at, true));
      }
      row.append(label, right);
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  return card;
}

function storageWarnings(d) {
  const out = [];
  const limit = getSetting('dashboard.storageThreshold') / 100;
  for (const p of [...d.planets, ...(d.moons || [])]) {
    const near = [];
    for (const [key, label] of RES_KEYS) {
      const cap = p.resources[`${key}Storage`];
      if (cap && p.resources[key] >= cap * limit) near.push([label, p.resources[key], cap]);
    }
    const rareCap = p.resources.rareStorage;
    if (rareCap) {
      for (const [key, label] of RARE_KEYS) {
        if (p.resources[key] >= rareCap * limit) near.push([label, p.resources[key], rareCap]);
      }
    }
    for (const [label, have, cap] of near) {
      out.push({ name: `${p.name}${p.isMoon ? ' (moon)' : ''}`, text: `${label}: ${Math.floor(have / cap * 100)}% (${fmt(have)} / ${fmt(cap)})` });
    }
  }
  return out;
}

// Things that may need the player's action; an entry only appears when it applies.
function attentionItems(d) {
  const on = key => getSetting(`dashboard.attention.${key}`);
  const items = [];
  const busyLabs = new Set(d.research.map(r => r.planetId));
  const idleLabs = on('labs') ? d.planets.filter(p => p.hasLab && !busyLabs.has(p.id)) : [];
  if (idleLabs.length) {
    items.push({ level: 'warn', text: `${idleLabs.length} research lab${idleLabs.length > 1 ? 's' : ''} idle`, tip: idleLabs.map(p => p.name) });
  }
  const noBuild = on('construction') ? d.planets.filter(p => p.queueMax != null && !p.construction.length) : [];
  if (noBuild.length) {
    items.push({ level: 'warn', text: `${noBuild.length} planet${noBuild.length > 1 ? 's' : ''} without construction`, tip: noBuild.map(p => p.name) });
  }
  const full = getSetting('dashboard.attention.storage') ? storageWarnings(d) : [];
  if (full.length) {
    const places = new Set(full.map(f => f.name)).size;
    items.push({ level: 'error', text: `Storage almost full on ${places} location${places > 1 ? 's' : ''}`, tip: full.map(f => `${f.name} - ${f.text}`) });
  }
  const hurt = on('damaged') ? [...d.planets, ...(d.moons || [])].filter(p => p.damaged?.length) : [];
  if (hurt.length) {
    const count = hurt.reduce((s, p) => s + p.damaged.reduce((n, x) => n + x.quantity, 0), 0);
    items.push({
      level: 'warn',
      text: `${count} damaged ship${count > 1 ? 's' : ''} need repair`,
      tip: hurt.flatMap(p => p.damaged.map(x => `${p.name}${p.isMoon ? ' (moon)' : ''} · ${x.quantity}× ${x.name}`)),
    });
  }
  if (on('commandRepair') && d.commander?.missingHull > 0) {
    const c = d.commander;
    items.push({ level: 'warn', text: 'Command ship needs repair', tip: [`${c.callsign || 'Command ship'}: ${fmt(c.missingHull)} / ${fmt(c.maxHull)} hull missing`] });
  }
  if (on('talents') && d.commander?.talentPoints) {
    items.push({ level: 'warn', text: `${d.commander.talentPoints} unspent command ship talent point${d.commander.talentPoints > 1 ? 's' : ''}`, tip: [d.commander.callsign].filter(Boolean) });
  }
  const idleYards = on('shipyards')
    ? [...d.planets, ...(d.moons || [])].filter(p => (p.shipYards || []).some(y => y.exists && !y.items.length))
    : [];
  if (idleYards.length) {
    items.push({ level: 'warn', text: `${idleYards.length} shipyard location${idleYards.length > 1 ? 's' : ''} idle`, tip: idleYards.map(p => `${p.name}${p.isMoon ? ' (moon)' : ''}`) });
  }
  const used = usedFleetSlots(d.missions);
  if (on('fleetSlots') && d.maxFleetSlots && used < d.maxFleetSlots) {
    const free = d.maxFleetSlots - used;
    items.push({ level: 'warn', text: `${free} free fleet slot${free > 1 ? 's' : ''}`, tip: [`${used} / ${d.maxFleetSlots} in use`] });
  }
  if (on('colonySlots') && d.slots) {
    if (d.slots.colonies > d.planets.length) items.push({ level: 'warn', text: 'Free colony slot', tip: [`${d.planets.length} / ${d.slots.colonies}`] });
    if (d.slots.moons > (d.moons?.length || 0)) items.push({ level: 'warn', text: 'Free moon slot', tip: [`${d.moons?.length || 0} / ${d.slots.moons}`] });
  }
  return items;
}

function attentionCard(d) {
  const items = attentionItems(d);
  if (!items.length) return null;
  const card = section('Needs attention');
  card.classList.add('ov-attention');
  const gear = el('button', 'ov-gear', '⚙');
  gear.type = 'button';
  gear.title = 'Choose which hints are shown';
  gear.addEventListener('click', () => {
    globalThis.nexusOptionsSection = 'dashboard';
    document.querySelector('.main-tab[data-tab="options"]')?.click();
  });
  card.appendChild(gear);
  const chips = el('div', 'ov-chips');
  for (const it of items) {
    const chip = el('span', `ov-chip ${it.level === 'error' ? 'bad' : 'warn'}`, it.text);
    if (it.tip?.length) chip.title = it.tip.join('\n');
    chips.appendChild(chip);
  }
  card.appendChild(chips);
  return card;
}

// Empire-wide figures as a tile strip in the same style as the total resources.
function empireStrip(d) {
  const all = [...d.planets, ...(d.moons || [])];
  const hangar = all.reduce((s, p) => s + p.fleet.total, 0);
  const flying = d.missions.reduce((s, m) => s + m.ships, 0);
  const sum = (list, f) => list.reduce((s, p) => s + (f(p) || 0), 0);
  const withSlots = all.filter(p => p.buildSlots?.max != null);
  const popMax = sum(d.planets, p => p.maxPopulation);
  const limit = (n, max) => (d.slots ? `${fmt(n)} / ${fmt(max)}` : fmt(n));

  const tile = (label, value, sub) => {
    const card = el('div', 'stat-card ov-empire-tile');
    card.append(el('div', 'label', label), el('div', 'value', value));
    if (sub) card.appendChild(el('div', 'ov-dim ov-res-rate', sub));
    return card;
  };
  const row = el('div', 'stats ov-stats');
  row.append(
    tile('Colonies', limit(d.planets.length, d.slots?.colonies)),
    tile('Moons', limit(d.moons?.length || 0, d.slots?.moons)),
    tile('Ships', fmt(hangar + flying), `${fmt(hangar)} docked · ${fmt(flying)} flying`),
  );
  if (popMax) row.appendChild(tile('Population', `${fmt(sum(d.planets, p => p.population))} / ${fmt(popMax)}`));
  if (withSlots.length) row.appendChild(tile('Building slots', `${sum(withSlots, p => p.buildSlots.used)} / ${sum(withSlots, p => p.buildSlots.max)}`));
  row.style.setProperty('--n', row.children.length);
  const panel = section('Empire Status');
  panel.classList.add('ov-empire-strip');
  panel.appendChild(row);
  return panel;
}


function planetCard(p, research) {
  const card = el('section', 'dashboard-panel ov-planet');
  const head = el('div', 'ov-planet-head');
  const title = el('div');
  title.append(el('div', 'ov-planet-name', p.name),
    el('div', 'ov-dim ov-planet-sub', [p.systemName, p.planetType].filter(Boolean).join(' · ') || 'Unknown system'));
  head.appendChild(title);
  if (p.isHomeworld || p.isMoon) head.appendChild(el('span', 'ov-badge', p.isMoon ? 'Moon' : 'Homeworld'));
  card.appendChild(head);

  const stats = el('div', 'ov-kv-row');
  if (p.buildSlots.max != null) stats.appendChild(kv('Building slots', `${p.buildSlots.used}/${p.buildSlots.max}`));
  if (p.maxPopulation) {
    const row = kv('Population', `${fmt(p.population)} / ${fmt(p.maxPopulation)}`);
    const rate = p.populationRate;
    if (p.population >= p.maxPopulation) row.title = 'Population is full';
    else if (rate > 0) row.title = `+${fmt(rate)}/h · full in ${fmtCountdown((p.maxPopulation - p.population) / rate * 3600000)}`;
    stats.appendChild(row);
  }
  if (stats.childElementCount) card.appendChild(stats);

  const res = el('div', 'ov-res');
  for (const [key, label, cls] of RES_KEYS) {
    const r = el('div', 'ov-res-item');
    const rate = p.resources[`${key}Rate`];
    const cap = p.resources[`${key}Storage`];
    if (cap) {
      const have = p.resources[key];
      if (have >= cap) r.title = `Storage ${fmt(cap)} · full`;
      else if (rate > 0) r.title = `Storage ${fmt(cap)} · full in ${fmtCountdown((cap - have) / rate * 3600000)}`;
      else r.title = `Storage ${fmt(cap)}`;
    }
    r.append(el('span', 'ov-kv-label', label), el('b', cls, fmt(p.resources[key])),
      el('span', 'ov-dim ov-res-rate', rate ? `${rate > 0 ? '+' : ''}${fmt(rate)}/h` : ''));
    res.appendChild(r);
  }
  card.appendChild(res);

  const rares = RARE_KEYS.filter(([key]) => p.resources[key] > 0 || p.resources[`${key}Rate`] > 0);
  if (rares.length) {
    const rareRow = el('div', 'ov-rares');
    const cap = p.resources.rareStorage;
    for (const [key, label] of rares) {
      const rate = p.resources[`${key}Rate`];
      const have = p.resources[key];
      const item = el('span', 'ov-rare-item');
      item.append(el('span', 'ov-dim', label), el('b', key, fmt(have)));
      if (rate) item.appendChild(el('span', 'ov-dim', `${rate > 0 ? '+' : ''}${fmt(rate)}/h`));
      if (cap) {
        if (have >= cap) item.title = `Storage ${fmt(cap)} · full`;
        else if (rate > 0) item.title = `Storage ${fmt(cap)} · full in ${fmtCountdown((cap - have) / rate * 3600000)}`;
        else item.title = `Storage ${fmt(cap)}`;
      }
      rareRow.appendChild(item);
    }
    card.appendChild(rareRow);
  }

  const running = (research || []).filter(r => r.planetId === p.id);
  if (running.length || p.hasLab) {
    card.appendChild(el('div', 'ov-sub', 'Research'));
    if (!running.length) card.appendChild(idle('Research idle', 'No research is running on this planet.'));
    const list = el('div', 'ov-list');
    for (const r of running) {
      const row = el('div', 'ov-row');
      const name = el('span', 'ov-row-name', r.name);
      if (r.level != null) name.appendChild(el('span', 'ov-dim', ` Lv.${r.level}`));
      row.append(name, countdown(r.endsAt));
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  const qHead = p.isMoon || p.queueMax == null ? 'Construction' : `Construction ${p.construction.length}/${p.queueMax}`;
  card.appendChild(el('div', 'ov-sub', qHead));
  if (p.construction.length) {
    const list = el('div', 'ov-list');
    for (const c of p.construction) {
      const row = el('div', 'ov-row');
      const name = el('span', 'ov-row-name', c.name);
      name.appendChild(el('span', 'ov-dim', ` Lv.${c.level}`));
      row.append(name, c.endsAt ? countdown(c.endsAt) : el('span', 'ov-dim', 'Queued'));
      list.appendChild(row);
    }
    card.appendChild(list);
  } else {
    card.appendChild(idle('Queue idle', 'No buildings are currently upgrading.'));
  }
  for (const y of p.shipYards || []) {
    if (!y.items.length) continue;
    card.appendChild(el('div', 'ov-sub', `${y.label} ${y.items.length}/${y.max}`));
    const list = el('div', 'ov-list');
    for (const s of y.items) {
      const row = el('div', 'ov-row');
      row.append(el('span', 'ov-row-name', `${s.repair ? 'Repair ' : ''}${s.quantity}× ${s.name}`),
        s.endsAt ? countdown(s.endsAt) : el('span', 'ov-dim', 'Queued'));
      list.appendChild(row);
    }
    card.appendChild(list);
  }

  const fleetHead = el('div', 'ov-sub ov-fleet-head');
  fleetHead.append(el('span', null, 'Hangar fleet'), el('b', null, `${p.fleet.total.toLocaleString()} ships`));
  card.appendChild(fleetHead);
  const split = el('div', 'ov-split');
  const legend = el('div', 'ov-legend');
  for (const [cls, qty] of Object.entries(p.fleet.classes).sort((a, b) => b[1] - a[1])) {
    if (!qty) continue;
    const seg = el('div', 'ov-split-seg');
    seg.style.flex = String(qty);
    seg.style.background = CLASS_COLORS[cls] || CLASS_COLORS.other;
    seg.title = `${cls}: ${qty.toLocaleString()}`;
    split.appendChild(seg);
    const item = el('span', 'ov-legend-item');
    const dot = el('i', 'ov-legend-dot');
    dot.style.background = CLASS_COLORS[cls] || CLASS_COLORS.other;
    item.append(dot, document.createTextNode(`${cls} ${qty.toLocaleString()}`));
    legend.appendChild(item);
  }
  if (!split.childElementCount) split.classList.add('empty');
  card.append(split, legend);
  return card;
}

function renderActionsBar() {
  const bar = document.getElementById('dashboard-status');
  const stamp = el('span', null, data?.fetchedAt ? `Last refresh: ${new Date(data.fetchedAt).toLocaleString()}` : '');
  const btn = el('button', null, loading ? 'Refreshing…' : 'Refresh');
  btn.disabled = loading;
  btn.addEventListener('click', () => load(false));
  bar.replaceChildren(stamp, btn);
}

// The automation controls live in the expert tabs; this box mirrors their main switch and status.

const expertMode = () => document.body.classList.contains('expert-mode');

function automationText(statusId) {
  const text = (document.getElementById(statusId)?.textContent || '').trim();
  return text.replace(/^Status:\s*/i, '').replace(/^-$/, '') || 'No status yet';
}

function automationsPanel() {
  const box = section('Automations');
  box.id = 'ov-automations';
  const list = el('div', 'ov-auto-list');
  for (const [label, boxId, statusId] of AUTOMATIONS) {
    const row = el('div', 'ov-auto-row');
    const sw = el('input', 'm-switch');
    sw.type = 'checkbox';
    sw.title = `Toggle ${label.toLowerCase()}`;
    sw.addEventListener('change', () => {
      const source = document.getElementById(boxId);
      if (!source || source.disabled) { sw.checked = !sw.checked; return; }
      source.checked = sw.checked;
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const text = el('div', 'ov-auto-text');
    text.append(el('span', 'ov-auto-name', label), el('span', 'ov-auto-status ov-dim'));
    row.append(sw, text);
    row.dataset.box = boxId;
    row.dataset.status = statusId;
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

function syncAutomations() {
  const panel = document.getElementById('ov-automations');
  if (!panel) return;
  panel.style.display = expertMode() ? '' : 'none';
  if (!expertMode()) return;
  for (const row of panel.querySelectorAll('.ov-auto-row')) {
    const source = document.getElementById(row.dataset.box);
    const sw = row.querySelector('.m-switch');
    const on = !!source?.checked;
    sw.checked = on;
    sw.disabled = !source || source.disabled;
    row.classList.toggle('on', on);
    const status = row.querySelector('.ov-auto-status');
    const msg = automationText(row.dataset.status);
    if (status.textContent !== msg) status.textContent = msg;
    status.title = msg;
  }
}

// Moons go last, or directly behind their planet (moons without a known parent stay last).
function cardOrder(d) {
  const moons = getSetting('dashboard.show.moons') ? d.moons || [] : [];
  if (!getSetting('dashboard.moonsAfterPlanet')) return [...d.planets, ...moons];
  const ids = new Set(d.planets.map(p => p.id));
  const out = [];
  for (const p of d.planets) out.push(p, ...moons.filter(m => m.parentPlanetId === p.id));
  return [...out, ...moons.filter(m => !ids.has(m.parentPlanetId))];
}

function render() {
  const host = root();
  if (!host) return;
  tickers = [];
  host.textContent = '';
  renderActionsBar();
  host.appendChild(automationsPanel());
  syncAutomations();

  if (!data || data.error) {
    const panel = el('section', 'dashboard-panel global-overview-panel ov-totals');
    const head = el('div', 'ov-totals-head');
    head.append(el('div', 'section-label dashboard-section-label', 'Dashboard'));
    const msg = !data
      ? el('div', 'ov-empty', 'Loading…')
      : el('div', 'ov-empty ov-error', `Could not load data: ${data.error}. Is the game open and are you logged in?`);
    panel.append(head, msg);
    host.appendChild(panel);
    return;
  }

  host.appendChild(totalsPanel(data));
  if (getSetting('dashboard.show.empire')) host.appendChild(empireStrip(data));
  const attention = attentionCard(data);
  if (attention) host.appendChild(attention);
  if (getSetting('dashboard.show.missions')) host.appendChild(missionsCard(data));

  const grid = el('div', 'ov-planets');
  const places = cardOrder(data);
  for (const p of places) grid.appendChild(planetCard(p, data.research));
  host.appendChild(grid);
}

// Automatic refreshes are polite (keep extra rate-limit headroom); the manual button is not.
async function load(polite = true) {
  if (loading) return;
  loading = true;
  if (data) render();
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_DASHBOARD_OVERVIEW', polite });
    data = res || { error: 'No response from background.' };
  } catch (err) {
    data = { error: err.message };
  }
  loading = false;
  refreshAt = Date.now() + getSetting('dashboard.refreshSeconds') * 1000;
  render();
}

function tick() {
  if (!visible()) return;
  syncAutomations();
  let finished = false;
  for (const t of tickers) {
    t.update();
    if (t.target <= Date.now() && !t.done) { t.done = true; finished = true; }
  }
  if ((finished || Date.now() >= refreshAt) && !loading && !document.hidden) load();
}

export function initDashboardTab() {
  if (!started) {
    started = true;
    onSettingsChange(() => { if (data) render(); });
    render();
    setInterval(tick, 1000);
    load();
    return;
  }
  syncAutomations();
  if (Date.now() >= refreshAt) load();
}
