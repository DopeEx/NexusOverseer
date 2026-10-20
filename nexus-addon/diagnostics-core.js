(function () {
  'use strict';
  if (globalThis.nexusDiagnostics) return;

  const SECRET = /password|passwd|secret|token|authorization|cookie|session|credential|api[-_]?key/i;
  const limits = Object.freeze({ entry: 256000, bodyPreview: 100000, capture: 1000000, text: 100000, items: 1000, depth: 20 });
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  let originals;
  let level = 'warn';

  function sanitize(value, depth = 0, state = { truncated: false }) {
    function omitted(reason) {
      state.truncated = true;
      return { truncated: true, reason };
    }
    if (depth > limits.depth) return omitted('Maximum nesting depth reached');
    if (typeof value === 'string') {
      if (value.length <= limits.capture) {
        try { return sanitize(JSON.parse(value), depth + 1, state); } catch { /* not JSON */ }
      }
      const redacted = value
        .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]')
        .replace(/((?:password|secret|token|authorization|cookie|session|api[-_]?key)[\w-]*=)[^&\s]+/gi, '$1[redacted]')
        .replace(/("(?:[^"]*(?:password|secret|token|authorization|cookie|session|credential|api[-_]?key)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
      return redacted.length > limits.text ? { ...omitted('Text exceeds character limit'), preview: redacted.slice(0, limits.text) } : redacted;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, limits.items).map(item => sanitize(item, depth + 1, state));
      if (value.length > limits.items) items.push(omitted(`${value.length - limits.items} array items omitted`));
      return items;
    }
    if (value && typeof value === 'object') {
      const fields = Object.entries(value);
      const result = Object.fromEntries(fields.slice(0, limits.items).map(([key, item]) =>
        [key, SECRET.test(key) ? '[redacted]' : sanitize(item, depth + 1, state)]));
      if (fields.length > limits.items) {
        result.truncated = true;
        result.truncationReason = omitted(`${fields.length - limits.items} object fields omitted`).reason;
      }
      if (value.truncated === true) state.truncated = true;
      return result;
    }
    return value;
  }

  function entry(kind, data, timestamp = Date.now()) {
    if (!['api', 'galaxy', 'websocket'].includes(kind)) throw new Error('Unknown diagnostic stream.');
    const state = { truncated: false };
    const payload = sanitize(data, 0, state);
    if (state.truncated && payload && typeof payload === 'object' && !Array.isArray(payload)) payload.truncated = true;
    const json = JSON.stringify(payload);
    let bounded = payload;
    function preview(text) {
      let end = Math.min(text.length, limits.bodyPreview);
      while (JSON.stringify(text.slice(0, end)).length > limits.bodyPreview) end = Math.floor(end * 0.9);
      return { truncated: true, reason: 'Entry exceeds character limit', preview: text.slice(0, end) };
    }
    if (json.length > limits.entry) {
      if (kind === 'api') {
        bounded = { truncated: true };
        for (const key of ['source', 'method', 'path', 'status', 'durationMs', 'error']) {
          if (payload[key] !== undefined) bounded[key] = typeof payload[key] === 'string' ? payload[key].slice(0, 1000) : payload[key];
        }
        for (const key of ['requestBody', 'responseBody']) {
          if (payload[key] === undefined) continue;
          const text = JSON.stringify(payload[key]);
          bounded[key] = text.length > limits.bodyPreview ? preview(text) : payload[key];
        }
        if (bounded.requestBody === undefined && bounded.responseBody === undefined) bounded.preview = preview(json).preview;
      } else {
        bounded = preview(json);
      }
    }
    return {
      kind,
      timestamp,
      data: bounded,
    };
  }

  function setLogLevel(next) {
    level = LEVELS.includes(next) ? next : 'warn';
    if (originals) return;
    originals = Object.fromEntries([...LEVELS, 'log'].map(key => [key, console[key].bind(console)]));
    for (const key of [...LEVELS, 'log']) {
      console[key] = (...args) => {
        if (LEVELS.indexOf(key === 'log' ? 'info' : key) >= LEVELS.indexOf(level)) originals[key](...args);
      };
    }
  }

  globalThis.nexusDiagnostics = Object.freeze({ sanitize, entry, setLogLevel, limits });
})();
