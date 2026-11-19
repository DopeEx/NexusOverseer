import { prepareBackupFile, releaseBackupFile } from './backup-host.js';

let job;

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || sender.tab || message?.target !== 'backup-offscreen') return;
  if (message.action === 'prepare') {
    if (job) return Promise.reject(new Error('Backup writer is busy.'));
    const current = job = { id: message.id, controller: new AbortController() };
    current.work = prepareBackupFile(message.options, {
      signal: current.controller.signal,
      progress: rows => {
        if (message.options.interactive) {
          void browser.runtime.sendMessage({ type: 'BACKUP_PROGRESS', id: current.id, phase: 'writing', rows }).catch(() => {});
        }
      },
    }).then(url => { current.url = url; return { url }; }, error => ({ error: error.message }));
    return current.work;
  }
  if (job?.id !== message.id) return;
  if (message.action === 'release') {
    const current = job;
    current.controller.abort(new DOMException('Backup cancelled.', 'AbortError'));
    return current.work.then(() => releaseBackupFile(current.url)).finally(() => { job = undefined; });
  }
});
