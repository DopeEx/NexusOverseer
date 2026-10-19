const API = 'https://api.github.com/repos/DopeEx/NexusOverseer';
const RELEASES = 'https://github.com/DopeEx/NexusOverseer/releases';
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const CACHE_KEY = 'manual_release_status_v1';

export function compareVersions(left, right) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d+(\.\d+){0,3}$/.test(value)) {
      throw new Error(`Invalid extension version: ${value}`);
    }
    return value.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 4; i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function requestJson(fetcher, url) {
  const response = await fetcher(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status})`);
  return response.json();
}

export async function getReleaseStatus({ installation, version, storage, fetcher = fetch, now = Date.now() }) {
  if (!['release', 'master'].includes(installation.channel)) return null;
  const revision = installation.revision || '';
  if (installation.channel === 'master' && !/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error('Manual development build has no valid commit identifier.');
  }
  const identity = `${installation.channel}:${revision}:${version}`;
  const cached = (await storage.get(CACHE_KEY))[CACHE_KEY];
  if (cached?.identity === identity && Number.isFinite(cached.checkedAt) &&
      now >= cached.checkedAt && now - cached.checkedAt < CHECK_INTERVAL) {
    return cached.result;
  }
  // Persist failed attempts too, to avoid hammering GitHub when offline/rate-limited.
  let result = { error: 'Release check did not complete.' };
  await storage.set({ [CACHE_KEY]: { identity, checkedAt: now, result } });
  try {
    const release = await requestJson(fetcher, `${API}/releases/latest`);
    if (release.draft || release.prerelease || typeof release.tag_name !== 'string') {
      throw new Error('GitHub did not return a stable release.');
    }
    const latest = release.tag_name.replace(/^v/, '');
    const newer = compareVersions(latest, version) > 0;
    result = { latest, newer, url: `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}` };
    if (installation.channel === 'master') {
      try {
        const comparison = await requestJson(fetcher,
          `${API}/compare/${encodeURIComponent(release.tag_name)}...${revision}`);
        if (!['ahead', 'behind', 'identical', 'diverged'].includes(comparison.status) ||
            !Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 0) {
          throw new Error('GitHub returned an invalid commit comparison.');
        }
        result.relation = comparison.status;
        result.ahead = comparison.ahead_by;
        if (['ahead', 'identical'].includes(comparison.status)) result.newer = false;
        if (comparison.status === 'behind') result.newer = true;
      } catch (error) {
        result.comparisonError = error.message;
      }
    }
  } catch (error) {
    result = { error: error.message };
  }
  await storage.set({ [CACHE_KEY]: { identity, checkedAt: now, result } });
  return result;
}

export async function initReleaseStatus({ versionLink, statusLink, runtime, storage, fetcher = fetch }) {
  const version = runtime.getManifest().version;
  const showFailure = message => {
    console.warn('[NexusOverseer] Release check:', message);
    statusLink.hidden = false;
    statusLink.textContent = 'Update check unavailable';
    statusLink.title = `${message} Open GitHub releases to check manually.`;
    statusLink.href = RELEASES;
  };
  try {
    const response = await fetcher(runtime.getURL('.nexus-install.json'));
    if (!response.ok) throw new Error(`Installation metadata unavailable (HTTP ${response.status})`);
    const installation = await response.json();
    if (!['release', 'master'].includes(installation.channel)) return;
    if (installation.channel === 'master') {
      versionLink.textContent = `v${version} · dev · ${(installation.revision || '').slice(0, 7)}`;
      versionLink.title = `Development build: ${installation.revision || 'unknown commit'}. Show what's new.`;
    }
    const check = () => getReleaseStatus({ installation, version, storage, fetcher });
    const status = globalThis.navigator?.locks
      ? await navigator.locks.request('nexus-manual-release-check', check)
      : await check();
    if (status.error) { showFailure(status.error); return; }
    if (installation.channel === 'master') {
      const relations = {
        ahead: `${status.ahead} commits ahead of release v${status.latest}`,
        behind: `Behind release v${status.latest}`,
        identical: `Same commit as release v${status.latest}`,
        diverged: `History diverges from release v${status.latest}`,
      };
      if (status.relation === 'ahead') versionLink.textContent += ' · ahead of release';
      versionLink.title += ` ${relations[status.relation] || 'Release comparison unavailable.'}`;
      if (status.comparisonError) showFailure(status.comparisonError);
    }
    if (status.newer) {
      statusLink.hidden = false;
      statusLink.href = status.url;
      statusLink.textContent = `Update available: v${status.latest}`;
      statusLink.title = 'Open the stable release. Use Update-Nexus.bat to install it, then reload the extension.';
      if (status.comparisonError) statusLink.title += ` Commit comparison unavailable: ${status.comparisonError}`;
    }
  } catch (error) {
    showFailure(error.message);
  }
}
