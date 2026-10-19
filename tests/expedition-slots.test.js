import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBrowserStub } from './helpers.js';

test('expedition manual and automatic launches honor normal slots but ignore patrol capacity', async t => {
  makeBrowserStub();
  globalThis.browser.storage.local.onChanged = globalThis.browser.storage.onChanged;
  t.mock.method(globalThis, 'setInterval', () => 0);
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  const elements = new Map();
  const element = () => ({
    textContent: '', style: {}, dataset: {}, value: '', checked: false, children: [], listeners: {},
    classList: { add() {}, remove() {} },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  });
  const document = globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
  };
  let missions = [{ missionType: 'mine' }, { missionType: 'patrol' }];
  const messages = [];
  globalThis.browser.runtime.sendMessage = async message => {
    messages.push(message.type);
    if (message.type === 'GET_PLANETS') return { planets: [] };
    if (message.type === 'GET_SHIP_DEFS') return { ships: [] };
    if (message.type === 'GET_MISSIONS') return { missions, maxFleetSlots: 1 };
    throw new Error(`Unexpected request: ${message.type}`);
  };
  const module = await import('../nexus-addon/tabs/expeditions.js');
  await module.initExpeditionsTab();
  const auto = document.getElementById('e-auto');
  auto.checked = true;
  await module.runExpeditionAutomations();
  assert.match(document.getElementById('e-launch-active').textContent, /1\/1 fleet slots/);
  assert.match(document.getElementById('e-auto-status').textContent, /1\/1 fleet slots in use/);
  await document.getElementById('e-launch-btn').listeners.click();
  assert.equal(messages.includes('SEND_EXPEDITION'), false);
  assert.match(document.getElementById('e-launch-status').children.at(-1).textContent, /Cannot launch expedition: 1\/1/);

  missions = [{ missionType: 'patrol' }];
  await module.runExpeditionAutomations();
  assert.match(document.getElementById('e-launch-active').textContent, /0\/1 fleet slots/);
  assert.equal(document.getElementById('e-auto-status').children.at(-1).textContent, 'Select a planet first.');
});
