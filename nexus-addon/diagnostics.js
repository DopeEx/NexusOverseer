import './diagnostics-core.js';
import { writeDiagnosticLogs } from './diagnostics-store.js';

export const LOG_KEY = 'diagnostics_log';
export const STREAM_LIMIT = 150;
export const STORAGE_LIMIT = 10000000;
export async function migrateDiagnostics(serverKey) {
  await globalThis.nexusStorage.migrateDiagnosticLogs(serverKey,
    entries => writeDiagnosticLogs(serverKey, [...entries].reverse(), STREAM_LIMIT, STORAGE_LIMIT));
}
export const ANALYTICS_KEYS = [
  'recent_reports', 'pirate_recent_reports', 'mining_recent_reports',
  'exp_recent_reports', 'xeno_recent_reports', 'debris_collection_log', 'fuel_log',
];
const RESOURCES = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter', 'precursor_fragments', 'artifact'];

export async function appendDiagnostics(batch, serverKey) {
  const settings = await globalThis.nexusStorage.getSettings();
  if (settings['developer.recording'] !== true) return { ok: true, recording: false };
  if (!Array.isArray(batch) || batch.length > 20) throw new Error('Invalid diagnostic batch.');
  const now = Date.now();
  const entries = batch.map(item => globalThis.nexusDiagnostics.entry(item.kind, item.data,
    Number.isFinite(item.timestamp) && item.timestamp <= now && item.timestamp > now - 60000 ? item.timestamp : now));
  const key = serverKey || (await globalThis.nexusStorage.getActiveServer()).key;
  await migrateDiagnostics(key);
  await writeDiagnosticLogs(key, entries, STREAM_LIMIT, STORAGE_LIMIT);
  return { ok: true };
}

export function analyticsEntries(store) {
  const entries = [];
  function add(record, source, type, data) {
    const timestamp = Date.parse(record.created_at || record.collected_at);
    if (!Number.isFinite(timestamp)) return;
    const resources = Object.fromEntries(RESOURCES
      .map(key => [key, data?.[key] ?? data?.rare?.[key]])
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value !== 0));
    if (Object.keys(resources).length) entries.push({ timestamp, source, type, resources, reportId: record.id });
  }
  for (const key of ANALYTICS_KEYS) {
    for (const record of store[key] || []) {
      if (key === 'fuel_log') {
        add(record, `fuel:${record.type}`, 'debit', { hydrogen: record.fuel });
      } else if (key === 'mining_recent_reports') {
        if (!record.report_type || record.report_type === 'delivery') add(record, 'mining', 'credit', record);
        add(record, 'mining:stolen', 'debit', record.stolen);
        add(record, 'mining:maintenance', 'debit', { alloys: record.maintenance_alloys });
      } else {
        const source = key === 'exp_recent_reports' ? record.kind || 'expedition' : key.replace(/_recent_reports|_collection_log|recent_reports/g, '') || 'survey';
        add(record, source, 'credit', record.loot || record);
      }
    }
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

export function analyticsBuckets(entries, interval, days, now = Date.now()) {
  const intervals = { '15m': 900000, '1h': 3600000, '1d': 86400000 };
  const step = intervals[interval];
  if (!step || ![1, 7, 30].includes(Number(days))) throw new Error('Invalid analytics interval or timeframe.');
  const buckets = new Map();
  for (const item of entries) {
    if (item.timestamp < now - Number(days) * 86400000 || item.timestamp > now) continue;
    const start = Math.floor(item.timestamp / step) * step;
    if (!buckets.has(start)) buckets.set(start, { timestamp: start, interval, resources: {} });
    const resources = buckets.get(start).resources;
    resources[item.source] ||= {};
    for (const [key, value] of Object.entries(item.resources)) {
      resources[item.source][key] ||= { credit: 0, debit: 0 };
      resources[item.source][key][item.type] += value;
    }
  }
  return [...buckets.values()].sort((a, b) => b.timestamp - a.timestamp);
}
