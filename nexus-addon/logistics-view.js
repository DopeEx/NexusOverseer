// Logistics View: a topbar button that opens a body-level overlay with a card per
// planet/moon/outpost showing its resources and ships (drag between cards to
// transfer). Same overlay pattern as guide-view.js —
// styled via theme.css (nx-overlay / nx-qm-* classes), lives in <body> so React
// re-renders can't wipe it. Data fetched same-origin (cookie).
//
// IIFE + re-run guard: Firefox can inject a content script twice into the same
// isolated world; top-level `const`s would then throw "redeclaration of const".
if (!window.__nxLogisticsView) {
window.__nxLogisticsView = true;
(function () {
const ext = (typeof browser !== 'undefined' ? browser : chrome);
const IMG = '/images/resources';
function setStatusText(el, text, variant) {
  if (!el) return;
  el.textContent = '';
  el.dataset.status = text || '';
  el.dataset.variant = variant || '';
  if (!variant) {
    el.textContent = text;
    return;
  }
  const span = document.createElement('span');
  span.textContent = text;
  if (variant === 'warning') span.className = 'nx-warn';
  else if (variant === 'error') span.className = 'nx-err';
  el.appendChild(span);
}
// Colony resource fields (camelCase, as the planet/outpost APIs return them) →
// label + icon filename.
// k = colony field (camelCase, as the APIs return it); cargo = dispatch cargo key
// (snake_case, as /fleet/dispatch expects).
const RESOURCES = [
  { k: 'ore',         cargo: 'ore',          label: 'Ore',         icon: 'ore.webp' },
  { k: 'silicates',   cargo: 'silicates',    label: 'Silicates',   icon: 'silicates.webp' },
  { k: 'hydrogen',    cargo: 'hydrogen',     label: 'Hydrogen',    icon: 'hydrogen.webp' },
  { k: 'alloys',      cargo: 'alloys',       label: 'Alloys',      icon: 'alloys.webp' },
  { k: 'cryoIce',     cargo: 'cryo_ice',     label: 'Cryo-Ice',    icon: 'cryo_ice.webp' },
  { k: 'quantumDust', cargo: 'quantum_dust', label: 'Quantum Dust',icon: 'quantum_dust.webp' },
  { k: 'plasmaCore',  cargo: 'plasma_core',  label: 'Plasma Core', icon: 'plasma_core.webp' },
  { k: 'bioExtract',  cargo: 'bio_extract',  label: 'Bio-Extract', icon: 'bio_extract.webp' },
  { k: 'darkMatter',  cargo: 'dark_matter',  label: 'Dark Matter', icon: 'dark_matter.webp' },
  { k: 'antimatter',  cargo: 'antimatter',   label: 'Antimatter',  icon: 'antimatter.webp' },
];
const RES_BY_K = Object.fromEntries(RESOURCES.map(r => [r.k, r]));
const BASE4 = new Set(['ore', 'silicates', 'hydrogen', 'alloys']);
// Storage cap for one resource on a colony. Planets carry a per-resource cap
// for the base four (`oreStorage`, …); moons share one `storage` cap across
// the base four instead; outposts share one `basicStorage` across the base
// four. All three share one `rareResourceStorage`/`rareStorage` cap across the
// other six (rare) resources.
function storageCap(c, k) {
  if (!c.res) return null;
  if (c.kind === 'Outpost') return BASE4.has(k) ? (c.res.basicStorage ?? null) : (c.res.rareStorage ?? null);
  if (c.kind === 'Moon') return BASE4.has(k) ? (c.res.storage ?? null) : (c.res.rareResourceStorage ?? null);
  return BASE4.has(k) ? (c.res[`${k}Storage`] ?? null) : (c.res.rareResourceStorage ?? null);
}

let dragItem = null;   // { src, resKey } while a resource chip is being dragged
let builder = null;    // staged transfer being configured in the top card
let builderEl = null;  // the top card element
let allColonies = [];  // current colonies (for the collect source-planet picker)

// Effective cargo capacity: base × (1 + cargo research + commander + shuttle
// bonus), fetched once. Mirrors the Scouting tab's hauler sizing.
// Per-ship capacity is right — confirmed in-game bulk_carrier shows 4500 =
// 3000 × (1 + general 0.40 + commander 0.10). A real dispatch of 2 such ships
// was rejected at "9000 > 8400" — that gap is NOT a per-ship bonus bug, still
// unexplained (fuel reserved out of the hold for the trip? a fleet-level cap
// distinct from ship sum?). Needs more data before touching this formula again.
let _cargoCtx = null;
async function cargoContext() {
  if (_cargoCtx) return _cargoCtx;
  const [research, me] = await Promise.all([
    jget('/api/research').catch(() => ({ research: [] })),
    jget('/api/auth/me').catch(() => ({})),
  ]);
  let general = 0, shuttle = 0;
  for (const r of (research.research || [])) {
    const lvl = r.level || 0; if (!lvl) continue;
    for (const e of (r.effects || [])) {
      if (e.type === 'cargo_bonus') general += (e.value || 0) * lvl;
      else if (e.type === 'shuttle_cargo_bonus') shuttle += (e.value || 0) * lvl;
    }
  }
  _cargoCtx = { general, shuttle, race: (me.user && me.user.race) || '',
    commander: (me.user && me.user.activeLeaderBonuses && me.user.activeLeaderBonuses.cargoBonus) || 0 };
  return _cargoCtx;
}
function effCap(def, ctx) {
  const b = ctx.general + ctx.commander + (def.key === 'transport_shuttle' ? ctx.shuttle : 0);
  return Math.floor((def.cargoCapacity || 0) * (1 + b));
}
const canCarry = (h, k) => !h.allowed || h.allowed.includes(k);
// Restricted haulers (ore_freighter, tanker) first (largest cap), then general —
// dedicating specialised haulers to their resources frees general haulers for the
// rest. Greedy fill; used by both the planner and the feasibility check.
function haulerOrder(haulers) {
  return haulers.slice().sort((a, b) => (Number(!!b.allowed) - Number(!!a.allowed)) || (b.cap - a.cap));
}
function fillFrom(rem, capLeft, h) {
  for (const k of Object.keys(rem).filter(k => canCarry(h, k) && rem[k] > 0).sort((a, b) => rem[b] - rem[a])) {
    const take = Math.min(rem[k], capLeft); rem[k] -= take; capLeft -= take; if (capLeft <= 0) break;
  }
}
// How much of `amounts` (snake→qty) the given ship counts CAN'T carry.
function residualAfter(shipQtys, amounts, haulers) {
  const rem = { ...amounts };
  for (const h of haulerOrder(haulers)) fillFrom(rem, (shipQtys[h.shipDefId] || 0) * h.cap, h);
  return Object.values(rem).reduce((s, v) => s + Math.max(0, v), 0);
}
// Fewest haulers to carry `amounts`, respecting each ship's allowedCargo.
function planFleetMulti(amounts, haulers) {
  const rem = { ...amounts };
  const plan = {};
  for (const h of haulerOrder(haulers)) {
    const need = Object.keys(rem).reduce((s, k) => s + (canCarry(h, k) ? Math.max(0, rem[k]) : 0), 0);
    if (need <= 0) continue;
    const n = Math.min(h.avail, Math.ceil(need / h.cap));
    if (n <= 0) continue;
    plan[h.shipDefId] = (plan[h.shipDefId] || 0) + n;
    fillFrom(rem, n * h.cap, h);
  }
  return { plan, remaining: Object.values(rem).reduce((s, v) => s + Math.max(0, v), 0) };
}
function fmtDur(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

const fmt = n => Math.round(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function jget(path) {
  return globalThis.nexusGameApi(path, { source: 'logistics' });
}

let overlay = null;
function closeView() { stopDragScroll(); if (overlay) { overlay.remove(); overlay = null; } }

// Native drag disables wheel scrolling, so auto-scroll the overlay while the
// dragged pointer sits in the (visible) top/bottom scroll zones.
const DRAG_EDGE = 90;
let dragScrollY = null, dragScrollRAF = null;
function startDragScroll() {
  if (dragScrollRAF || !overlay) return;
  overlay.classList.add('nx-qm-dragging-active');
  // Keep looping until dragend/drop even before the first dragover reports a
  // position (some browsers fire it only after the first animation frame).
  // Speed is time-based (px/s, independent of monitor refresh rate): slow when
  // entering the zone, faster only right at the screen edge.
  let last = null, carry = 0;
  const step = now => {
    if (!overlay) { dragScrollRAF = null; return; }
    const dt = last == null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dragScrollY != null) {
      const h = window.innerHeight;
      const depth = dragScrollY < DRAG_EDGE ? -(DRAG_EDGE - dragScrollY)
        : dragScrollY > h - DRAG_EDGE ? dragScrollY - (h - DRAG_EDGE) : 0;
      if (depth) {
        const t = Math.min(1, Math.abs(depth) / DRAG_EDGE);
        carry += Math.sign(depth) * (80 + 420 * t * t) * dt;
        const px = Math.trunc(carry);
        if (px) { overlay.scrollTop += px; carry -= px; }
      } else carry = 0;
    }
    dragScrollRAF = requestAnimationFrame(step);
  };
  dragScrollRAF = requestAnimationFrame(step);
}
function stopDragScroll() {
  if (dragScrollRAF) cancelAnimationFrame(dragScrollRAF);
  dragScrollRAF = null; dragScrollY = null;
  if (overlay) overlay.classList.remove('nx-qm-dragging-active');
}

async function openView() {
  if (overlay) { closeView(); return; }   // toggle
  overlay = document.createElement('div');
  overlay.className = 'nx-theme nx-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeView(); });
  // Edge auto-scroll during a drag (drag events bubble from the chips).
  overlay.addEventListener('dragstart', startDragScroll);
  overlay.addEventListener('dragover', e => { dragScrollY = e.clientY; });
  overlay.addEventListener('dragend', stopDragScroll);
  // The source chip can be re-rendered away before dragend reaches the overlay.
  overlay.addEventListener('drop', stopDragScroll);
  for (const dir of ['up', 'down']) {
    const zone = document.createElement('div');
    zone.className = `nx-qm-scrollzone nx-qm-scrollzone-${dir}`;
    zone.innerHTML = `<span>${dir === 'up' ? '\u25B2 scroll up' : '\u25BC scroll down'}</span>`;
    overlay.appendChild(zone);
  }

  const page = document.createElement('div');
  page.className = 'nx-overlay-page nx-qm-page';
  overlay.appendChild(page);
  document.body.appendChild(overlay);
  page.innerHTML = `<div class="nx-overlay-head"><div><h1>Nexus <span>Overseer</span>: Quartermaster</h1>
    <p class="lv-sub">Loading colonies…</p></div></div>`;

  const close = document.createElement('button');
  close.textContent = '✕'; close.title = 'Close (Esc)';
  close.type = 'button'; close.className = 'nx-overlay-close';
  close.addEventListener('click', closeView);
  overlay.appendChild(close);
  const onKey = e => { if (e.key === 'Escape') { closeView(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  let colonies;
  try {
    const [planetList, outpostData, meData] = await Promise.all([
      jget('/api/planets'), jget('/api/outposts').catch(() => ({})), jget('/api/auth/me').catch(() => ({})),
    ]);
    const planets = (planetList.planets || []).filter(p => p.id != null);
    const details = await Promise.all(planets.map(p => Promise.all([
      jget(`/api/planets/${p.id}`).catch(() => null),
      jget(`/api/planets/${p.id}/fleet`).catch(() => ({ fleet: [] })),
    ])));
    const outposts = outpostData.outposts || (Array.isArray(outpostData) ? outpostData : []);

    // Colonized moons have their own /api/moons/{id} endpoints; find their ids via
    // the galaxy view of my planets' systems (mine = matching userId).
    const myId = meData.user && (meData.user.id ?? meData.user.userId);
    const sysIds = [...new Set(planets.map(p => p.systemId).filter(x => x != null))];
    const sysData = await Promise.all(sysIds.map(s => jget(`/api/galaxy/systems/${s}/planets`).catch(() => ({}))));
    const moonIds = [];
    for (const sd of sysData) for (const mo of (sd.moons || [])) if (mo.userId != null && mo.userId === myId) moonIds.push(mo.id);
    const moonDetails = await Promise.all(moonIds.map(id => Promise.all([
      jget(`/api/moons/${id}`).catch(() => null),
      jget(`/api/moons/${id}/fleet`).catch(() => ({ fleet: [] })),
    ])));
    const moonCol = moonIds.map((id, i) => {
      const [det, fl] = moonDetails[i];
      const res = (det && det.moon) || {};
      return { id, systemId: res.systemId, kind: 'Moon', name: res.name || `Moon #${id}`, res, ships: (fl.fleet || []) };
    });

    colonies = planets.map((p, i) => {
      const [detail, fleet] = details[i];
      const res = (detail && detail.planet) || p;
      return { id: p.id, systemId: p.systemId, kind: 'Planet', name: p.name, res, ships: (fleet.fleet || []) };
    }).concat(moonCol,
      outposts.map(o => ({ id: o.id, systemId: o.systemId, kind: 'Outpost', name: o.name || `Outpost #${o.id}`, res: o, ships: null, deployed: o.deployedShipCount })));
  } catch (e) {
    page.querySelector('.lv-sub').textContent = `Error: ${e.message}`;
    return;
  }
  if (!overlay) return;
  render(page, colonies);
  applyPendingDeliver();
}

// Prefill a planet→planet resource delivery, e.g. from the building-upgrade
// planner. `resByCargoKey` is { cargoKey: amount } (snake keys, as dispatch
// wants). Opens the Quartermaster and stages a delivery from the planet holding
// the most of what's needed, capped to that source's stock (user can adjust).
let pendingDeliver = null;
window.__nxDeliverToPlanet = async (targetPlanetId, resByCargoKey) => {
  pendingDeliver = { targetPlanetId, resByCargoKey };
  if (!overlay) await openView(); else applyPendingDeliver();
};
async function applyPendingDeliver() {
  if (!pendingDeliver || !allColonies.length) return;
  const { targetPlanetId, resByCargoKey } = pendingDeliver;
  pendingDeliver = null;
  const target = allColonies.find(c => c.id === targetPlanetId && c.kind === 'Planet');
  if (!target) return;
  const needByK = {};
  for (const [cargo, amt] of Object.entries(resByCargoKey)) {
    const r = RESOURCES.find(x => x.cargo === cargo);
    if (r && amt > 0) needByK[r.k] = amt;
  }
  const needKeys = Object.keys(needByK);
  if (!needKeys.length) return;

  const cands = allColonies.filter(c => c.kind === 'Planet' && c.id !== targetPlanetId);
  if (!cands.length) return;

  // Distance target↔candidate from cached galaxy-map coords (background).
  const sysIds = [...new Set([target.systemId, ...cands.map(c => c.systemId)].filter(x => x != null))];
  let coords = {};
  try { coords = (await ext.runtime.sendMessage({ type: 'GET_SYSTEM_COORDS', ids: sysIds })) || {}; } catch { coords = {}; }
  const distTo = c => {
    const a = coords[target.systemId], b = coords[c.systemId];
    return (a && b) ? Math.hypot(b.x - a.x, b.y - a.y) : Infinity;
  };
  const sumHave = c => needKeys.reduce((s, k) => s + Math.min(needByK[k], (c.res && c.res[k]) || 0), 0);
  const covers = c => needKeys.every(k => ((c.res && c.res[k]) || 0) >= needByK[k]);

  // Prefer the NEAREST planet that fully covers the need. If none fully covers,
  // fall back to the planet holding the most of it (tie-break by distance).
  const full = cands.filter(covers);
  const src = full.length
    ? full.sort((a, b) => (distTo(a) - distTo(b)) || (sumHave(b) - sumHave(a)))[0]
    : cands.sort((a, b) => (sumHave(b) - sumHave(a)) || (distTo(a) - distTo(b)))[0];
  if (!src) return;
  builder = { src, target, mode: 'resource', res: {}, ships: {}, cargoManual: null };
  for (const [k, need] of Object.entries(needByK)) {
    const avail = Math.floor((src.res && src.res[k]) || 0);
    builder.res[k] = { amount: Math.min(need, avail), max: avail };
  }
  renderBuilder();
  if (builderEl) builderEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render(page, colonies) {
  page.querySelector('.lv-sub').innerHTML =
    `${colonies.length} colonies (${colonies.filter(c => c.kind === 'Planet').length} planets, ${colonies.filter(c => c.kind === 'Moon').length} moons, ${colonies.filter(c => c.kind === 'Outpost').length} outposts)` +
    ` · <span class="nx-faint">drag a resource or ship onto another colony to send it (confirm before dispatch)</span>`;

  allColonies = colonies;
  // Transfer builder card (populated on drop, hidden otherwise), pinned on top.
  builder = null;
  builderEl = document.createElement('div');
  builderEl.className = 'nx-qm-builder';
  builderEl.style.display = 'none';
  page.appendChild(builderEl);

  // ── Colony columns: moons + outposts stacked (left) · planets grid (right) ──
  const makeGroup = (label, list, grow) => {
    const wrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'nx-sub-label';
    lbl.textContent = `${label} (${list.length})`;
    wrap.appendChild(lbl);
    const inner = document.createElement('div');
    inner.className = grow ? 'nx-qm-grid' : 'nx-qm-stack';
    for (const c of list) inner.appendChild(colonyCard(c));
    wrap.appendChild(inner);
    return wrap;
  };
  const moons = colonies.filter(c => c.kind === 'Moon');
  const outposts = colonies.filter(c => c.kind === 'Outpost');
  const cols = document.createElement('div');
  cols.className = 'nx-qm-cols';
  if (moons.length || outposts.length) {
    const side = document.createElement('div');
    side.className = 'nx-qm-col';
    if (moons.length) side.appendChild(makeGroup('Moons', moons));
    if (outposts.length) side.appendChild(makeGroup('Outposts', outposts));
    cols.appendChild(side);
  }
  const main = makeGroup('Planets', colonies.filter(c => c.kind === 'Planet'), true);
  main.className = 'nx-qm-col-grow';
  cols.appendChild(main);
  page.appendChild(cols);
}

// Which source→target moves are supported. Outpost/moon export only to a planet;
// a planet can send to a planet, outpost, or moon.
function validCombo(item, tgt) {
  const sk = item.src.kind, tk = tgt.kind;
  if (sk === 'Outpost') return item.type === 'resource' && tk === 'Planet';   // collect
  if (sk === 'Moon') return tk === 'Planet';                                   // recall / transfer
  return tk === 'Planet' || tk === 'Outpost' || tk === 'Moon';                 // planet → anywhere
}

function colonyCard(c) {
  const card = document.createElement('div');
  card.className = 'nx-qm-card';
  // Drop target: accept only valid source→target combos (outpost/moon exports go
  // to a planet; planets export anywhere).
  const accepts = () => dragItem && dragItem.src !== c && c.id != null && validCombo(dragItem, c);
  card.addEventListener('dragover', e => { if (accepts()) { e.preventDefault(); card.classList.add('nx-qm-drop'); } });
  card.addEventListener('dragleave', () => { card.classList.remove('nx-qm-drop'); });
  card.addEventListener('drop', e => {
    e.preventDefault(); card.classList.remove('nx-qm-drop');
    const it = dragItem; dragItem = null;
    if (!it || it.src === c || c.id == null || !validCombo(it, c)) return;
    if (it.type === 'resource' && it.src.kind === 'Outpost') { stageCollectResource(it.src, c, it.resKey); return; }
    stageTransfer(it, c);
  });
  const head = document.createElement('div');
  head.className = 'nx-qm-card-head';
  head.innerHTML = `<span class="nx-qm-card-name">${esc(c.name)}</span><span class="nx-qm-kind">${c.kind}</span>`;
  // Outposts extract exactly one resource at a time — whichever `{k}Rate`
  // field is nonzero (mirrors its asteroid field's fieldType).
  if (c.kind === 'Outpost' && c.res) {
    const mining = RESOURCES.find(r => (c.res[`${r.k}Rate`] || 0) > 0);
    if (mining) {
      const badge = document.createElement('span');
      badge.className = 'nx-qm-rate';
      badge.title = `Mining ${mining.label}`;
      badge.innerHTML = `<img src="${IMG}/${mining.icon}" width="13" height="13" alt="">${fmt(c.res[`${mining.k}Rate`])}/h`;
      head.appendChild(badge);
    }
  }
  card.appendChild(head);

  // Resources
  const resWrap = document.createElement('div');
  resWrap.className = 'nx-qm-res';
  for (const r of RESOURCES) {
    const v = c.res ? c.res[r.k] : 0;
    if (!v) continue;
    const cap = storageCap(c, r.k);
    const row = document.createElement('div');
    row.className = 'nx-qm-row';
    row.innerHTML = `<img src="${IMG}/${r.icon}" width="15" height="15" alt="">` +
      `<span class="nx-qm-row-label">${r.label}</span>` +
      `<span class="nx-text">${fmt(v)}${cap ? `<span class="nx-subtle"> / ${fmt(cap)}</span>` : ''}</span>`;
    // Draggable: planet resources → deliver/supply anywhere; outpost resources →
    // drop on a planet to collect them there.
    if (c.id != null) {
      row.draggable = true; row.classList.add('nx-qm-drag');
      row.title = c.kind === 'Outpost' ? 'Drag to a planet to collect' : c.kind === 'Moon' ? 'Drag to a planet to transfer' : 'Drag to another colony to send';
      const grip = document.createElement('span'); grip.textContent = '⠿';
      grip.className = 'nx-qm-grip';
      row.insertBefore(grip, row.firstChild);
      row.addEventListener('dragstart', () => { dragItem = { type: 'resource', src: c, resKey: r.k, max: v }; row.classList.add('nx-qm-dragging'); });
      row.addEventListener('dragend', () => { row.classList.remove('nx-qm-dragging'); });
    }
    resWrap.appendChild(row);
  }
  if (!resWrap.childElementCount) resWrap.innerHTML = '<span class="nx-faint">No resources.</span>';
  card.appendChild(resWrap);

  // Ships
  const shipHead = document.createElement('div');
  shipHead.className = 'nx-sub-label nx-qm-ships-label';
  shipHead.textContent = 'Ships';
  card.appendChild(shipHead);
  const shipWrap = document.createElement('div');
  shipWrap.className = 'nx-qm-ships';
  if (c.ships == null) {
    shipWrap.innerHTML = `<span class="nx-dim">${c.deployed ? `${fmt(c.deployed)} deployed` : 'none'}</span>`;
  } else {
    const ships = c.ships.filter(f => (f.quantity || 0) > 0)
      .sort((a, b) => (a.definition?.sortOrder || 0) - (b.definition?.sortOrder || 0));
    if (!ships.length) shipWrap.innerHTML = '<span class="nx-faint">none</span>';
    for (const f of ships) {
      const sp = document.createElement('span');
      const nm = (f.definition || {}).name || '#' + f.shipDefId;
      sp.className = 'nx-qm-ship';
      sp.innerHTML = `<b class="nx-strong">${fmt(f.quantity)}</b>&times; <span class="nx-dim">${esc(nm)}</span>`;
      // Draggable → relocate these ships to another colony.
      const avail = (f.quantity || 0) - (f.damagedQuantity || 0);
      if (c.id != null && avail > 0) {
        sp.draggable = true; sp.classList.add('nx-qm-drag'); sp.title = c.kind === 'Moon' ? 'Drag to a planet to recall' : 'Drag to another colony to relocate';
        const grip = document.createElement('span'); grip.textContent = '⠿';
        grip.className = 'nx-qm-grip';
        sp.insertBefore(grip, sp.firstChild);
        sp.addEventListener('dragstart', () => { dragItem = { type: 'ship', src: c, shipDefId: f.shipDefId, name: nm, max: avail }; sp.classList.add('nx-qm-dragging'); });
        sp.addEventListener('dragend', () => { sp.classList.remove('nx-qm-dragging'); });
      }
      shipWrap.appendChild(sp);
    }
  }
  card.appendChild(shipWrap);
  return card;
}

async function jpost(path, body) {
  return globalThis.nexusGameApi(path, { method: 'POST', body, source: 'logistics',
    priority: path === '/api/fleet/fuel-estimate' ? 'interactive' : 'action' });
}
const fuelEstimate = (sourcePlanetId, targetSystemId, ships) =>
  jpost('/api/fleet/fuel-estimate', { sourcePlanetId, targetSystemId, ships });
function refresh() { closeView(); openView(); }

// Stage a dropped resource/ship into the top builder card. Same source+target+mode
// accumulates (more resources or ship types); a different combo starts fresh.
function stageTransfer(item, target) {
  const src = item.src, mode = item.type === 'resource' ? 'resource' : 'ship';
  if (!builder || builder.src.id !== src.id || builder.target.id !== target.id || builder.mode !== mode) {
    builder = { src, target, mode, res: {}, ships: {}, cargoManual: null };
  }
  if (mode === 'resource') builder.res[item.resKey] = { amount: Math.floor(item.max), max: Math.floor(item.max) };
  else builder.ships[item.shipDefId] = { name: item.name, qty: item.max, max: item.max };
  builder.cargoManual = null;   // re-autoplan on any change
  renderBuilder();
}

// Dedicated cargo haulers (not combat/mining ships). tanker/ore_freighter also
// restrict which resources they carry (definition.allowedCargo).
const CARGO_KEYS = new Set(['freighter', 'transport_shuttle', 'bulk_carrier', 'ore_freighter', 'tanker']);
const CARGO_SELECTION_KEY = 'lv_cargo_sel';
const cargoSel = new Set(CARGO_KEYS);
let cargoSelLoaded = false;
let cargoSelLoadError = null;
async function loadCargoSel() {
  if (cargoSelLoaded) return;
  cargoSelLoaded = true;
  try {
    const stored = await ext.storage.local.get(CARGO_SELECTION_KEY);
    const selection = stored[CARGO_SELECTION_KEY];
    if (Array.isArray(selection)) {
      cargoSel.clear();
      for (const key of selection) if (CARGO_KEYS.has(key)) cargoSel.add(key);
    }
  } catch (error) {
    cargoSelLoadError = error;
    console.error('[NexusOverseer] Could not load Quartermaster transport selection.', error);
  }
}
// Cargo haulers on a colony (effective capacity). If `wantKeys` (snake cargo
// keys being moved) is given, exclude haulers that can't carry all of them.
async function cargoShipsOf(colony, wantKeys) {
  const ctx = await cargoContext();
  await loadCargoSel();
  return ((colony && colony.ships) || []).map(f => {
    const def = f.definition || {};
    return { shipDefId: f.shipDefId, key: def.key, name: def.name || ('#' + f.shipDefId), cap: effCap(def, ctx), avail: (f.quantity || 0) - (f.damagedQuantity || 0), allowed: def.allowedCargo || null,
      imageUrl: (ctx.race && def.key) ? `/api/images/ships/${ctx.race}/${def.key}.webp` : null };
  }).filter(s => CARGO_KEYS.has(s.key) && s.cap > 0 && s.avail > 0 &&
    (!wantKeys || !wantKeys.length || !s.allowed || wantKeys.some(k => s.allowed.includes(k))));
}

function cargoPicker(haulers, onChange, status) {
  const wrap = document.createElement('div');
  wrap.className = 'nx-qm-cargo-pick';
  for (const h of haulers) {
    const on = cargoSel.has(h.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `${h.name} — ${fmt(h.cap)} cargo each${on ? '' : ' (not used)'}`;
    btn.setAttribute('aria-pressed', String(on));
    if (h.imageUrl) {
      const img = document.createElement('img');
      img.src = h.imageUrl;
      img.alt = h.name;
      img.onerror = () => {
        btn.textContent = h.name;
        btn.classList.add('nx-qm-cargo-text');
      };
      btn.appendChild(img);
    } else {
      btn.textContent = h.name;
      btn.classList.add('nx-qm-cargo-text');
    }
    btn.onclick = async () => {
      for (const pickerButton of wrap.querySelectorAll('button')) pickerButton.disabled = true;
      const next = new Set(cargoSel);
      if (on) next.delete(h.key);
      else next.add(h.key);
      try {
        await ext.storage.local.set({ [CARGO_SELECTION_KEY]: [...next] });
      } catch (error) {
        console.error('[NexusOverseer] Could not save Quartermaster transport selection.', error);
        setStatusText(status, 'Could not save transport selection.', 'error');
        for (const pickerButton of wrap.querySelectorAll('button')) pickerButton.disabled = false;
        return;
      }
      cargoSel.clear();
      for (const key of next) cargoSel.add(key);
      cargoSelLoadError = null;
      onChange();
    };
    wrap.appendChild(btn);
  }
  if (cargoSelLoadError) {
    setStatusText(status, 'Could not load saved transport selection; all eligible transports are enabled.', 'error');
  }
  return wrap;
}

// Collect: a resource dragged from an outpost onto a planet. The planet is the
// fleet origin/return; drop more outpost resources onto the same planet to add
// their types. Fleet goes planet → outpost → back with what fits the cargo.
function stageCollectResource(outpost, planet, resKey) {
  if (!builder || builder.mode !== 'collect' || builder.outpost.id !== outpost.id || builder.srcPlanetId !== planet.id) {
    builder = { mode: 'collect', outpost, srcPlanetId: planet.id, filter: new Set(), cargoManual: {} };
  }
  builder.filter.add(resKey);
  renderBuilder();
}

function fieldRow(labelHtml, input, onRemove) {
  const row = document.createElement('div');
  row.className = 'nx-qm-field';
  const l = document.createElement('div'); l.className = 'nx-qm-field-label'; l.innerHTML = labelHtml;
  row.append(l, input);
  if (onRemove) {
    const x = document.createElement('button'); x.textContent = '✕';
    x.type = 'button'; x.className = 'nx-icon-btn'; x.title = 'Remove';
    x.onclick = onRemove; row.appendChild(x);
  }
  return row;
}
function numInput(value) {
  // Text (not number) so there are no spinner arrows; guard to positive integers.
  const i = document.createElement('input');
  i.type = 'text'; i.inputMode = 'numeric';
  i.value = String(value);
  i.className = 'nx-input nx-input-num';
  i.addEventListener('input', () => { const c = i.value.replace(/[^\d]/g, ''); if (c !== i.value) i.value = c; });
  return i;
}
// Wrap a numInput with −/+ steppers and a Max button. Buttons set the value and
// fire input+change so the field's existing handlers re-run. `max` (when set)
// caps the value and enables the Max button.
function withStepper(inp, max) {
  const wrap = document.createElement('div');
  wrap.className = 'nx-qm-stepper';
  const mkBtn = txt => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.className = 'nx-btn nx-btn-ghost nx-btn-sm';
    return b;
  };
  const commit = v => {
    v = Math.max(0, Math.floor(v || 0));
    if (max != null && isFinite(max)) v = Math.min(max, v);
    inp.value = String(v);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const cur = () => parseInt(inp.value, 10) || 0;
  const minus = mkBtn('−'); minus.onclick = () => commit(cur() - 1);
  const plus = mkBtn('+'); plus.onclick = () => commit(cur() + 1);
  wrap.append(minus, inp, plus);
  if (max != null && isFinite(max)) { const mx = mkBtn('Max'); mx.onclick = () => commit(max); wrap.append(mx); }
  return wrap;
}

async function renderBuilder() {
  if (!builderEl) return;
  builderEl.innerHTML = '';
  if (!builder) { builderEl.style.display = 'none'; return; }
  builderEl.style.display = '';
  const b = builder;
  const toOutpost = b.mode !== 'collect' && b.target.kind === 'Outpost';
  const box = document.createElement('div');
  box.className = 'nx-qm-builder-box';
  const head = document.createElement('div');
  head.className = 'nx-qm-builder-head';
  box.appendChild(head);

  const status = document.createElement('div'); status.className = 'nx-qm-status';
  const fuelLine = document.createElement('div'); fuelLine.className = 'nx-qm-fuel';
  const send = document.createElement('button'); send.textContent = 'Send';
  send.type = 'button'; send.className = 'nx-btn nx-btn-primary';
  const clear = document.createElement('button'); clear.textContent = 'Clear';
  clear.type = 'button'; clear.className = 'nx-btn nx-btn-ghost';
  clear.onclick = () => { builder = null; renderBuilder(); };

  let getShips = () => [];
  let getCargoNeed = () => 0;   // total resource units being sent (resource mode only)
  let fuelSrc, fuelSys;
  let calcLocalCap = () => 0;   // locally estimated capacity of the currently selected ships (resource mode)
  const fitState = { short: false, over: false };
  let updateFitBtn = () => {};

  if (b.mode === 'collect') {
    const planets = allColonies.filter(c => c.kind === 'Planet');
    const srcPlanet = planets.find(c => c.id === b.srcPlanetId) || planets[0];
    head.innerHTML = `<span class="nx-qm-builder-title">Collect resources</span>` +
      `<span class="nx-qm-route">${srcPlanet ? esc(srcPlanet.name) : '?'} → ${esc(b.outpost.name)} → back</span>`;
    // Source planet picker.
    const sel = document.createElement('select');
    sel.className = 'nx-input';
    for (const p of planets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; if (p.id === b.srcPlanetId) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { b.srcPlanetId = Number(sel.value); b.cargoManual = {}; renderBuilder(); });
    box.appendChild(fieldRow('<span class="nx-dim">From planet</span>', sel));
    // Resource types to collect (present on the outpost).
    const typeWrap = document.createElement('div');
    typeWrap.className = 'nx-qm-types';
    for (const r of RESOURCES) {
      const have = (b.outpost.res && b.outpost.res[r.k]) || 0;
      if (have <= 0) continue;
      const lbl = document.createElement('label'); lbl.className = 'nx-qm-type';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = b.filter.has(r.k);
      cb.addEventListener('change', () => { if (cb.checked) b.filter.add(r.k); else b.filter.delete(r.k); b.cargoManual = {}; renderBuilder(); });
      lbl.append(cb, Object.assign(document.createElement('img'), { src: `${IMG}/${r.icon}`, width: 14, height: 14 }), document.createTextNode(`${r.label} (${fmt(have)})`));
      typeWrap.appendChild(lbl);
    }
    box.appendChild(typeWrap);
    // Transport ships from the source planet (only haulers that can carry the
    // selected resource types).
    const allHaulers = await cargoShipsOf(srcPlanet, [...b.filter].map(k => RES_BY_K[k].cargo));
    const cargoShips = allHaulers.filter(s => cargoSel.has(s.key));
    const availableOf = () => [...b.filter].reduce((s, k) => s + ((b.outpost.res && b.outpost.res[k]) || 0), 0);
    const availAll = () => Object.fromEntries([...b.filter].map(k => [RES_BY_K[k].cargo, (b.outpost.res && b.outpost.res[k]) || 0]));
    // Amounts to plan for: full availability, or capped to the target (largest first).
    const collectAmounts = () => {
      const av = availAll();
      if (!b.target) return av;
      let left = b.target; const out = {};
      for (const [ck, v] of Object.entries(av).sort((a, b2) => b2[1] - a[1])) { const t = Math.min(v, left); out[ck] = t; left -= t; }
      return out;
    };
    // Target amount: the API takes no amount (it fills ships to capacity), but we
    // can auto-plan the transport ships to carry ~this much.
    const targetInp = numInput(b.target || '', null);
    targetInp.placeholder = 'auto (fill ships)';
    targetInp.addEventListener('change', () => {
      b.target = Math.min(availableOf(), Math.max(0, parseInt(targetInp.value, 10) || 0));
      b.cargoManual = planFleetMulti(collectAmounts(), cargoShips).plan;
      renderBuilder();
    });
    box.appendChild(fieldRow('<span class="nx-dim">Target amount (auto-plan ships)</span>', withStepper(targetInp, availableOf())));
    const cw = document.createElement('div'); cw.className = 'nx-qm-section';
    cw.innerHTML = '<div class="nx-sub-label">Transport ships</div>';
    cw.appendChild(cargoPicker(allHaulers, () => { b.cargoManual = {}; renderBuilder(); }, status));
    box.appendChild(cw);
    const capLine = document.createElement('div'); capLine.className = 'nx-qm-cap';
    const updateSend = () => {
      const avail = availableOf();
      const cap = cargoShips.reduce((s, cs) => s + (b.cargoManual[cs.shipDefId] || 0) * cs.cap, 0);
      // Resource-aware: a ship can only carry resources its allowedCargo permits.
      const collected = avail - residualAfter(b.cargoManual, availAll(), cargoShips);
      const pct = avail > 0 ? Math.min(100, Math.round(collected / avail * 100)) : 0;
      capLine.innerHTML = `Available <b class="nx-strong">${fmt(avail)}</b> · capacity <b class="nx-strong">${fmt(cap)}</b> · ` +
        `~<b class="${collected >= avail && avail > 0 ? 'nx-ok' : 'nx-warn'}">${pct}%</b> collected (≈${fmt(collected)})`;
      send.disabled = !getShips().length || b.filter.size === 0;
      refreshFuel();
    };
    for (const cs of cargoShips) {
      const inp = numInput(b.cargoManual[cs.shipDefId] || 0, cs.avail);
      inp.addEventListener('input', () => { b.cargoManual[cs.shipDefId] = Math.min(cs.avail, Math.max(0, parseInt(inp.value, 10) || 0)); updateSend(); });
      cw.appendChild(fieldRow(`${esc(cs.name)} <span class="nx-subtle">/ ${fmt(cs.avail)} · ${fmt(cs.cap)} ea</span>`, withStepper(inp, cs.avail)));
    }
    if (!cargoShips.length) {
      const warn = document.createElement('span');
      warn.className = 'nx-err nx-qm-cap';
      warn.textContent = allHaulers.length ? 'No transport type selected.' : 'No cargo ships on this planet.';
      cw.appendChild(warn);
    }
    cw.appendChild(capLine);
    getShips = () => cargoShips.map(cs => ({ shipDefId: cs.shipDefId, quantity: b.cargoManual[cs.shipDefId] || 0 })).filter(s => s.quantity > 0);
    fuelSrc = b.srcPlanetId; fuelSys = b.outpost.systemId;
    box.append(fuelLine);
    updateSend();
  } else if (b.mode === 'resource') {
    const rVerb = b.src.kind === 'Moon' ? 'Transfer resources' : b.target.kind === 'Moon' ? 'Send resources' : toOutpost ? 'Supply outpost' : 'Deliver resources';
    head.innerHTML = `<span class="nx-qm-builder-title">${rVerb}</span>` +
      `<span class="nx-qm-route">${esc(b.src.name)} → ${esc(b.target.name)}</span>` +
      `<span class="nx-qm-hint">drag more onto ${esc(b.target.name)} to add</span>`;
    // Mission switch (planet → planet only): deliver = haulers drop cargo and
    // return; transfer = haulers stay at the destination. Other endpoints (moon/
    // outpost) don't take this choice.
    if (b.src.kind === 'Planet' && b.target.kind === 'Planet') {
      if (!b.deliverMode) b.deliverMode = 'deliver';
      const seg = document.createElement('div');
      seg.className = 'nx-qm-seg';
      const mk = (mode, label, title) => {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label; btn.title = title;
        btn.__paint = () => { btn.setAttribute('aria-pressed', String(b.deliverMode === mode)); };
        btn.__paint();
        btn.onclick = () => { b.deliverMode = mode; seg.querySelectorAll('button').forEach(x => x.__paint()); };
        return btn;
      };
      seg.append(mk('deliver', 'Deliver', 'Haulers drop the cargo and return'),
                 mk('transfer', 'Transfer', 'Haulers stay at the destination'));
      box.appendChild(fieldRow('<span class="nx-dim">Mission</span>', seg));
    }
    // Source picker — swap which planet the resources ship from (defaults to the
    // auto-chosen one). Changing it re-caps each amount to the new stock and
    // re-plans ships, since a different planet has different haulers.
    const srcOpts = allColonies.filter(c => c.id !== b.target.id && c.kind !== 'Outpost' && validCombo({ type: 'resource', src: c }, b.target));
    if (srcOpts.length > 1) {
      const sel = document.createElement('select');
      sel.className = 'nx-input';
      for (const c of srcOpts) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; if (c.id === b.src.id) o.selected = true; sel.appendChild(o); }
      sel.addEventListener('change', () => {
        const ns = srcOpts.find(c => c.id === Number(sel.value)); if (!ns) return;
        b.src = ns;
        for (const [rk, ent] of Object.entries(b.res)) { ent.max = Math.floor((ns.res && ns.res[rk]) || 0); ent.amount = Math.min(ent.amount, ent.max); }
        b.cargoManual = null; b.capRatio = null;
        renderBuilder();
      });
      box.appendChild(fieldRow('<span class="nx-dim">From planet</span>', sel));
    }
    for (const [k, ent] of Object.entries(b.res)) {
      const r = RES_BY_K[k];
      const inp = numInput(ent.amount, ent.max);
      inp.addEventListener('input', () => { ent.amount = Math.min(ent.max, Math.max(0, parseInt(inp.value, 10) || 0)); refreshCargo(); });
      // Re-plan the fleet to match the new amount (on blur/enter, so focus isn't lost mid-typing).
      inp.addEventListener('change', () => { b.cargoManual = planFleetMulti(amountsOf(), cargoShips).plan; renderBuilder(); });
      const ctl = document.createElement('div'); ctl.className = 'nx-qm-stepper';
      const fill = document.createElement('button'); fill.type = 'button'; fill.textContent = 'Fill';
      fill.title = 'Set to the most the fleet can still carry, given the other goods';
      fill.className = 'nx-btn nx-btn-ghost nx-btn-sm';
      fill.onclick = () => {
        const test = a => fits(Object.fromEntries(Object.entries(b.res).map(([kk, e]) => [RES_BY_K[kk].cargo, kk === k ? a : e.amount])));
        let lo = 0, hi = ent.max;
        if (test(hi)) lo = hi;
        else while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (test(mid)) lo = mid; else hi = mid; }
        ent.amount = lo; b.cargoManual = null; renderBuilder();
      };
      ctl.append(withStepper(inp, ent.max), fill);
      box.appendChild(fieldRow(`<img src="${IMG}/${r.icon}" width="15" height="15" alt=""> ${r.label} <span class="nx-subtle">/ ${fmt(ent.max)}</span>`,
        ctl, () => { delete b.res[k]; b.cargoManual = null; if (!Object.keys(b.res).length) builder = null; renderBuilder(); }));
    }
    const allHaulers = await cargoShipsOf(b.src, Object.keys(b.res).map(k => RES_BY_K[k].cargo));
    const cargoShips = allHaulers.filter(s => cargoSel.has(s.key));
    const cw = document.createElement('div'); cw.className = 'nx-qm-section';
    cw.innerHTML = '<div class="nx-sub-label">Transport ships</div>';
    cw.appendChild(cargoPicker(allHaulers, () => { b.cargoManual = null; renderBuilder(); }, status));
    box.appendChild(cw);
    const capLine = document.createElement('div'); capLine.className = 'nx-qm-cap';
    const amountsOf = () => Object.fromEntries(Object.entries(b.res).map(([k, e]) => [RES_BY_K[k].cargo, e.amount]));
    const totalCargo = () => Object.values(b.res).reduce((s, e) => s + e.amount, 0);
    getCargoNeed = () => totalCargo();
    calcLocalCap = () => cargoShips.reduce((s, cs) => s + (b.cargoManual[cs.shipDefId] || 0) * cs.cap, 0);
    // Can the whole available fleet carry these amounts? Respects per-ship cargo
    // restrictions and, once known, the game's real capacity vs. our estimate.
    const fits = amts => {
      const raw = cargoShips.reduce((s, cs) => s + cs.avail * cs.cap, 0);
      const limit = b.capRatio && b.capRatio < 1 ? Math.floor(raw * b.capRatio) : Infinity;
      const full = Object.fromEntries(cargoShips.map(cs => [cs.shipDefId, cs.avail]));
      return Object.values(amts).reduce((s, v) => s + v, 0) <= limit && residualAfter(full, amts, cargoShips) <= 0;
    };
    const fitBtn = document.createElement('button'); fitBtn.type = 'button'; fitBtn.textContent = 'Fit to fleet';
    fitBtn.title = 'Scale all goods down proportionally so they fit the fleet';
    fitBtn.className = 'nx-btn nx-btn-secondary nx-btn-sm';
    fitBtn.style.cssText = 'display:none; margin-top:6px;';
    fitBtn.onclick = () => {
      const scaled = f => Object.fromEntries(Object.entries(b.res).map(([k, e]) => [RES_BY_K[k].cargo, Math.min(e.max, Math.floor(e.amount * f))]));
      let lo = 0, hi = 1;
      if (fits(scaled(1))) lo = 1;
      else for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (fits(scaled(mid))) lo = mid; else hi = mid; }
      for (const e of Object.values(b.res)) e.amount = Math.min(e.max, Math.floor(e.amount * lo));
      b.cargoManual = null; renderBuilder();
    };
    updateFitBtn = () => { fitBtn.style.display = fitState.short || fitState.over ? '' : 'none'; };
    if (b.cargoManual == null) b.cargoManual = planFleetMulti(amountsOf(), cargoShips).plan;
    const refreshCargo = () => {
      const need = totalCargo();
      const short = residualAfter(b.cargoManual, amountsOf(), cargoShips);
      fitState.short = short > 0; updateFitBtn();
      capLine.innerHTML = `Carrying <b class="${short <= 0 ? 'nx-ok' : 'nx-err'}">${fmt(need - short)}</b> / ${fmt(need)}` +
        (short > 0 ? ` <span class="nx-err">· short ${fmt(short)}</span>` : '');
      send.disabled = need <= 0 || short > 0;
      refreshFuel();
    };
    for (const cs of cargoShips) {
      const inp = numInput(b.cargoManual[cs.shipDefId] || 0, cs.avail);
      inp.addEventListener('input', () => { b.cargoManual[cs.shipDefId] = Math.min(cs.avail, Math.max(0, parseInt(inp.value, 10) || 0)); refreshCargo(); });
      cw.appendChild(fieldRow(`${esc(cs.name)} <span class="nx-subtle">/ ${fmt(cs.avail)} · ${fmt(cs.cap)} ea</span>`, withStepper(inp, cs.avail)));
    }
    if (!cargoShips.length) {
      const warn = document.createElement('span');
      warn.className = 'nx-err nx-qm-cap';
      warn.textContent = allHaulers.length ? 'No transport type selected.' : 'No cargo ships on this colony.';
      cw.appendChild(warn);
    }
    cw.append(capLine, fitBtn);
    getShips = () => cargoShips.map(cs => ({ shipDefId: cs.shipDefId, quantity: b.cargoManual[cs.shipDefId] || 0 })).filter(s => s.quantity > 0);
    fuelSrc = b.src.id; fuelSys = b.target.systemId;
    box.append(fuelLine);
    refreshCargo();
  } else {   // ship
    const sVerb = b.src.kind === 'Moon' ? 'Recall ships' : b.target.kind === 'Moon' ? 'Send ships' : toOutpost ? 'Deploy ships' : 'Relocate ships';
    head.innerHTML = `<span class="nx-qm-builder-title">${sVerb}</span>` +
      `<span class="nx-qm-route">${esc(b.src.name)} → ${esc(b.target.name)}</span>` +
      `<span class="nx-qm-hint">drag more onto ${esc(b.target.name)} to add</span>`;
    for (const [id, ent] of Object.entries(b.ships)) {
      const inp = numInput(ent.qty, ent.max);
      inp.addEventListener('input', () => { ent.qty = Math.min(ent.max, Math.max(0, parseInt(inp.value, 10) || 0)); refreshFuel(); send.disabled = !getShips().length; });
      box.appendChild(fieldRow(`${esc(ent.name)} <span class="nx-subtle">/ ${fmt(ent.max)}</span>`, withStepper(inp, ent.max),
        () => { delete b.ships[id]; if (!Object.keys(b.ships).length) builder = null; renderBuilder(); }));
    }
    getShips = () => Object.entries(b.ships).map(([id, e]) => ({ shipDefId: Number(id), quantity: e.qty })).filter(s => s.quantity > 0);
    fuelSrc = b.src.id; fuelSys = b.target.systemId;
    box.append(fuelLine);
    send.disabled = !getShips().length;
  }

  async function refreshFuel() {
    const ships = getShips();
    if (!ships.length) { fuelLine.textContent = ''; return; }
    fuelLine.textContent = 'Fuel: …';
    const est = await fuelEstimate(fuelSrc, fuelSys, ships).catch(() => null);
    fuelLine.textContent = est ? `Fuel: ${fmt(est.fuelCost)} H · ETA ${fmtDur(est.travelTime)}${est.inRange === false ? ' · OUT OF RANGE' : ''}` : 'Fuel: —';
    // Server-authoritative capacity check: fuel-estimate returns the fleet's
    // real totalCargoCapacity (bonuses applied game-side), unlike our own
    // effCap() which reverse-engineers the bonus from research effects and can
    // drift from what the game actually enforces. Cross-check before Send is
    // even clickable, instead of only finding out from the dispatch rejection.
    if (est && b.mode === 'resource') {
      const need = getCargoNeed();
      const statusText = String(status?.dataset?.status ?? '');
      const localCap = calcLocalCap();
      if (localCap > 0 && est.totalCargoCapacity > 0) b.capRatio = est.totalCargoCapacity / localCap;
      fitState.over = need > est.totalCargoCapacity; updateFitBtn();
      if (need > est.totalCargoCapacity) {
        send.disabled = true;
        setStatusText(status, `Cargo hold exceeds fleet capacity: ${fmt(need)} > ${fmt(est.totalCargoCapacity)}`, 'error');
      } else if (statusText.startsWith('Cargo hold exceeds')) {
        setStatusText(status, '');
      }
    }
  }
  if (b.mode === 'ship') refreshFuel();

  // Endpoint + body per mode/source/target (payloads match the game's own requests).
  function sendSpec() {
    const ships = getShips();
    if (b.mode === 'collect')
      return { path: `/api/outposts/${b.outpost.id}/collect`, body: { sourcePlanetId: b.srcPlanetId, ships, resourceFilter: [...b.filter].map(k => RES_BY_K[k].cargo) } };
    const src = b.src, tgt = b.target;
    const resources = b.mode === 'resource'
      ? Object.fromEntries(Object.entries(b.res).filter(([, e]) => e.amount > 0).map(([k, e]) => [RES_BY_K[k].cargo, e.amount]))
      : {};
    if (src.kind === 'Moon')   // moon → planet
      return b.mode === 'resource'
        ? { path: `/api/moons/${src.id}/dispatch`, body: { missionType: 'transfer', targetPlanetId: tgt.id, ships, cargo: resources } }
        : { path: `/api/moons/${src.id}/recall`, body: { targetPlanetId: tgt.id, ships } };
    if (tgt.kind === 'Moon')   // planet → moon (send handles resources + ships)
      return { path: `/api/moons/${tgt.id}/send`, body: { sourcePlanetId: src.id, ships, cargo: resources } };
    if (tgt.kind === 'Outpost')
      return b.mode === 'resource'
        ? { path: `/api/outposts/${tgt.id}/supply`, body: { sourcePlanetId: src.id, ships, resources } }
        : { path: `/api/outposts/${tgt.id}/garrison`, body: { sourcePlanetId: src.id, ships } };
    return b.mode === 'resource'   // planet → planet
      ? { path: '/api/fleet/dispatch', body: { sourcePlanetId: src.id, targetPlanetId: tgt.id, missionType: b.deliverMode || 'deliver', ships, cargo: resources } }
      : { path: '/api/fleet/dispatch', body: { sourcePlanetId: src.id, targetPlanetId: tgt.id, missionType: 'transfer', ships, cargo: {} } };
  }

  send.onclick = async () => {
    if (!getShips().length) return;
    send.disabled = true; setStatusText(status, 'Sending…');
    try { const s = sendSpec(); await jpost(s.path, s.body); builder = null; refresh(); }
    catch (e) { setStatusText(status, e.message, 'error'); send.disabled = false; }
  };

  const foot = document.createElement('div');
  foot.className = 'nx-qm-foot';
  foot.append(status, clear, send);
  box.appendChild(foot);
  builderEl.appendChild(box);
}

// Inject the topbar button (re-injected if the SPA re-renders the topbar).
function injectButton() {
  if (document.getElementById('nx-logistics-btn')) return;
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const btn = document.createElement('button');
  btn.id = 'nx-logistics-btn';
  btn.type = 'button';
  btn.className = 'nx-theme nx-btn nx-btn-ghost nx-qm-topbar-btn';
  btn.title = 'Quartermaster — fleet & resources overview (addon)';
  btn.textContent = '📦 Quartermaster';
  btn.addEventListener('click', openView);
  const left = bar.querySelector('.topbar-left') || bar;
  left.appendChild(btn);
}

new MutationObserver(injectButton).observe(document.documentElement, { childList: true, subtree: true });
injectButton();
})();
}
