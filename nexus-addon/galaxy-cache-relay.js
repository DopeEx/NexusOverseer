(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  let stopped = false;
  const seen = new Map();
  async function onMessage(event) {
    if (stopped || event.source !== window || event.origin !== location.origin) return;
    const delta = event.data?.__nxGalaxyDelta;
    const observation = event.data?.__nxGalaxyObservation;
    const input = delta || observation;
    if (!input || !Number.isFinite(input.at)) return;
    if (delta ? delta.data?.type !== 'colonized' || delta.data?.hasColonies !== true ||
        !Number.isSafeInteger(delta.data?.systemId) || delta.data.systemId <= 0
      : typeof observation.path !== 'string') return;
    const key = delta ? `delta:${delta.data.systemId}` : observation.path;
    if (seen.get(key) >= input.at) return;
    seen.set(key, input.at);
    if (seen.size > 100) seen.delete(seen.keys().next().value);
    try {
      const response = await api.runtime.sendMessage(delta
        ? { type: 'GALAXY_DELTA', data: delta.data, at: delta.at }
        : { type: 'GALAXY_OBSERVED', ...observation });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      if (/extension context invalidated/i.test(error.message)) {
        stopped = true;
        window.removeEventListener('message', onMessage);
        console.info('[NexusOverseer] Galaxy capture stopped after extension reload. Reload the game tab to reconnect.');
      } else {
        seen.delete(key);
        console.error('[NexusOverseer] Galaxy capture failed:', error);
      }
    }
  }
  window.addEventListener('message', onMessage);
  window.postMessage({ __nxRequestGalaxy: true }, location.origin);
})();
