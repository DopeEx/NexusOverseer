const WORK_LABEL = {
  survey: 'Surveying', investigate: 'Investigating', collect_debris: 'Collecting',
  collect_salvage: 'Collecting', expedition: 'Exploring', xeno_survey: 'Surveying ruins',
  mine: 'Mining', raid: 'Raiding', patrol: 'Patrolling', scout_camp: 'Scouting',
  attack_pirates: 'Attacking',
};
const WORK_COLOR = {
  survey: '#3ec6ff', investigate: '#60a5fa', collect_debris: '#2dd4bf',
  collect_salvage: '#8b5cf6', expedition: '#f59e0b', xeno_survey: '#a78bfa',
  scout_camp: '#ffc070', attack_pirates: '#ff6b7a',
};
const WORK_GRADIENT = {
  survey: 'linear-gradient(90deg, #3ec6ff 0%, #7f77ff 100%)',
  investigate: 'linear-gradient(90deg, #60a5fa 0%, #6366f1 100%)',
  collect_debris: 'linear-gradient(90deg, #2dd4bf 0%, #38bdf8 100%)',
  collect_salvage: 'linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)',
  expedition: 'linear-gradient(90deg, #f59e0b 0%, #ffc070 100%)',
  xeno_survey: 'linear-gradient(90deg, #a78bfa 0%, #c4b5fd 100%)',
};
const WORK_STATUS = new Set([
  'surveying', 'investigating', 'collecting', 'exploring', 'mining', 'raiding',
  'patrolling', 'scouting', 'attacking', 'on_site',
]);

function timestamp(value) {
  const at = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

export function usesFleetSlot(mission) {
  return (mission.missionType || mission.type) !== 'patrol';
}

export function usedFleetSlots(missions = []) {
  return missions.filter(usesFleetSlot).length;
}

// Pure evaluation shared by raw API missions, dashboard summaries and saved runs.
// A server-reported phase never advances just because a local deadline elapsed.
export function missionProgress(m, now = Date.now()) {
  const type = m.missionType || m.type;
  const dep = timestamp(m.departsAt) ?? timestamp(m.createdAt);
  const arr = timestamp(m.arrivesAt);
  const rdep = timestamp(m.returnDepartsAt);
  const rarr = timestamp(m.returnArrivesAt);
  const cargo = m.cargo || {};
  let status = m.status;
  if (!status) {
    if (arr != null && now < arr) status = 'outbound';
    else if (rdep != null && now < rdep) status = 'on_site';
    else if (rarr != null) status = 'returning';
    else status = 'on_site';
  }

  let label = status.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  let color = '#b9cbdc', gradient;
  let start = null, end = null, eventLabel;
  if (status === 'outbound' || status === 'dispatched') {
    label = 'Outbound';
    color = '#63dbe7';
    gradient = 'linear-gradient(90deg, #227eaa 0%, #63dbe7 100%)';
    start = dep; end = arr; eventLabel = 'Arrival';
  } else if (status === 'returning') {
    color = '#8b5cf6';
    gradient = 'linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)';
    start = rdep; end = rarr; eventLabel = 'Return';
  } else if (WORK_STATUS.has(status)) {
    if (status === 'on_site') label = WORK_LABEL[type] || 'On site';
    if (status === 'surveying' && type === 'xeno_survey') label = WORK_LABEL[type];
    color = WORK_COLOR[type] || '#47d4ff';
    gradient = WORK_GRADIENT[type];
    start = arr; end = rdep; eventLabel = 'Departure';
    if (status === 'mining' || (status === 'on_site' && type === 'mine')) {
      start = timestamp(cargo._cycleStartedAt) ?? timestamp(m.cycleStartedAt);
      end = timestamp(cargo._nextCycleAt) ?? timestamp(m.nextCycleAt);
      eventLabel = 'Next cycle';
    } else if (status === 'collecting' || (status === 'on_site' && /^collect_/.test(type))) {
      // Collection departure times can be rolling estimates, not return evidence.
      start = timestamp(cargo._cycleStartedAt);
      end = timestamp(cargo._nextCycleAt) ?? rdep;
      eventLabel = 'Collection update';
    } else if (status === 'exploring' || (status === 'on_site' && type === 'expedition')) {
      const travelMs = Number(m.travelTime) * 1000;
      start = dep != null && travelMs > 0 ? dep + travelMs : null;
      end = arr; eventLabel = 'Exploration ends';
    } else if (status === 'patrolling' || (status === 'on_site' && type === 'patrol')) {
      start = dep; end = arr; eventLabel = 'Patrol ends';
    }
  }
  const event = end == null ? null : { label: eventLabel, at: end };
  const determinate = start != null && end != null && end > start;
  const frac = determinate ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 0;
  return {
    status, label, color, gradient, event, determinate, frac,
    eta: end == null ? 0 : Math.max(0, end - now),
    needsRefresh: end != null && now >= end,
  };
}
