import assert from 'node:assert/strict';
import test from 'node:test';
import { getSetting, loadSettings, resetSettings, setSettings } from '../nexus-addon/settings.js';
import { paginate } from '../nexus-addon/pagination.js';

test('table page size persists, validates input and clamps pages after changes', async t => {
  let stored = {};
  globalThis.nexusStorage = {
    getSettings: async () => stored,
    setSettings: async value => { stored = value; },
  };
  await loadSettings();
  assert.equal(getSetting('general.tablePageSize'), 25);
  assert.deepEqual([0, 1, 25, 26].map(length => paginate(Array(length)).pages), [1, 1, 1, 2]);
  assert.equal(paginate(Array(26), 1).rows.length, 1);
  assert.equal(paginate(Array(1), 1).page, 0);

  await setSettings({ 'general.tablePageSize': 10 });
  assert.equal(stored['general.tablePageSize'], 10);
  await loadSettings();
  assert.equal(paginate(Array(26), 2).rows.length, 6);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10']) {
    await assert.rejects(setSettings({ 'general.tablePageSize': invalid }), /positive whole number/);
    assert.equal(getSetting('general.tablePageSize'), 10);
  }
  await resetSettings('general.');
  assert.equal(getSetting('general.tablePageSize'), 25);
  assert.equal(Object.hasOwn(stored, 'general.tablePageSize'), false);
  const warning = t.mock.method(console, 'warn', () => {});
  stored = { 'general.tablePageSize': 0 };
  await loadSettings();
  assert.equal(getSetting('general.tablePageSize'), 25);
  assert.equal(warning.mock.callCount(), 1);
});
