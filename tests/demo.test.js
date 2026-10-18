import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDemoData, demoResponse, DEMO_NOW } from '../tools/demo/fixtures.js';
import { createDemoServer } from '../tools/demo/server.js';

test('demo fixtures are deterministic, fresh and internally consistent', () => {
  const data = createDemoData();
  assert.deepEqual(data, createDemoData());
  assert.equal(data.responses.GET_AUTH_ME.user.username, 'Demo Explorer');
  const shipIds = new Set(data.responses.GET_SHIP_DEFS.ships.map(s => s.id));
  for (const template of data.storage.fleet_templates) {
    for (const id of Object.keys(template.ships)) assert.ok(shipIds.has(Number(id)));
  }
  for (const p of data.planets) {
    assert.ok(data.systems.some(s => s.id === p.systemId));
    assert.equal(Object.values(p.fleet.classes).reduce((a, b) => a + b), p.fleet.total);
  }
  for (const mission of data.responses.GET_MISSIONS.missions) {
    assert.ok(Date.parse(mission.arrivesAt) > DEMO_NOW);
  }
  for (const field of data.fields) {
    assert.equal(field.zone, data.systems.find(s => s.id === field.systemId).securityZone);
  }
  for (const camp of data.responses.GET_PIRATE_CAMPS.camps) {
    assert.equal(camp.securityZone, data.systems.find(s => s.id === camp.systemId).securityZone);
  }
  data.storage.recent_reports[0].ore = 0;
  assert.notEqual(createDemoData().storage.recent_reports[0].ore, 0);
});

test('demo actions fail explicitly instead of falling through to a game API', () => {
  const data = createDemoData();
  for (const type of ['SEND_MINE', 'SEND_ATTACK_PIRATES', 'SIM_RUN', 'SCRAPE_NOW', 'UNKNOWN']) {
    assert.match(demoResponse(data, { type }).error, /No game request was sent/);
  }
  const response = demoResponse(data, { type: 'GET_PLANETS' });
  response.planets[0].name = 'changed';
  assert.equal(data.planets[0].name, 'Aurora');
  assert.deepEqual(demoResponse(data, { type: 'GET_SYSTEM_COORDS', ids: [1] })[1], data.systems[0]);
  assert.ok(demoResponse(data, { type: 'GET_SYSTEM_PLANETS', systemId: 3 }).asteroidFields.length);
  assert.match(demoResponse(data, { type: 'GET_SYSTEM_PLANETS', systemId: -1 }).error, /Unknown/);
});

test('demo browser storage is memory-only and resets on initialization', async () => {
  const previous = {
    Date: globalThis.Date, browser: globalThis.browser,
    nexusStorage: globalThis.nexusStorage, location: globalThis.location,
  };
  try {
    globalThis.location = { origin: 'http://127.0.0.1:4173' };
    await import('../tools/demo/browser.js?storage-test');
    assert.equal(Date.now(), DEMO_NOW);
    assert.equal(new Date().getTime(), DEMO_NOW);
    const local = globalThis.browser.storage.local;
    const changes = [];
    local.onChanged.addListener((change, area) => changes.push({ change, area }));
    await local.set({ example: { value: 1 } });
    const copy = await local.get('example');
    copy.example.value = 99;
    assert.equal((await local.get('example')).example.value, 1);
    assert.deepEqual(await local.get({ missing: 7 }), { missing: 7 });
    await local.remove('example');
    assert.deepEqual(await local.get('example'), {});
    assert.equal(changes[0].area, 'local');
    assert.deepEqual(changes[1].change.example.oldValue, { value: 1 });
    await assert.rejects(globalThis.nexusStorage.setActiveServer('s0'), /fictional/);
    await local.clear();
    assert.deepEqual(await local.get(null), {});
    await import('../tools/demo/browser.js?reset-test');
    assert.ok((await globalThis.browser.storage.local.get(null)).recent_reports.length);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('demo server isolates the real UI, blocks external connections and does not change addon files', async t => {
  const original = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const server = createDemoServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self';/);
  assert.match(response.headers.get('content-security-policy'), /img-src 'self' data:;/);
  const html = await response.text();
  assert.ok(html.includes('src="/demo/browser.js"'));
  assert.ok(!html.includes('src="server-storage.js"'));
  assert.ok(!html.includes('src="browser-polyfill.js"'));
  assert.ok(!html.includes('value="s0"'));
  assert.ok(html.includes('Fictional demo data'));
  assert.ok(html.includes('id="btn-import" disabled'));
  assert.equal(await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8'), original);
  const asteroidJs = await (await fetch(`${origin}/tabs/asteroids.js`)).text();
  assert.ok(!asteroidJs.includes('https://s0.nexuslegacy.space/images/resources/'));
  assert.ok(asteroidJs.includes('/images/resources/'));
  const icon = await fetch(`${origin}/images/resources/ore.webp`);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  for (const path of ['/package.json', '/.env', '/demo/server.js', '/..%5cpackage.json', '/%ZZ']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin, { method: 'POST' })).status, 405);
});
