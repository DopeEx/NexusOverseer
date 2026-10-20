// Suggests an attack fleet for a pirate camp: for each ship type available on the
// source planet, binary-searches the smallest count that the game's own combat
// simulator reports as a win without any own losses, then adds a safety margin.
// Simulator answers are remembered across sessions (see pirate-plan-cache.js).

import {
  NEVER, cacheKey, enemySignature, fingerprintOf, loadCache, newRecord, recordResult, saveCache,
} from './pirate-plan-cache.js';

const SAFETY_MARGIN = 0.1;
const MAX_CANDIDATE_TYPES = 5;
// The simulator was ~11 points optimistic on remaining HP in a real comparison.
// Bump CACHE_VERSION in pirate-plan-cache.js whenever this changes.
const MIN_REMAINING_HP = 50;
// Research changes the player's bonuses, so the profile is re-read regularly.
const BOOT_TTL_MS = 60 * 60 * 1000;

let bootPromise = null;
let bootAt = 0;
let cacheEntries = null;
const validatedKeys = new Set();

function loadBoot() {
  if (!bootPromise || Date.now() - bootAt > BOOT_TTL_MS) {
    bootAt = Date.now();
    bootPromise = browser.runtime.sendMessage({ type: 'SIM_BOOTSTRAP' }).then(res => {
      if (!res || res.error) throw new Error(res?.error || 'No response from the combat simulator.');
      return res.data || res;
    }).catch(error => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

function bonusFingerprint(boot) {
  const ships = (boot.playerShips || []).map(s => [s.id, s.attack, s.hp, s.shieldHp]);
  return fingerprintOf({ profile: boot.ownProfile ?? null, ships });
}

function reportOf(response) {
  const result = response?.ok && response.data ? response.data : (response?.data || response);
  return result?.report ? result : null;
}

async function simulate(camp, shipDefId, quantity) {
  const response = await browser.runtime.sendMessage({
    type: 'SIM_RUN',
    attacker: {
      type: 'player', fleet: [{ shipDefId, quantity }], useOwnBonuses: true,
      attachLeadership: false, hangarAssignments: {},
    },
    defender: {
      type: 'pirate', pirateZone: camp.securityZone,
      fleet: camp.fleetIntel.map(s => ({ shipDefId: s.shipDefId, quantity: s.quantity })),
    },
  });
  if (response?.error) {
    throw Object.assign(new Error(response.error), { status: response.status, retryAfter: response.retryAfter });
  }
  const result = reportOf(response);
  if (!result) throw new Error('The simulator reply did not contain a combat report.');
  const outcome = result.exact?.outcome || result.report.outcome;
  const losses = Array.isArray(result.report.attackerLosses)
    ? result.report.attackerLosses
    : Object.values(result.report.attackerLosses || {});
  const lossFree = !losses.some(l => Number(l?.lost ?? l) > 0);
  const rounds = result.report.rounds || [];
  const hpPercent = Number(rounds[rounds.length - 1]?.attackerHpPercent ?? 0);
  return { clean: outcome === 'attacker_won' && lossFree && hpPercent >= MIN_REMAINING_HP, scaled: result.scale?.mode === 'scaled' };
}

// Smallest quantity in [1, max] with a clean win, or null if even `max` is not enough.
async function minCleanQuantity(ctx, shipDefId, max) {
  const key = cacheKey({ ...ctx.keyParts, shipDefId });
  let rec = cacheEntries[key] || newRecord();
  const probe = async quantity => {
    ctx.progress(`Simulating ${quantity} ships`);
    const r = await simulate(ctx.camp, shipDefId, quantity);
    ctx.simulations++;
    rec = recordResult(rec, quantity, r.clean, r.scaled);
    cacheEntries[key] = rec;
  };

  // A remembered answer is re-checked once per session with a single simulator run.
  if (!validatedKeys.has(key) && rec.hi !== NEVER) {
    ctx.progress('Checking cached result');
    const check = await simulate(ctx.camp, shipDefId, rec.hi);
    ctx.simulations++;
    if (!check.clean) rec = newRecord();
  }
  validatedKeys.add(key);

  if (rec.hi > max) {
    if (rec.lo < max) await probe(max);
    if (rec.hi > max) return null;
  }
  // Now rec.lo < rec.hi <= max: the answer lies in (rec.lo, rec.hi].
  while (rec.hi - rec.lo > 1) await probe(Math.floor((rec.lo + rec.hi) / 2));
  return { quantity: rec.hi, scaled: rec.scaled };
}

// available: {shipDefId → count on the source planet}. options.allowedShipIds
// (optional array) restricts the ship types considered; without it the strongest
// types are tried. Resolves to { ships, note } or { error }.
export async function suggestAttackFleet(camp, available, options = {}) {
  if (!camp.hasFleetIntel || !(camp.fleetIntel || []).length) {
    return { error: 'Scout the camp first — no fleet intel.' };
  }
  let boot;
  try { boot = await loadBoot(); } catch (error) { return { error: error.message }; }

  const allowed = options.allowedShipIds ? new Set(options.allowedShipIds.map(String)) : null;
  let candidates = (boot.playerShips || [])
    .filter(s => !s.isNpc && Number(s.attack) > 0 && (available[s.id] || 0) > 0
      && (!allowed || allowed.has(String(s.id))));
  if (!candidates.length) {
    return { error: allowed ? 'None of the template ships are available on this planet.' : 'No attack ships on this planet.' };
  }
  if (!allowed) {
    candidates = candidates
      .sort((a, b) => (b.attack * ((b.hp || 0) + (b.shieldHp || 0))) - (a.attack * ((a.hp || 0) + (a.shieldHp || 0))))
      .slice(0, MAX_CANDIDATE_TYPES);
  }

  const ctx = {
    camp,
    simulations: 0,
    progress: () => {},
    keyParts: {
      fingerprint: bonusFingerprint(boot),
      zone: camp.securityZone,
      signature: enemySignature(camp.fleetIntel),
    },
  };
  const found = [];
  try {
    cacheEntries = await loadCache();
    for (const [index, def] of candidates.entries()) {
      ctx.progress = phase => options.onProgress?.(
        `${index + 1}/${candidates.length}: ${def.name} — ${phase} (${ctx.simulations} simulations completed)`,
      );
      ctx.progress('Reading cached bounds');
      const r = await minCleanQuantity(ctx, def.id, available[def.id]);
      if (r) found.push({ def, ...r });
    }
  } catch (error) {
    return { error: `Simulation failed: ${error.message}`, status: error.status, retryAfter: error.retryAfter };
  } finally {
    if (cacheEntries) {
      await saveCache(cacheEntries).catch(error => {
        console.error('[NexusOverseer] Failed to save pirate planner cache:', error);
      });
    }
  }
  if (!found.length) {
    return { error: `No single ship type on this planet wins with ≥${MIN_REMAINING_HP}% HP left.` };
  }

  found.sort((a, b) => a.quantity - b.quantity || String(a.def.id).localeCompare(String(b.def.id)));
  const best = found[0];
  const quantity = Math.min(available[best.def.id], Math.ceil(best.quantity * (1 + SAFETY_MARGIN)));
  const alt = found.slice(1, 3).map(o => `${o.quantity}× ${o.def.name}`).join(', ');
  const note = `Suggested: ${quantity}× ${best.def.name} (minimum ${best.quantity} for ≥${MIN_REMAINING_HP}% HP left, +${SAFETY_MARGIN * 100}% margin).`
    + (alt ? `\nAlternatives: ${alt}` : '')
    + (best.scaled ? '\nLarge battle — simulator values are estimates.' : '');
  return { ships: { [best.def.id]: quantity }, note };
}
