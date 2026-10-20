import { readDiagnosticLogs, writeDiagnosticLogs } from './diagnostics-store.js';

export const TRAFFIC_SOURCES = new Set([
  'galaxy-search', 'ownership-check', 'galaxy-cache', 'dashboard', 'simulator',
  'background-maintenance', 'fleet-action', 'content-tool', 'native-game',
  'scouting', 'pirates', 'expeditions', 'market', 'research', 'universe-catalog',
  'asteroid-search', 'xeno-search',
  'empire-view', 'logistics', 'building-planner', 'technology-planner', 'ship-planner', 'upgrade-queue',
]);
export const trafficSource = source => TRAFFIC_SOURCES.has(source) ? source : 'background-maintenance';

export function summarizeTraffic(entries) {
  const groups = new Map();
  const pending = new Map();
  const ended = new Set(entries.filter(entry => entry.kind === 'scheduling' && entry.data.event === 'wait-end')
    .map(entry => entry.data.id));
  for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    if (entry.kind !== 'scheduling') continue;
    const data = entry.data;
    const source = data.source;
    if (!groups.has(source)) groups.set(source, { source, requests: 0, pauses: 0, waitMs: 0, limited: 0, interrupted: 0 });
    const group = groups.get(source);
    if (data.event === 'dispatch') group.requests++;
    if (data.event === 'response' && data.status === 429) group.limited++;
    if (data.event === 'wait-start' && !ended.has(data.id)) pending.set(data.id, data);
    if (data.event === 'wait-end') {
      pending.delete(data.id);
      group.waitMs += data.durationMs;
      if (data.reasons.some(reason => reason.reason === 'budget')) group.pauses++;
      if (data.outcome === 'interrupted') group.interrupted++;
    }
  }
  return { groups: [...groups.values()], pending: [...pending.values()] };
}

export function createTrafficRecorder({ enabled, read = readDiagnosticLogs, write = writeDiagnosticLogs }) {
  let work = Promise.resolve();
  const recovered = new Set();
  return (origin, data) => {
    if (!enabled()) return;
    const serverKey = new URL(origin).hostname.split('.')[0];
    const timestamp = Date.now();
    const event = structuredClone(data);
    work = work.then(async () => {
      if (!enabled()) return;
      const entries = [];
      if (!recovered.has(serverKey)) {
        const old = await read(serverKey);
        for (const wait of summarizeTraffic(old).pending) {
          entries.push({ kind: 'scheduling', timestamp, data: {
            ...wait, event: 'wait-end', outcome: 'interrupted',
            durationMs: Math.max(0, (wait.lastSeenAt || wait.startedAt) - wait.startedAt),
            durationIncomplete: true,
          } });
        }
      }
      entries.push({ kind: 'scheduling', timestamp, data: event });
      await write(serverKey, entries, 150, 10000000);
      recovered.add(serverKey);
    }).catch(error => {
      console.error('[NexusOverseer] API wait recording failed:', error);
    });
    return work;
  };
}
