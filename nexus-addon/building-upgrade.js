// Injects an "⬆ upgrade" button onto every building card (.entity-image holding a
// /buildings/…webp image) on the game page. Clicking opens a planner: pick the
// planet, pick a target level, and it computes the total ore/silicates/hydrogen/
// alloys needed to get there — then hands the deficit to the Quartermaster to
// send from another planet.
//
// Cost model (reverse-engineered from /api/planets/{id} building.definition and
// calibrated against real in-game costs — ore mine 18→19 and alloy foundry
// 12→13): each level L→L+1 multiplies the base cost by
//     costFactor^min(L,9) · highLevelFactor^max(0,L-9)
// i.e. levels below 10 use costFactor (1.4), level 10+ use highLevelFactor (1.5),
// per resource. Alloys apply only from definition.alloysFromLevel. costDoubleAfter
// (nonzero on some buildings, e.g. Research Lab = 7) flat-doubles the cost for
// every level past it — confirmed against live previewUpgradeCost at L=6 (1×),
// L=8 and L=10 (both exactly 2×, not compounding further).
//
// IIFE + re-run guard: Firefox can inject a content script twice into one
// isolated world; top-level consts would then throw "redeclaration of const".
if (!window.__nxBuildingUpgrade) {
window.__nxBuildingUpgrade = true;
(function () {
const IMG = '/images/resources';
// Cost resources: colony/stock field (camelCase) · dispatch cargo key (snake) ·
// building-definition base-cost field · label · icon.
const COST_RES = [
  { k: 'ore',       cargo: 'ore',       base: 'baseCostOre',       label: 'Ore',       icon: 'ore.webp' },
  { k: 'silicates', cargo: 'silicates', base: 'baseCostSilicates', label: 'Silicates', icon: 'silicates.webp' },
  { k: 'hydrogen',  cargo: 'hydrogen',  base: 'baseCostHydrogen',  label: 'Hydrogen',  icon: 'hydrogen.webp' },
  { k: 'alloys',    cargo: 'alloys',    base: 'baseCostAlloys',    label: 'Alloys',    icon: 'alloys.webp' },
];
const fmt = n => Math.round(n || 0).toLocaleString();

// The planet currently in view, learned from the page's own /api/planets/{id}
// GET (relayed by galaxy-fetch-hook.js, MAIN world). Ask for a replay on load in
// case the fetch already happened before we attached the listener.
let currentPlanetId = null;
window.addEventListener('message', e => {
  if (e.origin !== window.location.origin) return;
  if (e.data && e.data.__nxCurrentPlanet != null) currentPlanetId = e.data.__nxCurrentPlanet;
});
window.postMessage({ __nxRequestCurrentPlanet: true }, window.location.origin);

// Cumulative cost to go from `fromLevel` to `toLevel` (exclusive→inclusive of the
// upgrades). Rounds each level as the game appears to (±1 vs observed).
function upgradeCost(def, fromLevel, toLevel) {
  const tot = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0 };
  for (let L = fromLevel; L < toLevel; L++) {   // the L→L+1 upgrade
    let m = Math.pow(def.costFactor || 1.4, Math.min(L, 9)) *
            Math.pow(def.highLevelFactor || 1.5, Math.max(0, L - 9));
    if (def.costDoubleAfter && L > def.costDoubleAfter) m *= 2;
    for (const r of COST_RES) {
      if (r.k === 'alloys' && (L + 1) < (def.alloysFromLevel || 0)) continue;
      tot[r.k] += Math.round((def[r.base] || 0) * m);
    }
  }
  return tot;
}

// Building key from the card image, e.g. /api/images/buildings/terran/ore_mine.webp
function keyFromCard(card) {
  const img = card.querySelector('img[src*="/buildings/"]');
  const m = img && img.src.match(/\/buildings\/[^/]+\/([a-z0-9_]+)\.webp/i);
  return m ? m[1] : null;
}

async function fetchPlanet(id) {
  return globalThis.nexusGameApi(`/api/planets/${id}`, { source: 'building-planner' });
}

// The card image name carries a planet-type suffix the definition key lacks
// (e.g. hydrogen_processor_gas_giant → hydrogen_processor). Match exact, else
// the longest definition key that's a prefix of the image name.
function findBuilding(d, buildingKey) {
  const builds = d.buildings || [];
  return builds.find(x => x?.definition?.key === buildingKey)
    || builds.filter(x => x?.definition?.key && buildingKey.startsWith(x.definition.key + '_'))
             .sort((a, c) => c.definition.key.length - a.definition.key.length)[0];
}

// Resource cost (dispatch cargo keys) to take a building from→target on a
// planet. Exposed for the to-do list (upgrade-queue.js), which sums this
// across every selected item and subtracts planet stock once — not per item,
// or a shared stock pool would get double-counted as covering each item.
window.__nxUpgradeNeed = window.__nxUpgradeNeed || {};
window.__nxUpgradeNeed.building = async (buildingKey, planetId, from, target) => {
  const d = await fetchPlanet(planetId);
  const b = findBuilding(d, buildingKey);
  if (!b) return {};
  const need = upgradeCost(b.definition, from, target);
  const out = {};
  for (const r of COST_RES) { if (need[r.k]) out[r.cargo] = need[r.k]; }
  return out;
};

let panel = null;
function closePanel() { if (panel) { panel.remove(); panel = null; } }

async function openPlanner(buildingKey) {
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
  title.innerHTML = 'Nexus <span>Overseer</span>: Building upgrade planner';
  box.appendChild(title);

  if (currentPlanetId == null) {
    box.innerHTML += '<div class="nx-err">Open a planet’s buildings first.</div>';
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

  const lvlRow = row('Target level');
  const lvlInp = document.createElement('input');
  lvlInp.type = 'text'; lvlInp.inputMode = 'numeric';   // text = no spinner arrows
  lvlInp.className = 'nx-input nx-input-num';
  lvlInp.addEventListener('input', () => { const c = lvlInp.value.replace(/[^\d]/g, ''); if (c !== lvlInp.value) lvlInp.value = c; });
  const stepBtn = txt => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.className = 'nx-btn nx-btn-ghost nx-btn-sm';
    return b;
  };
  const setLvl = v => { lvlInp.value = String(v); recompute(); };
  const minus = stepBtn('−'); minus.onclick = () => setLvl((parseInt(lvlInp.value, 10) || 0) - 1);
  const plus = stepBtn('+'); plus.onclick = () => setLvl((parseInt(lvlInp.value, 10) || 0) + 1);
  const maxBtn = stepBtn('Max'); maxBtn.onclick = () => setLvl(state ? state.def.maxLevel : lvlInp.value);
  lvlRow.append(minus, lvlInp, plus, maxBtn);
  const lvlHint = document.createElement('span'); lvlHint.className = 'nx-subtle'; lvlRow.appendChild(lvlHint);

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
    window.__nxQueue.add({ kind: 'building', key: buildingKey, name: state.def.name,
      planet: pName.textContent, planetId: currentPlanetId,
      from: state.level, target: parseInt(lvlInp.value, 10) || state.level });
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.type = 'button'; closeBtn.className = 'nx-btn nx-btn-ghost';
  closeBtn.onclick = closePanel;
  actions.append(addBtn, closeBtn, sendBtn);
  box.appendChild(actions);

  let state = null;   // { def, level, stock } for the selected planet

  async function loadPlanet() {
    state = null; table.textContent = ''; sendBtn.disabled = true;
    info.textContent = 'Loading…';
    let d;
    try { d = await fetchPlanet(currentPlanetId); }
    catch (e) { info.textContent = `Error: ${e.message}`; return; }
    const pl = d.planet || d;
    if (pl.name) pName.textContent = pl.name;
    const b = findBuilding(d, buildingKey);
    if (!b) { info.textContent = `“${buildingKey}” isn't built on this planet.`; lvlInp.disabled = true; return; }
    lvlInp.disabled = false;
    const def = b.definition;
    const stock = Object.fromEntries(COST_RES.map(r => [r.k, pl[r.k] || 0]));
    state = { def, level: b.level || 0, stock };
    info.textContent = `${def.name} · current level ${state.level} · max ${def.maxLevel}`;
    lvlInp.max = String(def.maxLevel);
    lvlInp.value = String(Math.min(def.maxLevel, state.level + 1));
    lvlHint.textContent = `(from ${state.level})`;
    recompute();
  }

  function recompute() {
    table.textContent = '';
    if (!state) return;
    let target = parseInt(lvlInp.value, 10) || 0;
    target = Math.max(state.level + 1, Math.min(state.def.maxLevel, target));
    lvlInp.value = String(target);
    const need = upgradeCost(state.def, state.level, target);

    // Fixed numeric columns so Need/On planet/Deficit align; a vertical rule
    // before each number column and a rule under each row keep them readable.
    const head = document.createElement('div');
    head.className = 'nx-planner-cost-row nx-planner-cost-head';
    head.innerHTML = '<div class="nx-resource-label"></div>' +
      '<div>Need</div><div>On planet</div><div>Deficit</div>';
    table.appendChild(head);

    const deficit = {};
    for (const r of COST_RES) {
      const n = need[r.k]; if (!n) continue;
      const have = state.stock[r.k] || 0;
      const short = Math.max(0, n - have);
      deficit[r.cargo] = short;
      const line = document.createElement('div');
      line.className = 'nx-planner-cost-row';
      line.innerHTML =
        `<div class="nx-resource-label"><img src="${IMG}/${r.icon}" width="15" height="15"> ${r.label}</div>` +
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

  lvlInp.addEventListener('input', recompute);
  await loadPlanet();
}

// ── Find the action-area that lives near a given card, walking up a few
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

// ── Inject the button onto building cards ───────────────────────────────────
function injectButtons() {
  document.querySelectorAll('div.entity-image').forEach(card => {
    if (!card.querySelector('img[src*="/buildings/"]')) return;
    const row = findNearbyRow(card, '.building-action-area');
    if (!row || row.querySelector('.nx-upgrade-btn')) return;
    const action = row.querySelector(':scope > .upgrade-btn');
    if (!action) return;
    const key = keyFromCard(card);
    if (!key) return;
    const btn = document.createElement('button');
    btn.className = 'nx-upgrade-btn nx-theme nx-btn nx-btn-secondary nx-planner-open';
    btn.type = 'button';
    btn.textContent = '🏗️';
    btn.title = 'Plan upgrade resources (addon)';
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
