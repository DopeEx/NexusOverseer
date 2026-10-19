import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadBridge(file, fetch) {
  let source = await readFile(new URL(`../nexus-addon/${file}`, import.meta.url), 'utf8');
  if (file === 'sidebar-inject.js') source = source.split('// ── Live-search matches window')[0];
  const listeners = [];
  const timeouts = [];
  const runtime = {
    getURL: path => path,
    onMessage: {
      addListener: fn => listeners.push(fn),
      removeListener() {},
    },
  };
  vm.runInNewContext(source, {
    browser: { runtime },
    fetch,
    AbortSignal: { timeout: ms => { timeouts.push(ms); return { timeout: ms }; } },
    document: { addEventListener() {}, getElementById: () => ({}), documentElement: {} },
    MutationObserver: class { observe() {} },
  });
  return { listener: listeners[0], timeouts };
}

for (const file of ['game-api-bridge.js', 'sidebar-inject.js']) {
  test(`${file}: bounds GET and POST requests and preserves API responses`, async () => {
    const requests = [];
    const { listener, timeouts } = await loadBridge(file, async (path, options) => {
      requests.push({ path, options });
      return {
        ok: true, status: 200,
        text: async () => '{"planets":[]}',
        headers: { get: () => null },
      };
    });
    assert.equal(listener({ type: 'OTHER' }, {}, () => assert.fail('unexpected response')), undefined);
    for (const method of ['GET', 'POST']) {
      const response = await new Promise(resolve => {
        assert.equal(listener({
          type: 'GAME_FETCH', path: '/api/planets', method,
          ...(method === 'POST' ? { body: { ships: [] } } : {}),
        }, {}, resolve), true);
      });
      assert.equal(response.ok, true);
      assert.equal(response.status, 200);
      assert.equal(response.data.planets.length, 0);
    }
    assert.deepEqual(timeouts, [20000, 20000]);
    assert.equal(requests[0].options.credentials, 'include');
    assert.equal(requests[0].options.signal.timeout, 20000);
    assert.equal(requests[0].options.body, undefined);
    assert.equal(requests[1].options.body, '{"ships":[]}');
  });

  test(`${file}: timeout during fetch or body read produces an explicit response`, async () => {
    for (const duringBody of [false, true]) {
      const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      const { listener } = await loadBridge(file, async () => {
        if (!duringBody) throw timeout;
        return { text: async () => { throw timeout; } };
      });
      const response = await new Promise(resolve => listener({
        type: 'GAME_FETCH', method: 'GET', path: '/api/planets',
      }, {}, resolve));
      assert.equal(response.networkError, true);
      assert.equal(response.error, 'API /api/planets timed out after 20 seconds.');
    }
  });
}

test('live-search requests identify failed messages and reject missing/API error responses', async () => {
  const source = await readFile(new URL('../nexus-addon/sidebar-inject.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('async function fieldsRequest('), source.indexOf('// Returns { count, name }'));
  let sendMessage;
  const context = vm.createContext({ ext: { runtime: { sendMessage: message => sendMessage(message) } } });
  vm.runInContext(helper, context);
  const request = message => context.fieldsRequest(message);
  sendMessage = async () => ({ planets: [] });
  assert.equal((await request({ type: 'GET_PLANETS' })).planets.length, 0);
  sendMessage = async () => { throw new Error('message channel closed'); };
  await assert.rejects(request({ type: 'GET_PLANETS' }), /GET_PLANETS: message channel closed/);
  sendMessage = async () => ({ error: 'Unauthorized' });
  await assert.rejects(request({ type: 'GET_AUTH_ME' }), /GET_AUTH_ME: Unauthorized/);
  sendMessage = async () => undefined;
  await assert.rejects(request({ type: 'GET_SHIP_DEFS' }), /GET_SHIP_DEFS: No response/);
});
