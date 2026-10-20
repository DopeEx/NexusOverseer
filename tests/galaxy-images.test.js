import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { galaxyImagePath, appendGalaxyImage } from '../nexus-addon/galaxy-images.js';
import { saveSystem, readSystem, saveCatalog, exportGalaxyCache, restoreGalaxyCache } from '../nexus-addon/galaxy-cache.js';

test('planet and moon image paths use the verified endpoints and reject untrusted paths', () => {
  assert.equal(galaxyImagePath('planets', { planetType: 'gas_giant' }), '/api/images/planets/gas_giant.webp');
  assert.equal(galaxyImagePath('moons', { moonType: 'metallic' }), '/images/moons/metallic.webp');
  assert.equal(galaxyImagePath('moons', { imagePath: '/images/moons/icy.webp' }), '/images/moons/icy.webp');
  for (const body of [
    { moonType: '../private' }, { imagePath: 'https://example.com/image.webp' },
    { imagePath: '/images/moons/../../secret.webp' }, {},
  ]) assert.equal(galaxyImagePath('moons', body), null);
  assert.equal(galaxyImagePath('asteroidFields', { planetType: 'terra' }), null);
});

test('all six known star types reuse the brighter gas giant asset without guessing unknown stars', () => {
  for (const starType of ['yellow', 'orange', 'red_dwarf', 'blue_giant', 'white_dwarf', 'neutron']) {
    assert.equal(galaxyImagePath('systems', { starType }), '/api/images/planets/gas_giant.webp');
  }
  for (const starType of [undefined, 'unknown', '../orange', 'constructor']) {
    assert.equal(galaxyImagePath('systems', { starType }), null);
  }
});

test('relative image paths survive old base data, partial observations and backup restoration', async () => {
  await restoreGalaxyCache();
  const at = Date.now() - 30 * 86400000;
  await saveSystem('s0', 1, {
    planets: [{ id: 11, planetType: 'terra' }],
    moons: [{ id: 111, planetId: 11, moonType: 'icy' }],
  }, at);
  await saveSystem('s0', 1, { planets: [{ id: 11, userId: null }] });
  await saveCatalog('s0', '/api/galaxy/sectors/66/systems', {
    systems: [{ id: 3101, starType: 'orange', seed: 1964548820 }],
  });
  const backup = await exportGalaxyCache();
  await restoreGalaxyCache(backup);
  const entry = await readSystem('s0', 1);
  assert.equal(entry.data.planets[0].imagePath, '/api/images/planets/terra.webp');
  assert.equal(entry.data.moons[0].imagePath, '/images/moons/icy.webp');
  assert.equal(entry.data._galaxyCache.times.moons, at);
  const restored = await exportGalaxyCache();
  assert.deepEqual(restored.entries.find(row => row.key === '/api/galaxy/sectors/66/systems').data.systems,
    [{ id: 3101, starType: 'orange', seed: 1964548820 }]);
});

test('image rendering uses the active origin, preserves labels and reports a missing asset once', () => {
  const warnings = [];
  const previousDocument = globalThis.document;
  const warn = console.warn;
  const element = () => ({
    children: [], listeners: {}, textContent: '',
    addEventListener(type, fn) { this.listeners[type] = fn; },
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
  });
  globalThis.document = { createElement: element };
  console.warn = text => warnings.push(text);
  try {
    const cell = element();
    cell.textContent = 'Terra A';
    appendGalaxyImage(cell, 'planets', { planetType: 'terra' }, 'https://beta.nexuslegacy.space');
    const [image, label] = cell.children[0].children;
    assert.equal(image.src, 'https://beta.nexuslegacy.space/api/images/planets/terra.webp');
    assert.equal(label.textContent, 'Terra A');
    assert.equal(image.loading, 'lazy');
    assert.equal(image.alt, '');
    image.listeners.error();
    assert.equal(image.hidden, true);
    assert.equal(cell.children[0].title, 'Image unavailable');
    assert.equal(warnings.length, 1);
    for (const starType of ['yellow', 'orange', 'red_dwarf', 'blue_giant', 'white_dwarf', 'neutron']) {
      const star = element();
      star.textContent = 'B16-1';
      appendGalaxyImage(star, 'systems', { starType }, 'https://beta.nexuslegacy.space');
      const [thumbnail, name] = star.children[0].children;
      assert.equal(thumbnail.src, 'https://beta.nexuslegacy.space/api/images/planets/gas_giant.webp');
      assert.equal(thumbnail.className, `finder-body-image finder-star-${starType}`);
      assert.equal(name.textContent, 'B16-1');
      assert.match(star.children[0].title, /Tinted gas giant placeholder/);
    }
    const other = element();
    appendGalaxyImage(other, 'planets', { planetType: 'terra' }, 'https://beta.nexuslegacy.space');
    other.children[0].children[0].listeners.error();
    assert.equal(warnings.length, 1);
  } finally {
    globalThis.document = previousDocument;
    console.warn = warn;
  }
});
