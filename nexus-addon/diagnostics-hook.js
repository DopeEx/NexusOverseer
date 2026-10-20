// MAIN world: observe traffic without changing requests or consuming responses.
(function () {
  'use strict';
  let enabled = false;
  let pending = [];
  let flushing = false;
  const origin = location.origin;
  const core = globalThis.nexusDiagnostics;
  const MAX_BODY = core.limits.capture;
  const oversized = () => ({ truncated: true, reason: 'Payload exceeds capture character limit' });
  const requestText = body => typeof body !== 'string' ? '[not captured]' : body.length > MAX_BODY ? oversized() : body;
  const galaxyDeltas = new Map();
  let trafficReady = false;
  let trafficPending = [];

  function traffic(path, response) {
    const message = { path, started: !response, ...(response ? { response } : {}) };
    if (trafficReady) window.postMessage({ __nxApiTraffic: message }, origin);
    else if (trafficPending.length < 100) trafficPending.push(message);
  }

  function budgetHeaders(get, status) {
    return {
      status,
      retryAfter: get('Retry-After'),
      rateLimitScope: get('X-RateLimit-Scope'),
      rateLimitLimit: get('RateLimit-Limit'),
      rateLimitPolicy: get('RateLimit-Policy'),
      rateLimitRemaining: get('RateLimit-Remaining'),
      rateLimitReset: get('RateLimit-Reset'),
    };
  }

  function capture(kind, data) {
    if (!enabled || pending.length >= 20) return;
    pending.push({ kind, data, timestamp: Date.now() });
  }

  function apiUrl(input) {
    try {
      const url = new URL(input, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/') || /\/(?:auth|login|logout|session)(?:\/|$)/i.test(url.pathname)) return null;
      return url.pathname; // Never collect query strings or headers.
    } catch { return null; }
  }

  function trafficUrl(input) {
    try {
      const url = new URL(input, origin);
      return url.origin === origin && url.pathname.startsWith('/api/') ? url.pathname : null;
    } catch { return null; }
  }

  async function responseBody(response) {
    if (!/json|text/i.test(response.headers.get('content-type') || '')) return '[non-text response]';
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (text.length < MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
      return oversized();
    } finally {
      void reader.cancel().catch(error => console.debug('[NexusOverseer] Diagnostic reader cancel failed', error));
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin) return;
    if (event.data?.__nxApiTrafficReady) {
      trafficReady = true;
      for (const message of trafficPending) window.postMessage({ __nxApiTraffic: message }, origin);
      trafficPending = [];
    }
    if (event.data?.__nxRequestGalaxy) {
      for (const delta of galaxyDeltas.values()) window.postMessage({ __nxGalaxyDelta: delta }, origin);
    }
    if (event.data?.__nxDiagnosticsConfig) {
      enabled = event.data.__nxDiagnosticsConfig.recording === true;
      if (!enabled) pending = [];
    }
  });
  window.postMessage({ __nxDiagnosticsReady: true }, origin);
  setInterval(() => {
    if (!enabled || !pending.length || flushing) return;
    flushing = true;
    const batch = pending;
    pending = [];
    const sanitized = [];
    function step() {
      if (!enabled) { flushing = false; return; }
      const item = batch.shift();
      if (!item) {
        window.postMessage({ __nxDiagnosticsBatch: sanitized }, origin);
        flushing = false;
        return;
      }
      sanitized.push(core.entry(item.kind, item.data, item.timestamp));
      // Yield between entries so a traffic burst cannot monopolize rendering.
      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  }, 500);

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    const input = args[0];
    const path = apiUrl(typeof input === 'string' || input instanceof URL ? input : input?.url);
    const trafficPath = trafficUrl(typeof input === 'string' || input instanceof URL ? input : input?.url);
    if (trafficPath) {
      traffic(trafficPath);
      result.then(response => traffic(trafficPath, budgetHeaders(name => response.headers.get(name), response.status)))
        .catch(error => console.debug('[NexusOverseer] Native API observation failed:', error));
    }
    if (enabled && path) {
      const method = args[1]?.method || input?.method || 'GET';
      const requestBody = requestText(args[1]?.body);
      const started = performance.now();
      result.then(async response => {
        if (!enabled) return;
        capture('api', { method, path, status: response.status, durationMs: Math.round(performance.now() - started), requestBody, responseBody: await responseBody(response.clone()) });
      }).catch(error => capture('api', { method, path, error: error.message }));
    }
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nxDiagnosticRequest = { method, path: apiUrl(url) };
    this.__nxTrafficPath = trafficUrl(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const path = this.__nxTrafficPath;
    if (path) {
      traffic(path);
      this.addEventListener('loadend', () => {
        traffic(path, budgetHeaders(name => this.getResponseHeader(name), this.status));
      }, { once: true });
    }
    if (enabled && this.__nxDiagnosticRequest?.path) {
      const request = { ...this.__nxDiagnosticRequest };
      const started = performance.now();
      this.addEventListener('loadend', () => {
        let response = '[non-text response]';
        if (!this.responseType || this.responseType === 'text') response = requestText(this.responseText);
        else if (this.responseType === 'json') response = this.response;
        capture('api', { ...request, status: this.status, durationMs: Math.round(performance.now() - started), requestBody: requestText(body), responseBody: response });
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      const url = new URL(socket.url || args[0], origin);
      const pageUrl = new URL(origin);
      if (url.hostname !== pageUrl.hostname || url.port !== pageUrl.port ||
          url.protocol !== (pageUrl.protocol === 'https:' ? 'wss:' : 'ws:')) return socket;
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        const text = event.data;
        if (!enabled && (text.length > 4096 || !text.includes('"galaxy:delta"'))) return;
        if (text.length > MAX_BODY) {
          capture('websocket', { payload: oversized() });
          return;
        }
        let payload = text;
        // Socket.IO event frames prefix the JSON array with "42" (and optionally a namespace).
        const start = text.startsWith('42') ? text.indexOf('[') : -1;
        try { payload = JSON.parse(start >= 0 ? text.slice(start) : text); } catch { /* plain text frame */ }
        if (Array.isArray(payload) && payload[0] === 'galaxy:delta') {
          const data = payload[1];
          if (data?.type === 'colonized' && Number.isSafeInteger(data.systemId) && data.systemId > 0 && data.hasColonies === true) {
            const delta = { data: { type: 'colonized', systemId: data.systemId, hasColonies: true }, at: Date.now() };
            galaxyDeltas.set(data.systemId, delta);
            if (galaxyDeltas.size > 100) galaxyDeltas.delete(galaxyDeltas.keys().next().value);
            window.postMessage({ __nxGalaxyDelta: delta }, origin);
          }
        }
        capture('websocket', { payload });
        if (Array.isArray(payload) && /galaxy[:.]delta/i.test(String(payload[0]))) {
          capture('galaxy', { event: payload[0], payload: payload[1] });
        }
      });
      return socket;
    },
  });
})();
