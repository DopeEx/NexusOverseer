import { stageBackupStorage, clearBackupStorageStage } from './galaxy-cache.js';
import { prepareBackupFile, releaseBackupFile } from './backup-host.js';

let queue = Promise.resolve();
const interactiveJobs = new Map();

export function cancelBackupDownload(id) {
  const controller = interactiveJobs.get(id);
  if (!controller) return false;
  controller.abort(new DOMException('Backup cancelled.', 'AbortError'));
  return true;
}

function progress(id, phase, rows) {
  if (id) void browser.runtime.sendMessage({ type: 'BACKUP_PROGRESS', id, phase, rows }).catch(error => {
    console.debug('[NexusOverseer] Backup progress listener unavailable:', error.message);
  });
}

async function waitForDownload(id, signal) {
  const api = browser.downloads;
  let listener, abort;
  try {
    await new Promise((resolve, reject) => {
      const check = ({ state, error }) => {
        if (state === 'complete') resolve();
        if (state === 'interrupted') reject(new Error(`Backup download interrupted: ${error || 'unknown reason'}`));
      };
      listener = event => {
        if (event.id === id && event.state) check({ state: event.state.current, error: event.error?.current });
      };
      abort = () => reject(signal.reason);
      api.onChanged.addListener(listener);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else api.search({ id }).then(([item]) => {
        if (!item) reject(new Error('Backup download was not found.'));
        else check(item);
      }, reject);
    });
  } catch (error) {
    if (signal.aborted) {
      try { await api.cancel(id); }
      catch (cancelError) { console.warn('[NexusOverseer] Could not stop backup download:', cancelError.message); }
    }
    throw error;
  } finally {
    if (listener) api.onChanged.removeListener(listener);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function downloadArchive(options, id, signal, requestId) {
  const offscreen = globalThis.chrome?.offscreen;
  let url, release, started = false, preparing = false;
  const send = action => browser.runtime.sendMessage({ target: 'backup-offscreen', action, id, options });
  const releaseWriter = () => {
    if (offscreen && started && !release) {
      release = send('release').then(() => null, error => error);
    }
  };
  const stopWriter = () => { if (preparing) releaseWriter(); };
  // Chrome's MV3 worker must stay alive while the offscreen writer and download run.
  const heartbeat = offscreen && setInterval(() => {
    void browser.runtime.getPlatformInfo().catch(error => {
      console.warn('[NexusOverseer] Backup worker keepalive failed:', error.message);
    });
  }, 20_000);
  signal.addEventListener('abort', stopWriter);
  try {
    progress(requestId, 'writing', 0);
    if (offscreen) {
      if (await offscreen.hasDocument()) await offscreen.closeDocument();
      await offscreen.createDocument({
        url: 'backup-offscreen.html', reasons: ['BLOBS', 'WORKERS'],
        justification: 'Write a compressed backup in a worker and expose its file as a download URL.',
      });
      signal.throwIfAborted();
      started = preparing = true;
      const result = await send('prepare');
      preparing = false;
      signal.throwIfAborted();
      url = result?.url;
      if (!url) throw new Error(result?.error || 'Backup writer did not produce a file.');
    } else {
      url = await prepareBackupFile(options, { signal, progress: rows => progress(requestId, 'writing', rows) });
    }
    signal.throwIfAborted();
    progress(requestId, 'downloading');
    const downloadId = await browser.downloads.download({
      url,
      filename: `NexusOverseer/nexus-overseer-${options.reason}-${options.exportedAt.slice(0, 10)}.nexus-backup.gz`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    await waitForDownload(downloadId, signal);
  } finally {
    signal.removeEventListener('abort', stopWriter);
    clearInterval(heartbeat);
    try {
      if (offscreen) {
        releaseWriter();
        const error = await release;
        if (error) console.warn('[NexusOverseer] Could not release backup writer:', error.message);
      } else {
        await releaseBackupFile(url);
      }
    } catch (error) {
      console.warn('[NexusOverseer] Could not remove temporary backup file:', error.message);
    } finally {
      try {
        if (offscreen && await offscreen.hasDocument()) await offscreen.closeDocument();
      } catch (error) {
        console.warn('[NexusOverseer] Could not close backup writer:', error.message);
      }
    }
  }
}

export function backupToDownloads(reason, { includeGalaxy = true, requestId } = {}) {
  if (typeof reason !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/i.test(reason)) {
    return Promise.reject(new Error('Invalid backup reason.'));
  }
  if (requestId && interactiveJobs.has(requestId)) return Promise.reject(new Error('Backup already running.'));
  const controller = new AbortController();
  if (requestId) interactiveJobs.set(requestId, controller);
  const run = queue.then(async () => {
    const { signal } = controller;
    signal.throwIfAborted();
    const id = requestId || crypto.randomUUID();
    const exportedAt = new Date().toISOString();
    progress(requestId, 'preparing');
    const data = await (globalThis.nexusStorage?.exportFullStorage
      ? globalThis.nexusStorage.exportFullStorage() : browser.storage.local.get(null));
    signal.throwIfAborted();
    try {
      await stageBackupStorage(data);
      signal.throwIfAborted();
      await downloadArchive({ reason, includeGalaxy, exportedAt, interactive: !!requestId }, id, signal, requestId);
      if (includeGalaxy) await browser.storage.local.set({ last_backup: new Date().toISOString() });
      console.log(`[NexusOverseer] Backup written (${reason}).`);
    } finally {
      await clearBackupStorageStage();
    }
  }).finally(() => { if (requestId) interactiveJobs.delete(requestId); });
  queue = run.catch(() => {}); // Keep the queue usable; the caller receives the original rejection.
  return run;
}
