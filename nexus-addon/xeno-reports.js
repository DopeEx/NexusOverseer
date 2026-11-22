const CORE_RESOURCES = ['ore', 'silicates', 'hydrogen', 'alloys'];

function count(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Xeno report count.');
  return value;
}

export function xenoLoot(loot) {
  if (loot != null && (typeof loot !== 'object' || Array.isArray(loot))) {
    throw new Error('Invalid Xeno loot object.');
  }
  if (loot?.resources != null && (typeof loot.resources !== 'object' || Array.isArray(loot.resources))) {
    throw new Error('Invalid Xeno resource map.');
  }
  const resources = {};
  for (const [key, amount] of Object.entries(loot?.resources || {})) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid Xeno loot amount: ${key}.`);
    if (amount > 0) resources[key] = amount;
  }
  if (count(loot?.fragments) > 0) resources.precursor_fragments = loot.fragments;
  if (loot?.artifactTier != null && typeof loot.artifactTier !== 'string') {
    throw new Error('Invalid Xeno artifact tier.');
  }
  if (typeof loot?.artifactTier === 'string' && loot.artifactTier) resources.artifact = 1;
  return resources;
}

export function normalizeXenoReport(report) {
  if (!Number.isSafeInteger(report?.id) || report.id <= 0
    || !Number.isSafeInteger(report?.missionId) || report.missionId <= 0
    || typeof report?.createdAt !== 'string' || !Number.isFinite(Date.parse(report.createdAt))
    || typeof report?.outcome !== 'string' || !report.outcome
    || !report.report || typeof report.report !== 'object' || Array.isArray(report.report)) {
    throw new Error('Invalid Xeno dig report identity or result.');
  }
  const detail = report.report;
  const losses = Array.isArray(detail.shipsLost) ? detail.shipsLost : null;
  const lossCount = key => losses && losses.every(ship => count(ship?.[key]) !== null)
    ? losses.reduce((sum, ship) => sum + ship[key], 0) : null;
  const rawLosses = key => (losses || []).filter(ship => count(ship?.[key]) > 0)
    .map(ship => ({ shipDefId: ship.shipDefId, key: ship.key, quantity: ship[key] }));
  return {
    id: `xeno-dig-${report.id}`, mission_id: report.missionId,
    created_at: report.createdAt, kind: 'dig', event: report.outcome,
    location: [detail.moonName, detail.systemName].filter(Boolean).join(' · '),
    zone: report.zone ?? null, trace: report.trace ?? null,
    entrance: report.entranceTrace ?? null, mode: report.mode ?? null,
    loot: xenoLoot(detail.delivered), overflow: xenoLoot(detail.overflow),
    artifact_tier: detail.delivered?.artifactTier ?? null,
    ships_lost: lossCount('destroyed'), ships_damaged: lossCount('damaged'),
    ships_destroyed_raw: rawLosses('destroyed'), ships_damaged_raw: rawLosses('damaged'),
    excavators_sent: count(report.excavatorsSent), excavators_lost: count(report.excavatorsLost),
    rounds: count(detail.rounds), battle_report_id: report.battleReportId ?? null,
    report,
  };
}

function resourceBag() {
  return { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
}

function addLoot(bag, loot) {
  for (const [key, amount] of Object.entries(loot || {})) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid archived Xeno loot amount: ${key}.`);
    if (CORE_RESOURCES.includes(key)) bag[key] += amount;
    else bag.rare[key] = (bag.rare[key] || 0) + amount;
  }
}

export function xenoTotals(records) {
  const totals = { ...resourceBag(), missions: 0, digs: 0, successful_digs: 0,
    ships_lost: 0, ships_damaged: 0, excavators_sent: 0, excavators_lost: 0,
    rounds: 0, careful: 0, fast: 0, unknown_losses: 0, incomplete_reports: 0,
    overflow: resourceBag(), outcomes: {}, artifact_tiers: {}, monuments: {}, codex_entries: 0 };
  for (const record of records) {
    addLoot(totals, record.loot);
    addLoot(totals.overflow, record.overflow);
    totals.missions++;
    totals.ships_lost += record.ships_lost || 0;
    totals.ships_damaged += record.ships_damaged || 0;
    if (record.kind !== 'dig') continue;
    totals.digs++;
    if (record.event === 'success') totals.successful_digs++;
    totals.outcomes[record.event] = (totals.outcomes[record.event] || 0) + 1;
    if (record.mode === 'careful' || record.mode === 'fast') totals[record.mode]++;
    if (record.ships_lost === null || record.ships_damaged === null) totals.unknown_losses++;
    if ([record.ships_lost, record.ships_damaged, record.excavators_sent, record.excavators_lost, record.rounds]
      .some(value => value == null) || !record.report?.report?.delivered || !record.report?.report?.overflow) {
      totals.incomplete_reports++;
    }
    totals.excavators_sent += record.excavators_sent || 0;
    totals.excavators_lost += record.excavators_lost || 0;
    totals.rounds += record.rounds || 0;
    if (record.artifact_tier) {
      totals.artifact_tiers[record.artifact_tier] = (totals.artifact_tiers[record.artifact_tier] || 0) + 1;
    }
    const monument = record.report?.report?.monument;
    if (monument?.key && count(monument.copies) !== null) {
      totals.monuments[monument.key] = (totals.monuments[monument.key] || 0) + monument.copies;
    }
    if (record.report?.report?.codex) totals.codex_entries++;
  }
  return totals;
}
