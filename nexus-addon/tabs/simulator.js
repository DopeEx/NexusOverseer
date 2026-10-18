// Runs battles through the game's combat calculator, avoiding a parallel
// simulator that would drift from the server's balance and combat rules.

import { fmt, makeStatCard, setStatusText } from '../common.js';
import {
  loadIntelReports, populatePlanetPicker, updateDistanceFromCoords,
  shipDefs, shipDefById, shipIdByKey,
} from '../simulator-intel.js';

let boot = null;
let initPromise = null;

const BONUS_FIELDS = [
  ['attackBonus', 'Attack'], ['hpBonus', 'Ship HP'], ['shipShieldBonus', 'Ship shield'],
  ['damageReduction', 'Damage reduction'], ['shieldRegen', 'Shield regen'],
  ['nanobotRepair', 'Nanobot repair'], ['phaseShieldDodge', 'Phase shield dodge'],
  ['fleetTactics', 'Fleet tactics'], ['armorPierce', 'Armour pierce'],
  ['torpedoBonus', 'Torpedo'], ['ionDisableChance', 'Ion disable chance'],
  ['laserAttackBonus', 'Laser attack'], ['kineticAttackBonus', 'Kinetic attack'],
  ['plasmaAttackBonus', 'Plasma attack'], ['missileAttackBonus', 'Missile attack'],
  ['ionAttackBonus', 'Ion attack'], ['bomberAttackBonus', 'Bomber attack'],
  ['dreadnoughtAttackBonus', 'Dreadnought attack'],
];

function sideType(side) {
  return document.getElementById(`${side}-type`).value;
}

function shipsForSide(side) {
  if (!boot) return [];
  const type = sideType(side);
  const list = type === 'player'
    ? (boot.playerShips || []).filter(s => !s.isNpc)
    : (boot.npcShips || []).filter(s => s.isNpc);
  const pirates = new Set(boot.pirateShipIds || []);
  return (type === 'pirate' ? list.filter(s => pirates.has(s.id)) : list)
    .slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id);
}

function readQuantities(side) {
  const quantities = {};
  document.querySelectorAll(`input[data-side="${side}"][data-ship-id]`).forEach(input => {
    const quantity = Math.max(0, parseInt(input.value, 10) || 0);
    if (quantity) quantities[input.dataset.shipId] = quantity;
  });
  return quantities;
}

function buildFleetInputs(side) {
  const tbody = document.getElementById(`${side}-ships`);
  const previous = readQuantities(side);
  tbody.textContent = '';
  for (const def of shipsForSide(side)) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'ship-name';
    name.textContent = def.name || def.key;
    const stats = document.createElement('td');
    stats.className = 'ship-stats';
    stats.textContent = [
      def.hp != null ? `${fmt(def.hp)} hp` : '',
      def.shieldHp ? `${fmt(def.shieldHp)} sh` : '',
      def.attack ? `${fmt(def.attack)} atk` : '',
      def.weaponType || '',
    ].filter(Boolean).join(' · ');
    const inputCell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = 0;
    input.value = previous[def.id] || 0;
    input.dataset.side = side;
    input.dataset.shipId = def.id;
    input.dataset.key = def.key || def.reportKey;
    const survivors = document.createElement('span');
    survivors.className = 'survivors';
    survivors.dataset.survSide = side;
    survivors.dataset.shipId = def.id;
    inputCell.append(input, survivors);
    row.append(name, stats, inputCell);
    tbody.appendChild(row);
  }
}

function buildBonusInputs(side) {
  const grid = document.getElementById(`${side}-bonuses`);
  grid.textContent = '';
  const addInput = (key, label, integer = false) => {
    const wrap = document.createElement('label');
    wrap.append(`${label}${integer ? '' : ' %'}`);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'panel-toolbar-input';
    input.step = integer ? '1' : '0.1';
    input.min = 0;
    input.max = integer ? 5 : undefined;
    input.placeholder = '0';
    input.dataset.bonusSide = side;
    input.dataset.bonus = key;
    wrap.appendChild(input);
    grid.appendChild(wrap);
  };
  addInput('carrierHangarLevel', 'Carrier operations (0-5)', true);
  for (const [key, label] of BONUS_FIELDS) addInput(key, label);
}

function buildDefenseInputs() {
  const grid = document.getElementById('defender-defense');
  grid.textContent = '';
  for (const defense of boot?.planetaryDefense || []) {
    const wrap = document.createElement('label');
    wrap.append(defense.name || defense.key);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'panel-toolbar-input';
    input.min = 0;
    input.value = 0;
    input.dataset.defKey = defense.key;
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
}

function buildZoneOptions(side) {
  const select = document.getElementById(`${side}-zone`);
  select.textContent = '';
  for (const zone of boot?.pirateZones || []) {
    const key = typeof zone === 'string' ? zone : zone.key;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = (typeof zone === 'string' ? zone : zone.name || key).replace(/_/g, ' ');
    select.appendChild(option);
  }
}

function readBonuses(side) {
  const bonuses = {};
  document.querySelectorAll(`input[data-bonus-side="${side}"]`).forEach(input => {
    if (!input.value.trim()) return;
    const key = input.dataset.bonus;
    const value = Number(input.value) || 0;
    bonuses[key] = key === 'carrierHangarLevel'
      ? Math.min(5, Math.max(0, Math.floor(value)))
      : value / 100;
  });
  return bonuses;
}

function readDefenseLevels() {
  const levels = {};
  document.querySelectorAll('input[data-def-key]').forEach(input => {
    const level = Math.max(0, Math.floor(Number(input.value) || 0));
    if (level) levels[input.dataset.defKey] = level;
  });
  return levels;
}

function buildSide(side) {
  const type = sideType(side);
  const fleet = Object.entries(readQuantities(side))
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }));
  const useOwnBonuses = type === 'player' && document.getElementById(`${side}-own-bonuses`).checked;
  const levels = side === 'defender' && type === 'player' ? readDefenseLevels() : {};
  const percentage = id => (Number(document.getElementById(id).value) || 0) / 100;
  return {
    type,
    fleet,
    ...(type === 'player' ? {
      useOwnBonuses,
      attachLeadership: document.getElementById(`${side}-leadership`).checked,
      ...(!useOwnBonuses ? { bonuses: readBonuses(side) } : {}),
      hangarAssignments: {},
    } : {}),
    ...(type === 'pirate' ? { pirateZone: document.getElementById(`${side}-zone`).value } : {}),
    ...(Object.keys(levels).length ? {
      planetaryDefense: {
        levels,
        buildingHpBonus: percentage('def-building-hp-bonus'),
        planetaryDefenseBonus: percentage('def-planetary-bonus'),
      },
    } : {}),
  };
}

function applySideVisibility(side) {
  const type = sideType(side);
  const player = type === 'player';
  document.getElementById(`${side}-zone-wrap`).style.display = type === 'pirate' ? '' : 'none';
  document.getElementById(`${side}-player-opts`).style.display = player ? '' : 'none';
  document.getElementById(`${side}-bonuses`).style.display =
    player && !document.getElementById(`${side}-own-bonuses`).checked ? '' : 'none';
  if (side === 'defender') {
    document.getElementById('defender-defense-box').style.display = player ? '' : 'none';
  }
}

function wireSide(side) {
  document.getElementById(`${side}-type`).addEventListener('change', () => {
    buildFleetInputs(side);
    applySideVisibility(side);
  });
  document.getElementById(`${side}-own-bonuses`).addEventListener('change', () => {
    if (document.getElementById(`${side}-own-bonuses`).checked) {
      const otherSide = side === 'attacker' ? 'defender' : 'attacker';
      document.getElementById(`${otherSide}-own-bonuses`).checked = false;
      applySideVisibility(otherSide);
    }
    applySideVisibility(side);
  });
}

export function initSimulatorTab() {
  if (!initPromise) {
    initPromise = doInitSimulatorTab().catch(error => {
      const status = document.getElementById('sim-status');
      status.textContent = `Could not initialize simulator: ${error.message}`;
      status.className = 'error';
      initPromise = null;
    });
  }
  return initPromise;
}

async function doInitSimulatorTab() {
  const status = document.getElementById('sim-status');
  status.textContent = "Loading the game's simulator…";
  const response = await browser.runtime.sendMessage({ type: 'SIM_BOOTSTRAP' });
  if (!response || response.error) throw new Error(response?.error || 'No response from game.');
  boot = response.data || response;
  for (const def of [...(boot.playerShips || []), ...(boot.npcShips || [])]) {
    const key = def.key || def.reportKey;
    if (key) shipDefs[key] = def;
  }
  if (!Object.keys(shipDefs).length) throw new Error('The game returned no ship definitions.');

  for (const side of ['attacker', 'defender']) {
    buildZoneOptions(side);
    buildBonusInputs(side);
    buildFleetInputs(side);
    wireSide(side);
    applySideVisibility(side);
  }
  buildDefenseInputs();
  if (boot.ownProfile?.bonusesAvailable === false) {
    for (const side of ['attacker', 'defender']) {
      const toggle = document.getElementById(`${side}-own-bonuses`);
      toggle.checked = false;
      toggle.disabled = true;
      applySideVisibility(side);
    }
  }
  if (!boot.ownProfile?.leadership?.available) {
    for (const side of ['attacker', 'defender']) {
      const toggle = document.getElementById(`${side}-leadership`);
      toggle.checked = false;
      toggle.disabled = true;
    }
  }

  const classSelect = document.getElementById('fleet-class');
  for (const className of [...new Set((boot.playerShips || []).map(s => s.shipClass).filter(Boolean))].sort()) {
    const option = document.createElement('option');
    option.value = className;
    option.textContent = className[0].toUpperCase() + className.slice(1);
    classSelect.appendChild(option);
  }
  await Promise.all([loadIntelReports(), populatePlanetPicker()]);
  status.textContent = `${Object.keys(shipDefs).length} ship types loaded from the game.`;
}

export function lossEntries(losses) {
  if (Array.isArray(losses)) return losses;
  return Object.entries(losses || {}).map(([key, value]) =>
    value && typeof value === 'object' ? { key, ...value } : { key, lost: Number(value) || 0 });
}

export function simPayload(response) {
  const result = response?.ok && response.data ? response.data : (response?.data || response);
  return result?.report ? result : null;
}

function mapById(entries, field) {
  const out = new Map();
  for (const entry of entries || []) {
    if (entry.shipDefId != null) out.set(Number(entry.shipDefId), Number(entry[field]) || 0);
    else {
      const id = shipIdByKey(entry.key);
      if (id != null) out.set(Number(id), Number(entry[field]) || 0);
    }
  }
  return out;
}

export function fleetRows(sent, survivors, losses) {
  const survived = mapById(survivors, 'quantity');
  const lost = mapById(lossEntries(losses), 'lost');
  const ids = new Set([...Object.keys(sent || {}).map(Number), ...survived.keys(), ...lost.keys()]);
  return [...ids].map(shipDefId => {
    const lostCount = lost.get(shipDefId) || 0;
    const sentCount = sent?.[shipDefId] ?? ((survived.get(shipDefId) || 0) + lostCount);
    return {
      shipDefId,
      sent: sentCount,
      lost: lostCount,
      remain: survived.has(shipDefId) ? survived.get(shipDefId) : Math.max(0, sentCount - lostCount),
    };
  });
}

function renderFleetResults(report) {
  const container = document.getElementById('fleet-results');
  container.textContent = '';
  for (const side of ['attacker', 'defender']) {
    const losses = lossEntries(report[`${side}Losses`]);
    const entries = fleetRows(readQuantities(side), report[`${side}Survivors`], losses);
    const card = document.createElement('section');
    card.className = `sim-fleet-card ${side}`;
    const heading = document.createElement('h3');
    heading.textContent = `${side === 'attacker' ? 'Attacker' : 'Defender'} survivors`;
    card.appendChild(heading);
    for (const { shipDefId, lost, remain } of entries) {
      const def = shipDefById(shipDefId);
      const line = document.createElement('div');
      line.className = 'sim-fleet-card-row';
      line.textContent = `${def?.name || String(shipDefId)}: ${fmt(remain)} remain, ${fmt(lost)} removed`;
      card.appendChild(line);
    }
    if (!entries.length) card.append('No ships');
    container.appendChild(card);
  }
}

function updateSurvivorInputs(side, losses) {
  const lost = mapById(lossEntries(losses), 'lost');
  const sent = readQuantities(side);
  document.querySelectorAll(`.survivors[data-surv-side="${side}"]`).forEach(span => {
    const id = Number(span.dataset.shipId);
    const quantity = Number(sent[id]) || 0;
    if (!quantity) { span.textContent = ''; return; }
    const remain = Math.max(0, quantity - (lost.get(id) || 0));
    span.textContent = `→ ${fmt(remain)} alive`;
    span.style.color = remain === quantity ? 'var(--success)' : remain ? 'var(--warning)' : 'var(--error)';
  });
}

function renderLosses(side, entries) {
  const container = document.getElementById(`${side}-losses`);
  container.textContent = '';
  const losses = lossEntries(entries).filter(item => Number(item.lost) > 0);
  if (!losses.length) { container.textContent = 'No losses'; return; }
  for (const loss of losses) {
    const row = document.createElement('div');
    const name = shipDefById(loss.shipDefId)?.name || loss.name || loss.key || 'Ship';
    row.textContent = `${fmt(loss.lost)}× ${name}` +
      (loss.destroyed != null || loss.damaged != null
        ? ` (${fmt(loss.destroyed)} destroyed, ${fmt(loss.damaged)} damaged)` : '');
    container.appendChild(row);
  }
}

function renderRounds(rounds) {
  const container = document.getElementById('rounds-log');
  container.textContent = '';
  document.getElementById('rounds-count').textContent = rounds?.length ? `(${rounds.length})` : '';
  for (const round of rounds || []) {
    const events = round.events || [];
    const damage = side => events.filter(event => event.side === side)
      .reduce((sum, event) => sum + (Number(event.totalDamage) || 0), 0);
    const destroyed = side => events.filter(event => event.side === side)
      .flatMap(event => event.shipsDestroyed || [])
      .map(item => `${fmt(item.lost)}× ${shipDefById(item.shipDefId)?.name || item.name || item.key}`);
    const row = document.createElement('div');
    row.className = 'sim-round-card';
    row.textContent = `Round ${round.round}: ${fmt(damage('attacker'))} attacker damage, ` +
      `${fmt(damage('defender'))} defender damage. ` +
      `Ships lost — attacker: ${destroyed('defender').join(', ') || 'none'}; ` +
      `defender: ${destroyed('attacker').join(', ') || 'none'}.`;
    container.appendChild(row);
  }
}

function renderResults(result) {
  const report = result.report;
  const outcome = result.exact?.outcome || report.outcome || 'unknown';
  const stats = document.getElementById('outcome-stats');
  stats.textContent = '';
  stats.append(makeStatCard('Outcome', outcome.replace(/_/g, ' ')));
  const rounds = result.exact?.rounds ?? result.summary?.averageRounds ?? report.rounds?.length ?? 0;
  stats.append(makeStatCard('Rounds', String(rounds)));
  if (result.scale?.mode === 'scaled') {
    stats.append(makeStatCard('Scaled battle', `÷${fmt(result.scale.factor)} — estimates`));
  }
  for (const leadership of report.leadershipOutcomes || []) {
    stats.append(makeStatCard(leadership.name || 'Leadership vessel',
      leadership.destroyed ? 'destroyed' : `${fmt(leadership.hullAfter)} hull remaining`));
  }
  renderFleetResults(report);
  updateSurvivorInputs('attacker', report.attackerLosses);
  updateSurvivorInputs('defender', report.defenderLosses);
  renderLosses('attacker', report.attackerLosses);
  renderLosses('defender', report.defenderLosses);
  renderRounds(report.rounds);

  const debris = document.getElementById('debris-stats');
  debris.textContent = '';
  const debrisValues = report.debris || {};
  for (const [key, value] of Object.entries(debrisValues)) {
    debris.append(makeStatCard(key.replace(/_/g, ' '), fmt(value)));
  }
  document.getElementById('results').style.display = '';
}

document.getElementById('btn-load-fleet').addEventListener('click', async function () {
  this.disabled = true;
  const status = document.getElementById('sim-status');
  try {
    const result = await browser.runtime.sendMessage({
      type: 'GET_FLEET', planetId: document.getElementById('fleet-planet').value,
    });
    if (result?.error) { setStatusText(status, `Load fleet failed: ${result.error}`); return; }
    const classSelect = document.getElementById('fleet-class');
    let total = 0;
    for (const input of document.querySelectorAll('input[data-side="attacker"][data-ship-id]')) {
      if (classSelect.value && shipDefById(input.dataset.shipId)?.shipClass !== classSelect.value) continue;
      const qty = result.fleet?.[input.dataset.key] || 0;
      input.value = qty;
      total += qty;
    }
    const selected = document.getElementById('fleet-planet').selectedOptions[0];
    const typeLabel = classSelect.value ? classSelect.selectedOptions[0]?.textContent : 'all types';
    setStatusText(status, `Loaded ${fmt(total)} ships (${typeLabel}) from ${selected?.textContent || 'selected planet'}.`);
    if (selected?.dataset.systemName) {
      document.getElementById('atk-system').value = selected.dataset.systemName;
      await updateDistanceFromCoords();
    }
  } catch (error) {
    setStatusText(status, `Load fleet failed: ${error.message}`);
  } finally {
    this.disabled = false;
  }
});

document.getElementById('btn-run').addEventListener('click', async function () {
  const status = document.getElementById('sim-status');
  if (!boot) { status.textContent = 'Simulator data not loaded yet.'; return; }
  const attacker = buildSide('attacker');
  const defender = buildSide('defender');
  if (!attacker.fleet.length) { status.textContent = 'Attacker needs at least one ship.'; return; }
  if (!defender.fleet.length && !defender.planetaryDefense) {
    status.textContent = 'Defender needs ships, or a planetary defence level.';
    return;
  }
  this.disabled = true;
  status.textContent = 'Asking the game to simulate…';
  try {
    await updateDistanceFromCoords();
    const response = await browser.runtime.sendMessage({ type: 'SIM_RUN', attacker, defender });
    if (response?.error) { status.textContent = response.error; return; }
    const result = simPayload(response);
    if (!result) {
      status.textContent = 'The game reply did not contain a combat report.';
      return;
    }
    renderResults(result);
    status.textContent = result.scale?.mode === 'scaled'
      ? `Simulated by the game, scaled ÷${fmt(result.scale.factor)} — results are estimates.`
      : `Simulated by the game — ${(result.report.rounds || []).length} rounds.`;
    document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    status.textContent = `Simulation failed: ${error.message}`;
  } finally {
    this.disabled = false;
  }
});

document.getElementById('btn-clear').addEventListener('click', () => {
  document.querySelectorAll('#simulator-content .fleet-table input').forEach(input => { input.value = 0; });
  document.querySelectorAll('.survivors').forEach(span => { span.textContent = ''; });
  document.getElementById('results').style.display = 'none';
});
