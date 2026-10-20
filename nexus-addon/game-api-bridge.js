// Receives API requests from the extension background and executes them from
// the logged-in game origin. The background can inject this into an already
// open game tab when the original content script listener is missing.
(function installNexusGameApiBridge() {
  'use strict';

  const extensionApi = typeof browser !== 'undefined' ? browser : chrome;
  const runtime = extensionApi.runtime;

  function onGameFetch(msg, sender, sendResponse) {
    void sender;
    if (!msg || msg.type !== 'GAME_FETCH') return;
    const respond = response => {
      globalThis.nexusRecordDiagnosticApi?.(msg, response);
      sendResponse(response);
    };

    fetch(msg.path, {
      method: msg.method || 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' },
      body: msg.body != null ? JSON.stringify(msg.body) : undefined,
    }).then(async response => {
      const text = await response.text();
      const meta = {
        status: response.status,
        retryAfter: response.headers.get('Retry-After'),
        rateLimitScope: response.headers.get('X-RateLimit-Scope'),
        rateLimitLimit: response.headers.get('RateLimit-Limit'),
        rateLimitPolicy: response.headers.get('RateLimit-Policy'),
        rateLimitRemaining: response.headers.get('RateLimit-Remaining'),
        rateLimitReset: response.headers.get('RateLimit-Reset'),
      };

      if (!response.ok) {
        let message = `${response.status}`;
        try {
          const json = JSON.parse(text);
          message = json.message || json.error || message;
        } catch {
          if (text) message = `${response.status}: ${text.slice(0, 200)}`;
        }
        respond({ error: message, ...meta });
        return;
      }

      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          respond({ error: `Failed to parse API response: ${error.message}`, parseError: true, ...meta });
          return;
        }
      }
      respond({ ok: true, data, ...meta });
    }).catch(error => respond({
      error: error.name === 'TimeoutError'
        ? `API ${msg.path} timed out after 20 seconds.`
        : error.message,
      networkError: true,
    }));

    return true;
  }

  // Re-register safely on repeated injections or extension reloads.
  const previousListener = globalThis.__nexusGameApiBridgeListener;
  if (previousListener) {
    try { runtime.onMessage.removeListener(previousListener); } catch { /* old context */ }
  }
  runtime.onMessage.addListener(onGameFetch);
  globalThis.__nexusGameApiBridgeListener = onGameFetch;
})();
