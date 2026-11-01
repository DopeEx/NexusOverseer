// Production figures as the game tooltips show them. The API rate fields exclude
// the account-wide development bonus (`starterProductionMultiplier`) and the
// population growth potential is damped by how full the housing is.

export const RESOURCE_RATE_KEYS = [
  'oreRate', 'silicatesRate', 'hydrogenRate', 'alloysRate',
  'cryoIceRate', 'quantumDustRate', 'plasmaCoreRate', 'bioExtractRate', 'darkMatterRate', 'antimatterRate',
];

// Accepts the top-level planet/moon response or a fleet response; the multiplier
// is sent both top-level and inside `resourceSnapshot`.
export function starterMultiplier(...responses) {
  for (const r of responses) {
    for (const v of [r?.starterProductionMultiplier, r?.resourceSnapshot?.starterProductionMultiplier]) {
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

export function scaledRates(entity, multiplier) {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return Object.fromEntries(RESOURCE_RATE_KEYS.map(k => [k, (entity?.[k] || 0) * m]));
}

// The tooltip growth equals potential * population * (1 - population / max) / 100.
export function effectivePopulationRate(population, max, potential) {
  if (!(max > 0) || !(potential > 0) || !(population >= 0)) return null;
  if (population >= max) return 0;
  return potential * population * (1 - population / max) / 100;
}

// Time until the population is within half a citizen of the cap, following the
// logistic curve implied by the damped growth (never reaches the cap exactly).
export function populationFullMs(population, max, potential) {
  if (!(max > 0) || !(potential > 0) || !(population >= 0)) return null;
  const target = max - 0.5;
  if (population >= target) return 0;
  if (population <= 0) return null;
  const rate = potential / 100;
  const hours = Math.log(((max - population) / population) / (max / target - 1)) / rate;
  return hours * 3600000;
}
