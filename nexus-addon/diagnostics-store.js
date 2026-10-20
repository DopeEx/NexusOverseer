let connection;

function database() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('nexus-diagnostics', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
      store.createIndex('server', 'serverKey');
      // Size and kind are available in the index without cloning stored bodies.
      store.createIndex('retention', ['serverKey', 'kind', 'bytes', 'sequence']);
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('Diagnostic database is blocked. Close older addon tabs and retry.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
  });
  return connection;
}

function validateServer(serverKey) {
  if (typeof serverKey !== 'string' || !/^[a-z0-9-]{1,63}$/.test(serverKey)) throw new Error('Invalid diagnostic server.');
}

async function transaction(serverKey, mode, work) {
  validateServer(serverKey);
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Diagnostic database transaction aborted.'));
    tx.onerror = () => reject(tx.error || new Error('Diagnostic database transaction failed.'));
    try { work(tx.objectStore('entries'), value => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export function readDiagnosticLogs(serverKey) {
  return transaction(serverKey, 'readonly', (store, done) => {
    const request = store.index('server').getAll(serverKey);
    request.onsuccess = () => done(request.result.sort((a, b) => b.id - a.id).map(row => row.entry));
  });
}

export function writeDiagnosticLogs(serverKey, entries, streamLimit, byteLimit) {
  return transaction(serverKey, 'readwrite', store => {
    for (const entry of entries) {
      store.add({
        serverKey, kind: entry.kind, entry,
        bytes: new TextEncoder().encode(JSON.stringify(entry)).length,
        sequence: crypto.randomUUID(),
      });
    }
    // Fetch index keys only: retention never re-serializes historical payloads.
    const request = store.index('retention').openKeyCursor(IDBKeyRange.bound([serverKey], [serverKey, []]));
    const rows = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if (cursor.key[0] === serverKey) rows.push({ id: cursor.primaryKey, kind: cursor.key[1], bytes: cursor.key[2] });
        cursor.continue();
        return;
      }
      rows.sort((a, b) => b.id - a.id);
      const counts = {};
      let bytes = 0;
      for (const row of rows) {
        counts[row.kind] = (counts[row.kind] || 0) + 1;
        if (counts[row.kind] > (row.kind === 'scheduling' ? 1000 : streamLimit) || bytes + row.bytes > byteLimit) store.delete(row.id);
        else bytes += row.bytes;
      }
    };
  });
}

export function clearDiagnosticLogs(serverKey, kind) {
  return transaction(serverKey, 'readwrite', store => {
    const request = store.index('retention').openKeyCursor(IDBKeyRange.bound([serverKey], [serverKey, []]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.key[0] === serverKey && (!kind || cursor.key[1] === kind)) store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}
