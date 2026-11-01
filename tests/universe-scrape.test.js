import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBrowserStub } from './helpers.js';

const uniqueImport = (spec) => import(`${spec}?ts=${crypto.randomUUID()}`);

test('scrape visits every catalog universe with an open game tab', async () => {
  makeBrowserStub();
  globalThis.browser.alarms.get = async () => null;
  globalThis.location = { hostname: 'example.com', href: 'https://example.com/' };
  await uniqueImport('../nexus-addon/server-storage.js');

  const gameTabs = [
    { id: 1, url: 'https://s0.nexuslegacy.space/' },
    { id: 2, url: 'https://beta.nexuslegacy.space/' },
  ];
  const requests = [];
  globalThis.browser.tabs.query = async query => {
    if (query?.url === '*://*.nexuslegacy.space/*') return gameTabs;
    const tab = gameTabs.find(candidate => query?.url === `${new URL(candidate.url).origin}/*`);
    return tab ? [tab] : [];
  };
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    const tab = gameTabs.find(candidate => candidate.id === tabId);
    requests.push({ host: new URL(tab.url).hostname, path: message.path });
    return { ok: true, data: { planets: [] } };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://nexuslegacy.space/api/universes');
    return {
      ok: true,
      json: async () => [
        { key: 's0', name: 'S0' },
        { key: 'beta', name: 'Beta' },
      ],
    };
  };

  try {
    await uniqueImport('../nexus-addon/background.js');
    const listener = globalThis.browser.runtime.onMessage.listeners[0];
    const result = await listener({ type: 'SCRAPE_NOW' });

    assert.equal(result.ok, false);
    assert.match(result.error, /Some universe scrapes failed/);
    assert.deepEqual(
      requests.filter(request => request.path === '/api/planets').map(request => request.host).sort(),
      ['beta.nexuslegacy.space', 's0.nexuslegacy.space'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
