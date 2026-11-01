/**
 * Offline sales queue in IndexedDB. A sale rung up without a connection is stored
 * with its device-generated id and original sale time, then synced with
 * `Idempotency-Key: pos-sale-<id>` so a retried sync can never double-book.
 */
export interface QueuedSale {
  id: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /** permanent server rejection: needs a person to look at it */
  rejected?: boolean;
}

const DB = 'aod-pos';
const STORE = 'sales';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(r.result);
    };
    t.onerror = () => reject(t.error);
  });
}

export const queueSale = (s: QueuedSale) => tx('readwrite', (st) => st.put(s));
export const listQueued = () => tx<QueuedSale[]>('readonly', (st) => st.getAll() as IDBRequest<QueuedSale[]>);
export const removeQueued = (id: string) => tx('readwrite', (st) => st.delete(id));

export class NetworkError extends Error {}

/** Posts every queued sale in order of sale time; stops at the first network failure. */
export async function syncQueue(post: (s: QueuedSale) => Promise<void>): Promise<{ synced: number; remaining: number }> {
  const all = (await listQueued()).filter((s) => !s.rejected).sort((a, b) => String(a.payload.sold_at).localeCompare(String(b.payload.sold_at)));
  let synced = 0;
  for (const s of all) {
    try {
      await post(s);
      await removeQueued(s.id);
      synced++;
    } catch (e) {
      if (e instanceof NetworkError) break;
      await queueSale({ ...s, attempts: s.attempts + 1, lastError: (e as Error).message, rejected: true });
    }
  }
  return { synced, remaining: (await listQueued()).length };
}
