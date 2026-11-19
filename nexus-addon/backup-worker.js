import { createBackupArchive, stageBackupArchive } from './backup-archive.js';
import { commitBackupImportRows } from './galaxy-cache.js';

async function writeArchive({ name, options }, progress) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  let written = 0;
  try {
    handle.truncate(0);
    await createBackupArchive(options, progress).pipeTo(new WritableStream({
      write(chunk) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const bytes = handle.write(chunk.subarray(offset), { at: written });
          if (bytes <= 0) throw new Error('Backup file write made no progress.');
          offset += bytes;
          written += bytes;
        }
      },
    }));
    handle.flush();
  } finally {
    handle.close();
  }
  return written;
}

globalThis.onmessage = async ({ data: { action, input } }) => {
  const progress = rows => globalThis.postMessage({ rows });
  try {
    let result;
    if (action === 'write') result = await writeArchive(input, progress);
    else if (action === 'stage') result = await stageBackupArchive(input, progress);
    else if (action === 'commit') await commitBackupImportRows();
    else throw new Error('Unsupported backup worker action.');
    globalThis.postMessage({ result });
  } catch (error) {
    globalThis.postMessage({ error: error.message });
  }
};
