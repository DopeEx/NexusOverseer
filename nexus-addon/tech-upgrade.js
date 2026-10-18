// Injects an "⬆ upgrade" button onto every technology card (.entity-image holding
// a /api/images/research/…webp image) on the game research page. Clicking opens a
// planner: pick a target level and a destination planet, and it computes the
// total ore/silicates/hydrogen/alloys/rare cost to get there — then hands the
// deficit to the Quartermaster to ship from another planet.
//
// Unlike buildings, research is account-global (a tech's level is the same on
// every planet) — but the cost is *spent on whichever planet launches it*. So
// the planner needs a destination planet (where you'll research) to diff the
// cost against, instead of the building tool's "planet in view".
//
// Cost model (same shape techtree.js uses): each level L costs
//     costOre/…/costAlloys · costFactor^(L-1)   (L 1-indexed), plus rareCosts
// scaled by the same factor. Guarded by test_tech_cost.js.
//
// IIFE + re-run guard: Firefox can inject a content script twice into one
// isolated world; top-level consts would then throw "redeclaration of const".
if (!window.__nxTechUpgrade) {
window.__nxTechUpgrade = true;
(function () {
const IMG = '/images/resources';
// snake cargo key (dispatch + rareCosts keys) → camelCase planet stock field.
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// The four base cost resources: research-def field · dispatch cargo key.
const BASE_RES = [
  { field: 'costOre',       cargo: 'ore' },
  { field: 'costSilicates', cargo: 'silicates' },
  { field: 'costHydrogen',  cargo: 'hydrogen' },
  { field: 'costAlloys',    cargo: 'alloys' },
];
const fmt = n => Math.round(n || 0).toLocaleString();
const labelOf = cargo => cargo.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Cumulative cost to research from `fromLevel` (exclusive) to `toLevel`
// (inclusive). Returns { cargoKey: amount } in dispatch (snake) keys.
function upgradeCost(t, fromLevel, toLevel) {
  const tot = {};
  for (let L = fromLevel + 1; L <= toLevel; L++) {   // researching level L
    const m = Math.pow(t.costFactor || 1, L - 1);
    for (const r of BASE_RES) {
      const v = Math.round((t[r.field] || 0) * m);
      if (v) tot[r.cargo] = (tot[r.cargo] || 0) + v;
    }
    for (const [k, v] of Object.entries(t.rareCosts || {})) {
      if (v) tot[k] = (tot[k] || 0) + Math.round(v * m);
    }
  }
  return tot;
}

// Tech key from the card image, e.g. /api/images/research/improved_mining.webp
function keyFromCard(card) {
  const img = card.querySelector('img[src*="/research/"]');
  const m = img && img.src.match(/\/research\/([a-z0-9_]+)\.webp/i);
  return m ? m[1] : null;
}

async function fetchJSON(path) {
  const r = await fetch(path, { credentials: 'include' });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// Match a research entry to the card key: exact, else the longest key that's a
// prefix of it.
function findTech(research, techKey) {
  return research.find(x => x.key === techKey)
    || research.filter(x => x.key && techKey.startsWith(x.key + '_'))
               .sort((a, b) => b.key.length - a.key.length)[0];
}

// Resource cost (dispatch cargo keys) to research a tech from→target.
// Exposed for the to-do list (upgrade-queue.js), which sums this across every
// selected item and subtracts planet stock once — not per item, or a shared
// stock pool would get double-counted as covering each item.
window.__nxUpgradeNeed = window.__nxUpgradeNeed || {};
window.__nxUpgradeNeed.tech = async (techKey, planetId, from, target) => {
  const rd = await fetchJSON(`/api/research?planetId=${planetId}`);
  const t = findTech(rd.research || [], techKey);
  if (!t) return {};
  return upgradeCost(t, from, target);
};

// Planet the page happens to be showing (relayed by galaxy-fetch-hook.js) — used
// only as the default destination when it's one of our planets.
let currentPlanetId = null;
window.addEventListener('message', e => {
  if (e.origin !== window.location.origin) return;
  if (e.data && e.data.__nxCurrentPlanet != null) currentPlanetId = e.data.__nxCurrentPlanet;
});
window.postMessage({ __nxRequestCurrentPlanet: true }, window.location.origin);

let panel = null;
function closePanel() { if (panel) { panel.remove(); panel = null; } }

async function openPlanner(techKey) {
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
  title.innerHTML = 'Nexus <span>Overseer</span>: Technology upgrade planner';
  box.appendChild(title);

  const row = (labelText) => {
    const r = document.createElement('div');
    r.className = 'nx-planner-field';
    const l = document.createElement('div'); l.className = 'nx-planner-label'; l.textContent = labelText;
    r.appendChild(l);
    box.appendChild(r);
    return r;
  };

  // Destination planet — where the research will run (its stock funds it).
  const pRow = row('Research on');
  const pSel = document.createElement('select');
  pSel.className = 'nx-input nx-planner-planet';
  pRow.appendChild(pSel);

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
  const maxBtn = stepBtn('Max'); maxBtn.onclick = () => setLvl(tech ? tech.maxLevel : lvlInp.value);
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
    if (!tech || !window.__nxQueue) return;
    window.__nxQueue.add({ kind: 'tech', key: tech.key, name: tech.name,
      planet: pSel.selectedOptions[0] && pSel.selectedOptions[0].textContent, planetId: destId,
      from: tech.level || 0, target: parseInt(lvlInp.value, 10) || (tech.level || 0) });
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.type = 'button'; closeBtn.className = 'nx-btn nx-btn-ghost';
  closeBtn.onclick = closePanel;
  actions.append(addBtn, closeBtn, sendBtn);
  box.appendChild(actions);

  let tech = null;      // the research def (global: level, maxLevel, cost fields)
  let stock = null;     // { camelField: amount } for the selected destination planet
  let destId = null;

  // Load planet list + the (global) research data once.
  info.textContent = 'Loading…';
  let planets;
  try {
    const [pd, rd] = await Promise.all([
      fetchJSON('/api/planets'),
      // Research is account-global; any planetId returns the same defs/levels.
      currentPlanetId != null ? fetchJSON(`/api/research?planetId=${currentPlanetId}`) : null,
    ]);
    planets = (pd.planets || []).map(p => ({ id: p.id, name: p.name || `Planet #${p.id}` }));
    if (!planets.length) { info.textContent = 'No planets found.'; return; }
    // If we couldn't fetch research yet (no planet in view), fetch via planet 1.
    const research = (rd || await fetchJSON(`/api/research?planetId=${planets[0].id}`)).research || [];
    tech = findTech(research, techKey);
    if (!tech) { info.textContent = `“${techKey}” isn't a known technology.`; return; }
  } catch (e) { info.textContent = `Error: ${e.message}`; return; }

  for (const p of planets) {
    const o = document.createElement('option');
    o.value = String(p.id); o.textContent = p.name;
    pSel.appendChild(o);
  }
  destId = planets.some(p => p.id === currentPlanetId) ? currentPlanetId : planets[0].id;
  pSel.value = String(destId);

  info.textContent = `${tech.name} · current level ${tech.level || 0} · max ${tech.maxLevel}`;
  lvlInp.value = String(Math.min(tech.maxLevel, (tech.level || 0) + 1));
  lvlHint.textContent = `(from ${tech.level || 0})`;

  async function loadStock() {
    stock = null; sendBtn.disabled = true; table.textContent = 'Loading planet stock…';
    try {
      const d = await fetchJSON(`/api/planets/${destId}`);
      const pl = d.planet || d;
      stock = pl;
    } catch (e) { table.textContent = `Error: ${e.message}`; return; }
    recompute();
  }

  function recompute() {
    if (!tech || !stock) return;
    table.textContent = '';
    let target = parseInt(lvlInp.value, 10) || 0;
    target = Math.max((tech.level || 0) + 1, Math.min(tech.maxLevel, target));
    lvlInp.value = String(target);
    const need = upgradeCost(tech, tech.level || 0, target);

    const head = document.createElement('div');
    head.className = 'nx-planner-cost-row nx-planner-cost-head';
    head.innerHTML = '<div class="nx-resource-label"></div>' +
      '<div>Need</div><div>On planet</div><div>Deficit</div>';
    table.appendChild(head);

    const deficit = {};
    for (const [cargo, n] of Object.entries(need)) {
      if (!n) continue;
      const have = stock[camel(cargo)] || 0;
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
    sendBtn.title = totalShort <= 0 ? 'Destination planet already has enough' : 'Ship the deficit to the destination planet';
    sendBtn.onclick = () => {
      const nonZero = Object.fromEntries(Object.entries(deficit).filter(([, v]) => v > 0));
      closePanel();
      if (window.__nxDeliverToPlanet) window.__nxDeliverToPlanet(destId, nonZero);
    };
  }

  pSel.addEventListener('change', () => { destId = Number(pSel.value); loadStock(); });
  lvlInp.addEventListener('input', recompute);
  await loadStock();
}

// ── Find the card-bottom row that lives near a given card, walking up a few
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

// ── Inject the button onto technology cards ──────────────────────────────────
function injectButtons() {
  document.querySelectorAll('div.entity-image').forEach(card => {
    if (!card.querySelector('img[src*="/research/"]')) return;
    const row = findNearbyRow(card, '.research-card-bottom');
    if (!row || row.querySelector('.nx-tech-btn')) return;
    const action = row.querySelector(':scope > .research-btn');
    if (!action) return;
    const key = keyFromCard(card);
    if (!key) return;
    const btn = document.createElement('button');
    btn.className = 'nx-tech-btn nx-theme nx-btn nx-btn-secondary nx-planner-open';
    btn.type = 'button';
    btn.textContent = '🔬';
    btn.title = 'Plan research resources (addon)';
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
