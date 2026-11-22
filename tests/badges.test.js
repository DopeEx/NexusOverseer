import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { allianceBadge, combatOutcomeBadge, formatBadgeLabel, listBadge, zoneBadge, zoneCell } from '../nexus-addon/common.js';

test('badge labels format categories while preserving names and technical labels', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  globalThis.document = { createElement: () => ({}) };
  assert.equal(formatBadgeLabel('ancient_signal'), 'Ancient signal');
  assert.equal(formatBadgeLabel('red_dwarf'), 'Red dwarf');
  assert.equal(formatBadgeLabel(null), 'Unknown');
  assert.equal(allianceBadge('MiXeD_Tag').textContent, '[MiXeD_Tag]');
  assert.equal(listBadge('GET').textContent, 'GET');
});

test('statistics and Galaxy Scout use the same zone badge, including unknown zones', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  globalThis.document = {
    createElement() {
      return {
        children: [],
        appendChild(child) { this.children.push(child); },
      };
    },
  };
  for (const zone of ['sentinel', 'open', 'dead', 'rift', null, 'unrecognized']) {
    const expected = zoneBadge(zone);
    const actual = zoneCell(zone).children[0];
    assert.equal(actual.className, expected.className);
    assert.equal(actual.textContent, expected.textContent);
  }
});

test('combat badges color outcomes from the player perspective', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  globalThis.document = { createElement: () => ({}) };
  for (const [outcome, attacker, label, tone] of [
    ['attacker_won', true, 'Victory', 'badge-success'],
    ['attacker_won', false, 'Defeat', 'badge-error'],
    ['defender_won', true, 'Defeat', 'badge-error'],
    ['defender_won', false, 'Victory', 'badge-success'],
    ['won', false, 'Victory', 'badge-success'],
    ['lost', false, 'Defeat', 'badge-error'],
    ['draw', true, 'Draw', 'badge-warning'],
  ]) {
    const badge = combatOutcomeBadge(outcome, attacker);
    assert.equal(badge.className, `badge ${tone}`);
    assert.equal(badge.textContent, label);
  }
  for (const [outcome, label] of [[null, 'Unknown'], ['—', 'Unknown'], ['not_won', 'Not won'], ['future_loss', 'Future loss']]) {
    const badge = combatOutcomeBadge(outcome);
    assert.equal(badge.className, 'badge');
    assert.equal(badge.textContent, label);
  }
});

test('Pirates reports render victory and defeat as outcome badges', async t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  const element = () => ({
    children: [], style: {},
    appendChild(child) { this.children.push(child); },
  });
  const elements = new Map();
  globalThis.document = {
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  const source = await readFile(new URL('../nexus-addon/tabs/pirates.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderPirateReports()'), source.indexOf('\nlet pcInited'));
  const context = vm.createContext({
    document: globalThis.document,
    pcReports: [
      { outcome: 'attacker_won', campId: 1 }, { outcome: 'defender_won', campId: 1 },
      { outcome: 'draw', campId: 1 }, { campId: 1 }, { outcome: 'future_loss', campId: 1 },
    ],
    pcReportsError: '', pcReportsPage: 0, pcCamps: [{ id: 1, name: 'Camp' }],
    paginate: rows => ({ rows, page: 0, total: rows.length }),
    updatePagination() {}, setStatusText() {},
    fleetText: () => '—', lossText: () => '—', resText: () => '—',
    combatOutcomeBadge,
  });
  vm.runInContext(`${render}\nrenderPirateReports();`, context);
  const rows = elements.get('pr-tbody').children;
  assert.deepEqual(rows.map(row => {
    const badge = row.children[2].children[0];
    return [badge.textContent, badge.className];
  }), [
    ['Victory', 'badge badge-success'],
    ['Defeat', 'badge badge-error'],
    ['Draw', 'badge badge-warning'],
    ['Unknown', 'badge'],
    ['Future loss', 'badge'],
  ]);
});

test('informational badges are outlined while evaluated outcomes stay filled', async () => {
  const css = await readFile(new URL('../nexus-addon/dashboard.css', import.meta.url), 'utf8');
  const declarations = selector => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').some(part => part.trim() === selector))
    .map(match => match[2]).join(';');

  assert.match(declarations('.badge'), /background:\s*transparent/);
  for (const selector of [
    '.badge.ancient_signal', '.badge.resource_cache', '.badge.rogue_drone',
    '.finder-alliance', '.finder-owner-free', '.finder-type-blue', '.finder-trace',
  ]) {
    const rule = declarations(selector);
    assert.match(rule, /color:/, selector);
    assert.doesNotMatch(rule, /background:/, selector);
  }
  for (const selector of ['.badge.badge-success', '.badge.badge-warning', '.badge.badge-error']) {
    assert.match(declarations(selector), /background:\s*var\(--(?:ok|warn|err)-bg\)/, selector);
  }
  assert.match(declarations('.badge.badge-outline'), /background:\s*transparent/);
});
