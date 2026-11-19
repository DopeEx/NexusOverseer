import { addBackupImportRows, backupGalaxyEntries, backupStorageEntries, clearBackupImportStage,
  prepareGalaxyBackupEntry, STORAGE_ONLY_BACKUP_VERSION } from './galaxy-cache.js';

const FORMAT = 3;
const MAX_RECORD = 128 * 1024 * 1024;
const BATCH = 16;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Keep large catalog arrays and report archives out of a single stringify call.
function* jsonParts(value, depth = 4) {
  if (depth && Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i) yield ',';
      yield* jsonParts(value[i] ?? null, depth - 1);
    }
    yield ']';
  } else if (depth && isObject(value) && !value.toJSON) {
    let first = true;
    yield '{';
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
      if (!first) yield ',';
      first = false;
      yield `${JSON.stringify(key)}:`;
      yield* jsonParts(member, depth - 1);
    }
    yield '}';
  } else {
    yield JSON.stringify(value);
  }
}

async function* archiveRecords({ exportedAt, reason, includeGalaxy }, progress) {
  yield { type: 'header', nexus_overseer_backup: FORMAT, exportedAt, reason, includeGalaxy };
  let storage = 0;
  for await (const row of backupStorageEntries()) {
    yield { type: 'storage', ...row };
    storage++;
  }
  let galaxy = 0;
  if (includeGalaxy) {
    for await (const entry of backupGalaxyEntries()) {
      yield { type: 'galaxy', entry };
      if (++galaxy % 128 === 0) progress(galaxy);
    }
  }
  progress(galaxy);
  yield { type: 'end', storage, galaxy };
}

export function createBackupArchive(options, progress = () => {}) {
  const encoder = new TextEncoder();
  const records = (async function* () {
    let text = '';
    for await (const record of archiveRecords(options, progress)) {
      const parts = record.type === 'storage' || (record.type === 'galaxy' && !record.entry.key.startsWith('system:'))
        ? jsonParts(record) : [JSON.stringify(record)];
      let length = 0;
      for (const part of parts) {
        length += part.length;
        if (length > MAX_RECORD) throw new Error('A backup record exceeds the supported size.');
        text += part;
        if (text.length >= 64 * 1024) {
          yield encoder.encode(text);
          text = '';
        }
      }
      text += '\n';
    }
    if (text) yield encoder.encode(text);
  })();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await records.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() { return records.return(); },
  }).pipeThrough(new CompressionStream('gzip'));
}

async function* readRecords(file) {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream('utf-8', { fatal: true })).getReader();
  let pieces = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        const end = value.indexOf('\n', offset);
        const piece = value.slice(offset, end < 0 ? undefined : end);
        length += piece.length;
        if (length > MAX_RECORD) throw new Error('A backup record exceeds the supported size.');
        pieces.push(piece);
        if (end < 0) break;
        const record = JSON.parse(pieces.join(''));
        pieces = [];
        length = 0;
        offset = end + 1;
        yield record;
      }
    }
    if (length) throw new Error('Incomplete backup record.');
  } finally {
    await reader.cancel().catch(() => {}); // The original stream error is reported to the caller.
    reader.releaseLock();
  }
}

async function stageArchive(file, progress) {
  let header;
  let finished = false;
  let count = 0;
  let rows = [];
  const storage = new Map();
  for await (const record of readRecords(file)) {
    if (!isObject(record) || finished) throw new Error('Unexpected backup record.');
    if (!header) {
      if (record.type !== 'header' || record.nexus_overseer_backup !== FORMAT ||
          typeof record.exportedAt !== 'string' || typeof record.includeGalaxy !== 'boolean') {
        throw new Error('Unsupported Nexus Overseer backup format.');
      }
      header = record;
    } else if (record.type === 'storage') {
      if (typeof record.key !== 'string' || storage.has(record.key) || !Object.hasOwn(record, 'value')) {
        throw new Error('Invalid or duplicate backup storage key.');
      }
      storage.set(record.key, record.value);
    } else if (record.type === 'galaxy' && header.includeGalaxy) {
      rows.push(prepareGalaxyBackupEntry(record.entry, true));
      count++;
      if (rows.length === BATCH || record.entry.key === 'public:galaxy') {
        await addBackupImportRows(rows);
        rows = [];
      }
      if (count % 128 === 0) progress(count);
    } else if (record.type === 'end' && record.storage === storage.size && record.galaxy === count) {
      finished = true;
    } else {
      throw new Error('Invalid backup record or entry count.');
    }
  }
  if (!finished) throw new Error('Backup is incomplete.');
  if (rows.length) await addBackupImportRows(rows);
  return { data: Object.fromEntries(storage), preserveGalaxy: !header.includeGalaxy, exportedAt: header.exportedAt };
}

async function stageLegacy(file, progress) {
  const payload = JSON.parse(await file.text());
  const preserveGalaxy = payload?.nexus_overseer_backup === STORAGE_ONLY_BACKUP_VERSION;
  if (!isObject(payload?.data) || !(preserveGalaxy || payload.nexus_overseer_backup === 1 ||
      payload.nexus_accounting_backup === 1)) throw new Error('Not a Nexus Overseer backup file.');
  if (preserveGalaxy && Object.hasOwn(payload, 'galaxyCache')) {
    throw new Error('Storage-only backups must not contain a galaxy database.');
  }
  const galaxy = payload.galaxyCache;
  if (galaxy != null && (galaxy.version !== 1 || !Array.isArray(galaxy.entries))) throw new Error('Invalid galaxy backup.');
  const entries = galaxy?.entries ?? [];
  for (let offset = 0; offset < entries.length; offset += BATCH) {
    await addBackupImportRows(entries.slice(offset, offset + BATCH).map(entry => prepareGalaxyBackupEntry(entry)), true);
    if (offset % 128 === 0) progress(offset);
  }
  return { data: payload.data, preserveGalaxy, exportedAt: payload.exported_at };
}

export async function stageBackupArchive(file, progress = () => {}) {
  try { await clearBackupImportStage(); }
  catch (cleanup) { console.warn('[NexusOverseer] Could not clear staged backup:', cleanup.message); }
  try {
    const [a, b] = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return await (a === 0x1f && b === 0x8b ? stageArchive(file, progress) : stageLegacy(file, progress));
  } catch (error) {
    await clearBackupImportStage();
    throw error;
  }
}
