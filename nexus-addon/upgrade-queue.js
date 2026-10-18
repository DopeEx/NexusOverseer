// Shared upgrade to-do list for the building-, tech-, and ship-upgrade
// planners. Runs in the same isolated world as all three (all content
// scripts of one extension share one `window`), so it just hangs an API off
// `window.__nxQueue`:
//   __nxQueue.add({ kind, key, name, from, target })  — queue an item
//   __nxQueue.mountPanel(overlay)                      — render the list beside a planner
// The queue persists in ext.storage.local and is reorderable by drag & drop.
//
// Left-clicking a row toggles it in/out of a selection. The panel then sums
// window.__nxUpgradeNeed[kind]() across every selected item and subtracts the
// destination planet's stock ONCE (not per item — summing per-item deficits
// would double-count a shared stock pool as covering each item separately),
// showing Need/On planet/Deficit plus a Send-via-Quartermaster button.
// Selection only makes sense for one planet at a time, since a single
// Quartermaster delivery has one destination.
if (!window.__nxQueue) {
(function () {
const ext = (typeof browser !== 'undefined' ? browser : chrome);
const KEY = 'nx_upgrade_queue';
const ICON = { building: '🏗️', tech: '🔬', ship: '🚀' };
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const fmt = n => Math.round(n || 0).toLocaleString();
const labelOf = cargo => cargo.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

let items = [];
let loaded = false;
let listEl = null;   // the current <div> holding rows, or null when unmounted
let aggEl = null;    // the current <div> holding the selection summary, or null when unmounted
const selected = new Set();   // item ids

async function load() {
  if (loaded) return;
  const got = await ext.storage.local.get(KEY);
  items = (Array.isArray(got[KEY]) ? got[KEY] : []).map(migrate);
  loaded = true;
}
function save() { ext.storage.local.set({ [KEY]: items }); }

// A card stores { id, kind, key, name, base, steps }: base = the game level it
// was captured at, steps = how many levels it advances. from/target are
// derived by walking the list in order (chain()), so reordering recomputes
// the labels.
function migrate(it) {
  if (it.steps != null) { if (!it.id) it.id = uid(); return it; }   // already new-shape
  return { id: uid(), kind: it.kind, key: it.key, name: it.name,
    planet: it.planet, planetId: it.planetId,
    base: it.from ?? 0, steps: Math.max(1, (it.target ?? 0) - (it.from ?? 0)) };
}

// Resolve each card's displayed from→target from list order: per building/tech,
// start at its base game level and let each successive card continue from the
// previous one's target.
// Chain identity: buildings and ships are per-planet (Silicate Mine — or a
// shipyard build — on planet A is a separate chain from the same one on
// planet B), so include the planet. Research is account-global — one chain
// per tech regardless of destination.
function chainId(it) {
  return it.kind + ':' + it.key + (it.kind === 'building' || it.kind === 'ship' ? ':' + (it.planet || '') : '');
}
function chain() {
  // The starting level of a chain is shared across its cards — take the lowest
  // base seen, so the order in which cards were added (or a card's stale migrated
  // base) can't shift it. Then walk the list in order.
  const baseOf = new Map();
  for (const it of items) {
    const id = chainId(it);
    baseOf.set(id, Math.min(baseOf.has(id) ? baseOf.get(id) : Infinity, it.base));
  }
  const running = new Map();
  return items.map(it => {
    const id = chainId(it);
    const from = running.has(id) ? running.get(id) : baseOf.get(id);
    const target = from + it.steps;
    running.set(id, target);
    return { it, from, target };
  });
}

function render() {
  if (!listEl) return;
  listEl.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'nx-planner-info';
    empty.textContent = 'Empty — add a building, tech, or ship from a planner.';
    listEl.appendChild(empty);
    return;
  }
  chain().forEach(({ it, from, target }, i) => {
    const isSel = selected.has(it.id);
    const row = document.createElement('div');
    row.draggable = true;
    row.dataset.i = String(i);
    row.className = 'nx-planner-queue-row';
    row.classList.toggle('nx-planner-queue-selected', isSel);
    row.title = 'Select to include in the resource total';
    row.innerHTML =
      `<span style="opacity:.5; cursor:grab;">⋮⋮</span>` +
      `<span style="font-size:15px;">${ICON[it.kind] || '•'}</span>` +
      `<div style="flex:1; min-width:0;">` +
        `<div class="nx-text" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${it.name || it.key}</div>` +
        `<div class="nx-subtle" style="font-size:.8rem;">L${from} → ${target}` +
          (it.planet ? ` · <span class="nx-dim">${it.planet}</span>` : '') + `</div>` +
      `</div>`;
    row.onclick = () => {
      if (isSel) selected.delete(it.id); else selected.add(it.id);
      render();
      renderAgg();
    };
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = '✕';
    del.title = 'Remove';
    del.className = 'nx-icon-btn';
    del.onclick = e => {
      e.stopPropagation();
      selected.delete(it.id);
      items.splice(i, 1);
      save(); render(); renderAgg();
    };
    row.appendChild(del);

    row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); row.style.opacity = '.4'; });
    row.addEventListener('dragend', () => { row.style.opacity = '1'; });
    row.addEventListener('dragover', e => { e.preventDefault(); });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = Number(row.dataset.i);
      if (Number.isNaN(from) || from === to) return;
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      save(); render(); renderAgg();
    });
    listEl.appendChild(row);
  });
}

// Sum window.__nxUpgradeNeed[kind]() across every selected item and render
// Need/On planet/Deficit + a Send button. A token guards against a stale
// fetch clobbering the display if the selection changes again before it
// resolves.
let aggToken = 0;
async function renderAgg() {
  if (!aggEl) return;
  const token = ++aggToken;
  const sel = chain().filter(({ it }) => selected.has(it.id));
  if (!sel.length) { aggEl.textContent = ''; return; }

  const planetIds = new Set(sel.map(({ it }) => it.planetId));
  if (planetIds.size > 1) {
    aggEl.innerHTML = '<div class="nx-err">Select items on one planet only.</div>';
    return;
  }
  const planetId = [...planetIds][0];
  if (planetId == null) { aggEl.textContent = ''; return; }
  aggEl.innerHTML = '<div class="nx-planner-info">Computing…</div>';

  let need = {}, pl;
  try {
    const parts = await Promise.all(sel.map(({ it, from, target }) => {
      const calc = window.__nxUpgradeNeed && window.__nxUpgradeNeed[it.kind];
      return calc ? calc(it.key, it.planetId, from, target) : {};
    }));
    if (token !== aggToken) return;
    for (const part of parts) for (const [k, v] of Object.entries(part || {})) need[k] = (need[k] || 0) + v;
    const r = await fetch(`/api/planets/${planetId}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`planet ${planetId} → ${r.status}`);
    const d = await r.json();
    pl = d.planet || d;
  } catch (e) {
    if (token !== aggToken) return;
    aggEl.innerHTML = `<div class="nx-err">Error: ${e.message}</div>`;
    return;
  }
  if (token !== aggToken) return;
  renderAggTable(need, pl, planetId);
}

function renderAggTable(need, pl, planetId) {
  aggEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'nx-planner-cost-row nx-planner-cost-head';
  head.innerHTML = '<div class="nx-resource-label">Selected</div>' +
    '<div>Need</div><div>Have</div><div>Deficit</div>';
  aggEl.appendChild(head);

  const deficit = {};
  for (const [cargo, n] of Object.entries(need)) {
    if (!n) continue;
    const have = pl[camel(cargo)] || 0;
    const short = Math.max(0, n - have);
    deficit[cargo] = short;
    const line = document.createElement('div');
    line.className = 'nx-planner-cost-row';
    line.innerHTML =
      `<div class="nx-resource-label"><img src="/images/resources/${cargo}.webp" width="16" height="16" title="${labelOf(cargo)}"></div>` +
      `<div>${fmt(n)}</div>` +
      `<div class="nx-subtle">${fmt(have)}</div>` +
      `<div class="${short > 0 ? 'nx-err' : 'nx-ok'}">${short > 0 ? fmt(short) : '—'}</div>`;
    aggEl.appendChild(line);
  }
  const totalShort = Object.values(deficit).reduce((s, v) => s + v, 0);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = 'Send via Quartermaster';
  sendBtn.disabled = totalShort <= 0;
  sendBtn.className = 'nx-btn nx-btn-primary nx-planner-queue-send';
  sendBtn.title = totalShort <= 0 ? 'Selection already covered on that planet' : 'Open the Quartermaster to ship the deficit there';
  sendBtn.onclick = () => {
    const nonZero = Object.fromEntries(Object.entries(deficit).filter(([, v]) => v > 0));
    if (window.__nxDeliverToPlanet) window.__nxDeliverToPlanet(planetId, nonZero);
  };
  aggEl.appendChild(sendBtn);
}

window.__nxQueue = {
  async add(item) {
    await load();
    // item.from = live game level, item.target = level picked in the planner.
    // Continue from the highest level already queued for this building/tech so a
    // second add is a new step: game 20, queue 21, then 22 → "20→21" and "21→22".
    const id = chainId(item);
    const top = chain().filter(r => chainId(r.it) === id)
      .reduce((m, r) => Math.max(m, r.target), item.from);
    const steps = item.target - top;
    if (steps > 0) items.push({ id: uid(), kind: item.kind, key: item.key, name: item.name,
      planet: item.planet, planetId: item.planetId, base: item.from, steps });
    save();
    render();
  },

  // Render the to-do list as a sibling panel to the right of a planner's overlay.
  async mountPanel(overlay) {
    await load();
    const panel = document.createElement('div');
    panel.className = 'nx-planner-box nx-planner-queue';
    panel.innerHTML = '<h2>To-do</h2>';
    listEl = document.createElement('div');
    listEl.className = 'nx-planner-queue-list';
    panel.appendChild(listEl);
    aggEl = document.createElement('div');
    aggEl.className = 'nx-planner-queue-summary';
    panel.appendChild(aggEl);
    overlay.appendChild(panel);
    render();
    renderAgg();
  },
};
})();
}
