export const XENO_SURVEY_LIMIT = 5;

const SURVEY_REQUIRED_SHIPS = new Map([[2, 'Spy Probe'], [16, 'Hacker Ship']]);

export function xenoSurveyFleetError(ships, planetFleet) {
  if (!Array.isArray(ships) || !ships.length || ships.some(ship =>
    !Number.isSafeInteger(ship?.shipDefId) || ship.shipDefId <= 0 ||
    !Number.isSafeInteger(ship.quantity) || ship.quantity <= 0)) {
    return 'The survey fleet is empty or contains invalid ship quantities.';
  }
  const ids = new Set(ships.map(ship => ship.shipDefId));
  if (ids.size !== ships.length) return 'The survey fleet contains duplicate ship types.';
  const missing = [...SURVEY_REQUIRED_SHIPS].filter(([id]) => !ids.has(id)).map(([, name]) => name);
  if (missing.length) {
    return `A survey requires at least 1 Spy Probe and 1 Hacker Ship. Missing: ${missing.join(', ')}.`;
  }
  if (planetFleet === undefined) return null;
  if (planetFleet?.error) return `Could not check survey ships: ${planetFleet.error}`;
  const available = planetFleet?.available;
  if (!available || typeof available !== 'object' || Array.isArray(available)) {
    return 'Could not check survey ships: invalid availability response.';
  }
  const shortages = [];
  for (const ship of ships) {
    const count = Object.hasOwn(available, ship.shipDefId) ? available[ship.shipDefId] : 0;
    const name = SURVEY_REQUIRED_SHIPS.get(ship.shipDefId) || `Ship #${ship.shipDefId}`;
    if (!Number.isSafeInteger(count) || count < 0) return `Could not check the available quantity of ${name}.`;
    if (count < ship.quantity) shortages.push(`${name}: ${count} available, ${ship.quantity} required`);
  }
  return shortages.length ? `Full survey template unavailable. ${shortages.join('; ')}. Nothing was sent.` : null;
}

export function hasClassifiedMissions(snapshot) {
  return !snapshot?.error && Array.isArray(snapshot?.missions) &&
    snapshot.missions.every(mission => typeof mission?.missionType === 'string' && mission.missionType.length > 0);
}

export function xenoSurveyCount(missions) {
  return missions.filter(mission => mission.missionType === 'xeno_survey').length;
}

export function xenoSurveyLimitError(missions) {
  const count = xenoSurveyCount(missions);
  return count >= XENO_SURVEY_LIMIT
    ? `Survey limit reached (${count} / ${XENO_SURVEY_LIMIT} in transit, including returning fleets). Wait until fewer than ${XENO_SURVEY_LIMIT} survey fleets remain.`
    : null;
}

export function xenoMissionStatusesChanged(before, after) {
  const statuses = new Map(before.map(mission => [mission.id, mission.status]));
  return statuses.size !== after.length ||
    after.some(mission => !statuses.has(mission.id) || statuses.get(mission.id) !== mission.status);
}

export function xenoTargetExclusions(chain, missions) {
  const moonIds = new Set();
  const systemIds = new Set();
  for (const clue of Array.isArray(chain?.clues) ? chain.clues : []) {
    if (clue.moonId != null) moonIds.add(clue.moonId);
    if (clue.systemId != null) systemIds.add(clue.systemId);
  }
  for (const mission of missions) {
    if (mission.missionType !== 'xeno_survey') continue;
    const moonId = mission.targetMoonId
      ?? mission.cargo?._targetMoonId
      ?? mission.cargo?._xenoClue?.moonId;
    if (moonId != null) moonIds.add(moonId);
    if (mission.targetSystemId != null) systemIds.add(mission.targetSystemId);
  }
  return { moonIds, systemIds };
}

export async function* xenoSearchSystems(targets, zone, getSectorSystems, shouldContinue = () => true) {
  const sectors = new Map();
  let eligible = 0;
  for (const target of targets) {
    if (!shouldContinue() || eligible >= 500) return;
    if (zone) {
      const { s: system } = target;
      if (system.sectorId == null) throw new Error(`System ${system.id} has no sector ID.`);
      if (!sectors.has(system.sectorId)) {
        const response = await getSectorSystems(system.sectorId);
        if (!shouldContinue()) return;
        if (response?.error) throw new Error(`Could not check sector ${system.sectorId}: ${response.error}`);
        if (!Array.isArray(response?.systems)) throw new Error(`Sector ${system.sectorId} returned an invalid system list.`);
        sectors.set(system.sectorId, new Map(response.systems.map(item => [item?.id, item])));
      }
      const meta = sectors.get(system.sectorId).get(system.id);
      if (typeof meta?.securityZone !== 'string' || !meta.securityZone) {
        throw new Error(`System ${system.id} has no verified security zone.`);
      }
      if (meta.securityZone !== zone) continue;
    }
    eligible++;
    yield target;
  }
}

export async function findAvailableAncientMoon(
  moons, targetedMoonIds, getMoonDetails, shouldContinue = () => true, criteria = {},
) {
  for (const moon of moons) {
    if (!shouldContinue()) return null;
    if (moon.moonType !== 'ancient' || targetedMoonIds.has(moon.id)) continue;

    const details = await getMoonDetails(moon.id);
    if (!shouldContinue()) return null;
    if (!details || details.error) {
      throw new Error(details?.error || `Could not read Xeno details for moon ${moon.id}.`);
    }
    if (!Number.isFinite(details.cooldownRemainingSeconds) || details.cooldownRemainingSeconds < 0) {
      throw new Error(`Moon ${moon.id} returned an invalid Xeno cooldown.`);
    }
    if (typeof details.trace !== 'string' || !details.trace) {
      throw new Error(`Moon ${moon.id} returned no Xeno trace.`);
    }
    if (criteria.zone && (typeof details.zone !== 'string' || !details.zone)) {
      throw new Error(`Moon ${moon.id} returned no Xeno zone.`);
    }
    if ((criteria.trace && details.trace !== criteria.trace) || (criteria.zone && details.zone !== criteria.zone)) continue;
    if (details.cooldownRemainingSeconds === 0) return moon;
  }
  return null;
}

export async function campaignFromInFlightSurveys(missions, getMoonDetails) {
  const surveys = missions.filter(mission => mission.missionType === 'xeno_survey');
  if (!surveys.length) return null;

  const candidates = await Promise.all(surveys.map(async mission => {
    const moonId = mission.targetMoonId
      ?? mission.cargo?._targetMoonId
      ?? mission.cargo?._xenoClue?.moonId;
    if (moonId == null) throw new Error('An active Xeno survey has no target moon.');
    const details = await getMoonDetails(moonId);
    if (!details || details.error) {
      throw new Error(details?.error || `Could not read Xeno details for moon ${moonId}.`);
    }
    if (typeof details.trace !== 'string' || !details.trace ||
        typeof details.zone !== 'string' || !details.zone) {
      throw new Error(`Moon ${moonId} returned no active campaign trace or zone.`);
    }
    return { trace: details.trace, zone: details.zone };
  }));
  const unique = new Map(candidates.map(candidate => [`${candidate.trace}\u0000${candidate.zone}`, candidate]));
  if (unique.size > 1) {
    throw new Error('Active Xeno surveys report different traces or zones.');
  }
  return candidates[0];
}
