export const API_PRIORITY = Object.freeze({
  action: 0, interactive: 1, check: 2, bulk: 3, background: 4,
});

export function apiScope(path) {
  const pathname = path.split('?')[0];
  if (pathname === '/api/fleet/fuel-estimate') return 'fuel-estimate';
  if (/^\/api\/galaxy\/systems\/\d+\/planets$/.test(pathname)) return 'system-details';
  if (pathname.startsWith('/api/combat-simulator/')) return 'simulator';
  return 'general';
}

export function retryDelay(value, fallback = 5000) {
  if (value == null || String(value).trim() === '') return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : fallback;
}

const SCOPE_LIMITS = {
  'fuel-estimate': [[10000, 40], [60000, 120]],
  'system-details': [[10000, 30], [60000, 180]],
  simulator: [[10000, 3]],
};
const WINDOW_MARGIN_MS = 100;
const emptyBudget = () => ({ times: [], remaining: null, resetAt: 0, blockedUntil: 0 });

// The shared local ceiling is deliberately conservative across universes; header
// observations and endpoint cooldowns are kept separately for each origin.
export function createApiScheduler({ storage, key = 'nexus_api_scheduler_v1', record } = {}) {
  let state = { global: emptyBudget(), origins: {} };
  let persistence = Promise.resolve();
  let failure;
  const ready = storage ? storage.get(key).then(saved => {
    if (saved[key]?.global && saved[key]?.origins) state = saved[key];
  }).catch(error => { failure = error; }) : Promise.resolve();
  const queue = [];
  const reads = new Map();
  const active = new Set();
  let running = 0;
  let timer;
  let pumping = false;
  let repump = false;
  const recordEvent = (job, data) => record?.(job.origin, {
    id: job.id, source: job.source, scope: apiScope(job.path),
    consumers: [...job.consumers],
    priority: Object.keys(API_PRIORITY).find(name => API_PRIORITY[name] === job.priority),
    ...data,
  });

  function trafficSnapshot(job, now) {
    const host = originState(job.origin);
    return {
      contributors: Object.fromEntries(Object.entries(host.contributors || {})
        .map(([source, times]) => [source, times.filter(time => time > now - 60000).length])),
      localGeneral: state.global.times.filter(time => time > now - 60000).length,
      localScope: scopeState(job.origin, apiScope(job.path)).times.filter(time => time > now - 60000).length,
      serverRemaining: host.general.reportedRemaining ?? null,
      scopeServerRemaining: scopeState(job.origin, apiScope(job.path)).reportedRemaining ?? null,
      generalResetAt: host.general.resetAt,
      scopeResetAt: scopeState(job.origin, apiScope(job.path)).resetAt,
    };
  }

  function trackWait(job, now) {
    const reasons = waitsFor(job, now);
    if (!reasons.length) reasons.push({ reason: 'queue', scope: apiScope(job.path), until: null });
    for (const reason of reasons) {
      const previous = job.waitReasons.find(value => value.reason === reason.reason && value.scope === reason.scope && value.windowMs === reason.windowMs);
      if (!previous) {
        job.waitReasons.push(reason);
      } else if (reason.until > previous.until) previous.until = reason.until;
    }
    if (job.waitStartedAt == null) {
      job.waitStartedAt = now;
      recordEvent(job, { event: 'wait-start', startedAt: now, reasons: [...job.waitReasons],
        ...trafficSnapshot(job, now) });
    }
  }

  function endWait(job, outcome) {
    if (job.waitStartedAt == null) return;
    recordEvent(job, { event: 'wait-end', startedAt: job.waitStartedAt,
      durationMs: Date.now() - job.waitStartedAt, reasons: job.waitReasons, outcome,
      ...trafficSnapshot(job, Date.now()) });
    job.waitStartedAt = null;
  }

  function originState(origin) {
    return state.origins[origin] ||= {
      general: emptyBudget(), scopes: {}, nextPoliteAt: 0, interval: 200, lastLimitedAt: null,
    };
  }

  function scopeState(origin, scope) {
    return originState(origin).scopes[scope] ||= emptyBudget();
  }

  function save() {
    if (!storage) return Promise.resolve();
    const snapshot = structuredClone(state);
    persistence = persistence.then(() => storage.set({ [key]: snapshot }));
    return persistence;
  }

  function trim(budget, now) {
    budget.times = budget.times.filter(time => time > now - 60000 - WINDOW_MARGIN_MS);
  }

  function windowWait(budget, limits, now) {
    trim(budget, now);
    let until = budget.blockedUntil;
    for (const [window, limit] of limits) {
      const times = budget.times.filter(time => time > now - window - WINDOW_MARGIN_MS);
      if (times.length >= limit) until = Math.max(until, times[times.length - limit] + window + WINDOW_MARGIN_MS);
    }
    return until;
  }

  function waitsFor(job, now) {
    const origin = originState(job.origin);
    const scope = scopeState(job.origin, apiScope(job.path));
    const buffer = job.priority === 0 ? 0 : job.polite ? 40 : 20;
    return [
      { reason: 'server', scope: 'general', until: origin.general.blockedUntil },
      { reason: 'server', scope: apiScope(job.path), until: scope.blockedUntil },
      { reason: 'budget', scope: 'general', windowMs: 60000, until: windowWait(state.global, [[60000, job.priority === 0 ? 400 : 380]], now) },
      ...(SCOPE_LIMITS[apiScope(job.path)] || []).map(limit => ({
        reason: 'budget', scope: apiScope(job.path), windowMs: limit[0],
        until: windowWait({ ...scope, blockedUntil: 0 }, [limit], now),
      })),
      { reason: 'budget', scope: 'general', until:
        origin.general.remaining != null && origin.general.remaining <= buffer
          ? origin.general.resetAt + WINDOW_MARGIN_MS : 0 },
      { reason: 'budget', scope: apiScope(job.path), until:
        scope.remaining != null && scope.remaining <= 0 ? scope.resetAt + WINDOW_MARGIN_MS : 0 },
      { reason: 'pacing', scope: apiScope(job.path), until: job.polite ? origin.nextPoliteAt : 0 },
    ].filter(wait => wait.until > now);
  }

  function eligibleAt(job, now) {
    return Math.max(0, ...waitsFor(job, now).map(wait => wait.until));
  }

  function count(origin, path, now) {
    trim(state.global, now);
    state.global.times.push(now);
    const general = originState(origin).general;
    if (general.remaining != null) general.remaining = Math.max(0, general.remaining - 1);
    const scope = scopeState(origin, apiScope(path));
    trim(scope, now);
    scope.times.push(now);
    if (scope.remaining != null) scope.remaining = Math.max(0, scope.remaining - 1);
    return { at: now, budgets: [state.global, scope] };
  }

  function completeReservation(reservation) {
    const now = Date.now();
    for (const budget of reservation.budgets) {
      const index = budget.times.indexOf(reservation.at);
      if (index !== -1) budget.times.splice(index, 1);
      // A slot must outlive transport latency: admission can precede server
      // receipt, whereas receiving the response cannot.
      trim(budget, now);
      budget.times.push(now);
    }
  }

  function applyObservation(origin, path, response, fallback = 5000) {
    const now = Date.now();
    const host = originState(origin);
    const scopeName = apiScope(path);
    const reported = response.rateLimitScope === 'combat-simulator' ? 'simulator' : response.rateLimitScope;
    const knownScope = Object.hasOwn(SCOPE_LIMITS, reported) || reported === 'simulator';
    const scopeOnly = knownScope && reported === scopeName;
    // Simulator headers without an explicit general policy retain their
    // endpoint-specific interpretation for compatibility with existing servers.
    const explicitGeneral = Number(response.rateLimitLimit) === 400 || /^400(?:;|$)/.test(response.rateLimitPolicy || '');
    const generalHeaders = explicitGeneral || scopeName !== 'simulator' &&
      !Object.hasOwn(SCOPE_LIMITS, reported);
    const headerBudget = generalHeaders ? host.general : scopeOnly ? scopeState(origin, reported) : null;
    if (headerBudget) {
      const remaining = response.rateLimitRemaining == null ? NaN : Number(response.rateLimitRemaining);
      const reset = response.rateLimitReset == null ? NaN : Number(response.rateLimitReset);
      const budget = headerBudget;
      if (Number.isFinite(remaining) && remaining >= 0) {
        budget.reportedRemaining = remaining;
        budget.observedAt = now;
        budget.remaining = now >= budget.resetAt || budget.remaining == null
          ? remaining : Math.min(budget.remaining, remaining);
      }
      if (Number.isFinite(reset) && reset >= 0) {
        budget.resetAt = Math.max(budget.resetAt, now + reset * 1000);
      }
    }
    if (Number(response.status) !== 429) return;
    const wait = retryDelay(response.retryAfter, fallback);
    const budget = scopeOnly ? scopeState(origin, reported) : host.general;
    budget.blockedUntil = Math.max(budget.blockedUntil, now + wait,
      !scopeOnly && host.general.remaining != null && host.general.remaining <= 20 ? host.general.resetAt : 0);
    if (scopeName !== 'simulator') {
      host.interval = Math.min(2000, host.interval * 2);
      host.lastLimitedAt = now;
      host.nextPoliteAt = Math.max(host.nextPoliteAt, now + host.interval);
    }
  }

  async function observe(origin, path, response, { started = false, fallback = 5000 } = {}) {
    await ready;
    if (failure) throw failure;
    if (started) {
      count(origin, path, Date.now());
      const contributors = originState(origin).contributors ||= {};
      contributors['native-game'] = (contributors['native-game'] || []).filter(time => time > Date.now() - 60000);
      contributors['native-game'].push(Date.now());
    }
    if (response) applyObservation(origin, path, response, fallback);
    await save();
    pump();
  }

  function finish(job, error, result) {
    if (job.method === 'GET') reads.delete(job.key);
    for (const waiter of job.waiters) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      if (error) waiter.reject(error);
      else waiter.resolve(result);
    }
    job.waiters = [];
  }

  async function execute(job) {
    try {
      // Reserve durably before sending, so worker termination cannot erase an
      // already-sent attempt from the local rolling windows.
      await save();
      const now = Date.now();
      recordEvent(job, { event: 'dispatch', ...trafficSnapshot(job, now) });
      const contributors = originState(job.origin).contributors ||= {};
      for (const name of Object.keys(contributors)) contributors[name] = contributors[name].filter(time => time > now - 60000);
      (contributors[job.source] ||= []).push(now);
      let response;
      try {
        response = await job.run();
        recordEvent(job, { event: 'response', status: Number(response.status) || (response.ok ? 200 : 0) });
        applyObservation(job.origin, job.path, response, job.fallback);
      } finally {
        completeReservation(job.reservation);
        await save();
      }
      finish(job, null, response);
    } catch (error) {
      recordEvent(job, { event: 'transport-error' });
      finish(job, error);
    } finally {
      active.delete(job);
      running--;
      pump();
    }
  }

  function pump() {
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    void ready.then(() => {
      clearTimeout(timer);
      timer = undefined;
      if (failure) {
        for (const job of queue.splice(0)) {
          endWait(job, 'failed');
          finish(job, failure);
        }
        return;
      }
      const now = Date.now();
      queue.sort((a, b) =>
        Math.max(0, a.priority - Math.floor((now - a.queuedAt) / 30000)) -
        Math.max(0, b.priority - Math.floor((now - b.queuedAt) / 30000)) || a.queuedAt - b.queuedAt);
      let next = Infinity;
      for (let i = 0; i < queue.length;) {
        const job = queue[i];
        const at = eligibleAt(job, now);
        if (at > now || running >= 3 || (running >= 2 && job.priority > 1 && now - job.queuedAt < 30000)) {
          trackWait(job, now);
          if (at > now) next = Math.min(next, at);
          else next = Math.min(next, job.queuedAt + 30000);
          i++;
          continue;
        }
        queue.splice(i, 1);
        endWait(job, 'dispatched');
        job.started = true;
        job.reservation = count(job.origin, job.path, now);
        const host = originState(job.origin);
        if (job.polite) {
          if (host.lastLimitedAt != null && now - host.lastLimitedAt >= 60000) {
            host.interval = 200;
            host.lastLimitedAt = null;
          }
          host.nextPoliteAt = now + host.interval;
        }
        running++;
        active.add(job);
        void execute(job);
      }
      if (queue.length && next !== Infinity && running < 3) {
        timer = setTimeout(pump, Math.max(1, Math.min(2000, next - now)));
      }
    }).catch(error => {
      failure = error;
      for (const job of queue.splice(0)) {
        endWait(job, 'failed');
        finish(job, error);
      }
    }).finally(() => {
      pumping = false;
      if (repump) {
        repump = false;
        pump();
      }
    });
  }

  function schedule({ origin, path, method = 'GET', priority = 'interactive', polite = false, signal, fallback, source = 'background-maintenance' }, run) {
    if (!Object.hasOwn(API_PRIORITY, priority)) return Promise.reject(new Error(`Unknown API priority: ${priority}`));
    const rank = API_PRIORITY[priority];
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('API request cancelled.'));
    const readKey = `${origin}:${path}`;
    let job = method === 'GET' ? reads.get(readKey) : null;
    if (!job) {
      job = { origin, path, method, priority: rank, polite, fallback, key: readKey, source, consumers: new Set([source]),
        id: crypto.randomUUID(), waitReasons: [], waitStartedAt: null,
        queuedAt: Date.now(), waiters: [], run, started: false };
      queue.push(job);
      if (method === 'GET') reads.set(readKey, job);
    } else if (!job.started && rank < job.priority) {
      job.priority = rank;
      job.polite = polite;
    }
    job.consumers.add(source);
    const result = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => {
        job.waiters = job.waiters.filter(value => value !== waiter);
        reject(signal.reason || new Error('API request cancelled.'));
        if (!job.started && !job.waiters.length) {
          endWait(job, 'cancelled');
          queue.splice(queue.indexOf(job), 1);
          if (method === 'GET') reads.delete(readKey);
        }
        pump();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      job.waiters.push(waiter);
    });
    pump();
    return result;
  }

  function promote(origin, path, priority) {
    const job = reads.get(`${origin}:${path}`);
    const rank = API_PRIORITY[priority];
    if (job && !job.started && Object.hasOwn(API_PRIORITY, priority) && rank < job.priority) {
      job.priority = rank;
      job.polite = false;
      pump();
    }
  }

  async function status(origin, path) {
    await ready;
    if (failure) throw failure;
    const now = Date.now();
    const host = originState(origin);
    const jobs = queue.filter(job => job.origin === origin);
    const runningJobs = [...active].filter(job => job.origin === origin);
    const describe = job => {
      const waits = waitsFor(job, now);
      const server = waits.filter(wait => wait.reason === 'server').sort((a, b) => b.until - a.until)[0];
      const longest = waits.sort((a, b) => b.until - a.until)[0];
      return server || longest || { reason: 'queue', scope: apiScope(job.path), until: null };
    };
    const budget = (value, limits) => ({
      windows: limits.map(([windowMs, limit]) => ({
        windowMs, limit, counted: value.times.filter(time => time > now - windowMs - WINDOW_MARGIN_MS).length,
      })),
      reportedRemaining: value.reportedRemaining ?? null,
      observedAt: value.observedAt ?? null,
      resetAt: value.resetAt,
    });
    const scopes = ['general', 'system-details', 'fuel-estimate', 'simulator'].map(name => {
      const pending = jobs.filter(job => apiScope(job.path) === name);
      const waits = pending.map(describe);
      const serverBudget = name === 'general' ? host.general : scopeState(origin, name);
      const serverWait = Math.max(host.general.blockedUntil, serverBudget.blockedUntil);
      const wait = serverWait > now ? { reason: 'server', scope: name, until: serverWait }
        : waits.sort((a, b) => (b.until || 0) - (a.until || 0))[0] || null;
      return {
        name, queued: pending.length, running: runningJobs.filter(job => apiScope(job.path) === name).length,
        wait,
        local: budget(name === 'general' ? state.global : serverBudget,
          name === 'general' ? [[60000, 400]] : SCOPE_LIMITS[name] || []).windows,
        server: budget(serverBudget, []),
      };
    });
    let request = null;
    if (path) {
      const queued = jobs.find(job => job.path === path);
      request = runningJobs.some(job => job.path === path) ? { reason: 'running' }
        : queued ? describe(queued)
          : describe({ origin, path, priority: API_PRIORITY.bulk, polite: true });
    }
    return { origin, at: now, queued: jobs.length, running: runningJobs.length, scopes, request };
  }

  return { schedule, observe, promote, status };
}
