import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIONS, initHumanVerificationBanner, pauseAutomationsForHumanVerification } from '../nexus-addon/human-verification.js';

class Element {
  children = [];
  listeners = new Map();
  classList = { toggle() {} };
  checked = false;
  disabled = false;
  style = {};
  textContent = '';

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
}

test('human verification restores pirate attacks that were enabled before pausing', async t => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  const elements = new Map();
  const store = {};
  for (const [, boxId, statusId] of AUTOMATIONS) {
    elements.set(boxId, new Element());
    elements.set(statusId, new Element());
  }
  const banner = new Element();
  elements.set('hv-banner', banner);
  globalThis.document = {
    getElementById: id => elements.get(id) || null,
    createElement: () => new Element(),
  };
  globalThis.browser = {
    storage: {
      local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(values) { Object.assign(store, values); },
        async remove(key) { delete store[key]; },
        onChanged: { addListener() {} },
      },
    },
  };
  t.after(() => {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  });

  const attackSwitch = elements.get('pc-auto-attack');
  const scoutingSwitch = elements.get('sc-auto');
  const expeditionSwitch = elements.get('e-auto');
  attackSwitch.checked = true;
  scoutingSwitch.checked = true;
  await pauseAutomationsForHumanVerification('Human verification required');
  attackSwitch.checked = false;
  attackSwitch.disabled = true;
  scoutingSwitch.checked = false;
  scoutingSwitch.disabled = true;
  await initHumanVerificationBanner();

  const restoreButton = banner.children.at(-1);
  restoreButton.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(attackSwitch.checked, true);
  assert.equal(attackSwitch.disabled, false);
  assert.equal(scoutingSwitch.checked, true);
  assert.equal(scoutingSwitch.disabled, false);
  assert.equal(expeditionSwitch.checked, false);
  assert.equal(expeditionSwitch.disabled, false);
  assert.equal('human_verification_pending' in store, false);
});
