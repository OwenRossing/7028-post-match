// Tiny promise wrapper around IndexedDB. Stores: kv (settings, folder handle), files (saved uploads),
// summaries (cached library summaries).

export type StoreName = 'kv' | 'files' | 'summaries';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('pitview', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['kv', 'files', 'summaries']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return run(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined);
  },
  set(store: StoreName, key: string, value: unknown): Promise<void> {
    return run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
  },
  del(store: StoreName, key: string): Promise<void> {
    return run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
  },
  keys(store: StoreName): Promise<string[]> {
    return run(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<string[]>).catch(() => []);
  },
  clear(store: StoreName): Promise<void> {
    return run(store, 'readwrite', (s) => s.clear()).then(() => undefined);
  },
};
