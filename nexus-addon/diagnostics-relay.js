(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  // Chromium may deduplicate manifest script files across MAIN and ISOLATED.
  // Import in this world explicitly instead of sharing the MAIN script entry.
  const coreReady = import(api.runtime.getURL('diagnostics-core.js')).then(() => {
    if (!globalThis.nexusDiagnostics) throw new Error('Diagnostic helper failed to initialize in the extension context.');
    return globalThis.nexusDiagnostics;
  });
  let recording = false;
  let stopped = false;
  let pending = [];
  let flushTimer;
  function enqueue(entry) {
    if (!recording || stopped || pending.length >= 20) return;
    pending.push(entry);
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, 500);
  }
  async function flush() {
    const batch = pending;
    pending = [];
    if (stopped || !recording || !batch.length) return;
    await send(batch);
  }
  function reportFailure(label, error) {
    if (stopped) return;
    if (!api.runtime.id || /extension context invalidated/i.test(String(error?.message || error))) {
      stopped = true;
      recording = false;
      pending = [];
      clearTimeout(flushTimer);
      window.removeEventListener('message', onPageMessage);
      globalThis.nexusRecordDiagnosticApi = undefined;
      publish();
      console.info('[NexusOverseer] Diagnostic recording stopped because the extension was updated or reloaded. Reload this game tab to reconnect.');
      return;
    }
    console.error(`[NexusOverseer] ${label}:`, error);
  }
  async function send(batch) {
    if (stopped) return;
    try {
      if (!api.runtime.id) throw new Error('Extension context invalidated.');
      const response = await api.runtime.sendMessage({ type: 'DIAGNOSTICS_APPEND', batch });
      if (response?.error) console.error('[NexusOverseer] Diagnostic capture failed:', response.error);
    } catch (error) {
      reportFailure('Diagnostic relay failed', error);
    }
  }
  globalThis.nexusRecordDiagnosticApi = (request, response) => {
    if (!recording) return;
    try {
      const url = new URL(request.path, location.origin);
      if (url.origin !== location.origin) return;
      const path = url.pathname;
      if (!path.startsWith('/api/') || /\/(?:auth|login|logout|session)(?:\/|$)/i.test(path)) return;
      enqueue({ kind: 'api', timestamp: Date.now(), data: {
        source: 'addon', method: request.method || 'POST', path,
        requestBody: request.body, status: response.status,
        responseBody: response.data, error: response.error,
      } });
    } catch (error) {
      reportFailure('Diagnostic API capture failed', error);
    }
  };
  function publish() {
    window.postMessage({ __nxDiagnosticsConfig: { recording } }, location.origin);
  }
  async function configure() {
    if (stopped) return;
    const core = await coreReady;
    const settings = await globalThis.nexusStorage.getSettings();
    if (stopped) return;
    recording = settings['developer.recording'] === true;
    if (!recording) {
      pending = [];
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    core.setLogLevel(settings['developer.logLevel']);
    publish();
  }
  function onPageMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.__nxDiagnosticsReady) publish();
    const batch = event.data?.__nxDiagnosticsBatch;
    if (!recording || !Array.isArray(batch) || batch.length > 20) return;
    for (const entry of batch) enqueue(entry);
  }
  window.addEventListener('message', onPageMessage);
  globalThis.nexusStorage.onChanged.addListener(changes => {
    if (!stopped && changes.nexus_settings) void configure().catch(error => reportFailure('Diagnostic settings failed', error));
  });
  void configure().catch(error => reportFailure('Diagnostic initialization failed', error));
})();
