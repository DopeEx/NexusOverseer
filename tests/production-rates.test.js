import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectivePopulationRate, populationFullMs, scaledRates, starterMultiplier,
} from '../nexus-addon/production-rates.js';

test('development bonus is read top-level or from the resource snapshot', () => {
  assert.equal(starterMultiplier({ starterProductionMultiplier: 1.3435 }), 1.3435);
  assert.equal(starterMultiplier(null, { resourceSnapshot: { starterProductionMultiplier: 1.2 } }), 1.2);
  assert.equal(starterMultiplier({}, undefined), null);
  assert.equal(starterMultiplier({ starterProductionMultiplier: 0 }), null);
});

test('API rates are scaled to the tooltip values for planets and moons', () => {
  const m = 1.3435070373665132;
  const planet = scaledRates({ oreRate: 9602.567, bioExtractRate: 36.83112 }, m);
  assert.equal(Math.round(planet.oreRate), 12901);
  assert.equal(Math.round(planet.bioExtractRate), 49);
  assert.equal(planet.silicatesRate, 0);
  const moon = scaledRates({ oreRate: 1677.72, silicatesRate: 1652.868, hydrogenRate: 378.7 }, m);
  assert.equal(moon.oreRate.toFixed(0), '2254');
  assert.equal(moon.silicatesRate.toFixed(1), '2220.6');
  assert.equal(moon.hydrogenRate.toFixed(1), '508.8');
  assert.equal(scaledRates({ oreRate: 5 }, null).oreRate, 5);
});

test('population growth is damped towards the housing limit', () => {
  assert.equal(effectivePopulationRate(4600, 4600, 20.547), 0);
  assert.equal(effectivePopulationRate(2749.6116, 2760, 14.8).toFixed(1), '1.5');
  assert.ok(Math.abs(effectivePopulationRate(8374, 9142, 45.26) - 321) < 5);
  assert.equal(effectivePopulationRate(100, 0, 5), null);
});

test('population-full estimate follows the logistic curve', () => {
  assert.equal(populationFullMs(4600, 4600, 20.5), 0);
  const slow = populationFullMs(8374, 9142, 45.26);
  const fast = populationFullMs(5000, 9142, 45.26);
  assert.ok(slow > 0 && fast > slow);
  assert.equal(populationFullMs(0, 100, 5), null);
});
