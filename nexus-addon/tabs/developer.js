import { ANALYTICS_KEYS, LOG_KEY, analyticsEntries, analyticsBuckets } from '../diagnostics.js';
import { readDiagnosticLogs } from '../diagnostics-store.js';
import { getSetting, onSettingsChange } from '../settings.js';
import { summarizeTraffic } from '../api-telemetry.js';

let bound = false;
let page = 1;
let entries = [];
let logs = [];
let refreshVersion = 0;
let analyticsView = 'entries';
const PAGE_SIZE = 10;
const STREAMS = [
  ['scheduling', 'API Wait Times', 'Retained scheduling metadata only. Counts cover retained events, not lifetime totals. Sources identify the initiating operation, not necessarily the cause of congestion.'],
  ['api', 'API Tracker Logs', 'Captured HTTP requests from the game client and addon game bridge.'],
  ['galaxy', 'Galaxy Delta Updates', 'Galaxy delta events extracted from incoming WebSocket messages.'],
  ['websocket', 'WebSocket Event Logs', 'Incoming text frames, including decoded Socket.IO events.'],
];
const el = id => document.getElementById(id);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function status(message, failed = false) {
  el('debug-status').textContent = message;
  el('debug-status').classList.toggle('debug-error', failed);
}

async function action(run) {
  try { await run(); }
  catch (error) {
    console.error('[NexusOverseer] Developer tools failed:', error);
    status(error.message, true);
  }
}

function button(label, run) {
  const node = element('button', label);
  node.type = 'button';
  node.className = 'toolbar-button secondary-button';
  node.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void action(run);
  });
  return node;
}

function copyButton(label, data) {
  const node = button(label, async () => {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    node.classList.add('debug-copy-done');
    node.setAttribute('aria-label', 'Copied');
    node.title = 'Copied';
    status(`${label}: copied.`);
    setTimeout(() => {
      node.classList.remove('debug-copy-done');
      node.setAttribute('aria-label', label);
      node.title = label;
    }, 1500);
  });
  node.className = 'debug-copy';
  node.setAttribute('aria-label', label);
  node.title = label;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M9 9h11v11H9z M15 5V3H3v12h2');
  svg.append(path);
  node.replaceChildren(svg);
  return node;
}

function jsonView(data, withCopy = true) {
  const wrapper = element('div', undefined, 'debug-json');
  if (withCopy) wrapper.append(copyButton('Copy JSON', data));
  wrapper.append(element('pre', JSON.stringify(data, null, 2)));
  return wrapper;
}

function time(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function websocketTitle(data) {
  const payload = data.payload ?? data;
  if (Array.isArray(payload) && typeof payload[0] === 'string') return `Event: ${payload[0]}`;
  if (typeof payload === 'string' || typeof payload === 'number') {
    const frame = String(payload);
    if (frame === '2') return 'Ping (keep-alive)';
    if (frame === '3') return 'Pong (keep-alive)';
    if (frame === '1') return 'Connection closed';
    if (/^0\{/.test(frame)) return 'Connection handshake';
    if (/^40(?:$|[{/])/.test(frame)) return 'Socket.IO connected';
    if (/^41(?:$|\/)/.test(frame)) return 'Socket.IO disconnected';
    return 'Text frame';
  }
  return 'WebSocket message';
}

function payloadView(title, data, open = true) {
  const details = element('details', undefined, 'debug-payload');
  details.open = open;
  const summary = element('summary');
  summary.append(element('span', title, 'debug-payload-title'), copyButton(`Copy ${title.toLowerCase()}`, data));
  details.append(summary);
  let rendered = false;
  details.addEventListener('toggle', () => {
    if (!details.open || rendered) return;
    rendered = true;
    details.append(jsonView(data, false));
  });
  return details;
}

function renderAnalytics() {
  const buckets = analyticsView === 'buckets';
  el('debug-interval-field').hidden = !buckets;
  el('debug-days-field').hidden = !buckets;
  const items = buckets ? analyticsBuckets(entries, el('debug-interval').value, Number(el('debug-days').value)) : entries;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const table = element('table', undefined, 'debug-table');
  const head = element('thead');
  const row = element('tr');
  for (const label of buckets ? ['Interval start', 'Interval', 'Resources JSON'] : ['Time', 'Source', 'Type', 'Data JSON']) row.append(element('th', label));
  head.append(row);
  const body = element('tbody');
  for (const item of items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
    const tr = element('tr');
    tr.append(element('td', time(item.timestamp)));
    if (buckets) tr.append(element('td', item.interval));
    else tr.append(element('td', item.source), element('td', item.type, `debug-${item.type}`));
    const data = element('td');
    data.append(jsonView(item.resources));
    tr.append(data);
    body.append(tr);
  }
  table.append(head, body);
  const wrapper = element('div', undefined, 'debug-table-scroll');
  wrapper.append(table);
  el('debug-analytics').replaceChildren(items.length ? wrapper : element('p', 'No retained entries for this selection.', 'opt-note'));
  el('debug-page-info').textContent = `Page ${page} / ${pages} (Total: ${items.length})`;
  el('debug-prev').disabled = page <= 1;
  el('debug-next').disabled = page >= pages;
}

function renderStream(kind) {
  const container = el(`debug-stream-${kind}`);
  const items = logs.filter(item => item.kind === kind);
  container.replaceChildren();
  if (!items.length) container.append(element('p', kind === 'scheduling'
    ? 'No scheduling events. Enable Record API wait times; no game-tab reload is needed.'
    : 'No entries captured. Enable recording and use or reload the game. Existing WebSocket connections may require a game-tab reload.', 'opt-note'));
  for (const item of items) {
    const details = element('details', undefined, 'debug-entry');
    const heading = element('summary');
    const data = item.data;
    if (kind === 'api') {
      const method = String(data.method || 'API').toUpperCase();
      const methodColor = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'put', DELETE: 'delete' }[method] || 'neutral';
      heading.append(element('span', method, `debug-badge debug-method-${methodColor}`));
    } else if (kind === 'galaxy') {
      heading.append(element('span', data.payload?.type || 'delta', 'debug-badge debug-method-put'));
    }
    const description = kind === 'api'
      ? data.path || (data.truncated ? 'API request (details unavailable in older truncated entry)' : 'API request')
      : kind === 'scheduling' ? `${data.source} · ${data.event} · ${data.scope}${data.durationMs != null ? ` · ${data.durationMs} ms · ${data.outcome}` : ''}`
        : kind === 'galaxy' ? `System ID: ${data.payload?.systemId ?? '-'}` : websocketTitle(data);
    heading.append(element('span', description, 'debug-entry-path'));
    if (kind === 'api' && data.status != null) {
      const category = data.status >= 200 && data.status < 300 ? 'success'
        : data.status >= 300 && data.status < 400 ? 'redirect' : data.status >= 400 || data.status === 0 ? 'failure' : 'neutral';
      heading.append(element('span', String(data.status), `debug-badge debug-status-${category}`));
    }
    if (data.truncated) heading.append(element('span', 'Truncated', 'debug-badge debug-method-put'));
    const timestamp = element('time', time(item.timestamp), 'debug-entry-time');
    if (Number.isFinite(item.timestamp)) timestamp.dateTime = new Date(item.timestamp).toISOString();
    heading.append(timestamp, copyButton('Copy entry', item));
    details.append(heading);
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      rendered = true;
      const content = element('div', undefined, 'debug-entry-body');
      if (kind === 'api') {
        if (data.truncated) content.append(element('p', 'Content truncated to stay within diagnostic storage limits.', 'opt-note'));
        if (data.error) content.append(element('p', data.error, 'debug-error'));
        if (data.durationMs != null) content.append(element('p', `Duration: ${data.durationMs} ms`, 'opt-note'));
        const requestBody = data.requestBody;
        if (requestBody != null && (typeof requestBody !== 'string' || (requestBody.trim() !== '' && requestBody.trim() !== '[not captured]'))) {
          content.append(payloadView('Request body', requestBody, false));
        }
        if (data.responseBody !== undefined) content.append(payloadView('Response body', data.responseBody));
        if (data.preview !== undefined) content.append(payloadView('Truncated API data (preview)', data.preview));
      } else {
        content.append(jsonView(data.payload ?? data, false));
      }
      details.append(content);
    });
    container.append(details);
  }
  if (kind === 'api') filterApi();
}

async function refresh() {
  const version = ++refreshVersion;
  const server = await globalThis.nexusStorage.getActiveServer();
  const [store, savedLogs] = await Promise.all([
    browser.storage.local.get([...ANALYTICS_KEYS, LOG_KEY]),
    readDiagnosticLogs(server.key),
  ]);
  if (version !== refreshVersion || server.key !== (await globalThis.nexusStorage.getActiveServer()).key) return;
  entries = analyticsEntries(store);
  logs = [...savedLogs, ...(store[LOG_KEY] || [])];
  renderAnalytics();
  for (const [kind] of STREAMS) renderStream(kind);
  const traffic = el('debug-traffic-summary');
  traffic.textContent = '';
  const groups = summarizeTraffic(logs).groups;
  if (!groups.length) traffic.append(element('p', 'No recorded scheduling events. Enable Record API wait times to begin.', 'opt-note'));
  else {
    const table = element('table');
    const heading = element('tr');
    for (const text of ['Source', 'Requests', 'API budget pauses', 'Wait (s)', '429', 'Interrupted']) heading.append(element('th', text));
    const head = element('thead');
    head.append(heading);
    const body = element('tbody');
    for (const group of groups) {
      const row = element('tr');
      for (const value of [group.source, group.requests, group.pauses, (group.waitMs / 1000).toFixed(1), group.limited, group.interrupted]) row.append(element('td', String(value)));
      body.append(row);
    }
    table.append(head, body);
    traffic.append(table);
  }
  status(`${server.id || server.name || server.key} | Traffic recording ${getSetting('developer.recording') ? 'on' : 'off'} | Wait recording ${getSetting('developer.apiWaitRecording') ? 'on' : 'off'} | ${logs.length} diagnostic entries. Refreshed ${time(Date.now())}.`);
}

function buildStreams() {
  for (const [kind, title, description] of STREAMS) {
    const details = element('details', undefined, 'dashboard-panel debug-panel');
    const summary = element('summary', undefined, 'debug-heading');
    summary.append(element('strong', title));
    const body = element('div', undefined, 'debug-body');
    const toolbar = element('div', undefined, 'debug-toolbar');
    toolbar.append(element('span', description, 'opt-note'));
    if (kind === 'scheduling') {
      const overview = element('div', undefined, 'debug-table-scroll');
      overview.id = 'debug-traffic-summary';
      body.append(overview);
    }
    if (kind === 'api') {
      const search = element('input');
      search.type = 'search';
      search.placeholder = 'Search paths...';
      search.setAttribute('aria-label', 'Search API paths');
      search.className = 'toolbar-input';
      search.id = 'debug-api-search';
      search.addEventListener('input', () => filterApi());
      toolbar.append(search);
    }
    toolbar.append(button('Refresh', refresh), button('Download .jsonl', async () => {
      const server = await globalThis.nexusStorage.getActiveServer();
      const stored = await browser.storage.local.get(LOG_KEY);
      const items = [...await readDiagnosticLogs(server.key), ...(stored[LOG_KEY] || [])].filter(item => item.kind === kind);
      if (!items.length) throw new Error('No entries to export.');
      const blob = new Blob([items.map(item => JSON.stringify(globalThis.nexusDiagnostics.sanitize(item))).join('\n') + '\n'], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = element('a');
      link.href = url;
      link.download = `nexus-overseer-${server.key}-${kind}-${Date.now()}.jsonl`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('Diagnostic export downloaded. Review private game data before sharing.');
    }), button('Clear logs', async () => {
      if (!confirm(`Delete ${title} for the selected server? Statistics and reports are kept.`)) return;
      const server = await globalThis.nexusStorage.getActiveServer();
      const response = await browser.runtime.sendMessage({ type: 'DIAGNOSTICS_CLEAR', kind, serverKey: server.key });
      if (!response?.ok) throw new Error(response?.error || 'Could not clear diagnostic logs.');
      await refresh();
      status(`${title} cleared for ${server.id || server.name || server.key}. Recording ${getSetting(kind === 'scheduling' ? 'developer.apiWaitRecording' : 'developer.recording') ? 'remains on; new entries may appear immediately' : 'is off'}.`);
    }));
    const items = element('div');
    items.id = `debug-stream-${kind}`;
    body.append(toolbar, items);
    details.append(summary, body);
    el('debug-streams').append(details);
  }
}

function filterApi() {
  const search = el('debug-api-search').value.toLowerCase();
  let matches = 0;
  for (const node of el('debug-stream-api').querySelectorAll('.debug-entry')) {
    node.hidden = !node.querySelector('summary').textContent.toLowerCase().includes(search);
    if (!node.hidden) matches++;
  }
  el('debug-api-empty')?.remove();
  if (search && !matches) {
    const message = element('p', 'No API logs match your search.', 'opt-note');
    message.id = 'debug-api-empty';
    el('debug-stream-api').append(message);
  }
}

export function initDeveloperTab() {
  if (!bound) {
    bound = true;
    buildStreams();
    onSettingsChange(() => {
      if (!el('opt-developer').hidden) void action(refresh);
    });
    const tabs = [...document.querySelectorAll('[data-analytics-view]')];
    function selectView(tab) {
      analyticsView = tab.dataset.analyticsView;
      for (const item of tabs) {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
      }
      el('debug-analytics').setAttribute('aria-labelledby', tab.id);
      page = 1;
      renderAnalytics();
    }
    for (const tab of tabs) {
      tab.addEventListener('click', () => selectView(tab));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(item => item !== tab);
        next.focus();
        selectView(next);
      });
    }
    for (const id of ['debug-interval', 'debug-days']) {
      el(id).addEventListener('change', () => { page = 1; renderAnalytics(); });
    }
    el('debug-analytics-refresh').addEventListener('click', () => { void action(refresh); });
    el('debug-prev').addEventListener('click', () => { page--; renderAnalytics(); });
    el('debug-next').addEventListener('click', () => { page++; renderAnalytics(); });
  }
  void action(refresh);
}
