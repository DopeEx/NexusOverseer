import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_INTERVAL, compareVersions, getReleaseStatus, initReleaseStatus } from '../nexus-addon/release-status.js';

const sha = 'a'.repeat(40);
function fixture({ channel = 'release', revision = 'v2.1.0', latest = 'v2.2.0', relation = 'ahead' } = {}) {
  const data = {};
  const calls = [];
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
  };
  const installation = { channel, revision };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const value = url.startsWith('extension:')
      ? installation
      : url.includes('/compare/')
        ? { status: relation, ahead_by: relation === 'ahead' ? 3 : 0 }
        : { tag_name: latest, draft: false, prerelease: false };
    return { ok: true, json: async () => value };
  };
  const versionLink = { textContent: 'v2.1.0', title: 'Show what is new' };
  const statusLink = { hidden: true };
  const runtime = { getManifest: () => ({ version: '2.1.0' }), getURL: file => `extension:${file}` };
  return { storage, installation, fetcher, calls, data, versionLink, statusLink, runtime, version: '2.1.0', now: 100 };
}

test('version comparison is numeric, handles four components and rejects invalid inputs', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.1', '2.1.0.0'), 0);
  assert.equal(compareVersions('2.1.0.1', '2.1'), 1);
  assert.equal(compareVersions('2.0', '2.1'), -1);
  for (const value of ['2.x', 'v2.1', '2.1-beta', '', null]) {
    assert.throws(() => compareVersions(value, '2.1'), /Invalid extension version/);
  }
});

test('store packages do not contact GitHub or write update cache', async () => {
  const f = fixture({ channel: 'store' });
  assert.equal(await getReleaseStatus(f), null);
  await initReleaseStatus(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'extension:.nexus-install.json');
  assert.deepEqual(f.data, {});
  assert.equal(f.statusLink.hidden, true);
  assert.equal(f.versionLink.textContent, 'v2.1.0');
});

test('stable check caches exactly six hours and omits credentials and referrers', async () => {
  const f = fixture();
  assert.equal((await getReleaseStatus(f)).newer, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal((await getReleaseStatus({ ...f, now: 100 + CHECK_INTERVAL - 1 })).latest, '2.2.0');
  assert.equal(f.calls.length, 1);
  await getReleaseStatus({ ...f, now: 100 + CHECK_INTERVAL });
  assert.equal(f.calls.length, 2);
});

test('changing installed revision invalidates cache even before six hours', async () => {
  const f = fixture({ channel: 'master', revision: sha });
  await getReleaseStatus(f);
  await getReleaseStatus({ ...f, installation: { channel: 'master', revision: 'b'.repeat(40) } });
  assert.equal(f.calls.length, 4);
});

test('explicit checks bypass the cache and update its result', async () => {
  const f = fixture();
  await getReleaseStatus(f);
  await getReleaseStatus({ ...f, force: true });
  assert.equal(f.calls.length, 2);
  await getReleaseStatus(f);
  assert.equal(f.calls.length, 2);
});

test('manual button shows progress, checks immediately and enforces cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ latest: 'v2.1.0' });
  let click;
  f.checkButton = {
    hidden: true,
    addEventListener(event, handler) { assert.equal(event, 'click'); click = handler; },
  };
  await initReleaseStatus(f);
  assert.equal(f.checkButton.hidden, false);
  assert.equal(f.checkButton.disabled, false);
  assert.match(f.checkButton.title, /Last check:/);
  click();
  assert.equal(f.checkButton.disabled, true);
  assert.equal(f.checkButton.textContent, 'Checking…');
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(f.statusLink.textContent, 'Up to date · just checked');
  const count = f.calls.length;
  click();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(f.calls.length, count);
  assert.equal(f.checkButton.disabled, true);
  t.mock.timers.tick(30000);
  assert.equal(f.checkButton.disabled, false);
});

test('store installations keep the manual check button hidden and unbound', async () => {
  const f = fixture({ channel: 'store' });
  f.checkButton = { hidden: true, addEventListener() { assert.fail('Store button bound'); } };
  await initReleaseStatus(f);
  assert.equal(f.checkButton.hidden, true);
});

test('dev ancestry distinguishes ahead, behind, identical and diverged, including equal versions', async () => {
  for (const relation of ['ahead', 'behind', 'identical', 'diverged']) {
    const f = fixture({ channel: 'master', revision: sha, latest: 'v2.1.0', relation });
    const status = await getReleaseStatus(f);
    assert.equal(status.relation, relation);
    assert.equal(status.newer, relation === 'behind');
    assert.match(f.calls[1].url, new RegExp(`/compare/v2.1.0\\.\\.\\.${sha}$`));
  }
  const ahead = await getReleaseStatus(fixture({ channel: 'master', revision: sha }));
  assert.equal(ahead.newer, false, 'Do not suggest a release behind this commit even with a higher version number');
});

test('footer retains version button, labels dev and renders independent update link', async () => {
  const stable = fixture();
  await initReleaseStatus(stable);
  assert.equal(stable.versionLink.textContent, 'v2.1.0');
  assert.equal(stable.statusLink.textContent, 'Update available: v2.2.0');
  assert.equal(stable.statusLink.href, 'https://github.com/DopeEx/NexusOverseer/releases/tag/v2.2.0');
  const dev = fixture({ channel: 'master', revision: sha, latest: 'v2.1.0' });
  await initReleaseStatus(dev);
  assert.equal(dev.versionLink.textContent, 'v2.1.0 · dev · aaaaaaa · ahead of release');
  assert.match(dev.versionLink.title, /3 commits ahead/);
  assert.equal(dev.statusLink.hidden, true);
});

test('offline and rate-limit failures remain visible and cached, never reported up to date', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  let requests = 0;
  const originalFetch = f.fetcher;
  f.fetcher = async (url, options) => {
    if (url.startsWith('extension:')) return originalFetch(url, options);
    requests++;
    return { ok: false, status: 403 };
  };
  await initReleaseStatus(f);
  await initReleaseStatus(f);
  assert.equal(requests, 1);
  assert.equal(f.statusLink.textContent, 'Update check unavailable');
  assert.match(f.statusLink.title, /403/);
  assert.equal(f.statusLink.hidden, false);
  const offline = fixture();
  offline.fetcher = async () => { throw new Error('offline'); };
  assert.equal((await getReleaseStatus(offline)).error, 'offline');
});

test('failed commit comparison keeps dev label without claiming ahead or hiding a newer release', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture({ channel: 'master', revision: sha });
  const originalFetch = f.fetcher;
  f.fetcher = async (url, options) => {
    if (url.includes('/compare/')) throw new Error('comparison offline');
    return originalFetch(url, options);
  };
  await initReleaseStatus(f);
  assert.equal(f.versionLink.textContent, 'v2.1.0 · dev · aaaaaaa');
  assert.match(f.versionLink.title, /comparison unavailable/i);
  assert.equal(f.statusLink.textContent, 'Update available: v2.2.0');
});

test('invalid or prerelease GitHub responses never produce update notices', async () => {
  for (const release of [
    { tag_name: 'v2.2.0', prerelease: true },
    { tag_name: 'v2.2.0', draft: true },
    { tag_name: 'v2.2-beta' },
    {},
  ]) {
    const f = fixture();
    f.fetcher = async () => ({ ok: true, json: async () => release });
    assert.ok((await getReleaseStatus(f)).error);
  }
  await assert.rejects(getReleaseStatus(fixture({ channel: 'master', revision: 'invalid' })), /commit identifier/);
});
