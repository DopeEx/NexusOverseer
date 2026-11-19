export async function runBackupWorker(action, input, { signal, progress } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./backup-worker.js', import.meta.url), { type: 'module' });
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (Object.hasOwn(data, 'rows')) progress?.(data.rows);
        else if (Object.hasOwn(data, 'error')) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = event => reject(new Error(event.message || 'Backup worker failed.'));
      worker.onmessageerror = () => reject(new Error('Could not read the backup worker response.'));
      worker.postMessage({ action, input });
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}

const TEMP = 'nexus-backup-download.tmp';

export async function releaseBackupFile(url) {
  if (url) URL.revokeObjectURL(url);
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(TEMP);
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
}

export async function prepareBackupFile(options, { signal, progress }) {
  const root = await navigator.storage.getDirectory();
  const size = await runBackupWorker('write', { name: TEMP, options }, { signal, progress });
  signal.throwIfAborted();
  const file = await (await root.getFileHandle(TEMP)).getFile();
  if (!size || file.size !== size) throw new Error('Incomplete backup file.');
  // The temporary file has no gzip MIME type; Chrome can otherwise change the download to .txt.
  return URL.createObjectURL(file.slice(0, file.size, 'application/gzip'));
}
