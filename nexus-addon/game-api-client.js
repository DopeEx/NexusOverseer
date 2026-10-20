(function installGameApiClient() {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let sequence = 0;
  const instance = crypto.randomUUID();
  let trafficStopped = false;

  function reportTrafficFailure(error) {
    if (trafficStopped) return;
    if (!api.runtime.id || /extension context invalidated/i.test(String(error?.message || error))) {
      trafficStopped = true;
      window.removeEventListener('message', onTraffic);
      console.info('[NexusOverseer] API traffic observation stopped after an extension reload. Reload this game tab to reconnect.');
      return;
    }
    console.error('[NexusOverseer] API traffic observation failed:', error);
  }

  async function onTraffic(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const traffic = event.data?.__nxApiTraffic;
    if (!traffic || typeof traffic.path !== 'string' || traffic.path.length > 2000) return;
    const response = traffic.response;
    const allowed = {};
    if (response && typeof response === 'object') {
      for (const key of ['status', 'retryAfter', 'rateLimitScope', 'rateLimitLimit',
        'rateLimitPolicy', 'rateLimitRemaining', 'rateLimitReset']) {
        if (typeof response[key] === 'number' || typeof response[key] === 'string' && response[key].length <= 200) {
          allowed[key] = response[key];
        }
      }
    }
    try {
      const reply = await api.runtime.sendMessage({ type: 'API_TRAFFIC', path: traffic.path,
        started: traffic.started === true, response: response ? allowed : undefined });
      if (reply?.error) reportTrafficFailure(new Error(reply.error));
    } catch (error) {
      reportTrafficFailure(error);
    }
  }
  window.addEventListener('message', onTraffic);
  window.postMessage({ __nxApiTrafficReady: true }, location.origin);
  globalThis.nexusGameApi = async (path, { method = 'GET', body, priority = method === 'POST' ? 'action' : 'interactive', signal, source = 'content-tool' } = {}) => {
    const requestId = `${instance}:${++sequence}`;
    if (signal?.aborted) throw signal.reason || new Error('API request cancelled.');
    const cancel = async () => {
      try {
        await api.runtime.sendMessage({ type: 'API_CANCEL', requestId });
      } catch (error) {
        console.error('[NexusOverseer] API cancellation failed:', error);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await api.runtime.sendMessage({ type: 'API_REQUEST', path, method, body, priority, requestId, source });
      if (!response?.ok || response.error) {
        throw Object.assign(new Error(response?.error || 'No game API response.'), { status: response?.status });
      }
      if (signal?.aborted) throw signal.reason || new Error('API request cancelled.');
      return response.data;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
})();
