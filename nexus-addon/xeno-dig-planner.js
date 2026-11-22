export function xenoEntrances(chain) {
  if (!chain?.site || !Array.isArray(chain.garrison)) return [];
  return [
    { id: 'main', trace: chain.trace, label: `Main (${chain.trace})`, garrison: chain.garrison },
    ...(Array.isArray(chain.sideEntrances) ? chain.sideEntrances : [])
      .filter(entry => typeof entry?.trace === 'string')
      .map(entry => ({ id: entry.trace, trace: entry.trace, label: `Side (${entry.trace})`, garrison: entry.garrison })),
  ];
}

export function xenoCandidates(ships, available, zone, leadershipMass = 0) {
  const limit = Number(zone?.massLimit);
  const required = Number(zone?.excavators);
  const excavator = ships.find(ship => ship.key === 'excavator');
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(required) || required <= 0) {
    throw new Error('The zone is missing its mass limit or excavator requirement.');
  }
  if (!excavator || !Number.isFinite(excavator.hp) || excavator.hp <= 0) {
    throw new Error('Excavator hull data is unavailable.');
  }
  if ((available[excavator.id] || 0) < required) throw new Error(`At least ${required} undamaged excavators are required.`);
  const remaining = limit - required * excavator.hp - leadershipMass;
  if (remaining <= 0) throw new Error('Excavators and leadership leave no room for an escort.');
  const candidates = ships.filter(ship => ship.shipClass === 'combat' && !ship.isNpc
    && ship.shipSize && !['capital', 'huge'].includes(ship.shipSize)
    && Number.isFinite(ship.hp) && ship.hp > 0 && Number(ship.attack) > 0
    && (available[ship.id] || 0) > 0)
    .sort((a, b) => b.attack * (b.hp + (b.shieldHp || 0)) - a.attack * (a.hp + (a.shieldHp || 0)))
    .slice(0, 5)
    .map(ship => {
      const quantity = Math.min(available[ship.id], Math.floor(remaining / ship.hp));
      return {
        fleet: [{ shipDefId: ship.id, quantity }, { shipDefId: excavator.id, quantity: required }],
        mass: quantity * ship.hp + required * excavator.hp + leadershipMass,
        label: `${quantity}× ${ship.name} + ${required}× ${excavator.name}`,
      };
    }).filter(candidate => candidate.fleet[0].quantity > 0);
  if (!candidates.length) throw new Error('No eligible combat escort fits the mass limit.');
  return candidates;
}

export function xenoTemplateCandidate(ships, available, zone, leadershipMass, template) {
  const required = Number(zone?.excavators);
  const limit = Number(zone?.massLimit);
  const excavator = ships.find(ship => ship.key === 'excavator');
  if (!excavator || !Number.isSafeInteger(required) || required <= 0
    || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Zone or excavator data is incomplete.');
  const wanted = Object.entries(template.ships || {}).map(([id, quantity]) => ({ id: Number(id), quantity }));
  if (!wanted.length || wanted.some(item => !Number.isSafeInteger(item.id)
    || !Number.isSafeInteger(item.quantity) || item.quantity < 0)) throw new Error('The fleet template is invalid or empty.');
  const selected = wanted.filter(item => item.quantity > 0);
  if (!selected.length) throw new Error('The fleet template has no ships.');
  const excavators = selected.find(item => item.id === excavator.id);
  if (excavators && excavators.quantity !== required) throw new Error(`The template must contain exactly ${required} excavators.`);
  if (!excavators) selected.push({ id: excavator.id, quantity: required });
  let mass = leadershipMass;
  const labels = [];
  for (const item of selected) {
    const def = ships.find(ship => ship.id === item.id);
    if (!def || !def.shipSize || !Number.isFinite(def.hp) || def.hp <= 0) {
      throw new Error(`Hull data is missing for ship ${item.id}.`);
    }
    if (['capital', 'huge'].includes(def.shipSize)) throw new Error(`${def.name} cannot enter the tunnel.`);
    if ((available[item.id] || 0) < item.quantity) throw new Error(`Not enough undamaged ${def.name} on this planet.`);
    mass += item.quantity * def.hp;
    labels.push(`${item.quantity}× ${def.name}`);
  }
  if (mass > limit) throw new Error(`The template exceeds the estimated mass limit (${mass} / ${limit}).`);
  return { fleet: selected.map(item => ({ shipDefId: item.id, quantity: item.quantity })), mass, label: labels.join(' + ') };
}

export function xenoDefender(entrance, npcShips) {
  if (!Array.isArray(entrance.garrison) || !entrance.garrison.length) {
    throw new Error(`No garrison data for ${entrance.label}.`);
  }
  const fleet = entrance.garrison.map(guardian => {
    const def = npcShips.find(ship => ship.key === guardian.key && ship.isNpc);
    if (!def || !Number.isSafeInteger(guardian.quantity) || guardian.quantity <= 0) {
      throw new Error(`Invalid or unknown guardian: ${guardian.key || 'missing'}.`);
    }
    return { shipDefId: def.id, quantity: guardian.quantity };
  });
  return { type: 'npc', fleet, useOwnBonuses: false, attachLeadership: false, npcZone: 'rift' };
}

export function xenoSimulationResult(result, excavatorId, required) {
  const report = result?.report;
  if (!report || !Array.isArray(report.attackerSurvivors) || !Array.isArray(report.attackerLosses)) {
    throw new Error('The simulator returned an incomplete combat report.');
  }
  if (!['attacker_won', 'defender_won', 'draw'].includes(report.outcome)
    || report.attackerLosses.some(ship => !Number.isSafeInteger(ship.destroyed) || !Number.isSafeInteger(ship.damaged)
      || ship.destroyed < 0 || ship.damaged < 0)) {
    throw new Error('The simulator returned an incomplete outcome or loss breakdown.');
  }
  const excavators = report.attackerSurvivors.find(ship => ship.shipDefId === excavatorId)?.quantity || 0;
  const destroyed = report.attackerLosses.reduce((sum, ship) => sum + ship.destroyed, 0);
  const damaged = report.attackerLosses.reduce((sum, ship) => sum + ship.damaged, 0);
  return {
    viable: report.outcome === 'attacker_won' && excavators >= Math.ceil(required / 2),
    outcome: report.outcome,
    excavators,
    destroyed,
    damaged,
    losses: report.attackerLosses,
    scaled: result.scale?.mode === 'scaled',
  };
}

export function compareXenoResults(a, b) {
  return Number(b.result.viable) - Number(a.result.viable)
    || a.result.destroyed - b.result.destroyed
    || a.result.damaged - b.result.damaged;
}

export function xenoLeadershipFingerprint(leadership) {
  const vessel = leadership?.vessel;
  if (!vessel || !leadership.combatStats) throw new Error('Leadership data is incomplete.');
  return JSON.stringify({
    callsign: vessel.callsign, level: vessel.level,
    commandAttack: vessel.commandAttack, commandDefense: vessel.commandDefense,
    commandLogistics: vessel.commandLogistics, commandInsight: vessel.commandInsight,
    combatStats: leadership.combatStats,
    effects: leadership.effectiveEquippedEffects, talents: leadership.talents,
  });
}

export function prepareXenoDig(snapshot, entry, overview, available, ships, leadership, mode) {
  const chain = overview?.chain;
  if (!entry?.result?.viable || !Number.isSafeInteger(snapshot?.planetId)
    || !Number.isSafeInteger(snapshot.siteMoonId) || typeof snapshot.leadership !== 'boolean'
    || !Array.isArray(entry.garrison) || !Array.isArray(entry.candidate?.fleet)) {
    throw new Error('This comparison lacks launch data. Run a new comparison.');
  }
  if (!chain?.site || chain.id !== snapshot.chainId || chain.site.moonId !== snapshot.siteMoonId
    || chain.zone !== snapshot.zone || chain.paused || !Number.isFinite(Date.parse(chain.expiresAt))
    || Date.parse(chain.expiresAt) <= Date.now()) {
    throw new Error('The active channel or dig site changed or expired. Run a new comparison.');
  }
  if (!Object.hasOwn(overview, 'liveDig') || overview.liveDig !== null) {
    throw new Error('A dig is already active or its status is unavailable.');
  }
  const entrance = xenoEntrances(chain).find(item => item.id === entry.entranceId);
  const canonicalGarrison = garrison => JSON.stringify(garrison.map(({ key, quantity }) => ({ key, quantity }))
    .sort((a, b) => a.key.localeCompare(b.key)));
  if (!entrance || !Array.isArray(entrance.garrison)
    || canonicalGarrison(entrance.garrison) !== canonicalGarrison(entry.garrison)) {
    throw new Error('The selected entrance or its garrison changed. Run a new comparison.');
  }
  if (!['careful', 'fast'].includes(mode) || !overview.config?.modes?.[mode]) {
    throw new Error('The selected dig mode is unavailable.');
  }
  let leadershipMass = 0;
  if (snapshot.leadership) {
    if (leadership?.vessel?.status !== 'ready' || leadership.vessel.currentPlanetId !== snapshot.planetId
      || !snapshot.leadershipFingerprint || xenoLeadershipFingerprint(leadership) !== snapshot.leadershipFingerprint) {
      throw new Error('The leadership vessel changed or is not ready. Run a new comparison.');
    }
    leadershipMass = leadership.combatStats.maxHull;
    if (!Number.isFinite(leadershipMass) || leadershipMass <= 0
      || leadership.combatStats.currentHull !== leadershipMass) {
      throw new Error('The leadership vessel is damaged or its mass is unknown.');
    }
  }
  if (!Array.isArray(ships) || !available || typeof available !== 'object') {
    throw new Error('Fleet inventory or ship definitions are unavailable.');
  }
  const fleet = entry.candidate.fleet;
  if (fleet.some(item => !Number.isSafeInteger(item.shipDefId) || item.shipDefId <= 0
    || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)
    || new Set(fleet.map(item => item.shipDefId)).size !== fleet.length) {
    throw new Error('The compared fleet is invalid. Run a new comparison.');
  }
  const candidate = xenoTemplateCandidate(ships, available, overview.config?.zones?.[chain.zone],
    leadershipMass, { ships: Object.fromEntries(fleet.map(item => [item.shipDefId, item.quantity])) });
  if (candidate.fleet.length !== fleet.length || candidate.mass !== entry.candidate.mass
    || snapshot.massLimit !== overview.config.zones[chain.zone].massLimit) {
    throw new Error('Fleet requirements or estimated mass changed. Run a new comparison.');
  }
  return { sourcePlanetId: snapshot.planetId, ships: fleet, attachLeader: snapshot.leadership,
    hangarAssignments: {}, mode, entrance: entrance.id, hall: false };
}
