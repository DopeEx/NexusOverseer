// Injects a "🚀 build" button onto every ship card (.entity-image holding a
// /api/images/ships/…webp image) on the game shipyard page. Clicking opens a
// planner: pick a quantity to build and it computes the total ore/silicates/
// hydrogen/alloys/rare cost — then hands the deficit to the Quartermaster to
// send from another planet.
//
// Cost model: flat per-unit (no level scaling, unlike buildings/tech) — ship
// def fields costOre/costSilicates/costHydrogen/costAlloys + rareCosts, the
// same shape buildShipCatalog() in background.js stores. qty × unit cost.
//
// Ships are per-planet like buildings (built at the shipyard of the planet in
// view, funded by that planet's stock) — reuses building-upgrade.js's "planet
// in view" pattern rather than tech's destination picker.
//
// IIFE + re-run guard: Firefox can inject a content script twice into one
// isolated world; top-level consts would then throw "redeclaration of const".
if (!window.__nxShipUpgrade) {
window.__nxShipUpgrade = true;
(function () {
const IMG = '/images/resources';
// snake cargo key (dispatch + rareCosts keys) → camelCase planet stock field.
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// The four base cost resources: ship-def field · dispatch cargo key.
const BASE_RES = [
  { field: 'costOre',       cargo: 'ore' },
  { field: 'costSilicates', cargo: 'silicates' },
  { field: 'costHydrogen',  cargo: 'hydrogen' },
  { field: 'costAlloys',    cargo: 'alloys' },
];
const fmt = n => Math.round(n || 0).toLocaleString();
const labelOf = cargo => cargo.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// The planet currently in view, learned from the page's own /api/planets/{id}
// GET (relayed by galaxy-fetch-hook.js, MAIN world). Ask for a replay on load in
// case the fetch already happened before we attached the listener.
let currentPlanetId = null;
window.addEventListener('message', e => {
  if (e.origin !== window.location.origin) return;
  if (e.data && e.data.__nxCurrentPlanet != null) currentPlanetId = e.data.__nxCurrentPlanet;
});
window.postMessage({ __nxRequestCurrentPlanet: true }, window.location.origin);

// Total cost to build `qty` more of a ship. Returns { cargoKey: amount }.
function buildCost(def, qty) {
  const tot = {};
  if (qty <= 0) return tot;
  for (const r of BASE_RES) {
    const v = Math.round((def[r.field] || 0) * qty);
    if (v) tot[r.cargo] = (tot[r.cargo] || 0) + v;
  }
  for (const [k, v] of Object.entries(def.rareCosts || {})) {
    if (v) tot[k] = (tot[k] || 0) + Math.round(v * qty);
  }
  return tot;
}

// Ship key from the card image, e.g. /api/images/ships/terran/interceptor.webp
function keyFromCard(card) {
  const img = card.querySelector('img[src*="/ships/"]');
  const m = img && img.src.match(/\/ships\/[^/]+\/([a-z0-9_]+)\.webp/i);
  return m ? m[1] : null;
}

async function fetchJSON(path) {
  return globalThis.nexusGameApi(path, { source: 'ship-planner' });
}

function findShip(ships, shipKey) {
  return (ships || []).find(s => s.key === shipKey);
}

// Owned (undamaged) quantity of a ship on a planet, keyed by ship def key.
function ownedQty(fleet, shipKey) {
  const f = (fleet || []).find(x => x.definition?.key === shipKey);
  return f ? Math.max(0, (f.quantity || 0) - (f.damagedQuantity || 0)) : 0;
}

// Resource cost (dispatch cargo keys) to build `target − from` more of a ship
// on a planet. Exposed for the to-do list (upgrade-queue.js), which sums this
// across every selected item and subtracts planet stock once — not per item,
// or a shared stock pool would get double-counted as covering each item.
window.__nxUpgradeNeed = window.__nxUpgradeNeed || {};
window.__nxUpgradeNeed.ship = async (shipKey, planetId, from, target) => {
  const sd = await fetchJSON(`/api/planets/${planetId}/shipyard`);
  const s = findShip(sd.ships, shipKey);
  if (!s) return {};
  return buildCost(s, Math.max(0, target - from));
};

let panel = null;
function closePanel() { if (panel) { panel.remove(); panel = null; } }

async function openPlanner(shipKey) {
  closePanel();
  const overlay = document.createElement('div');
  panel = overlay;
  overlay.className = 'nx-theme nx-planner-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

  const box = document.createElement('div');
  box.className = 'nx-planner-box';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  if (window.__nxQueue) window.__nxQueue.mountPanel(overlay);

  const title = document.createElement('h2');
  title.innerHTML = 'Nexus <span>Overseer</span>: Shipyard build planner';
  box.appendChild(title);

  if (currentPlanetId == null) {
    box.innerHTML += '<div class="nx-err">Open a planet’s shipyard first.</div>';
    return;
  }

  const row = (labelText) => {
    const r = document.createElement('div');
    r.className = 'nx-planner-field';
    const l = document.createElement('div'); l.className = 'nx-planner-label'; l.textContent = labelText;
    r.appendChild(l);
    box.appendChild(r);
    return r;
  };

  // Planet in view — taken from the page's current planet, not chosen by the user.
  const pRow = row('Planet');
  const pName = document.createElement('div');
  pName.className = 'nx-planner-planet';
  pName.textContent = `Planet #${currentPlanetId}`;
  pRow.appendChild(pName);

  const info = document.createElement('div');
  info.className = 'nx-planner-info';
  box.appendChild(info);

  const qtyRow = row('Build qty');
  const qtyInp = document.createElement('input');
  qtyInp.type = 'text'; qtyInp.inputMode = 'numeric';   // text = no spinner arrows
  qtyInp.className = 'nx-input nx-input-num';
  qtyInp.addEventListener('input', () => { const c = qtyInp.value.replace(/[^\d]/g, ''); if (c !== qtyInp.value) qtyInp.value = c; });
  const stepBtn = txt => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.className = 'nx-btn nx-btn-ghost nx-btn-sm';
    return b;
  };
  const setQty = v => { qtyInp.value = String(Math.max(1, v)); recompute(); };
  const minus = stepBtn('−'); minus.onclick = () => setQty((parseInt(qtyInp.value, 10) || 1) - 1);
  const plus = stepBtn('+'); plus.onclick = () => setQty((parseInt(qtyInp.value, 10) || 1) + 1);
  qtyRow.append(minus, qtyInp, plus);
  const qtyHint = document.createElement('span'); qtyHint.className = 'nx-subtle'; qtyRow.appendChild(qtyHint);

  const table = document.createElement('div');
  table.className = 'nx-planner-costs';
  box.appendChild(table);

  const actions = document.createElement('div');
  actions.className = 'nx-planner-actions';
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send deficit via Quartermaster';
  sendBtn.type = 'button'; sendBtn.className = 'nx-btn nx-btn-primary';
  const addBtn = document.createElement('button');
  addBtn.textContent = '➕ To-do';
  addBtn.type = 'button'; addBtn.className = 'nx-btn nx-btn-secondary nx-planner-add';
  addBtn.onclick = () => {
    if (!state || !window.__nxQueue) return;
    const qty = parseInt(qtyInp.value, 10) || 1;
    window.__nxQueue.add({ kind: 'ship', key: shipKey, name: state.def.name,
      planet: pName.textContent, planetId: currentPlanetId,
      from: state.owned, target: state.owned + qty });
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.type = 'button'; closeBtn.className = 'nx-btn nx-btn-ghost';
  closeBtn.onclick = closePanel;
  actions.append(addBtn, closeBtn, sendBtn);
  box.appendChild(actions);

  let state = null;   // { def, owned, stock } for the selected planet

  async function loadPlanet() {
    state = null; table.textContent = ''; sendBtn.disabled = true;
    info.textContent = 'Loading…';
    let sd, fd, pd;
    try {
      [sd, fd, pd] = await Promise.all([
        fetchJSON(`/api/planets/${currentPlanetId}/shipyard`),
        fetchJSON(`/api/planets/${currentPlanetId}/fleet`),
        fetchJSON(`/api/planets/${currentPlanetId}`),
      ]);
    } catch (e) { info.textContent = `Error: ${e.message}`; return; }
    const pl = pd.planet || pd;
    if (pl.name) pName.textContent = pl.name;
    const def = findShip(sd.ships, shipKey);
    if (!def) { info.textContent = `“${shipKey}” isn't buildable on this planet.`; qtyInp.disabled = true; return; }
    qtyInp.disabled = false;
    const owned = ownedQty(fd.fleet, shipKey);
    state = { def, owned, stock: pl };
    info.textContent = `${def.name} · owned ${owned}`;
    qtyInp.value = '1';
    qtyHint.textContent = `(owned ${owned})`;
    recompute();
  }

  function recompute() {
    table.textContent = '';
    if (!state) return;
    let qty = parseInt(qtyInp.value, 10) || 0;
    qty = Math.max(1, qty);
    qtyInp.value = String(qty);
    const need = buildCost(state.def, qty);

    // Fixed numeric columns so Need/On planet/Deficit align; a vertical rule
    // before each number column and a rule under each row keep them readable.
    const head = document.createElement('div');
    head.className = 'nx-planner-cost-row nx-planner-cost-head';
    head.innerHTML = '<div class="nx-resource-label"></div>' +
      '<div>Need</div><div>On planet</div><div>Deficit</div>';
    table.appendChild(head);

    const deficit = {};
    for (const [cargo, n] of Object.entries(need)) {
      if (!n) continue;
      const have = state.stock[camel(cargo)] || 0;
      const short = Math.max(0, n - have);
      deficit[cargo] = short;
      const line = document.createElement('div');
      line.className = 'nx-planner-cost-row';
      line.innerHTML =
        `<div class="nx-resource-label"><img src="${IMG}/${cargo}.webp" width="15" height="15"> ${labelOf(cargo)}</div>` +
        `<div>${fmt(n)}</div>` +
        `<div class="nx-subtle">${fmt(have)}</div>` +
        `<div class="${short > 0 ? 'nx-err' : 'nx-ok'}">${short > 0 ? fmt(short) : '—'}</div>`;
      table.appendChild(line);
    }
    const totalShort = Object.values(deficit).reduce((s, v) => s + v, 0);
    sendBtn.disabled = totalShort <= 0;
    sendBtn.title = totalShort <= 0 ? 'Planet already has enough' : 'Open the Quartermaster to ship the deficit here';
    sendBtn.onclick = () => {
      const nonZero = Object.fromEntries(Object.entries(deficit).filter(([, v]) => v > 0));
      closePanel();
      if (window.__nxDeliverToPlanet) window.__nxDeliverToPlanet(currentPlanetId, nonZero);
    };
  }

  qtyInp.addEventListener('input', recompute);
  await loadPlanet();
}

// ── Find the build-row that lives near a given card, walking up a few
// ancestor levels since the row is a sibling of the card's header, not the
// card itself. ───────────────────────────────────────────────────────────
function findNearbyRow(card, rowSelector, maxLevels = 3) {
  let el = card.parentElement;
  for (let i = 0; i < maxLevels && el; i++) {
    const row = el.querySelector(rowSelector);
    if (row) return row;
    el = el.parentElement;
  }
  return null;
}

// ── Inject the button onto ship cards ────────────────────────────────────────
function injectButtons() {
  document.querySelectorAll('div.entity-image').forEach(card => {
    if (!card.querySelector('img[src*="/ships/"]')) return;
    const row = findNearbyRow(card, '.ship-build-row');
    if (!row || row.querySelector('.nx-ship-btn')) return;
    const action = row.querySelector(':scope > .build-btn');
    if (!action) return;
    const key = keyFromCard(card);
    if (!key) return;
    const btn = document.createElement('button');
    btn.className = 'nx-ship-btn nx-theme nx-btn nx-btn-secondary nx-planner-open';
    btn.type = 'button';
    btn.textContent = '🚀';
    btn.title = 'Plan build resources (addon)';
    btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); openPlanner(key); });
    row.classList.add('nx-planner-action-row');
    action.after(btn);
  });
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; injectButtons(); });
}
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
schedule();
})();
}
