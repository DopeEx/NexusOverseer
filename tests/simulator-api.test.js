import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowserStub, setupDomStub, loadBackground } from './helpers.js';

setupDomStub();
const simulator = await import('../nexus-addon/tabs/simulator.js');

const report = {
  outcome: 'attacker_won',
  attackerSurvivors: [{ shipDefId: 5, key: 'fighter', quantity: 1462 }],
  defenderSurvivors: [],
  attackerLosses: [
    { shipDefId: 5, key: 'fighter', lost: 338, destroyed: 237, damaged: 101 },
  ],
  defenderLosses: [
    { shipDefId: -2100001, key: 'missile_defense', name: 'Missile Defense', lost: 10 },
  ],
};

test('lossEntries preserves the server destroyed/damaged split', () => {
  const [loss] = simulator.lossEntries(report.attackerLosses);
  assert.equal(loss.destroyed, 237);
  assert.equal(loss.damaged, 101);
  assert.equal(loss.lost, 338);
});

test('lossEntries tolerates object-shaped loss maps', () => {
  assert.deepEqual(simulator.lossEntries({ cruiser: { lost: 12 } }), [
    { key: 'cruiser', lost: 12 },
  ]);
  assert.deepEqual(simulator.lossEntries(undefined), []);
});

test('fleetRows uses the server survivor list and includes generated defenses', () => {
  const rows = simulator.fleetRows(
    { 5: 1800 },
    [...report.attackerSurvivors, { shipDefId: -9000432, key: 'leader_command_vessel', quantity: 1 }],
    report.attackerLosses,
  );
  const fighter = rows.find(row => row.shipDefId === 5);
  assert.equal(fighter.remain, 1462);
  assert.equal(fighter.lost, 338);
  const leader = rows.find(row => row.shipDefId === -9000432);
  assert.equal(leader.sent, 1);
  assert.equal(leader.remain, 1);

  const defense = simulator.fleetRows({}, [], report.defenderLosses)[0];
  assert.equal(defense.shipDefId, -2100001);
  assert.equal(defense.remain, 0);
});

test('simPayload unwraps the game-tab transport and rejects missing reports', () => {
  assert.deepEqual(simulator.simPayload({ ok: true, data: { report } }), { report });
  assert.equal(simulator.simPayload({ ok: true, data: {} }), null);
  assert.equal(simulator.simPayload(undefined), null);
});

test('SIM_RUN posts the official body through the game-tab bridge', async () => {
  const store = makeBrowserStub();
  const sent = [];
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = async (_tabId, message) => {
    sent.push(message);
    return { ok: true, data: { report } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const attacker = { type: 'player', fleet: [{ shipDefId: 5, quantity: 10 }] };
  const defender = { type: 'pirate', fleet: [{ shipDefId: 101, quantity: 2 }], pirateZone: 'open' };
  const response = await listener({ type: 'SIM_RUN', attacker, defender });

  assert.equal(response.ok, true);
  assert.equal(sent[0].type, 'GAME_FETCH');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, '/api/combat-simulator/simulate');
  assert.deepEqual(sent[0].body, { attacker, defender });
  assert.equal(store.last_error, undefined);
});

test('SIM_RUN rejects an empty attacker before issuing a game request', async () => {
  const store = makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  const response = await listener({ type: 'SIM_RUN', attacker: { fleet: [] }, defender: { fleet: [] } });
  assert.match(response.error, /Attacker needs/);
  assert.equal(store.last_error, undefined);
});

const simulationRequest = {
  type: 'SIM_RUN',
  attacker: { fleet: [{ shipDefId: 5, quantity: 10 }] },
  defender: { fleet: [{ shipDefId: 101, quantity: 2 }] },
};

async function simulationListener(sendMessage) {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.browser.tabs.query = async () => [{ id: 42, url: 'https://s0.nexuslegacy.space/' }];
  globalThis.browser.tabs.sendMessage = sendMessage;
  await loadBackground();
  return globalThis.browser.runtime.onMessage.listeners.at(-1);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('simulator requests bypass a held storage scope and stay pinned to the selected universe during retries', async t => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  await import(`../nexus-addon/server-storage.js?simulator=${Date.now()}`);
  const storage = globalThis.nexusStorage;
  await storage.setActiveServer('s0');
  const queries = [];
  let runs = 0;
  globalThis.browser.tabs.query = async query => {
    queries.push(query.url);
    return [{ id: query.url.includes('s0.') ? 42 : 99 }];
  };
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 42, 'never use the universe temporarily forced by the scrape');
    if (message.path.endsWith('/bootstrap')) return { ok: true, data: { playerShips: [] } };
    return ++runs === 1
      ? { status: 429, error: 'Too many requests' }
      : { ok: true, data: { report } };
  };
  await loadBackground();
  const listener = globalThis.browser.runtime.onMessage.listeners.at(-1);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const scrape = storage.withServer('beta', async () => {
    entered();
    await gate;
  });
  await ready;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let bootstrap;
  let result;
  const boot = listener({ type: 'SIM_BOOTSTRAP' }).then(value => { bootstrap = value; });
  const pending = listener(simulationRequest).then(value => { result = value; });
  try {
    await settle();
    assert.equal(bootstrap?.playerShips.length, 0, 'bootstrap must not wait for the scrape');
    assert.equal(runs, 1, 'simulation must start before the scrape releases its scope');
    await storage.setActiveServer('beta');
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(result?.ok, true, 'the retry must finish while the scrape still owns the scope');
    assert.deepEqual(queries, Array(3).fill('https://s0.nexuslegacy.space/*'));
    assert.equal((await storage.getActiveServer()).key, 'beta');
  } finally {
    release();
    await scrape;
  }
  await Promise.all([boot, pending]);
});

test('SIM_RUN serializes callers with an initial 500 ms response-to-request gap', async t => {
  const times = [];
  let finishFirst;
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    if (times.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    return { ok: true, data: { report } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const first = listener(simulationRequest);
  const second = listener(simulationRequest);
  const third = listener(simulationRequest);
  await settle();
  assert.deepEqual(times, [100000]);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(times.length, 1, 'no second request while the first is in flight');
  finishFirst();
  assert.equal((await first).ok, true);
  await settle();
  t.mock.timers.tick(499);
  await settle();
  assert.equal(times.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await second).ok, true);
  await settle();
  t.mock.timers.tick(500);
  assert.equal((await third).ok, true);
  assert.deepEqual(times, [100000, 110500, 111000]);
});

test('SIM_RUN waits on 429, retries the same payload and resumes queued callers', async t => {
  const now = Date.UTC(2026, 9, 20, 12);
  const cases = [
    { retryAfter: null, cooldown: 5000 },
    { retryAfter: '0', cooldown: 5000 },
    { retryAfter: '-5', cooldown: 5000 },
    { retryAfter: 'invalid', cooldown: 5000 },
    { retryAfter: '120', cooldown: 120000 },
    { retryAfter: new Date(now + 90000).toUTCString(), cooldown: 90000 },
    { retryAfter: '10', rateLimitReset: '180', cooldown: 180000 },
    { retryAfter: '2', rateLimitReset: '180', rateLimitRemaining: '350', cooldown: 5000 },
  ];
  for (const { cooldown, ...headers } of cases) {
    await t.test(JSON.stringify(headers), async t => {
      let calls = 0;
      const payloads = [];
      const listener = await simulationListener(async (_tab, message) => {
        calls++;
        payloads.push(message.body);
        return calls === 1
          ? { status: 429, error: 'Too many requests', ...headers }
          : { ok: true, data: { report } };
      });
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
      const first = listener(simulationRequest);
      const queued = listener(simulationRequest);
      await settle();
      assert.equal(calls, 1);
      t.mock.timers.tick(cooldown - 1);
      await settle();
      assert.equal(calls, 1);
      t.mock.timers.tick(1);
      assert.equal((await first).ok, true);
      assert.equal(calls, 2, 'the interrupted simulation resumes, not a new fleet search');
      assert.deepEqual(payloads[0], payloads[1]);
      await settle();
      t.mock.timers.tick(1000);
      assert.equal((await queued).ok, true);
      assert.equal(calls, 3);
    });
  }
});

test('SIM_RUN only aborts after four consecutive 429s and shares the final cooldown', async t => {
  const times = [];
  let fail = true;
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    return fail ? { status: 429, error: 'Too many requests' } : { ok: true, data: { report } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const first = listener(simulationRequest);
  const queued = listener(simulationRequest);
  await settle();
  for (const ms of [5000, 10000, 20000]) {
    t.mock.timers.tick(ms);
    await settle();
  }
  for (const response of await Promise.all([first, queued])) {
    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, '40');
    assert.match(response.error, /rate limit reached/);
  }
  assert.deepEqual(times, [100000, 105000, 115000, 135000]);
  t.mock.timers.tick(39999);
  assert.equal((await listener(simulationRequest)).status, 429);
  assert.equal(times.length, 4);
  t.mock.timers.tick(1);
  fail = false;
  assert.equal((await listener(simulationRequest)).ok, true);
  assert.equal(times.at(-1), 175000);
});

test('SIM_RUN keeps longer server cooldowns even after retry exhaustion', async t => {
  let calls = 0;
  const listener = await simulationListener(async () => {
    calls++;
    return { status: 429, error: 'Too many requests', retryAfter: '120' };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = listener(simulationRequest);
  await settle();
  for (let retry = 0; retry < 3; retry++) {
    t.mock.timers.tick(120000);
    await settle();
  }
  assert.equal((await pending).retryAfter, '120');
  assert.equal(calls, 4);
  t.mock.timers.tick(119999);
  assert.equal((await listener(simulationRequest)).status, 429);
  assert.equal(calls, 4);
});

test('SIM_RUN only speeds up after ten consecutive successes and stops at the 500 ms floor', async t => {
  let calls = 0;
  const listener = await simulationListener(async () => {
    calls++;
    return calls === 1 ? { status: 429, error: 'Too many requests' } : { ok: true, data: { report } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(5000);
  assert.equal((await pending).ok, true);
  for (let success = 1; success <= 111; success++) {
    const interval = Math.max(500, 1000 - Math.floor(success / 10) * 50);
    const before = calls;
    const next = listener(simulationRequest);
    await settle();
    t.mock.timers.tick(interval - 1);
    await settle();
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    assert.equal((await next).ok, true);
    assert.equal(calls, before + 1);
  }
});

test('SIM_RUN resets recovery progress when another 429 interrupts successful responses', async t => {
  let calls = 0;
  const listener = await simulationListener(async () => {
    calls++;
    return calls === 1 || calls === 11
      ? { status: 429, error: 'Too many requests' }
      : { ok: true, data: { report } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const first = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(5000);
  await first;
  for (let success = 0; success < 8; success++) {
    const next = listener(simulationRequest);
    await settle();
    t.mock.timers.tick(1000);
    await next;
  }
  const interrupted = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 11);
  t.mock.timers.tick(5000);
  assert.equal((await interrupted).ok, true);
  const next = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(calls, 12, 'one recovery success must not undo the second 429 slowdown');
  t.mock.timers.tick(1);
  assert.equal((await next).ok, true);
});

test('full five-type fleet searches stay bounded and survive a transient 429 without restarting', async t => {
  for (const limited of [false, true]) {
    await t.test(limited ? 'one transient 429' : 'no rate limit', async t => {
      const ships = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, name: `Ship ${i + 1}`, attack: 30, hp: 250,
      }));
      const probes = [];
      const listener = await simulationListener(async (_tab, message) => {
        if (message.path.endsWith('/bootstrap')) return { ok: true, data: { playerShips: ships } };
        const fleet = message.body.attacker.fleet[0];
        probes.push({ ...fleet });
        if (limited && probes.length === 5) return { status: 429, error: 'Too many requests' };
        return {
          ok: true,
          data: {
            report: {
              outcome: 'attacker_won', attackerLosses: [],
              rounds: [{ attackerHpPercent: fleet.quantity >= 7 ? 70 : 40 }],
            },
          },
        };
      });
      globalThis.browser.runtime.sendMessage = listener;
      const { suggestAttackFleet } = await import(`../nexus-addon/pirate-planner.js?integration=${limited}`);
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
      let result;
      const pending = suggestAttackFleet({
        hasFleetIntel: true, securityZone: 'open', fleetIntel: [{ shipDefId: 101, quantity: 2 }],
      }, Object.fromEntries(ships.map(ship => [ship.id, 1024]))).then(value => { result = value; });
      await settle();
      const maxElapsed = limited ? 60000 : 28000;
      for (let elapsed = 0; !result && elapsed < maxElapsed; elapsed += 250) {
        t.mock.timers.tick(250);
        await settle();
      }
      assert.ok(result, `the complete five-type search must finish within ${maxElapsed} simulated milliseconds`);
      await pending;
      assert.deepEqual(result.ships, { 1: 8 });
      assert.match(result.note, /minimum 7/);
      assert.equal(probes.length, limited ? 56 : 55);
      if (limited) assert.deepEqual(probes[4], probes[5], 'retry the failed probe without restarting the search');
      assert.ok(Date.now() - 100000 <= maxElapsed);
    });
  }
});

test('SIM_RUN observes the general API budget without treating small simulator budgets as exhausted', async t => {
  const times = [];
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    return {
      ok: true, data: { report }, rateLimitRemaining: '19', rateLimitReset: '5',
    };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  await listener({ type: 'GET_MISSIONS' });
  const first = listener(simulationRequest);
  await settle();
  assert.equal(times.length, 1);
  for (const ms of [2000, 2000, 1100]) {
    t.mock.timers.tick(ms);
    await settle();
  }
  assert.equal((await first).ok, true);
  assert.equal(times[1], 105100);
  const second = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(500);
  assert.equal((await second).ok, true);
  assert.equal(times[2], 105600);
});

test('simulator bootstrap and successful low-budget replies do not impose a global headroom pause', async t => {
  const times = [];
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    return { ok: true, data: { report }, rateLimitRemaining: '9', rateLimitReset: '60' };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  await listener({ type: 'SIM_BOOTSTRAP' });
  assert.equal((await listener(simulationRequest)).ok, true);
  const second = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(499);
  await settle();
  assert.equal(times.length, 2);
  t.mock.timers.tick(1);
  assert.equal((await second).ok, true);
  assert.deepEqual(times, [100000, 100000, 100500]);
});

test('SIM_RUN waits for an actually exhausted simulator budget even without a 429', async t => {
  const times = [];
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    return { ok: true, data: { report }, rateLimitRemaining: '0', rateLimitReset: '5' };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  await listener(simulationRequest);
  const second = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(times.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await second).ok, true);
  assert.deepEqual(times, [100000, 105000]);
});

test('SIM_RUN queue recovers after a transport failure without retrying it', async t => {
  let calls = 0;
  const listener = await simulationListener(async () => {
    if (++calls === 1) throw new Error('Game tab closed');
    return { ok: true, data: { report } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  assert.match((await listener(simulationRequest)).error, /Game tab closed/);
  const next = listener(simulationRequest);
  await settle();
  t.mock.timers.tick(2000);
  assert.equal((await next).ok, true);
  assert.equal(calls, 2);
});

test('other POSTs retain 429 retries and honour Retry-After HTTP dates', async t => {
  const now = Date.UTC(2026, 9, 20, 12);
  const times = [];
  const listener = await simulationListener(async () => {
    times.push(Date.now());
    return times.length === 1
      ? { status: 429, error: 'Too many requests', retryAfter: new Date(now + 5000).toUTCString() }
      : { ok: true, data: { fuel: 100 } };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const response = listener({ type: 'GET_FUEL_ESTIMATE', body: {} });
  await settle();
  assert.deepEqual(times, [now]);
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(times.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await response, { fuel: 100 });
  assert.deepEqual(times, [now, now + 5000]);
});

test('other POSTs stop retrying after five 429 responses', async t => {
  let calls = 0;
  const listener = await simulationListener(async () => {
    calls++;
    return { status: 429, error: 'Too many requests' };
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const response = listener({ type: 'GET_FUEL_ESTIMATE', body: {} });
  await settle();
  for (const ms of [5000, 5000, 5000, 8000]) {
    t.mock.timers.tick(ms);
    await settle();
  }
  assert.equal((await response).status, 429);
  assert.equal(calls, 5);
  const other = listener({ type: 'GET_AUTH_ME' });
  await settle();
  assert.equal(calls, 5, 'the final POST failure must also pause subsequent GET requests');
  t.mock.timers.tick(16000);
  await settle();
  assert.equal(calls, 6);
  // Let this GET exhaust its own bounded retries too.
  for (const ms of [5000, 5000, 5000]) {
    t.mock.timers.tick(ms);
    await settle();
  }
  assert.equal((await other).status, 429);
});
