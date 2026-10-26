import { parsePersistedWorld, type PersistedWorldSnapshotV1, type WorldParseResult } from './worldState.ts';

export const WORLD_DATABASE_NAME = 'kurohige-map-world';
export const WORLD_DATABASE_VERSION = 1;
export const ACTIVE_WORLD_KEY = 'active-world';

export type WorldLoadResult =
  | { status: 'missing' }
  | { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }
  | { status: 'corrupt'; reason: string };

export interface WorldRepository {
  loadActive(): Promise<WorldLoadResult>;
  save(snapshot: PersistedWorldSnapshotV1): Promise<boolean>;
  corruptActiveForTest?(value: unknown): Promise<void>;
  clearActive(): Promise<void>;
  replaceActive?(snapshot: PersistedWorldSnapshotV1 | null, expected: { worldId: string; worldRevision: number } | null): Promise<void>;
}

type StoredWorld = { key: string; snapshot: unknown };
type QuarantinedWorld = { quarantinedAt: string; reason: string; snapshot: unknown };

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
});

function openWorldDatabase(factory: IDBFactory, databaseName: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, WORLD_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('worlds')) database.createObjectStore('worlds', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('quarantine')) database.createObjectStore('quarantine', { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open World database.'));
  });
}

async function quarantine(database: IDBDatabase, snapshot: unknown, reason: string) {
  const transaction = database.transaction('quarantine', 'readwrite');
  transaction.objectStore('quarantine').add({ quarantinedAt: new Date().toISOString(), reason, snapshot } satisfies QuarantinedWorld);
  await transactionDone(transaction);
}

export function createIndexedDbWorldRepository(
  factory: IDBFactory = globalThis.indexedDB,
  options: { databaseName?: string; quarantineCorrupt?: boolean } = {},
): WorldRepository {
  let saveQueue = Promise.resolve<boolean>(true);
  const databasePromise = openWorldDatabase(factory, options.databaseName ?? WORLD_DATABASE_NAME);
  return {
    async loadActive() {
      const database = await databasePromise;
      const transaction = database.transaction('worlds', 'readonly');
      const stored = await requestResult(transaction.objectStore('worlds').get(ACTIVE_WORLD_KEY) as IDBRequest<StoredWorld | undefined>);
      await transactionDone(transaction);
      if (!stored) return { status: 'missing' };
      const parsed = parsePersistedWorld(stored.snapshot);
      if (parsed.status === 'ready') return parsed;
      if (options.quarantineCorrupt !== false) await quarantine(database, stored.snapshot, parsed.reason);
      return parsed;
    },
    save(snapshot) {
      saveQueue = saveQueue.then(async () => {
        const database = await databasePromise;
        const transaction = database.transaction('worlds', 'readwrite');
        const store = transaction.objectStore('worlds');
        const current = await requestResult(store.get(ACTIVE_WORLD_KEY) as IDBRequest<StoredWorld | undefined>);
        const currentRevision = current && typeof current.snapshot === 'object' && current.snapshot
          && 'worldRevision' in current.snapshot && Number.isSafeInteger((current.snapshot as { worldRevision?: unknown }).worldRevision)
          ? Number((current.snapshot as { worldRevision: number }).worldRevision)
          : -1;
        const currentWorldId = current && typeof current.snapshot === 'object' && current.snapshot
          && 'worldId' in current.snapshot && typeof (current.snapshot as { worldId?: unknown }).worldId === 'string'
          ? (current.snapshot as { worldId: string }).worldId
          : '';
        if (currentWorldId === snapshot.worldId && currentRevision >= snapshot.worldRevision) {
          transaction.abort();
          try { await transactionDone(transaction); } catch { /* Expected abort for a stale save. */ }
          return false;
        }
        store.put({ key: ACTIVE_WORLD_KEY, snapshot } satisfies StoredWorld);
        await transactionDone(transaction);
        return true;
      });
      return saveQueue;
    },
    async corruptActiveForTest(value) {
      const database = await databasePromise;
      const transaction = database.transaction('worlds', 'readwrite');
      transaction.objectStore('worlds').put({ key: ACTIVE_WORLD_KEY, snapshot: value } satisfies StoredWorld);
      await transactionDone(transaction);
    },
    async clearActive() {
      const database = await databasePromise;
      const transaction = database.transaction('worlds', 'readwrite');
      transaction.objectStore('worlds').delete(ACTIVE_WORLD_KEY);
      await transactionDone(transaction);
    },
    async replaceActive(snapshot, expected) {
      const database = await databasePromise;
      const transaction = database.transaction('worlds', 'readwrite');
      const store = transaction.objectStore('worlds');
      const current = await requestResult(store.get(ACTIVE_WORLD_KEY) as IDBRequest<StoredWorld | undefined>);
      const currentWorldId = current && typeof current.snapshot === 'object' && current.snapshot && 'worldId' in current.snapshot
        ? String((current.snapshot as { worldId?: unknown }).worldId ?? '') : '';
      const currentRevision = current && typeof current.snapshot === 'object' && current.snapshot && 'worldRevision' in current.snapshot
        ? Number((current.snapshot as { worldRevision?: unknown }).worldRevision) : -1;
      const matches = expected === null ? !current : currentWorldId === expected.worldId && currentRevision === expected.worldRevision;
      if (!matches) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* stale local state */ }
        throw new Error('The local World changed before the server Snapshot could be applied.');
      }
      if (snapshot) store.put({ key: ACTIVE_WORLD_KEY, snapshot: structuredClone(snapshot) } satisfies StoredWorld);
      else store.delete(ACTIVE_WORLD_KEY);
      await transactionDone(transaction);
    },
  };
}

export function createMemoryWorldRepository(initial?: unknown): WorldRepository & { readRaw(): unknown } {
  let value = initial;
  let queue = Promise.resolve<boolean>(true);
  return {
    async loadActive() {
      if (value === undefined) return { status: 'missing' };
      const parsed: WorldParseResult = parsePersistedWorld(value);
      if (parsed.status === 'corrupt') {
        return parsed;
      }
      return parsed;
    },
    save(snapshot) {
      queue = queue.then(async () => {
        const parsed = value === undefined ? null : parsePersistedWorld(value);
        const currentRevision = parsed?.status === 'ready' ? parsed.snapshot.worldRevision : -1;
        const currentWorldId = parsed?.status === 'ready' ? parsed.snapshot.worldId : '';
        if (currentWorldId === snapshot.worldId && currentRevision >= snapshot.worldRevision) return false;
        value = structuredClone(snapshot);
        return true;
      });
      return queue;
    },
    async corruptActiveForTest(next) { value = next; },
    async clearActive() { value = undefined; },
    async replaceActive(snapshot, expected) {
      const parsed = value === undefined ? null : parsePersistedWorld(value);
      const matches = expected === null
        ? value === undefined
        : parsed?.status === 'ready' && parsed.snapshot.worldId === expected.worldId && parsed.snapshot.worldRevision === expected.worldRevision;
      if (!matches) throw new Error('The local World changed before the server Snapshot could be applied.');
      value = snapshot ? structuredClone(snapshot) : undefined;
    },
    readRaw: () => value,
  };
}
