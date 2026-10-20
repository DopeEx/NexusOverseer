import { validatePublicGalaxy, validatePublicManifest, PUBLIC_MAX_BYTES } from './galaxy-public.js';

export const PUBLIC_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
export const PUBLIC_GALAXY_URL = 'https://raw.githubusercontent.com/DopeEx/NexusOverseer/master/data/galaxy/';
const STATUS_KEY = 'galaxy_public_status';

export async function galaxySha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function requestText(fetcher, path) {
  const response = await fetcher(`${PUBLIC_GALAXY_URL}${path}`, {
    method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Public galaxy download failed (HTTP ${response.status}).`);
  if (Number(response.headers?.get('content-length')) > PUBLIC_MAX_BYTES) throw new Error('Public galaxy file exceeds 25 MB.');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PUBLIC_MAX_BYTES) throw new Error('Public galaxy file exceeds 25 MB.');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createGalaxySharing({ storage, read, write, fetcher = fetch, now = Date.now }) {
  const pending = new Map(), generations = new Map();
  return {
    cancel(serverKey) { generations.set(serverKey, (generations.get(serverKey) || 0) + 1); },
    async status(serverKey) {
      const state = (await storage.get(STATUS_KEY))[STATUS_KEY] || {};
      const installed = await read(serverKey);
      return { ...state, installed: installed?.sha256 || null, installedAt: installed?.at || null };
    },
    async update(serverKey, { force = false, enabled = true } = {}) {
      if (!/^[a-z0-9-]{1,63}$/.test(serverKey)) throw new Error('Invalid public galaxy universe.');
      if (pending.has(serverKey)) return pending.get(serverKey);
      const generation = generations.get(serverKey) || 0;
      const run = async () => {
        const state = await this.status(serverKey);
        const at = now();
        if ((!force && !enabled) || (state.checkedAt && at >= state.checkedAt &&
          at - state.checkedAt < (force ? 30000 : PUBLIC_CHECK_INTERVAL))) return state;
        let result = { ...state, checkedAt: at, message: 'Public galaxy check interrupted.' };
        await storage.set({ [STATUS_KEY]: result });
        const current = () => {
          if ((generations.get(serverKey) || 0) !== generation) throw new Error('Public galaxy update cancelled because data was cleared.');
        };
        try {
          const manifest = validatePublicManifest(JSON.parse(await requestText(fetcher, 'manifest.json')));
          current();
          const entry = Object.hasOwn(manifest.servers, serverKey) ? manifest.servers[serverKey] : null;
          if (!entry) result = { ...result, message: 'No public dataset published for this universe yet.', error: null };
          else {
            if (state.installed !== entry.sha256) {
              const text = await requestText(fetcher, entry.file);
              if (await galaxySha256(text) !== entry.sha256) throw new Error('Public galaxy checksum mismatch. Existing data was kept.');
              const data = validatePublicGalaxy(JSON.parse(text), serverKey);
              current();
              await write(serverKey, data, entry.sha256);
            }
            result = { ...result, message: state.installed === entry.sha256
              ? 'Public galaxy data is up to date.' : 'Public galaxy data updated.', error: null };
          }
        } catch (error) {
          current();
          console.warn('[NexusOverseer] Public galaxy check failed:', error);
          result = { ...result, error: error.message, message: `Update failed: ${error.message}` };
        }
        current();
        if (!result.error) result.successAt = at;
        await storage.set({ [STATUS_KEY]: result });
        return this.status(serverKey);
      };
      const promise = run();
      pending.set(serverKey, promise);
      try { return await promise; }
      finally { pending.delete(serverKey); }
    },
  };
}
