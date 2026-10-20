// Runs in the PAGE world (manifest world:"MAIN") at document_start, so it wraps
// the page's network calls before the game grabs its own references. The game
// only renders a field's *percent* remaining; the optimal-ships calc needs the
// absolute resource amount + field type, which live in the /systems/{id}/planets
// response the game fetches on system select. Relay the field stats to the
// isolated content script (galaxy-fields.js) via postMessage. Wrap both fetch
// and XHR since we don't know which transport the game uses.
(function () {
  const PLANETS = /\/api\/galaxy\/systems\/\d+\/planets/;
  const galaxyBuffer = new Map();
  function galaxyPath(input) {
    try {
      const url = new URL(input, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      return /^\/api\/galaxy\/(?:map|station-index|arms|arms\/\d+\/sectors|sectors\/\d+\/systems|systems\/\d+\/planets)$/.test(url.pathname)
        ? url.pathname : null;
    } catch { return null; }
  }
  function relayGalaxy(path, text) {
    let data;
    try { data = JSON.parse(text); }
    catch (error) { console.debug('[NexusOverseer] Galaxy response not JSON:', error); return; }
    const observation = { path, data, at: Date.now() };
    galaxyBuffer.set(path, observation);
    if (galaxyBuffer.size > 20) galaxyBuffer.delete(galaxyBuffer.keys().next().value);
    window.postMessage({ __nxGalaxyObservation: observation }, window.location.origin);
    if (PLANETS.test(path)) relayFields(data);
  }
  // Also track which planet the page is currently showing: the SPA GETs
  // /api/planets/{id} (the buildings/overview view is built from it). Relay the
  // last id so building-upgrade.js can plan against the planet in view instead
  // of asking the user to pick one.
  const PLANET = /\/api\/planets\/(\d+)(?:[/?]|$)/;
  let lastPlanetId = null;
  function notePlanet(url) {
    const m = PLANET.exec(url || '');
    if (!m) return;
    lastPlanetId = Number(m[1]);
    window.postMessage({ __nxCurrentPlanet: lastPlanetId }, window.location.origin);
  }

  // Buffer every field we relay, keyed by id. The content script (galaxy-fields.js)
  // attaches its `message` listener at document_idle, which can be *after* the game
  // has already fetched the focused system's planets on initial mount — that live
  // message would be lost. On init it asks for a replay and we flush the buffer.
  const buffer = new Map();

  function relayFields(data) {
    const fields = (data.asteroidFields || []).map(f => ({
      id: f.id, remaining: f.remainingResources,
      richness: f.richness, type: f.fieldType,
    }));
    if (!fields.length) return;
    for (const f of fields) buffer.set(f.id, f);
    window.postMessage({ __nxFields: fields }, window.location.origin);
  }

  // Replay the whole buffer when the content script (re)initializes.
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.__nxRequestFields && buffer.size) {
      window.postMessage({ __nxFields: [...buffer.values()] }, window.location.origin);
    }
    if (e.data && e.data.__nxRequestCurrentPlanet && lastPlanetId != null) {
      window.postMessage({ __nxCurrentPlanet: lastPlanetId }, window.location.origin);
    }
    if (e.source === window && e.data?.__nxRequestGalaxy) {
      for (const observation of galaxyBuffer.values()) {
        window.postMessage({ __nxGalaxyObservation: observation }, window.location.origin);
      }
    }
  });

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    const url = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : (args[0] && args[0].url) || '';
    notePlanet(url);
    const path = galaxyPath(url);
    if (path) {
      p.then(async response => {
        if (!response.ok || (args[1]?.method || args[0]?.method || 'GET').toUpperCase() !== 'GET') return;
        const text = await response.clone().text();
        relayGalaxy(path, text);
      })
        .catch(e => console.debug('[nx] planets fetch relay failed', e));
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nxUrl = url;
    this.__nxMethod = method;
    notePlanet(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      const path = galaxyPath(this.__nxUrl);
      if (!path || this.status < 200 || this.status >= 300 || this.__nxMethod.toUpperCase() !== 'GET') return;
      const text = this.responseType === 'json' ? JSON.stringify(this.response)
        : !this.responseType || this.responseType === 'text' ? this.responseText : null;
      if (text == null) return;
      relayGalaxy(path, text);
    }, { once: true });
    return origSend.apply(this, args);
  };
})();
