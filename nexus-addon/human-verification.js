// Central handling for the game's "Human verification" block: every automation
// is paused together and can be restored in one step once the check is done.
import { rememberSelection, setStatusText } from './common.js';

const PENDING_KEY = 'human_verification_pending';
const HV_STATUS_MESSAGE = 'Paused: human verification required';

// [label, main switch id, status element id]
export const AUTOMATIONS = [
  ['Scouting', 'sc-auto', 'sc-auto-status'],
  ['Investigation', 'sc-investigate-auto', 'sc-investigate-status'],
  ['Debris collection', 'sc-debris-auto', 'sc-debris-status'],
  ['Salvage collection', 'sc-salvage-auto', 'sc-salvage-status'],
  ['Pirate scouting', 'pc-auto', 'pc-auto-status'],
  ['Pirate attacks', 'pc-auto-attack', 'pc-attack-status'],
  ['Expeditions', 'e-auto', 'e-auto-status'],
];

export function isHumanVerificationError(error) {
  return String(error || '').includes('Human verification');
}

let queue = Promise.resolve();

// Switches every automation off (remembering which ones were on) and shows the banner.
export function pauseAutomationsForHumanVerification(error) {
  const wasOn = [];
  for (const [, boxId, statusId] of AUTOMATIONS) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    if (box.checked) {
      wasOn.push(boxId);
      setStatusText(document.getElementById(statusId), HV_STATUS_MESSAGE, 'error');
    }
    box.checked = false;
    box.disabled = true;
    rememberSelection(boxId, false);
  }
  queue = queue.then(async () => {
    const got = await browser.storage.local.get(PENDING_KEY);
    const prior = got[PENDING_KEY];
    const restore = [...new Set([...(prior?.restore || []), ...wasOn])];
    await browser.storage.local.set({
      [PENDING_KEY]: { at: prior?.at || Date.now(), error: String(error || ''), restore },
    });
  }).catch(() => {});
  return queue;
}

async function restoreAutomations() {
  const got = await browser.storage.local.get(PENDING_KEY);
  const restore = new Set(got[PENDING_KEY]?.restore || []);
  for (const [, boxId, statusId] of AUTOMATIONS) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    box.disabled = false;
    if (!restore.has(boxId)) continue;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    setStatusText(document.getElementById(statusId), 'Resumed');
  }
  await browser.storage.local.remove(PENDING_KEY);
  renderBanner(null);
}

function renderBanner(pending) {
  const banner = document.getElementById('hv-banner');
  if (!banner) return;
  banner.textContent = '';
  banner.classList.toggle('show', !!pending);
  if (!pending) return;
  const count = (pending.restore || []).length;
  const text = document.createElement('div');
  text.className = 'hv-text';
  const title = document.createElement('b');
  title.textContent = 'Human verification required';
  const detail = document.createElement('span');
  detail.textContent = count
    ? `All automations were paused (${count} will be restored). Complete the verification in the game, then restore them.`
    : 'All automations were paused. Complete the verification in the game, then re-enable them.';
  text.append(title, detail);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toolbar-button';
  btn.textContent = 'Verification done — restore automations';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    restoreAutomations().catch(() => { btn.disabled = false; });
  });
  banner.append(text, btn);
}

// Keeps the checkboxes locked after a reload for as long as a verification is pending.
function lockSwitches() {
  for (const [, boxId] of AUTOMATIONS) {
    const box = document.getElementById(boxId);
    if (box) { box.checked = false; box.disabled = true; }
  }
}

export async function initHumanVerificationBanner() {
  const got = await browser.storage.local.get(PENDING_KEY);
  if (got[PENDING_KEY]) lockSwitches();
  renderBanner(got[PENDING_KEY]);
  browser.storage.local.onChanged.addListener(changes => {
    if (!changes[PENDING_KEY]) return;
    renderBanner(changes[PENDING_KEY].newValue);
  });
}
