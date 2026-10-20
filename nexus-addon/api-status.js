const labels = {
  general: 'General', 'system-details': 'System details',
  'fuel-estimate': 'Fuel estimates', simulator: 'Simulator',
};

export function waitText(wait, now = Date.now()) {
  if (!wait) return '';
  const seconds = Math.max(1, Math.ceil((wait.until - now) / 1000));
  const scope = labels[wait.scope] || 'API';
  if (wait.reason === 'server') return `${scope}: API server pause (429), retry in ${seconds}s`;
  if (wait.reason === 'budget') return `${scope}: API budget pause, next release in ${seconds}s`;
  if (wait.reason === 'pacing') return `${scope}: API request spacing, next release in ${seconds}s`;
  if (wait.reason === 'running') return 'API request in progress';
  return 'API request queued; waiting for a request slot / higher-priority work';
}

export function statusView(status, now = Date.now()) {
  const waits = status.scopes.map(scope => scope.wait).filter(wait => wait?.until > now);
  const wait = waits.find(wait => wait.reason === 'server') ||
    waits.find(wait => wait.reason === 'budget') || waits[0];
  const counts = `${status.running} running / ${status.queued} queued`;
  const seconds = wait ? Math.max(1, Math.ceil((wait.until - now) / 1000)) : 0;
  const state = wait?.reason === 'server' ? 'server' : wait?.reason === 'budget' ? 'budget'
    : status.running || status.queued ? 'active' : 'ready';
  const summary = state === 'server' ? `API · server pause · ${seconds}s · ${counts}`
    : state === 'budget' ? `API · budget pause · ${seconds}s · ${counts}`
      : state === 'active' ? `API · ${counts}` : 'API · ready';
  const details = [
    new URL(status.origin).hostname,
    ...status.scopes.map(scope => {
      const local = scope.local.length
        ? scope.local.map(window => `${window.counted}/${window.limit} (${window.windowMs / 1000}s)`).join(' · ')
        : 'limit unknown';
      const server = scope.server.reportedRemaining == null ? ''
        : ` · Server: ${scope.server.reportedRemaining} left, ${Math.max(0, Math.floor((now - scope.server.observedAt) / 1000))}s ago${scope.server.resetAt <= now ? ' (stale)' : ''}`;
      const activity = scope.running || scope.queued ? ` · ${scope.running} running / ${scope.queued} queued` : '';
      const pause = scope.wait?.until > now
        ? ` · ${scope.wait.reason === 'server' ? 'API server pause (429)' : scope.wait.reason === 'budget' ? 'API budget pause' : 'API request spacing'} ${Math.max(1, Math.ceil((scope.wait.until - now) / 1000))}s`
        : '';
      return `${labels[scope.name]}: ${local}${activity}${server}${pause}`;
    }),
    'Local estimates; general count shared. Pauses apply per scope.',
  ];
  return { state, summary, details };
}

export function initApiStatus() {
  const panel = document.getElementById('api-status');
  if (!panel) return;
  const summary = document.getElementById('api-status-summary');
  const details = document.getElementById('api-status-details');
  const progress = document.getElementById('f-progress');
  const searchWait = document.getElementById('f-api-wait');
  const selector = document.getElementById('server-select');
  const compactNavigation = window.matchMedia('(max-width: 900px)');
  const position = () => {
    const target = document.getElementById(compactNavigation.matches ? 'api-status-header' : 'api-status-nav');
    target.appendChild(panel);
  };
  position();
  compactNavigation.addEventListener('change', position);
  let timer;
  let stopped = false;
  let busy = false;
  let lastError = '';

  async function refresh() {
    if (stopped || busy || document.hidden) return;
    busy = true;
    const selected = selector.value;
    const path = progress?.dataset.apiPath;
    try {
      const status = await browser.runtime.sendMessage({ type: 'GET_API_STATUS', ...(path ? { path } : {}) });
      if (stopped || selector.value !== selected) return;
      if (!status || status.error) throw new Error(status?.error || 'No scheduler status received.');
      if (new URL(status.origin).hostname !== `${selected}.nexuslegacy.space`) {
        throw new Error('Scheduler status belongs to a different universe; retrying.');
      }
      const view = statusView(status);
      panel.dataset.state = view.state;
      summary.textContent = view.summary;
      details.textContent = '';
      for (const text of view.details) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        details.appendChild(paragraph);
      }
      if (searchWait) {
        const wait = status.request;
        const shortPause = ['budget', 'server', 'pacing'].includes(wait?.reason) &&
          wait.until - Date.now() <= 1000;
        const text = path && progress.dataset.apiPath === path && !shortPause ? waitText(wait) : '';
        searchWait.textContent = text ? ` · ${text}` : '';
      }
      lastError = '';
    } catch (error) {
      if (stopped || selector.value !== selected) return;
      panel.dataset.state = 'error';
      summary.textContent = 'API · status unavailable';
      details.textContent = error.message;
      if (searchWait) searchWait.textContent = path && progress.dataset.apiPath === path ? ' · API status unavailable' : '';
      if (lastError !== error.message) console.error('[NexusOverseer] API status display failed:', error);
      lastError = error.message;
    } finally {
      busy = false;
    }
  }

  async function tick() {
    await refresh();
    if (!stopped) timer = setTimeout(tick, 1000);
  }
  const onChange = () => {
    summary.textContent = 'API · loading…';
    details.textContent = '';
    panel.dataset.state = 'loading';
    if (searchWait) searchWait.textContent = '';
    void refresh();
  };
  selector.addEventListener('change', onChange);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(timer);
    selector.removeEventListener('change', onChange);
    compactNavigation.removeEventListener('change', position);
    document.removeEventListener('visibilitychange', refresh);
  }, { once: true });
  void tick();
}
