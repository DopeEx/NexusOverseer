// Shared state and helpers used by every dashboard tab.
// Loaded first — all other dashboard scripts depend on it.

import { getSetting } from './settings.js';
import { missionProgress } from './mission-state.js';
export { missionProgress } from './mission-state.js';
export { usesFleetSlot, usedFleetSlots } from './mission-state.js';

export let store = {};   // full storage snapshot
export function setStore(s) { store = s; }   // setter: other modules can't reassign an import

export let activeTab = 'dashboard';
export function setActiveTab(t) { activeTab = t; }

// Message class by wording, so every status line is colored consistently:
// failures are errors (red), unmet preconditions are warnings (yellow).
const ERROR_TEXT = /\bfailed\b|^(⚠\s*)?(error|failed)\b|^could not\b|^unable to\b/i;
const WARNING_TEXT = /^cannot\b|^waiting for ships\b|^select .+ first\b|^no (suitable|source|available)\b/i;

// Shared inline styles for the dialogs built in this file.
const DIALOG_BOX_CSS = 'background:var(--bg-panel);color:var(--text);border:1px solid var(--border-strong);border-radius:8px;padding:20px;font:14px/1.5 system-ui,sans-serif;';
function dialogBtnCss(primary, bg, border) {
  const tone = primary ? `background:${bg};color:#fff;border-color:${border}` : 'background:var(--bg-hover);color:var(--text)';
  return `padding:7px 16px;border-radius:6px;border:1px solid var(--border-strong);cursor:pointer;${tone}`;
}

function classifyStatus(text, variant) {
  const s = String(text ?? '');
  if (variant === 'warning' || !variant) {
    if (ERROR_TEXT.test(s)) return 'error';
  }
  if (!variant && WARNING_TEXT.test(s)) return 'warning';
  return variant;
}

export function setStatusText(el, text, variant) {
  if (!el) return;
  el.style.color = '';
  el.textContent = '';
  variant = classifyStatus(text, variant);
  if (!variant) {
    el.textContent = text;
    return;
  }
  const span = document.createElement('span');
  span.className = ['status-message', variant].filter(Boolean).join(' ');
  span.textContent = text;
  el.appendChild(span);
}

export function appendStatusText(el, text, variant) {
  if (!el) return null;
  el.style.color = '';
  variant = classifyStatus(text, variant);
  const span = document.createElement('span');
  span.className = ['status-message', variant].filter(Boolean).join(' ');
  span.textContent = text;
  el.appendChild(span);
  return span;
}

export const setStatusMessage = setStatusText;
export const appendStatusMessage = appendStatusText;

export const PER_PAGE = 20;

// shipDefId → def ({ name, imageUrl, … }), fetched once and cached.
let _shipDefs = null;
async function shipDefs() {
  if (!_shipDefs) {
    const res = await browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' });
    _shipDefs = {};
    for (const s of (res.ships || [])) _shipDefs[s.shipDefId] = s;
  }
  return _shipDefs;
}
export async function shipName(id) {
  return (await shipDefs())[id]?.name || `#${id}`;
}

// In-page replacement for window.confirm(). Native confirm() is silently
// suppressed once a user ticks Firefox's "prevent additional dialogs" box,
// which permanently blocks fleet/research launches. This never triggers that.
// Optional `ships` = [{ shipDefId, quantity }] renders an image+name chip row.
export async function confirmDialog(message, ships) {
  const defs = ships?.length ? await shipDefs() : null;
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = DIALOG_BOX_CSS + 'max-width:420px;white-space:pre-line';
    const msg = document.createElement('div');
    // Render per line so a ⚠ warning (e.g. not enough ships to fill the template)
    // stands out in red.
    for (const line of String(message).split('\n')) {
      const l = document.createElement('div');
      l.textContent = line;
      if (line.trim().startsWith('⚠')) l.style.color = '#ff6b7a';
      msg.appendChild(l);
    }
    const btns = document.createElement('div');
    btns.style.cssText = 'margin-top:18px;display:flex;gap:10px;justify-content:flex-end;white-space:normal';
    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = dialogBtnCss(primary, 'var(--btn-primary)', 'var(--btn-primary)');
      return b;
    };
    const cancel = mk('Cancel', false);
    const ok = mk('Confirm', true);
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
    box.append(msg);
    if (defs) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:10px;display:flex;flex-wrap:wrap;gap:12px;white-space:normal';
      for (const s of ships) {
        const def = defs[s.shipDefId] || {};
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
        if (def.imageUrl) {
          const img = document.createElement('img');
          img.src = def.imageUrl;
          img.style.cssText = 'width:24px;height:24px;object-fit:contain';
          chip.append(img);
        }
        chip.append(document.createTextNode(`${s.quantity}× ${def.name || '#' + s.shipDefId}`));
        row.append(chip);
      }
      box.append(row);
    }
    btns.append(cancel, ok);
    box.append(btns);
    ov.append(box);
    document.body.append(ov);
    ok.focus();
  });
}

// Editable fleet dialog — the launch-time fleet editor (mirrors the live-search
// panel's editor). Rows = union of seeded ships and ships available on the
// source planet; seeded quantities are capped to availability. Optional
// requirements keep recommended/template groups from being silently reduced.
// {shipDefId → wanted qty}, `avail` is {shipDefId → count on planet}. Resolves
// to [{shipDefId, quantity}] on confirm (send once), or null on cancel.
export async function editFleetDialog({
  title, subtitle = '', avail = {}, seed = {}, recShips = [], miningShipIds = null,
  excavatorShipDefId = null, excavatorBonus = 1.2, escortTemplates = [], autoEscortTemplate = null, untilFullState = null,
  escortRetreatThresholdState = null, refreshAvailability = null, planner = null,
}) {
  const defs = await shipDefs();
  const ids = [...new Set([
    ...Object.keys(seed).map(Number),
    ...Object.keys(avail).map(Number).filter(id => (avail[id] || 0) > 0),
    ...recShips.map(ship => ship.shipDefId),
    ...(miningShipIds || []),
    ...(excavatorShipDefId != null ? [excavatorShipDefId] : []),
    ...escortTemplates.flatMap(template => Object.keys(template.ships || {}).map(Number)),
  ])];
  const state = new Map();
  for (const id of ids) {
    const q = Math.min(seed[id] || 0, avail[id] || 0);
    if (q > 0) state.set(id, q);
  }
  const effective = () => [...state.entries()]
    .map(([id, q]) => ({ shipDefId: id, quantity: q }))
    .filter(s => s.quantity > 0);
  const requiredShips = new Map();

  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = DIALOG_BOX_CSS + 'max-width:420px;width:90%';
    const h = document.createElement('div');
    h.textContent = title || 'Edit fleet';
    h.style.cssText = 'font-weight:600;margin-bottom:2px';
    box.append(h);
    if (subtitle) {
      const sub = document.createElement('div');
      sub.textContent = subtitle;
      sub.style.cssText = 'color:var(--text-muted);font-size:0.85rem;margin-bottom:8px;white-space:pre-line';
      box.append(sub);
    }

    const rows = document.createElement('div');
    rows.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;margin-top:8px';
    if (!ids.length) {
      rows.textContent = 'No ships available on the source planet.';
      rows.style.color = '#c0cce0';
    }
    const ok = document.createElement('button');   // declared early for refresh()
    const validation = document.createElement('div');
    validation.setAttribute('role', 'alert');
    validation.style.cssText = 'margin-top:10px;color:var(--error);font-size:0.82rem;white-space:pre-line';
    let confirming = false;
    let availabilityError = '';
    let escortButtonRow = null;
    let escortLabel = null;
    const excavatorAvailable = excavatorShipDefId != null && (avail[excavatorShipDefId] || 0) > 0;
    let excavatorEnabled = excavatorAvailable && localStorage.getItem('nx-af-excavator') === '1';

    const templateCoverage = (template) => {
      const entries = Object.entries(template.ships || {});
      if (!entries.length) return 0;
      if (!template.escortPerMiner) {
        return entries.every(([id, quantity]) =>
          (state.get(Number(id)) || 0) >= Math.ceil(quantity)) ? Infinity : 0;
      }
      return Math.min(...entries.map(([id, ratio]) =>
        ratio > 0 ? Math.floor((state.get(Number(id)) || 0) / ratio) : Infinity));
    };

    const applyEscortTemplate = (template, exact = false) => {
      const minerCount = miningShipIds
        ? [...miningShipIds].reduce((total, id) => total + (state.get(id) || 0), 0)
        : 0;
      for (const [idString, quantity] of Object.entries(template.ships || {})) {
        const id = Number(idString);
        const required = template.escortPerMiner
          ? Math.ceil(quantity * minerCount)
          : Math.ceil(quantity);
        if (required > 0) requiredShips.set(id, { quantity: required, label: `${template.name} escort` });
        else requiredShips.delete(id);
        const nextQuantity = Math.min(
          exact ? required : Math.max(state.get(id) || 0, required),
          avail[id] || 0,
        );
        const input = inputs.get(id);
        if (nextQuantity > 0) state.set(id, nextQuantity);
        else state.delete(id);
        if (input) input.value = String(nextQuantity);
      }
    };

    const rebuildEscortButtons = () => {
      if (!escortButtonRow) return;
      escortButtonRow.textContent = '';
      const minerCount = miningShipIds
        ? [...miningShipIds].reduce((total, id) => total + (state.get(id) || 0), 0)
        : 0;
      const hasPerMiner = escortTemplates.some(template => template.escortPerMiner);
      escortLabel.textContent = hasPerMiner
        ? `Escort for this zone (${minerCount} miner${minerCount === 1 ? '' : 's'}):`
        : 'Escort for this zone:';

      const coverage = escortTemplates.reduce((total, template) =>
        total + Math.min(minerCount, templateCoverage(template)), 0);
      const allCovered = minerCount === 0 || coverage >= minerCount;
      ok.style.borderColor = allCovered ? 'var(--btn-ok-border)' : 'var(--btn-danger-border)';
      ok.style.background = allCovered ? 'var(--btn-ok)' : 'var(--btn-danger)';

      for (const template of escortTemplates) {
        const entries = Object.entries(template.ships || {});
        const otherCoverage = escortTemplates
          .filter(other => other !== template)
          .reduce((total, other) => total + Math.min(minerCount, templateCoverage(other)), 0);
        const remainingMiners = Math.max(0, minerCount - Math.min(minerCount, otherCoverage));
        const required = (quantity) => template.escortPerMiner
          ? Math.ceil(quantity * remainingMiners)
          : Math.ceil(quantity);
        const canFill = entries.length > 0 && entries.every(([id, quantity]) =>
          (avail[Number(id)] || 0) >= required(quantity));
        const color = canFill ? '#7ed957' : '#ff6b7a';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = template.name;
        button.style.cssText = `padding:4px 12px;border-radius:6px;border:1px solid ${color};background:transparent;color:${color};cursor:pointer;font-size:0.82rem;white-space:nowrap;`;
        button.title = canFill
          ? `Apply "${template.name}"`
          : `Cannot fully fill "${template.name}" — not enough ships on planet`;
        button.onclick = () => {
          applyEscortTemplate(template);
          refresh();
        };
        escortButtonRow.append(button);
      }
    };

    const refresh = () => {
      const issues = validateFleet();
      ok.disabled = confirming || !effective().length || issues.length > 0;
      ok.style.opacity = ok.disabled ? '0.5' : '1';
      validation.textContent = issues.join('\n');
      rebuildEscortButtons();
    };
    const validateFleet = () => {
      const issues = availabilityError ? [availabilityError] : [];
      for (const [id, requirement] of requiredShips) {
        const count = avail[id] || 0;
        if (requirement.quantity > count) {
          const name = defs[id]?.name || `#${id}`;
          issues.push(`${requirement.label}: ${name} needs ${requirement.quantity}, only ${count} available.`);
        } else if ((state.get(id) || 0) < requirement.quantity) {
          const name = defs[id]?.name || `#${id}`;
          issues.push(`${requirement.label}: increase ${name} to ${requirement.quantity}.`);
        }
      }
      for (const [id, quantity] of state) {
        const count = avail[id] || 0;
        if (quantity > count && (!requiredShips.has(id) || requiredShips.get(id).quantity <= count)) {
          const name = defs[id]?.name || `#${id}`;
          issues.push(`${name}: ${quantity} selected, only ${count} available.`);
        }
      }
      return issues;
    };
    const optimiseMiningFleet = () => {
      for (const id of miningShipIds || []) {
        state.delete(id);
        const input = inputs.get(id);
        if (input) input.value = '0';
      }
      const recommendedShips = excavatorEnabled
        ? recShips.map(ship => ({ ...ship, quantity: Math.ceil(ship.quantity / excavatorBonus) }))
        : recShips;
      if (excavatorEnabled && excavatorAvailable) {
        recommendedShips.push({ shipDefId: excavatorShipDefId, quantity: 1 });
      }
      for (const id of miningShipIds || []) requiredShips.delete(id);
      for (const ship of recommendedShips) {
        requiredShips.set(ship.shipDefId, { quantity: ship.quantity, label: 'Mining recommendation' });
        const quantity = Math.min(ship.quantity, avail[ship.shipDefId] || 0);
        const input = inputs.get(ship.shipDefId);
        if (quantity > 0) {
          state.set(ship.shipDefId, quantity);
          if (input) input.value = String(quantity);
        }
      }
      if (autoEscortTemplate && localStorage.getItem('nx-af-auto-escort') === '1') {
        applyEscortTemplate(autoEscortTemplate, true);
      }
      refresh();
    };
    const inputs = new Map();   // shipDefId → its qty <input>, so "Optimise" can update rows in place
    for (const id of ids) {
      const def = defs[id] || {};
      const max = avail[id] || 0;
      const line = document.createElement('div');
      line.style.cssText = 'display:grid;grid-template-columns:24px 1fr 64px 44px;align-items:center;gap:8px';
      const iconCell = document.createElement('span');
      if (def.imageUrl) {
        const img = document.createElement('img');
        img.src = def.imageUrl; img.style.cssText = 'width:22px;height:22px;object-fit:contain;display:block';
        iconCell.append(img);
      }
      const name = document.createElement('span');
      name.textContent = def.name || `#${id}`;
      name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const inp = document.createElement('input');
      const avLbl = document.createElement('span');
      inp.type = 'number'; inp.min = '0'; inp.max = String(max); inp.value = String(state.get(id) || 0);
      inp.style.cssText = 'width:100%;background:var(--bg-raised);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:6px;font-size:0.85rem;box-sizing:border-box';
      inp.addEventListener('change', () => {
        let v = parseInt(inp.value, 10); if (isNaN(v) || v < 0) v = 0;
        if (v > (avail[id] || 0)) v = avail[id] || 0;
        inp.value = String(v);
        if (v > 0) state.set(id, v); else state.delete(id);
        if (requiredShips.has(id)) {
          if (v > 0) requiredShips.set(id, { ...requiredShips.get(id), quantity: v });
          else requiredShips.delete(id);
        }
        refresh();
      });
      avLbl.textContent = `/ ${max}`; avLbl.style.color = '#c0cce0';
      line.append(iconCell, name, inp, avLbl);
      rows.append(line);
      inputs.set(id, inp);
    }
    box.append(rows);
    if (planner) {
      const planRow = document.createElement('div');
      planRow.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:10px';
      const planBtn = document.createElement('button');
      planBtn.type = 'button';
      planBtn.textContent = planner.label || 'Calculate fleet';
      planBtn.style.cssText = 'padding:5px 12px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg-hover);color:var(--text);cursor:pointer;font-size:0.82rem';
      const planMsg = document.createElement('span');
      planMsg.style.cssText = 'color:var(--text-muted);font-size:0.82rem;white-space:pre-line';
      planBtn.onclick = async () => {
        planBtn.disabled = true;
        planBtn.style.opacity = '0.5';
        planMsg.textContent = 'Calculating…';
        try {
          const r = await planner.run(text => { planMsg.textContent = text; });
          if (r.error) {
            planMsg.textContent = r.error;
          } else {
            for (const id of [...state.keys()]) {
              state.delete(id);
              const input = inputs.get(id);
              if (input) input.value = '0';
            }
            for (const [idString, quantity] of Object.entries(r.ships || {})) {
              const id = Number(idString);
              const q = Math.min(quantity, avail[id] || 0);
              if (q <= 0) continue;
              state.set(id, q);
              const input = inputs.get(id);
              if (input) input.value = String(q);
            }
            planMsg.textContent = r.note || '';
            refresh();
          }
        } catch (error) {
          planMsg.textContent = error.message || String(error);
        }
        planBtn.disabled = false;
        planBtn.style.opacity = '1';
      };
      planRow.append(planBtn, planMsg);
      box.append(planRow);
    }
    if (escortTemplates.length) {
      const escortSection = document.createElement('div');
      escortSection.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid var(--border);';
      escortLabel = document.createElement('div');
      escortLabel.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-bottom:6px;';
      escortButtonRow = document.createElement('div');
      escortButtonRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      escortSection.append(escortLabel, escortButtonRow);
      if (autoEscortTemplate) {
        let autoEscort = localStorage.getItem('nx-af-auto-escort') === '1';
        const autoLabel = document.createElement('label');
        autoLabel.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-size:0.82rem;color:var(--text-muted);cursor:pointer';
        autoLabel.title = `Automatically add "${autoEscortTemplate.name}" when opening or optimising this mining fleet`;
        const autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = autoEscort;
        autoCheckbox.addEventListener('change', () => {
          autoEscort = autoCheckbox.checked;
          localStorage.setItem('nx-af-auto-escort', autoEscort ? '1' : '0');
          if (autoEscort) {
            applyEscortTemplate(autoEscortTemplate, true);
            refresh();
          }
        });
        autoLabel.append(autoCheckbox, document.createTextNode(`Auto-add ${autoEscortTemplate.name}`));
        escortSection.append(autoLabel);
      }
      box.append(escortSection);
    }

    const btns = document.createElement('div');
    btns.style.cssText = 'margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end';
    const mk = (b, label, primary) => {
      b.textContent = label;
      b.style.cssText = dialogBtnCss(primary, 'var(--btn-ok)', 'var(--btn-ok-border)');
      return b;
    };
    const cancel = mk(document.createElement('button'), 'Cancel', false);
    mk(ok, 'Send', true);
    if (untilFullState) {
      const untilFullLabel = document.createElement('label');
      untilFullLabel.title = 'Keep mining past the usual 10 cycles until the mining hold is full or the field is depleted';
      untilFullLabel.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:12px;color:var(--text-muted);font-size:0.85rem;cursor:pointer';
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
      retreatLabel.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--text-muted);font-size:0.85rem;cursor:pointer';
      retreatLabel.append(document.createTextNode('Withdraw escort by damage threshold'));
      const retreatSelect = document.createElement('select');
      retreatSelect.style.cssText = 'background:var(--bg-raised);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:6px;font-size:0.85rem';
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
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    ok.onclick = async () => {
      if (ok.disabled || confirming) return;
      confirming = true;
      availabilityError = '';
      refresh();
      try {
        if (refreshAvailability) {
          const result = await refreshAvailability();
          if (result?.error) {
            availabilityError = `Could not refresh ship availability: ${result.error}`;
            return;
          }
          avail = result?.available || {};
          for (const [id, input] of inputs) {
            const count = avail[id] || 0;
            input.max = String(count);
            input.parentElement.lastChild.textContent = `/ ${count}`;
          }
        }
        refresh();
        if (validateFleet().length) return;
        done(effective());
      } catch (error) {
        availabilityError = `Could not refresh ship availability: ${error.message}`;
      } finally {
        confirming = false;
        if (ov.isConnected) refresh();
      }
    };
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    refresh();
    if (recShips.length) {
      const miningOptions = document.createElement('div');
      miningOptions.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;color:var(--text-muted);font-size:0.82rem;';
      let autoOptimise = localStorage.getItem('nx-af-auto-optimise') === '1';
      const autoOptimiseLabel = document.createElement('label');
      autoOptimiseLabel.title = 'Automatically apply the mining recommendation when this dialog opens';
      autoOptimiseLabel.style.cssText = 'display:inline-flex;align-items:center;gap:5px;cursor:pointer';
      const autoOptimiseCheckbox = document.createElement('input');
      autoOptimiseCheckbox.type = 'checkbox';
      autoOptimiseCheckbox.checked = autoOptimise;
      autoOptimiseCheckbox.addEventListener('change', () => {
        autoOptimise = autoOptimiseCheckbox.checked;
        localStorage.setItem('nx-af-auto-optimise', autoOptimise ? '1' : '0');
        if (autoOptimise) optimiseMiningFleet();
      });
      autoOptimiseLabel.append(autoOptimiseCheckbox, document.createTextNode('Auto-optimise mining fleet'));
      miningOptions.append(autoOptimiseLabel);
      if (excavatorAvailable) {
        const excavatorLabel = document.createElement('label');
        excavatorLabel.title = 'Include one Excavator and reduce the recommended mining ships by 20%';
        excavatorLabel.style.cssText = 'display:inline-flex;align-items:center;gap:5px;cursor:pointer';
        const excavatorCheckbox = document.createElement('input');
        excavatorCheckbox.type = 'checkbox';
        excavatorCheckbox.checked = excavatorEnabled;
        excavatorCheckbox.addEventListener('change', () => {
          excavatorEnabled = excavatorCheckbox.checked;
          localStorage.setItem('nx-af-excavator', excavatorEnabled ? '1' : '0');
          optimiseMiningFleet();
        });
        excavatorLabel.append(excavatorCheckbox, document.createTextNode('Excavator +20%'));
        miningOptions.append(excavatorLabel);
      }
      box.append(miningOptions);
      const opt = document.createElement('button');
      opt.textContent = 'Optimise Mining Fleet';
      opt.title = 'Set the recommended count for mining ships only — escort/combat ships untouched';
      opt.style.cssText = 'padding:7px 16px;border-radius:6px;border:1px solid var(--btn-blue);background:var(--btn-blue);color:#fff;cursor:pointer;margin-right:auto';
      opt.onclick = optimiseMiningFleet;
      btns.append(opt);
      if (autoOptimise) optimiseMiningFleet();
    }
    btns.append(cancel, ok);
    box.append(validation);
    box.append(btns);
    ov.append(box);
    document.body.append(ov);
    if (autoEscortTemplate && localStorage.getItem('nx-af-auto-escort') === '1') {
      applyEscortTemplate(autoEscortTemplate, true);
      refresh();
    }
  });
}

export function changelogForVersion(markdown, version) {
  const target = version.replace(/-demo$/, '');
  if (!/^\d+\.\d+\.\d+$/.test(target)) return [];
  const [major, minor, patch] = target.split('.').map(Number);
  const releases = [];
  for (const match of markdown.matchAll(/^## \[([^\]]+)\][^\r\n]*\r?\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm)) {
    if (!/^\d+\.\d+\.\d+$/.test(match[1])) continue;
    const [entryMajor, entryMinor, entryPatch] = match[1].split('.').map(Number);
    const notes = match[2].trim();
    if (entryMajor === major && entryMinor === minor && entryPatch <= patch && notes) {
      releases.push({ version: match[1], notes, patch: entryPatch });
    }
  }
  return releases.sort((a, b) => b.patch - a.patch).map(({ version: releaseVersion, notes }) => ({
    version: releaseVersion, notes,
  }));
}

// Minimal Markdown → DOM for the changelog: ### headings, - bullets (with
// wrapped continuation lines), **bold**, *italic*, `code`. Returns a fragment.
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  let ul = null, li = null;
  const closeList = () => { ul = null; li = null; };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      closeList();
      const el = document.createElement('h4');
      inlineMd(el, h[1]);
      frag.append(el);
    } else if (/^[-*]\s+/.test(line)) {
      if (!ul) { ul = document.createElement('ul'); frag.append(ul); }
      li = document.createElement('li');
      inlineMd(li, line.replace(/^[-*]\s+/, ''));
      ul.append(li);
    } else if (li) {                       // wrapped continuation of a bullet
      li.append(document.createTextNode(' '));
      inlineMd(li, line.trim());
    } else {
      const p = document.createElement('div');
      inlineMd(p, line.trim());
      frag.append(p);
    }
  }
  return frag;
}

function inlineMd(parent, text) {
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const el = document.createElement(m[1] != null ? 'strong' : m[2] != null ? 'em' : 'code');
    el.textContent = m[1] ?? m[2] ?? m[3];
    parent.append(el);
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

// One-button info modal (e.g. "What's new"). `body` may be a string (plain
// text) or a DOM node (e.g. from renderMarkdown). Header and button stay
// visible; only the body scrolls.
export function infoDialog(title, body, { width = 480 } = {}) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px';
    const box = document.createElement('div');
    box.style.cssText = DIALOG_BOX_CSS + `width:min(${width}px,100%);max-height:100%;display:flex;flex-direction:column;padding:0`;
    const h = document.createElement('h3');
    h.textContent = title;
    h.style.cssText = 'margin:0;padding:16px 20px 12px;border-bottom:1px solid var(--edge-soft)';
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 20px;overflow:auto;min-height:0';
    if (body instanceof Node) msg.append(body);
    else { msg.textContent = body; msg.style.whiteSpace = 'pre-wrap'; }
    const btns = document.createElement('div');
    btns.style.cssText = 'padding:12px 20px 16px;border-top:1px solid var(--edge-soft);display:flex;justify-content:flex-end';
    const ok = document.createElement('button');
    ok.textContent = 'Got it';
    ok.style.cssText = dialogBtnCss(true, 'var(--btn-primary)', 'var(--btn-primary)');
    const close = () => { ov.remove(); resolve(); };
    ok.onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    btns.append(ok);
    box.append(h, msg, btns);
    ov.append(box);
    document.body.append(ov);
    ok.focus();
  });
}

// Fuel estimate, cached per route+fleet+mission so the server's mission-specific
// travel time is not reused for a different mission. Errors aren't cached.
const _fuelCache = new Map();
export async function fuelEstimate(sourcePlanetId, targetSystemId, ships, missionType) {
  const sig = ships.map(s => `${s.shipDefId}:${s.quantity}`).sort().join(',');
  const key = `${sourcePlanetId}|${targetSystemId}|${sig}|${missionType || ''}`;
  if (_fuelCache.has(key)) return _fuelCache.get(key);
  const body = { sourcePlanetId, targetSystemId, ships };
  if (missionType) body.missionType = missionType;
  const est = await browser.runtime.sendMessage({
    type: 'GET_FUEL_ESTIMATE',
    body,
  });
  if (!est.error) _fuelCache.set(key, est);
  return est;
}

// Fill a box with "On this planet:" + a chip (icon + qty × name) per ship that
// has a positive count. `ships` is [{ shipDefId, name, imageUrl }] to consider.
// Clear an availability strip (or show a message) and invalidate its signature,
// so the next renderAvailStrip with the same data still repaints. Callers must
// use this instead of box.textContent='' — a raw wipe leaves the cached sig and
// the strip stays blank.
export function clearAvailStrip(box, msg = '') {
  box.textContent = msg;
  delete box.dataset.availSig;
}

export function renderAvailStrip(box, ships, available, emptyMsg) {
  const here = ships.filter(s => (available[s.shipDefId] || 0) > 0);
  // Skip rebuild when nothing changed — avoids the empty-frame flash and the
  // img reload that shifts layout on every poll.
  const sig = here.map(s => `${s.shipDefId}:${available[s.shipDefId] || 0}`).join('|') || emptyMsg;
  if (box.dataset.availSig === sig) return;
  box.dataset.availSig = sig;
  box.textContent = '';
  const label = document.createElement('span');
  label.textContent = here.length ? 'On this planet:' : emptyMsg;
  box.appendChild(label);
  for (const s of here) {
    const chip = document.createElement('span');
    chip.className = 'mission-availability-item';
    chip.title = s.name;
    if (s.imageUrl) {
      const img = document.createElement('img');
      img.src = s.imageUrl;
      chip.appendChild(img);
    }
    chip.append(document.createTextNode(`${(available[s.shipDefId] || 0).toLocaleString()}× ${s.name}`));
    box.appendChild(chip);
  }
}

// Remember template-dropdown choices (by element id) across tabs and sessions.
export async function rememberedSelections() {
  const { template_selections } = await browser.storage.local.get('template_selections');
  return template_selections || {};
}
let rememberQueue = Promise.resolve();
export function rememberSelection(id, value) {
  // Serialized: concurrent read-modify-write calls would otherwise overwrite each other.
  const run = rememberQueue.then(async () => {
    const cur = await rememberedSelections();
    cur[id] = value;
    await browser.storage.local.set({ template_selections: cur });
  });
  rememberQueue = run.catch(() => {});
  return run;
}

// Whole numbers only: amounts are never fractional for the player, but the API returns fractions.
export function fmt(n) {
  if (n == null) return '0';
  const v = Math.round(Number(n) || 0);
  const format = getSetting('general.numberFormat');
  if (format === 'compact') {
    return new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  }
  return v.toLocaleString(format === 'en' ? 'en-US' : 'de-DE');
}

// ── In-flight mission progress bars ─────────────────────────────────────────
// Shared by any tab that lists fleets in transit (Scouting, Expeditions, …).

export function fmtCountdown(ms) {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function missionCountdown(progress) {
  if (!progress.event) return '—';
  if (progress.needsRefresh) return 'updating…';
  return fmtCountdown(progress.eta);
}

// Refresh once per elapsed event, with periodic retries for server-side changes.
export function createMissionRefresh(refresh) {
  let lastRefreshAt = Date.now();
  let pending = false;
  let handled = new Set();
  return async missions => {
    const now = Date.now();
    const due = missions.map(m => {
      const p = missionProgress(m, now);
      return p.needsRefresh ? `${m.id}:${p.status}:${p.event.at}` : null;
    }).filter(Boolean);
    const unseen = due.some(key => !handled.has(key));
    if (pending || now - lastRefreshAt < (unseen ? 5000 : 30000)) return;
    pending = true;
    lastRefreshAt = now;
    handled = new Set(due);
    try {
      await refresh();
    } catch (error) {
      console.error('[NexusOverseer] Mission refresh failed:', error);
    } finally {
      pending = false;
    }
  };
}

// Compact inline progress bar for a table cell or transit-list row. Returns
// { el, upd }; caller registers `upd` somewhere it gets called every second.
export function makeMissionBar(m) {
  const wrap = document.createElement('div');
  wrap.className = 'mission-progress';
  const track = document.createElement('div');
  track.className = 'mission-progress-track';
  const fill = document.createElement('div');
  fill.className = 'mission-progress-fill';
  track.appendChild(fill);
  const cap = document.createElement('div');
  cap.className = 'mission-progress-caption';
  const ph = document.createElement('span'), et = document.createElement('span');
  ph.className = 'mission-progress-phase';
  et.className = 'mission-progress-eta';
  cap.append(ph, et);
  wrap.append(track, cap);
  const upd = () => {
    const p = missionProgress(m);
    fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
    fill.style.background = p.gradient || p.color;
    ph.textContent = p.label; ph.style.color = p.color;
    et.textContent = missionCountdown(p);
  };
  upd();
  return { el: wrap, upd };
}

// Escape a string for safe interpolation into an innerHTML template. Names
// (ship/tech/colony) come from the game API or the player and must never be
// trusted as markup.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Mode-aware data helpers ────────────────────────────────────────────────

export function getMode() {
  return document.getElementById('mode-select').value; // 'all'|'daily'|'yesterday'|'last3'|'last7'|'last30'|'hourly'
}

// Local-time bucket keys. created_at is stored as UTC/server time; bucketing on
// the raw ISO string mis-files reports near local midnight by the UTC offset.
const pad2 = n => String(n).padStart(2, '0');
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function hourKey(ts) {
  const d = new Date(ts);
  return `${dayKey(d)}T${pad2(d.getHours())}:00`;
}
export function bucketKey(ts, byHour) {
  return byHour ? hourKey(ts) : dayKey(ts);
}

// Day range from the Days picker, as { from, to } 'YYYY-MM-DD' ('' = open).
export function getWindowRange() {
  const f = document.getElementById('window-from');
  const t = document.getElementById('window-to');
  return { from: f ? f.value : '', to: t ? t.value : '' };
}

// True when the Days picker has a From and/or To set (a range is in effect).
export function windowActive() {
  const { from, to } = getWindowRange();
  return !!(from || to);
}

// Filter records to the Days picker range (by local day). Open range = all.
export function inWindowRange(records) {
  const { from, to } = getWindowRange();
  if (!from && !to) return records || [];
  return (records || []).filter(r => {
    const day = dayKey(r.created_at);
    return (!from || day >= from) && (!to || day <= to);
  });
}

// Fuel (hydrogen) spent, summed from the per-mission fuel log for a tab type
// ('survey'|'pirate'|'mining'|'debris'|'expedition'|'all'), honouring the
// current View + Zone. Counted per launched fleet, independent of reports.
export function fuelForMode(type, mode) {
  let rows = store.fuel_log || [];
  if (type !== 'all') rows = rows.filter(e => e.type === type);
  rows = filterZone(rows);
  if (mode !== 'all') rows = inWindowRange(rows);
  return rows.reduce((s, e) => s + (e.fuel || 0), 0);
}

// Selected security zone, or 'all'.
export function getZone() {
  const el = document.getElementById('zone-select');
  return el ? el.value : 'all';
}

// Filter records to the selected zone (passthrough when 'all'). Records from
// before zones were tracked have no `zone` → treated as 'unknown'.
export function filterZone(reports) {
  const z = getZone();
  if (z === 'all') return reports || [];
  return (reports || []).filter(r => (r.zone || 'unknown') === z);
}

// True when the precomputed all-time totals can be used as-is (no zone filter).
export function isUnfiltered() {
  return getZone() === 'all';
}

export function getLabelKey(mode) {
  return mode === 'hourly' ? 'hour' : 'day';
}

const shortDate = s => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export function periodLabelFor(mode) {
  if (mode === 'all') return '';
  const { from, to } = getWindowRange();
  if (!from && !to) return '';
  if (from && to) return from === to ? ` (${shortDate(from)})` : ` (${shortDate(from)}–${shortDate(to)})`;
  return from ? ` (from ${shortDate(from)})` : ` (to ${shortDate(to)})`;
}

// ── Shared per-tab helpers ─────────────────────────────────────────────────
// Every tab follows the same pattern: slice the latest day/hour out of its
// report history, optionally compute an hourly series, and draw the standard
// three-resource line chart. The per-tab code only supplies field getters.

// Records to aggregate for the current mode + zone: zone-filtered all-time for
// 'all' mode, else the zone-filtered records within the Days picker range.
export function recordsForMode(allRecords, mode) {
  const filtered = filterZone(allRecords || []);
  if (mode === 'all' && !windowActive()) return filtered;   // a set range overrides All time
  return inWindowRange(filtered);
}

// Time series grouped by day (all/daily modes) or hour (hourly mode).
// fieldGetters: { field: r => value }.
export function computeSeries(reports, mode, fieldGetters) {
  const byHour = mode === 'hourly';
  const keyName = byHour ? 'hour' : 'day';
  const fields = Object.keys(fieldGetters);
  const map = {};
  for (const r of reports) {
    const k = bucketKey(r.created_at, byHour);
    if (!map[k]) {
      map[k] = { [keyName]: k };
      for (const f of fields) map[k][f] = 0;
    }
    for (const [f, get] of Object.entries(fieldGetters)) map[k][f] += get(r);
  }
  const keys = Object.keys(map).sort();
  if (keys.length < 2) return keys.map(k => map[k]);

  // Fill empty days/hours with zero rows so the time axis stays continuous —
  // otherwise the chart's equal-spaced labels misrepresent gaps in activity.
  // Step in LOCAL calendar units (handles the UTC offset and DST correctly).
  const toDate = k => new Date(byHour ? `${k}:00` : `${k}T00:00:00`);   // local time
  const blank = k => { const o = { [keyName]: k }; for (const f of fields) o[f] = 0; return o; };
  const out = [];
  const endD = toDate(keys[keys.length - 1]);
  let cur = toDate(keys[0]), guard = 0;
  while (cur <= endD && guard++ < 100000) {
    const k = bucketKey(cur, byHour);
    out.push(map[k] || blank(k));
    if (byHour) cur.setHours(cur.getHours() + 1); else cur.setDate(cur.getDate() + 1);
  }
  const { from, to } = getWindowRange();
  if (!from && !to) return out;
  return out.filter(o => {
    const day = String(o[keyName] || '').slice(0, 10);   // 'hour' keys are YYYY-MM-DDTHH:00
    return (!from || day >= from) && (!to || day <= to);
  });
}

export const RESOURCE_SERIES = [
  { field: 'ore',          label: 'Ore',          color: '#f59e0b' },
  { field: 'silicates',    label: 'Silicates',    color: '#8b5cf6' },
  { field: 'hydrogen',     label: 'Hydrogen',     color: '#06b6d4' },
  { field: 'alloys',       label: 'Alloys',       color: '#6b7280' },
  { field: 'cryo_ice',     label: 'Cryo-Ice',     color: '#67e8f9' },
  { field: 'quantum_dust', label: 'Quantum Dust', color: '#f472b6' },
  { field: 'plasma_core',  label: 'Plasma Core',  color: '#f97316' },
  { field: 'dark_matter',  label: 'Dark Matter',  color: '#9333ea' },
  { field: 'antimatter',   label: 'Antimatter',   color: '#ef4444' },
  { field: 'precursor_fragments', label: 'Precursor Fragments', color: '#7ee787' },
  { field: 'artifact',            label: 'Artifact',            color: '#d29922' },
];

// fieldGetters covering every chartable resource, for computeSeries.
export const SERIES_GETTERS = {};
for (const d of RESOURCE_SERIES) SERIES_GETTERS[d.field] = r => r[d.field] || 0;

// Resource line chart. Ore/silicates/hydrogen always shown; alloys + exotics
// only when the series actually carries some (avoids a wall of flat-zero lines).
// `count` = { field, label } adds a report-count line on a secondary y-axis.
export function makeResourceLineChart(canvasId, series, labelKey, count) {
  const ALWAYS = new Set(['ore', 'silicates', 'hydrogen']);
  const shown = RESOURCE_SERIES.filter(d =>
    ALWAYS.has(d.field) || series.some(r => (r[d.field] || 0) > 0));
  const datasets = shown.map(d => ({
    label: d.label,
    data: series.map(r => r[d.field] || 0),
    borderColor: d.color,
    backgroundColor: d.color + '22',
    fill: true,
    tension: 0.3,
  }));
  const scales = { ...SCALE_OPTS };
  if (count) {
    datasets.push({
      label: count.label,
      data: series.map(r => r[count.field] || 0),
      borderColor: cssVar('--text-muted'),
      borderDash: [5, 4],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      yAxisID: 'count',
    });
    scales.count = {
      position: 'right',
      beginAtZero: true,
      ticks: { color: cssVar('--text-muted'), precision: 0 },
      grid: { drawOnChartArea: false },
    };
  }
  return new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: { labels: series.map(r => r[labelKey]), datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: cssVar('--text') } } },
      scales,
    },
  });
}

// ── Pure aggregation helpers ───────────────────────────────────────────────

export function computeEventBreakdown(reports) {
  const map = {};
  for (const r of reports) {
    const et = r.event_type || 'unknown';
    if (!map[et]) map[et] = { event_type: et, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    map[et].count += 1;
    map[et].ore += r.ore || 0;
    map[et].hydrogen += r.hydrogen || 0;
    map[et].silicates += r.silicates || 0;
    for (const k of EXTRA_RES_KEYS_UI) map[et][k] = (map[et][k] || 0) + (r[k] || 0);
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

// A damaged ship costs half its build cost to repair.
export const REPAIR_FACTOR = 0.5;

export function emptyResources() {
  return { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
}

// Loss split into full-cost destruction and half-cost repair of damaged ships.
// Returns { destroyed, repair }, each an emptyResources()-shaped object.
export function computeResourcesLost(reports, ships) {
  const out = { destroyed: emptyResources(), repair: emptyResources() };
  const add = (into, detail, factor) => {
    for (const [defId, qty] of Object.entries(detail || {})) {
      const ship = ships[defId];
      if (!ship) continue;
      const q = qty * factor;
      into.ore += q * (ship.costOre || 0);
      into.silicates += q * (ship.costSilicates || 0);
      into.hydrogen += q * (ship.costHydrogen || 0);
      into.alloys += q * (ship.costAlloys || 0);
      for (const [k, v] of Object.entries(ship.rareCosts || {})) {
        into.rare[k] = (into.rare[k] || 0) + q * v;
      }
    }
  };
  for (const r of reports) {
    add(out.destroyed, r.ships_lost_detail, 1);
    add(out.repair, r.ships_damaged_detail, REPAIR_FACTOR);
  }
  return out;
}

// Ship-loss build cost from raw ships_destroyed_raw arrays
// ([{shipDefId,quantity}] or [{key,lost}]) — the shape expeditions/wormholes/
// xeno store per-record, as opposed to computeResourcesLost's shipDefId→qty
// map. Ships destroyed outright (no repair concept for these encounters).
export function computeRawLossCost(reports, ships) {
  const out = emptyResources();
  const byKey = {};
  for (const s of Object.values(ships || {})) if (s && s.key) byKey[s.key] = s;
  for (const r of reports) {
    for (const i of (r.ships_destroyed_raw || [])) {
      const ship = i.shipDefId != null ? ships[i.shipDefId] : byKey[i.key];
      if (!ship) continue;
      const q = i.quantity ?? i.lost ?? 1;
      out.ore += q * (ship.costOre || 0);
      out.silicates += q * (ship.costSilicates || 0);
      out.hydrogen += q * (ship.costHydrogen || 0);
      out.alloys += q * (ship.costAlloys || 0);
      for (const [k, v] of Object.entries(ship.rareCosts || {})) out.rare[k] = (out.rare[k] || 0) + q * v;
    }
  }
  return out;
}

// Per-resource destroyed + repair, for net calculations.
export function combinedLost(lost) {
  const d = lost.destroyed || {}, r = lost.repair || {};
  const out = emptyResources();
  for (const k of ['ore', 'silicates', 'hydrogen', 'alloys']) out[k] = (d[k] || 0) + (r[k] || 0);
  for (const src of [d.rare || {}, r.rare || {}]) {
    for (const [k, v] of Object.entries(src)) out.rare[k] = (out.rare[k] || 0) + v;
  }
  return out;
}

// ── Stat cards ─────────────────────────────────────────────────────────────

export function makeStatCard(label, value, valueClass, valueStyle) {
  const card = document.createElement('div');
  const styleClass = /#ff6b7a|--error/.test(valueStyle || '') ? 'danger'
    : /#e3b341|--warning/.test(valueStyle || '') ? 'warning'
      : /#7ed957|--success/.test(valueStyle || '') ? 'positive' : '';
  card.className = ['stat-card', valueClass, styleClass].filter(Boolean).join(' ');
  const labelDiv = document.createElement('div');
  labelDiv.className = 'label';
  labelDiv.textContent = label;
  const valueDiv = document.createElement('div');
  valueDiv.className = valueClass ? `value ${valueClass}` : 'value';
  if (valueStyle) valueDiv.style.cssText = valueStyle;
  valueDiv.textContent = value;
  card.append(labelDiv, valueDiv);
  return card;
}

// ── Charts ─────────────────────────────────────────────────────────────────

// Getters so the theme colours are read when a chart is built, not at import time.
const scaleAxis = () => ({ ticks: { color: cssVar('--text-muted') }, grid: { color: cssVar('--bg-raised') } });
export const SCALE_OPTS = {
  get x() { return scaleAxis(); },
  get y() { return scaleAxis(); },
};

// ── Shared helpers for the newer tabs ──────────────────────────────────────

export function zeroCell(v) {
  const td = document.createElement('td');
  if (v) {
    td.textContent = fmt(v);
  } else {
    const span = document.createElement('span');
    span.className = 'zero';
    span.textContent = '—';
    td.appendChild(span);
  }
  return td;
}

// Alloys + exotic resources, shown as their own collected cards. Values may be
// stored flat on totals or inside a `rare` map; read either.
export const EXTRA_RESOURCES = [
  ['alloys', 'Alloys', 'alloys'],
  ['cryo_ice', 'Cryo-Ice', 'cryo_ice'],
  ['quantum_dust', 'Quantum Dust', 'quantum_dust'],
  ['plasma_core', 'Plasma Core', 'plasma_core'],
  ['dark_matter', 'Dark Matter', 'dark_matter'],
  ['antimatter', 'Antimatter', 'antimatter'],
  ['precursor_fragments', 'Precursor Fragments', 'rare'],
  ['artifact', 'Artifact', 'rare'],
];

export const EXTRA_RES_KEYS_UI = EXTRA_RESOURCES.map(e => e[0]);

export function resourceVal(totals, key) {
  if (totals && totals[key] != null) return totals[key];
  return (totals && totals.rare && totals.rare[key]) || 0;
}

// Append the alloys + exotic-resource cards (alloys always; rares only when
// some has been collected) to a collected-resources container.
export function appendExtraResourceCards(container, totals, suffix) {
  for (const [key, label, cls] of EXTRA_RESOURCES) {
    const v = resourceVal(totals, key);
    if (key === 'alloys' || v > 0) container.appendChild(makeStatCard(`${label}${suffix}`, fmt(v), cls));
  }
}

export function appendRareCards(container, rare, suffix) {
  Object.entries(rare || {})
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => container.appendChild(
      makeStatCard(`${k.replace(/_/g, ' ')}${suffix}`, fmt(v), k)
    ));
}

export function renderPagedTable(reports, page, infoId, prevId, nextId, tbodyId, rowFn) {
  const totalPages = Math.ceil(reports.length / PER_PAGE);
  const maxPage = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(1, page), maxPage);
  document.getElementById(infoId).textContent = `Page ${safePage} / ${maxPage} (${reports.length} total)`;
  document.getElementById(prevId).disabled = safePage <= 1;
  document.getElementById(nextId).disabled = safePage >= totalPages;
  const tbody = document.getElementById(tbodyId);
  tbody.textContent = '';
  for (const r of reports.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)) {
    tbody.appendChild(rowFn(r));
  }
}

// Fill a stats container with ore/silicates/hydrogen/alloys + rare cards.
export function fillResourceCards(containerId, res, suffix) {
  const el = document.getElementById(containerId);
  if (!el) return;
  res = res || emptyResources();
  el.textContent = '';
  el.append(
    makeStatCard(`Ore${suffix}`, fmt(res.ore || 0), 'ore'),
    makeStatCard(`Silicates${suffix}`, fmt(res.silicates || 0), 'silicates'),
    makeStatCard(`Hydrogen${suffix}`, fmt(res.hydrogen || 0), 'hydrogen'),
    makeStatCard(`Alloys${suffix}`, fmt(res.alloys || 0), 'alloys'),
  );
  appendRareCards(el, res.rare, suffix);
}

// Renders a { destroyed, repair } loss into two separate titled containers.
// Pass repairId = null for tabs with no repair concept (debris, expeditions).
export function renderLostCards(destroyedId, repairId, lost, periodLabel) {
  fillResourceCards(destroyedId, lost.destroyed, periodLabel);
  if (repairId) fillResourceCards(repairId, lost.repair, periodLabel);
}

// Relative value of each resource, used to weight the net total.
export const RESOURCE_WEIGHTS = {
  ore: 1, silicates: 2, hydrogen: 3, alloys: 5,
  precursor_fragments: 50, artifact: 2000,
};
export const RARE_WEIGHT = 10;   // exotics with no specific weight above (ice, quantum dust, …)

export function resourceWeight(key) {
  return RESOURCE_WEIGHTS[key] || RARE_WEIGHT;
}

// Signed trade valuation from the current player's perspective.
// Positive oreEquivalent means the received side outweighs what was paid.
export function marketTradeNet(trade, userId) {
  const soldByMe = String(trade.sellerId) === String(userId);
  const fee = Math.max(0, Number(soldByMe ? trade.commissionSeller : trade.commissionBuyer) || 0);
  const paidResource = soldByMe ? trade.resourceSold : trade.resourcePaid;
  const receivedResource = soldByMe ? trade.resourcePaid : trade.resourceSold;
  const paid = Math.max(0, Number(soldByMe ? trade.amountSold : trade.amountPaid) || 0);
  const grossReceived = Math.max(0, Number(soldByMe ? trade.amountPaid : trade.amountSold) || 0);
  const received = Math.max(0, grossReceived - fee);
  const oreEquivalent = received * resourceWeight(receivedResource) - paid * resourceWeight(paidResource);
  return { soldByMe, fee, paidResource, receivedResource, paid, received, oreEquivalent };
}

// Net gain cards: resources collected minus ship build costs, per resource
// (raw), plus a weighted total (ore×1, silicates×2, hydrogen×3, alloys×5).
// Rare resource losses are not in the total (no common valuation).
export function renderNetCards(containerId, collected, lost, periodLabel, fuelHydrogen = 0) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.textContent = '';
  const cost = combinedLost(lost);   // destruction + repair
  const fuel = fuelHydrogen || 0;
  const fields = [
    ['Ore', 'ore'], ['Silicates', 'silicates'], ['Hydrogen', 'hydrogen'], ['Alloys', 'alloys'],
  ];
  let total = 0;
  for (const [label, key] of fields) {
    let v = (collected[key] || 0) - (cost[key] || 0);
    if (key === 'hydrogen') v -= fuel;   // fuel is hydrogen burned on the trip
    total += v * RESOURCE_WEIGHTS[key];
    el.appendChild(makeStatCard(`${label} net${periodLabel}`, (v >= 0 ? '+' : '') + fmt(v), key));
  }
  // Exotic resources — net (collected − any rare ship-cost), weighted per
  // RESOURCE_WEIGHTS (falling back to RARE_WEIGHT). Shown when present either side.
  for (const [key, label, cls] of EXTRA_RESOURCES) {
    if (key === 'alloys') continue;   // already a core field above
    const got = resourceVal(collected, key);
    const spent = resourceVal(cost, key);
    if (!got && !spent) continue;
    const v = got - spent;
    total += v * resourceWeight(key);
    el.appendChild(makeStatCard(`${label} net${periodLabel}`, (v >= 0 ? '+' : '') + fmt(v), cls));
  }
  const totalCard = makeStatCard(`Total net${periodLabel}`, (total >= 0 ? '+' : '') + fmt(total),
    '', total >= 0 ? 'color:var(--success)' : 'color:var(--error)');
  totalCard.title = 'Weighted: ore×1, silicates×2, hydrogen×3, alloys×5, precursor fragments×50, artifacts×2000, other exotics×10.'
    + (fuel ? ` Includes ${fmt(fuel)} hydrogen fuel (est.).` : '');
  el.appendChild(totalCard);
}

// Doughnut of a loot/resource breakdown (ore, silicates, hydrogen, alloys and
// any rares) for the current view period. `totals` is a mode-aware totals
// object; returns the Chart instance.
/** Reads a CSS custom property from :root (for canvas/Chart.js, which cannot use var()). */
export function cssVar(name, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
// Canvas/Chart.js cannot use var(); keep in sync with --res-* in dashboard.css.
export const RESOURCE_COLORS = {
  ore: '#f59e0b', silicates: '#8b5cf6', hydrogen: '#06b6d4', alloys: '#6b7280',
};
export const RARE_COLORS = {
  cryo_ice: '#67e8f9', quantum_dust: '#f472b6', plasma_core: '#f97316',
  bio_extract: '#10b981', dark_matter: '#9333ea', antimatter: '#ef4444',
};
export const ALL_RES_COLORS = { ...RESOURCE_COLORS, ...RARE_COLORS };
const RARE_FALLBACK = ['#bc8cff', '#d2a8ff', '#ffa657', '#7ee787'];

export function makeResourceDoughnut(canvasId, totals) {
  const entries = [];
  for (const k of ['ore', 'silicates', 'hydrogen', 'alloys']) {
    if (totals[k] > 0) entries.push([k, totals[k], RESOURCE_COLORS[k]]);
  }
  let ri = 0;
  for (const [k, v] of Object.entries(totals.rare || {})) {
    if (v > 0) entries.push([k.replace(/_/g, ' '), v, RARE_COLORS[k] || RARE_FALLBACK[ri++ % RARE_FALLBACK.length]]);
  }
  const total = entries.reduce((s, e) => s + e[1], 0);
  return new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels: entries.map(e => {
        const pct = total ? (e[1] / total * 100).toFixed(1) : 0;
        return `${e[0]} — ${fmt(e[1])} (${pct}%)`;
      }),
      datasets: [{ data: entries.map(e => e[1]), backgroundColor: entries.map(e => e[2]) }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text'), font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = total ? (ctx.parsed / total * 100).toFixed(1) : 0;
              return ` ${fmt(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// Colored zone badge cell for report tables.
export const ZONE_COLORS = {
  sentinel: '#22c55e', open: '#f59e0b', dead: '#ef4444', rift: '#7c3aed', unknown: '#c0cce0',
};
export const ZONE_DEFS = Object.freeze([
  Object.freeze({ key: 'sentinel', label: 'Sentinel' }),
  Object.freeze({ key: 'open', label: 'Open' }),
  Object.freeze({ key: 'dead', label: 'Dead' }),
  Object.freeze({ key: 'rift', label: 'Rift' }),
]);
export function zoneCell(zone) {
  const z = zone || 'unknown';
  const td = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = z;
  badge.style.color = ZONE_COLORS[z] || ZONE_COLORS.unknown;
  td.appendChild(badge);
  return td;
}

// ── Sortable tables ─────────────────────────────────────────────────────────
// Click a th.sortable[data-key] to sort; click again to flip. `state` is a
// plain { key, dir } object the caller keeps; `rerender` redraws the table.
export function attachSortable(headId, state, rerender) {
  const head = document.getElementById(headId);
  if (!head) return;
  head.addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    state.dir = state.key === th.dataset.key ? -state.dir : -1;
    state.key = th.dataset.key;
    rerender();
  });
}

// Sort a copy of records by the state, draw the header arrow, and return it.
export function applySort(headId, records, state, tiebreak = 'created_at') {
  const { key, dir } = state;
  document.querySelectorAll(`#${headId} th.sortable`).forEach(th => {
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (th.dataset.key === key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = dir === -1 ? ' ▼' : ' ▲';
      th.appendChild(arrow);
    }
  });
  return records.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    let cmp;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
    return cmp * dir || String(b[tiebreak] ?? '').localeCompare(String(a[tiebreak] ?? ''));
  });
}
