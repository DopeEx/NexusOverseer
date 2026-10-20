// Injects an "Addon → Nexus Overseer" section into the game's sidebar, styled
// with the game's own classes, that opens the addon dashboard. The game is a
// SPA, so re-inject whenever the nav re-renders. dashboard.html is web-
// accessible for this origin, so a plain link to it works.

const ext = (typeof browser !== 'undefined' ? browser : chrome);
const rt = ext.runtime;
const DASH_URL = rt.getURL('dashboard.html');

// lucide-style "line chart" icon, matching the other sidebar icons.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  class="lucide lucide-line-chart sidebar-link-icon" aria-hidden="true">
  <path d="M3 3v16a2 2 0 0 0 2 2h16"></path><path d="m19 9-5 5-4-4-3 3"></path></svg>`;

// lucide-style "book-open" icon for the user guide.
const GUIDE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  class="lucide lucide-book-open sidebar-link-icon" aria-hidden="true">
  <path d="M12 7v14"></path><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path></svg>`;

const ASTEROIDS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  class="sidebar-link-icon" aria-hidden="true">
  <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999"/>
  <path d="M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024"/>
  <path d="M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069"/>
  <path d="M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z"/></svg>`;

function buildSection() {
  const section = document.createElement('div');
  section.className = 'sidebar-section';
  section.id = 'nexus-addon-section';
  section.innerHTML = `
    <div class="sidebar-section-label">Addon</div>
    <a class="sidebar-link" href="${DASH_URL}" target="_blank" rel="noopener" data-nexus-addon="1">
      ${ICON}<span class="sidebar-link-label">Nexus Overseer</span>
    </a>
    <a class="sidebar-link" href="#" data-nexus-lsbelts="1">
      ${ASTEROIDS_ICON}<span class="sidebar-link-label">Live Search Belts</span>
    </a>
    <a class="sidebar-link" href="#" data-nexus-guide="1">
      ${GUIDE_ICON}<span class="sidebar-link-label">User Guide</span>
    </a>`;
  return section;
}

// Floating, draggable, non-modal panels on the game page.
function makeDraggable(el, handle) {
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button, input')) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
    el.style.left = `${ox}px`; el.style.top = `${oy}px`; el.style.right = 'auto';
    const onMove = ev => { el.style.left = `${ox + ev.clientX - sx}px`; el.style.top = `${oy + ev.clientY - sy}px`; };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function openFieldsPanelSafe() {
  openFieldsPanel().catch(err => {
    console.warn('[NexusOverseer] Could not open live-search window:', err);
    if (fieldsPanel) { fieldsPanel.remove(); fieldsPanel = null; }
    window.alert(/context invalidated/i.test(String(err && err.message))
      ? 'The NexusOverseer extension was reloaded. Please reload this page (Ctrl+F5) and try again.'
      : `Could not open the live-search window: ${err && err.message || err}`);
  });
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-nexus-lsbelts]')) { e.preventDefault(); openFieldsPanelSafe(); }
});

function inject() {
  if (document.getElementById('nexus-addon-section')) return;   // already there
  const nav = document.querySelector('nav.sidebar-nav');
  if (!nav) return;
  nav.appendChild(buildSection());
}

inject();
// Re-inject on SPA navigation / sidebar re-render.
new MutationObserver(() => inject())
  .observe(document.documentElement, { childList: true, subtree: true });

// Run game API requests from the page origin so the browser attaches the same
// HttpOnly session cookie as the game's own client. The extension never reads or
// forwards the cookie value itself.
rt.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'GAME_FETCH') return;
  const respond = response => {
    globalThis.nexusRecordDiagnosticApi?.(msg, response);
    sendResponse(response);
  };
  fetch(msg.path, {
    method: msg.method || 'POST',
    credentials: 'include',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: msg.body != null ? JSON.stringify(msg.body) : undefined,
  }).then(async r => {
    const text = await r.text();
    const meta = {
      status: r.status,
      retryAfter: r.headers.get('Retry-After'),
      rateLimitRemaining: r.headers.get('RateLimit-Remaining'),
      rateLimitReset: r.headers.get('RateLimit-Reset'),
    };
    if (!r.ok) {
      let m = `${r.status}`;
      try { const j = JSON.parse(text); m = j.message || j.error || m; }
      catch { if (text) m = `${r.status}: ${text.slice(0, 200)}`; }
      respond({ error: m, ...meta });
    } else {
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          respond({ error: `Failed to parse API response: ${e.message}`, parseError: true, ...meta });
          return;
        }
      }
      respond({ ok: true, data, ...meta });
    }
  }).catch(e => respond({
    error: e.name === 'TimeoutError'
      ? `API ${msg.path} timed out after 20 seconds.`
      : e.message,
    networkError: true,
  }));
  return true;   // keep the channel open for the async sendResponse
});

// ── Live-search matches window ──────────────────────────────────────────────
// Opened when the user clicks an asteroid live-search notification. Floating,
// draggable, non-modal — same style as the ratio calculator.
const TYPE_COLOR = {
  ore: 'var(--res-ore)', gas: 'var(--res-hydrogen)', ice: 'var(--res-cryo)', plasma: 'var(--res-plasma)',
  quantum: 'var(--res-quantum)', dark: 'var(--res-dark)',
};
// Ship recommendation per field type: specialized ship + per-cycle extraction
// (Stats.txt). ships = ceil( remaining / (rate * cycles * richness) ); an
// Excavator in the fleet adds a whole-fleet yield bonus.
const REC_SHIP = {
  ore: ['Mining Vessel', 50], plasma: ['Mining Vessel', 25],
  gas: ['Gas Collector', 17], quantum: ['Gas Collector', 3],
  ice: ['Ice Drill', 25], dark: ['Ice Drill', 3],
};
const REC_CYCLES = 10;
const EXCAVATOR_BONUS = 1.2;
// Mining ships the recommendation manages; escort/combat ships in the editor
// are kept when the recommendation swaps in the mining ships.
const MINING_SHIPS = new Set([...Object.values(REC_SHIP).map(s => s[0]), 'Excavator']);
async function fieldsRequest(message) {
  let response;
  try {
    response = await ext.runtime.sendMessage(message);
  } catch (error) {
    throw new Error(`${message.type}: ${error.message}`, { cause: error });
  }
  if (!response || response.error) {
    throw new Error(`${message.type}: ${response?.error || 'No response from extension background.'}`);
  }
  return response;
}

// Returns { count, name } for a match, or null when it can't be computed.
function recommend(m, excavator) {
  const spec = REC_SHIP[m.type];
  if (!spec || !m.remaining || !m.mult) return null;
  const [name, rate] = spec;
  const cap = rate * (excavator ? EXCAVATOR_BONUS : 1);
  return { count: Math.ceil(m.remaining / (cap * REC_CYCLES * m.mult)), name };
}
// Confirmation dialog with the fleet composition — mirrors common.js
// confirmDialog so a send from this window looks like one from the dashboard.
function lsConfirm(message, ships, defs, untilFullState = null, escortRetreatThresholdState = null) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'nx-theme nx-ls-confirm';
    const box = document.createElement('div');
    box.className = 'nx-ls-confirm-box';
    const msg = document.createElement('div');
    // Per line so a ⚠ warning (not enough ships to fill the template) shows red.
    for (const line of String(message).split('\n')) {
      const l = document.createElement('div');
      l.textContent = line;
      if (line.trim().startsWith('⚠')) l.className = 'nx-err';
      msg.appendChild(l);
    }
    box.append(msg);
    if (ships && ships.length) {
      const row = document.createElement('div');
      row.className = 'nx-ls-confirm-ships';
      for (const s of ships) {
        const def = defs[s.shipDefId] || {};
        const chip = document.createElement('span');
        chip.className = 'nx-ls-confirm-ship';
        if (def.imageUrl) {
          const img = document.createElement('img');
          img.src = def.imageUrl;
          chip.append(img);
        }
        chip.append(document.createTextNode(`${s.quantity}× ${def.name || '#' + s.shipDefId}`));
        row.append(chip);
      }
      box.append(row);
    }
    if (untilFullState) {
      const untilFullLabel = document.createElement('label');
      untilFullLabel.title = 'Keep mining past the usual 10 cycles until the mining hold is full or the field is depleted';
      untilFullLabel.className = 'nx-ls-check nx-ls-confirm-option';
      const untilFullCheckbox = document.createElement('input');
      untilFullCheckbox.type = 'checkbox';
      untilFullCheckbox.checked = !!untilFullState.untilFull;
      untilFullCheckbox.addEventListener('change', () => {
        untilFullState.untilFull = untilFullCheckbox.checked;
      });
      untilFullLabel.append(untilFullCheckbox, document.createTextNode('Mine until full'));
      box.append(untilFullLabel);
    }
    if (escortRetreatThresholdState) {
      const retreatLabel = document.createElement('label');
      retreatLabel.title = 'If pirates damage the escort past this threshold, the fleet returns early and mining stops. Pirates may still steal cargo.';
      retreatLabel.className = 'nx-ls-check nx-ls-confirm-option';
      retreatLabel.append(document.createTextNode('Withdraw escort by damage threshold'));
      const retreatSelect = document.createElement('select');
      retreatSelect.className = 'nx-input';
      for (const [value, label] of [[null, 'Off'], [30, '30%'], [50, '50%'], [70, '70%']]) {
        const option = document.createElement('option');
        option.value = value == null ? '' : String(value);
        option.textContent = label;
        option.selected = value === escortRetreatThresholdState.threshold;
        retreatSelect.append(option);
      }
      retreatSelect.addEventListener('change', () => {
        const value = Number(retreatSelect.value);
        escortRetreatThresholdState.threshold = [30, 50, 70].includes(value) ? value : null;
      });
      retreatLabel.append(retreatSelect);
      box.append(retreatLabel);
    }
    const btns = document.createElement('div');
    btns.className = 'nx-ls-confirm-actions';
    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.type = 'button';
      b.className = primary ? 'nx-btn nx-btn-primary' : 'nx-btn nx-btn-ghost';
      return b;
    };
    const cancel = mk('Cancel', false), ok = mk('Confirm', true);
    const done = v => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done('ok');
    ov.onclick = e => { if (e.target === ov) done(false); };
    btns.append(cancel);
    btns.append(ok);
    box.append(btns);
    ov.append(box);
    document.body.append(ov);
    ok.focus();
  });
}

let fieldsPanel = null;
async function openFieldsPanel() {
  if (fieldsPanel) { fieldsPanel.remove(); fieldsPanel = null; }
  const { live_search_last_matches, live_search_last_at, live_search } =
    await ext.storage.local.get(['live_search_last_matches', 'live_search_last_at', 'live_search']);
  let matches = live_search_last_matches || [];
  const running = !!(live_search && live_search.enabled);

  const panel = document.createElement('div');
  fieldsPanel = panel;
  panel.className = 'nx-theme nx-ls-panel';

  const header = document.createElement('div');
  header.className = 'nx-ls-header';
  const titleWrap = document.createElement('div');
  const heading = document.createElement('h1');
  heading.innerHTML = 'Nexus <span>Overseer</span>: Live Search Belts';
  const title = document.createElement('div');
  title.textContent = `Asteroid matches (${matches.length})`;
  title.className = 'nx-sub-label';
  const sub = document.createElement('div');
  sub.className = 'nx-ls-note';
  sub.textContent = live_search_last_at ? `as of ${new Date(live_search_last_at).toLocaleTimeString()}` : 'no scan yet';
  titleWrap.append(heading, title, sub);
  const content = document.createElement('div');
  content.className = 'nx-ls-content';
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'nx-overlay-close';
  collapse.textContent = '\u2212';
  collapse.title = 'Collapse';
  collapse.setAttribute('aria-label', 'Collapse Live Search Belts');
  collapse.setAttribute('aria-expanded', 'true');
  collapse.onclick = () => {
    const collapsed = panel.classList.toggle('nx-ls-collapsed');
    content.hidden = collapsed;
    collapse.textContent = collapsed ? '+' : '\u2212';
    collapse.title = collapsed ? 'Expand' : 'Collapse';
    collapse.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} Live Search Belts`);
    collapse.setAttribute('aria-expanded', String(!collapsed));
  };
  const close = document.createElement('button');
  close.textContent = '✕';
  close.type = 'button';
  close.title = 'Close';
  close.className = 'nx-overlay-close';
  close.onclick = () => { panel.remove(); fieldsPanel = null; };
  const windowActions = document.createElement('div');
  windowActions.className = 'nx-ls-window-actions';
  windowActions.append(collapse, close);
  header.append(titleWrap, windowActions);

  // Sending context: source planet (from live search) + a fleet template chosen
  // in the picker below, capped to what the planet actually has. Availability is
  // fetched once; switching template just re-caps and re-renders.
  const planetId = live_search && live_search.planetId;
  const { fleet_templates, template_selections } =
    await ext.storage.local.get(['fleet_templates', 'template_selections']);
  const templates = (fleet_templates || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));   // alphabetical picker
  let avail = {};
  if (planetId) {
    const av = await fieldsRequest({ type: 'GET_PLANET_SHIPS', planetId });
    avail = av.available || {};
  }
  // Source planet name + ship catalog (names/icons) for the confirmation dialog.
  const planets = (await fieldsRequest({ type: 'GET_PLANETS' })).planets || [];
  const planetName = (planets.find(p => p.id === planetId) || {}).name || planetId;
  const shipDefs = {};
  const nameToId = {};   // ship name → shipDefId, for the recommendation
  for (const s of ((await fieldsRequest({ type: 'GET_SHIP_DEFS' })).ships || [])) {
    shipDefs[s.shipDefId] = s;
    if (s.name) nameToId[s.name] = s.shipDefId;
  }
  let tpl = templates.find(t => String(t.id) === String((template_selections || {})['af-template-select'])) || templates[0] || null;
  let excavator = localStorage.getItem('nx-ls-excavator') === '1';   // +20% capacity toggle
  const savedUntilFull = localStorage.getItem('nx-ls-until-full');
  let untilFull = savedUntilFull == null || savedUntilFull === '1';
  const savedRetreatThreshold = localStorage.getItem('nx-ls-escort-retreat-threshold');
  let escortRetreatThreshold = savedRetreatThreshold == null
    ? 50
    : [30, 50, 70].includes(Number(savedRetreatThreshold)) ? Number(savedRetreatThreshold) : null;

  // "Already mining" row highlight: fields we already control, or with an
  // active mine mission en route. Mirrors the Asteroids tab's criteria.
  const me = await fieldsRequest({ type: 'GET_AUTH_ME' });
  const myUsername = (me && !me.error && me.user) ? me.user.username : null;
  let miningFieldIds = new Set();
  async function refreshMiningFieldIds() {
    const mi = await fieldsRequest({ type: 'GET_MISSIONS' });
    miningFieldIds = new Set(
      (mi.missions || []).filter(m => m.missionType === 'mine' && m.targetFieldId != null).map(m => m.targetFieldId));
  }
  await refreshMiningFieldIds();
  const miningRefreshTimer = setInterval(() => {
    if (!panel.isConnected) { clearInterval(miningRefreshTimer); return; }
    refreshMiningFieldIds().then(renderRows).catch(error => {
      console.warn('[NexusOverseer] Live-search mission refresh failed:', error);
      sub.textContent = `Mission refresh failed: ${error.message}`;
      clearInterval(miningRefreshTimer);
    });
  }, 10000);

  // Recommended fleet for a match, capped to planet availability: [{shipDefId, quantity}].
  function recShipsFor(m) {
    const r = recommend(m, excavator);
    const id = r && nameToId[r.name];
    if (id == null) return [];
    const q = Math.min(r.count, avail[id] || 0);
    return q > 0 ? [{ shipDefId: id, quantity: q }] : [];
  }

  // Editor's escort/combat ships (non-mining) merged with the recommended mining
  // ships — keeps escorts, swaps mining ships for the calc. Capped to availability.
  function fleetWithRec(recShips) {
    const out = new Map();
    for (const [id, q] of shipsState) {
      const def = shipDefs[id];
      if (def && MINING_SHIPS.has(def.name)) continue;   // drop miners; rec supplies them
      out.set(id, q);
    }
    for (const s of recShips) out.set(s.shipDefId, s.quantity);
    return [...out.entries()]
      .map(([id, q]) => ({ shipDefId: id, quantity: Math.min(q, avail[id] || 0) }))
      .filter(s => s.quantity > 0);
  }

  // Editable fleet composition: one ship type per line. Seeded from the chosen
  // template (capped to the planet), then the user can tweak quantities.
  const shipsState = new Map();   // shipDefId → wanted qty
  function seedFromTemplate(t) {
    shipsState.clear();
    for (const [id, q] of Object.entries((t && t.ships) || {})) {
      const cap = Math.min(q, avail[Number(id)] || 0);
      if (cap > 0) shipsState.set(Number(id), cap);
    }
  }
  function effectiveShips() {
    return [...shipsState.entries()]
      .map(([id, q]) => ({ shipDefId: id, quantity: Math.min(q, avail[id] || 0) }))
      .filter(s => s.quantity > 0);
  }
  seedFromTemplate(tpl);

  // Template picker (seeds the editor below) + collapse toggle for the editor.
  const pickWrap = document.createElement('div');
  pickWrap.className = 'nx-ls-picker';
  // Clickable toggle (caret + label) — clearly affords showing/hiding the editor.
  const toggle = document.createElement('button');
  toggle.title = 'Show/hide fleet editor';
  toggle.className = 'nx-btn nx-btn-secondary';
  toggle.type = 'button';
  const caret = document.createElement('span');
  caret.textContent = '▾'; caret.style.cssText = 'transition:transform .15s;transform:rotate(-90deg)';
  const tLbl = document.createElement('span');
  tLbl.textContent = 'Edit fleet';
  toggle.append(caret, tLbl);
  toggle.onclick = () => {
    const hidden = editorWrap.style.display === 'none';
    editorWrap.style.display = hidden ? 'flex' : 'none';
    caret.style.transform = hidden ? '' : 'rotate(-90deg)';
  };
  const pickLbl = document.createElement('span');
  pickLbl.textContent = 'Fleet:'; pickLbl.className = 'nx-subtle';
  const picker = document.createElement('select');
  picker.className = 'nx-input';
  if (!templates.length) {
    const o = document.createElement('option'); o.textContent = '— none (create in Asteroids tab) —'; picker.appendChild(o); picker.disabled = true;
  } else {
    for (const t of templates) {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.name;
      if (tpl && String(t.id) === String(tpl.id)) o.selected = true;
      picker.appendChild(o);
    }
  }
  // Excavator +20% toggle — boosts the recommended-ship calculation.
  const excLbl = document.createElement('label');
  excLbl.title = 'Include an Excavator: +20% fleet extraction capacity in the recommendation';
  excLbl.className = 'nx-ls-check';
  const excChk = document.createElement('input');
  excChk.type = 'checkbox';
  excChk.checked = excavator;
  excChk.addEventListener('change', () => {
    excavator = excChk.checked;
    localStorage.setItem('nx-ls-excavator', excavator ? '1' : '0');
    renderRows();
  });
  excLbl.append(excChk, document.createTextNode('Excavator +20%'));
  pickWrap.append(pickLbl, picker, toggle, excLbl);

  // Per-ship-type editor — one line per ship available on the planet (or in the
  // template). Editing a quantity updates the fleet used for fuel + sending.
  const editorWrap = document.createElement('div');
  editorWrap.className = 'nx-ls-editor';
  editorWrap.style.display = 'none';
  function buildEditor() {
    editorWrap.textContent = '';
    const ids = new Set([
      ...Object.keys((tpl && tpl.ships) || {}).map(Number),
      ...Object.keys(avail).map(Number).filter(id => (avail[id] || 0) > 0),
    ]);
    if (!ids.size) { editorWrap.textContent = 'No ships available on the source planet.'; return; }
    for (const id of ids) {
      const def = shipDefs[id] || {};
      const max = avail[id] || 0;
      // Fixed grid so the icon / name / input / "/max" columns line up across rows.
      const line = document.createElement('div');
      line.className = 'nx-ls-editor-row';
      const iconCell = document.createElement('span');
      if (def.imageUrl) {
        const img = document.createElement('img');
        img.src = def.imageUrl;
        iconCell.append(img);
      }
      const name = document.createElement('span');
      name.textContent = def.name || `#${id}`; name.className = 'nx-ls-editor-name';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.max = String(max); inp.value = String(shipsState.get(id) || 0);
      inp.className = 'nx-no-spin nx-input';
      inp.addEventListener('change', () => {
        let v = parseInt(inp.value, 10); if (isNaN(v) || v < 0) v = 0;
        if (v > max) v = max;
        inp.value = String(v);
        if (v > 0) shipsState.set(id, v); else shipsState.delete(id);
        renderRows();
      });
      const avLbl = document.createElement('span');
      avLbl.textContent = `/ ${max}`; avLbl.className = 'nx-subtle';
      line.append(iconCell, name, inp, avLbl);
      editorWrap.append(line);
    }
  }
  buildEditor();

  const body = document.createElement('div');
  body.className = 'nx-ls-body';

  // Row picked via the radio column, for the "Optimise Mining Fleet" button.
  let selectedMatchId = null;

  function renderRows() {
    body.textContent = '';
    if (!matches.length) { body.textContent = 'No current matches.'; return; }

    const table = document.createElement('table');
    table.className = 'nx-ls-table';
    table.innerHTML = `<thead><tr>
      <th></th><th></th><th>Fuel (System)</th>
      <th>Type</th><th class="nx-ls-numeric">Mult</th>
      <th class="nx-ls-numeric">Left %</th>
      <th>Recommended</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const m of matches) {
      const tr = document.createElement('tr');
      if ((myUsername && m.controllerName === myUsername) || miningFieldIds.has(m.id)) {
        tr.className = 'nx-ls-mining';   // already mining / claimed by us
      }

      const selTd = document.createElement('td');
      const selInp = document.createElement('input');
      selInp.type = 'radio'; selInp.name = 'nx-ls-row-select';
      selInp.checked = selectedMatchId === m.id;
      selInp.addEventListener('change', () => { selectedMatchId = m.id; paintOptBtn(); });
      selTd.appendChild(selInp);

      // Fleet for this field: the user's chosen template by default (editable
      // in the shared editor); fall back to the calculated recommendation only
      // when the template has nothing sendable (e.g. none selected).
      const rec = recommend(m, excavator);
      const recShips = recShipsFor(m);
      const tplShips = effectiveShips();
      const ships = tplShips.length ? tplShips : fleetWithRec(recShips);
      const canMine = !!(planetId && ships.length);
      const mineTip = !planetId ? 'Live search has no source planet set.'
        : !ships.length ? 'No recommendation and no ships set in the editor.'
        : 'Send the recommended fleet to mine this field.';

      const mineTd = document.createElement('td');
      const mineBtn = document.createElement('button');
      mineBtn.textContent = '⛏';
      mineBtn.title = mineTip;
      mineBtn.disabled = !canMine;
      mineBtn.type = 'button';
      mineBtn.className = 'nx-btn nx-btn-secondary nx-btn-sm';
      mineBtn.onclick = async () => {
        if (!canMine) return;
        const short = ships.some(s => (avail[s.shipDefId] || 0) < s.quantity);
        const untilFullState = { untilFull };
        const escortRetreatThresholdState = { threshold: escortRetreatThreshold };
        const r = await lsConfirm(
          `Send fleet?\nTo: ${m.name} (${m.system})\nFrom: ${planetName}` +
          (short ? '\n\n⚠ Some ships are short on this planet; sending what is available.' : ''),
          ships, shipDefs, untilFullState, escortRetreatThresholdState);
        if (!r) return;
        untilFull = untilFullState.untilFull;
        localStorage.setItem('nx-ls-until-full', untilFull ? '1' : '0');
        escortRetreatThreshold = escortRetreatThresholdState.threshold;
        if (escortRetreatThreshold == null) {
          localStorage.removeItem('nx-ls-escort-retreat-threshold');
        } else {
          localStorage.setItem('nx-ls-escort-retreat-threshold', String(escortRetreatThreshold));
        }
        const sendShips = ships;
        // Reflect the sent fleet in the shared editor (escorts kept, miners swapped).
        shipsState.clear();
        for (const s of sendShips) shipsState.set(s.shipDefId, s.quantity);
        buildEditor();
        mineBtn.disabled = true; mineBtn.textContent = '…';
        const res = await ext.runtime.sendMessage({
          type: 'SEND_MINE', sourcePlanetId: planetId, targetFieldId: m.id, ships: sendShips, miningDuration: 600,
          mineUntilFull: untilFull,
          escortRetreatThreshold,
        });
        if (res && res.error) { mineBtn.textContent = '⛏'; mineBtn.disabled = false; window.alert(`Send failed: ${res.error}`); }
        else {
          mineBtn.textContent = '✓'; mineBtn.className = 'nx-btn nx-btn-secondary nx-btn-sm';
          miningFieldIds.add(m.id);   // optimistic — GET_MISSIONS can lag right after the send
          renderRows();
          refreshMiningFieldIds().then(renderRows);
        }
      };
      mineTd.appendChild(mineBtn);

      const fuelTd = document.createElement('td');
      fuelTd.textContent = `${ships.length ? '…' : '—'} (${m.system})`;
      if (ships.length && m.systemId != null) {
        ext.runtime.sendMessage({ type: 'GET_FUEL_ESTIMATE', body: { sourcePlanetId: planetId, targetSystemId: m.systemId, ships } })
          .then(est => { fuelTd.textContent = `${est && est.fuelCost != null ? est.fuelCost : '?'} (${m.system})`; })
          .catch(() => { fuelTd.textContent = `? (${m.system})`; });
      }

      const cell = (txt, extra = '') => { const td = document.createElement('td'); td.style.cssText = extra; td.textContent = txt; return td; };
      tr.append(selTd, mineTd, fuelTd,
        cell(m.type, `color:${TYPE_COLOR[m.type] || 'var(--text)'}`),
        cell(m.mult != null ? `×${m.mult}` : '—', 'text-align:right'),
        cell(m.leftPct != null ? `${m.leftPct}%` : '—', 'text-align:right'),
        cell(rec ? `${rec.count}× ${rec.name}` : '—'));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    body.appendChild(table);
  }

  picker.addEventListener('change', () => {
    tpl = templates.find(t => String(t.id) === picker.value) || null;
    ext.storage.local.get('template_selections').then(({ template_selections: current }) => ext.storage.local.set({
      template_selections: { ...(current || {}), 'af-template-select': picker.value },
    }));
    seedFromTemplate(tpl);
    buildEditor();
    renderRows();
  });
  renderRows();

  // Live-refresh title/timestamp/rows when a background scan writes new results,
  // so the window doesn't sit on a stale "as of" time. Self-removes once closed.
  function onScan(changes, area) {
    if (area !== 'local' || !('live_search_last_at' in changes || 'live_search_last_matches' in changes)) return;
    if (!panel.isConnected) { ext.storage.onChanged.removeListener(onScan); return; }
    ext.storage.local.get(['live_search_last_matches', 'live_search_last_at']).then(d => {
      matches = d.live_search_last_matches || [];
      title.textContent = `Asteroid matches (${matches.length})`;
      sub.textContent = d.live_search_last_at ? `as of ${new Date(d.live_search_last_at).toLocaleTimeString()}` : 'no scan yet';
      renderRows();
    });
  }
  ext.storage.onChanged.addListener(onScan);

  const footer = document.createElement('div');
  footer.className = 'nx-ls-footer';
  const note = document.createElement('span');
  note.className = 'nx-ls-note';
  // Start/Stop toggle. Starting re-uses the saved config (planet + filters).
  const toggleBtn = document.createElement('button');
  let curRunning = running;
  const paintToggle = () => {
    toggleBtn.textContent = curRunning ? 'Stop Live Search' : 'Start Live Search';
    note.textContent = curRunning ? 'Live search running (every 5 min).' : 'Live search stopped.';
    toggleBtn.className = curRunning ? 'nx-btn nx-ls-stop' : 'nx-btn nx-btn-primary';
  };
  paintToggle();
  toggleBtn.onclick = async () => {
    if (curRunning) {
      await ext.runtime.sendMessage({ type: 'STOP_LIVE_SEARCH' });
      curRunning = false;
    } else {
      if (!live_search || live_search.planetId == null) {
        window.alert('Configure live search in the Tracker’s Asteroids tab first (planet + filters).');
        return;
      }
      await ext.runtime.sendMessage({ type: 'SET_LIVE_SEARCH', config: { ...live_search, enabled: true } });
      curRunning = true;
    }
    paintToggle();
  };

  // Sets the editor to the recommended ship count for the row picked via the
  // radio column (escorts kept, miner swapped in — same merge as the pickaxe).
  const optBtn = document.createElement('button');
  optBtn.textContent = 'Optimise Mining Fleet';
  optBtn.title = 'Set the editor to the recommended ship count for the selected row';
  const paintOptBtn = () => {
    const has = selectedMatchId != null;
    optBtn.disabled = !has;
    optBtn.className = 'nx-btn nx-btn-secondary';
  };
  paintOptBtn();
  optBtn.onclick = () => {
    const m = matches.find(x => x.id === selectedMatchId);
    if (!m) return;
    const recShips = recShipsFor(m).slice();
    if (excavator) {
      const excId = nameToId['Excavator'];
      if (excId != null && (avail[excId] || 0) > 0) recShips.push({ shipDefId: excId, quantity: 1 });
    }
    if (!recShips.length) { window.alert('No mining recommendation for this field.'); return; }
    const merged = fleetWithRec(recShips);   // computed first: reads escorts off shipsState before it's cleared
    shipsState.clear();
    for (const s of merged) shipsState.set(s.shipDefId, s.quantity);
    buildEditor();
    renderRows();
  };

  const btnGroup = document.createElement('div');
  btnGroup.className = 'nx-ls-actions';
  btnGroup.append(optBtn, toggleBtn);
  footer.append(note, btnGroup);

  content.append(pickWrap, editorWrap, body, footer);
  panel.append(header, content);
  document.body.append(panel);
  makeDraggable(panel, header);
}

ext.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'SHOW_LS_RESULTS') openFieldsPanelSafe();
});

// Game tab opened from a notification with no tab previously open: show the panel.
ext.storage.local.get('live_search_open_panel').then(({ live_search_open_panel }) => {
  if (live_search_open_panel) { ext.storage.local.set({ live_search_open_panel: false }); openFieldsPanelSafe(); }
});
