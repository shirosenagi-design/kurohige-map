import type { AccountSyncBundleV1 } from './accountSyncContract.ts';

export const SYNC_OUTBOX_DATABASE_NAME = 'kurohige-map-account-sync';
export const SYNC_OUTBOX_DATABASE_VERSION = 2;
export const SYNC_OUTBOX_LEASE_MS = 30_000;

export type SyncOutboxState = 'pending' | 'sending' | 'acknowledged' | 'conflict' | 'blocked';
export type SyncBlockReason = 'reauthentication_required' | 'invalid_payload' | 'payload_too_large' | 'account_changed' | 'repair_required';

export type SyncOutboxOperation = {
  operationId: string;
  accountId: string;
  worldId: string | null;
  deviceId: string;
  baseSyncRevision: number;
  bundle: AccountSyncBundleV1;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  state: SyncOutboxState;
  retryCount: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  acknowledgedSyncRevision: number | null;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
  blockedReason: SyncBlockReason | null;
  conflict: unknown | null;
};

export type SyncAuthorization = {
  accountId: string;
  deviceId: string;
  authorizedWorldIds: string[];
  acknowledgedSyncRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type SyncOutboxQuarantine = {
  quarantinedAt: string;
  reason: string;
  value: unknown;
};

export type SyncLocalApplyState = 'prepared' | 'world_applied' | 'completed' | 'failed';

export type SyncLocalApplyJournal = {
  id: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  state: SyncLocalApplyState;
  previousProduct: unknown;
  previousWorld: unknown | null;
  targetProduct: unknown;
  targetWorld: unknown | null;
  serverSyncRevision: number;
  errorCode: string | null;
};

export interface SyncOutboxRepository {
  authorizeWorld(input: { accountId: string; worldId: string; deviceId?: string; acknowledgedSyncRevision: number }): Promise<SyncAuthorization>;
  getAuthorization(accountId: string): Promise<SyncAuthorization | null>;
  listAuthorizations(): Promise<SyncAuthorization[]>;
  enqueue(operation: SyncOutboxOperation): Promise<void>;
  get(operationId: string): Promise<SyncOutboxOperation | null>;
  list(accountId: string): Promise<SyncOutboxOperation[]>;
  claimNext(accountId: string, leaseOwner: string, now: Date, leaseMs?: number): Promise<SyncOutboxOperation | null>;
  updateClaimed(operationId: string, leaseOwner: string, update: Partial<SyncOutboxOperation>): Promise<SyncOutboxOperation>;
  acknowledge(operationId: string, leaseOwner: string, syncRevision: number, now: Date): Promise<SyncOutboxOperation>;
  resumeAuthenticationBlocks(accountId: string): Promise<number>;
  settleConflict(input: { accountId: string; operationId: string; acknowledgedSyncRevision: number; outcome: 'server' | 'candidate' }): Promise<void>;
  prepareLocalApply(journal: SyncLocalApplyJournal): Promise<void>;
  updateLocalApply(id: string, update: Partial<SyncLocalApplyJournal>): Promise<SyncLocalApplyJournal>;
  getOpenLocalApply(accountId: string): Promise<SyncLocalApplyJournal | null>;
  quarantine(value: unknown, reason: string): Promise<void>;
}

type StoredAuthorization = SyncAuthorization & { key: string };

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
});

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, SYNC_OUTBOX_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('operations')) {
        const operations = database.createObjectStore('operations', { keyPath: 'operationId' });
        operations.createIndex('account-created', ['accountId', 'createdAt'], { unique: false });
        operations.createIndex('account-state-created', ['accountId', 'state', 'createdAt'], { unique: false });
      }
      if (!database.objectStoreNames.contains('authorizations')) database.createObjectStore('authorizations', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('quarantine')) database.createObjectStore('quarantine', { autoIncrement: true });
      if (!database.objectStoreNames.contains('local-apply')) {
        const recovery = database.createObjectStore('local-apply', { keyPath: 'id' });
        recovery.createIndex('account-created', ['accountId', 'createdAt'], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open sync Outbox database.'));
  });
}

const authorizationKey = (accountId: string) => `account:${accountId}`;
const asAuthorization = ({ key: _key, ...value }: StoredAuthorization): SyncAuthorization => value;

function byCreatedAt(left: SyncOutboxOperation, right: SyncOutboxOperation): number {
  return left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId);
}

export function createIndexedDbSyncOutbox(
  factory: IDBFactory = globalThis.indexedDB,
  options: { databaseName?: string } = {},
): SyncOutboxRepository {
  const databasePromise = openDatabase(factory, options.databaseName ?? SYNC_OUTBOX_DATABASE_NAME);
  return {
    async authorizeWorld({ accountId, worldId, deviceId, acknowledgedSyncRevision }) {
      const database = await databasePromise;
      const transaction = database.transaction('authorizations', 'readwrite');
      const store = transaction.objectStore('authorizations');
      const key = authorizationKey(accountId);
      const current = await requestResult(store.get(key) as IDBRequest<StoredAuthorization | undefined>);
      const now = new Date().toISOString();
      const authorization: StoredAuthorization = {
        key,
        accountId,
        deviceId: current?.deviceId ?? deviceId ?? `device-${crypto.randomUUID()}`,
        authorizedWorldIds: [...new Set([...(current?.authorizedWorldIds ?? []), worldId])],
        acknowledgedSyncRevision: Math.max(current?.acknowledgedSyncRevision ?? 0, acknowledgedSyncRevision),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      store.put(authorization);
      await transactionDone(transaction);
      return asAuthorization(authorization);
    },
    async getAuthorization(accountId) {
      const database = await databasePromise;
      const transaction = database.transaction('authorizations', 'readonly');
      const value = await requestResult(transaction.objectStore('authorizations').get(authorizationKey(accountId)) as IDBRequest<StoredAuthorization | undefined>);
      await transactionDone(transaction);
      return value ? asAuthorization(value) : null;
    },
    async listAuthorizations() {
      const database = await databasePromise;
      const transaction = database.transaction('authorizations', 'readonly');
      const values = await requestResult(transaction.objectStore('authorizations').getAll() as IDBRequest<StoredAuthorization[]>);
      await transactionDone(transaction);
      return values.map(asAuthorization);
    },
    async enqueue(operation) {
      const database = await databasePromise;
      const transaction = database.transaction(['operations', 'authorizations'], 'readwrite');
      const authorization = await requestResult(transaction.objectStore('authorizations').get(authorizationKey(operation.accountId)) as IDBRequest<StoredAuthorization | undefined>);
      if (!authorization || (operation.worldId && !authorization.authorizedWorldIds.includes(operation.worldId))) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* authorization rejection */ }
        throw new Error('Sync World was not explicitly authorized for this account.');
      }
      const store = transaction.objectStore('operations');
      const existing = await requestResult(store.get(operation.operationId) as IDBRequest<SyncOutboxOperation | undefined>);
      if (existing && existing.contentHash !== operation.contentHash) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* operation collision */ }
        throw new Error('operationId is already associated with different sync content.');
      }
      if (!existing) store.add(structuredClone(operation));
      await transactionDone(transaction);
    },
    async get(operationId) {
      const database = await databasePromise;
      const transaction = database.transaction('operations', 'readonly');
      const value = await requestResult(transaction.objectStore('operations').get(operationId) as IDBRequest<SyncOutboxOperation | undefined>);
      await transactionDone(transaction);
      return value ? structuredClone(value) : null;
    },
    async list(accountId) {
      const database = await databasePromise;
      const transaction = database.transaction('operations', 'readonly');
      const values = await requestResult(transaction.objectStore('operations').index('account-created').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff'])) as IDBRequest<SyncOutboxOperation[]>);
      await transactionDone(transaction);
      return values.sort(byCreatedAt).map((value) => structuredClone(value));
    },
    async claimNext(accountId, leaseOwner, now, leaseMs = SYNC_OUTBOX_LEASE_MS) {
      const database = await databasePromise;
      const transaction = database.transaction('operations', 'readwrite');
      const store = transaction.objectStore('operations');
      const values = (await requestResult(store.index('account-created').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff'])) as IDBRequest<SyncOutboxOperation[]>)).sort(byCreatedAt);
      const blocking = values.find((value) => value.state === 'conflict' || value.state === 'blocked');
      const nowMs = now.getTime();
      const next = blocking ? null : values.find((value) => {
        if (value.state === 'pending') return !value.nextAttemptAt || Date.parse(value.nextAttemptAt) <= nowMs;
        return value.state === 'sending' && (!value.leaseExpiresAt || Date.parse(value.leaseExpiresAt) <= nowMs);
      }) ?? null;
      if (next) {
        next.state = 'sending';
        next.updatedAt = now.toISOString();
        next.leaseOwner = leaseOwner;
        next.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
        store.put(next);
      }
      await transactionDone(transaction);
      return next ? structuredClone(next) : null;
    },
    async updateClaimed(operationId, leaseOwner, update) {
      const database = await databasePromise;
      const transaction = database.transaction('operations', 'readwrite');
      const store = transaction.objectStore('operations');
      const current = await requestResult(store.get(operationId) as IDBRequest<SyncOutboxOperation | undefined>);
      if (!current || current.leaseOwner !== leaseOwner || current.state !== 'sending') {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* lost lease */ }
        throw new Error('Sync Outbox lease is no longer owned by this sender.');
      }
      const next = { ...current, ...structuredClone(update), operationId: current.operationId, accountId: current.accountId, bundle: current.bundle };
      store.put(next);
      await transactionDone(transaction);
      return structuredClone(next);
    },
    async acknowledge(operationId, leaseOwner, syncRevision, now) {
      const database = await databasePromise;
      const transaction = database.transaction(['operations', 'authorizations'], 'readwrite');
      const store = transaction.objectStore('operations');
      const current = await requestResult(store.get(operationId) as IDBRequest<SyncOutboxOperation | undefined>);
      if (!current || current.leaseOwner !== leaseOwner || current.state !== 'sending') {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* lost lease */ }
        throw new Error('Sync Outbox lease is no longer owned by this sender.');
      }
      const next: SyncOutboxOperation = {
        ...current,
        state: 'acknowledged',
        updatedAt: now.toISOString(),
        acknowledgedSyncRevision: syncRevision,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        blockedReason: null,
      };
      store.put(next);
      const authStore = transaction.objectStore('authorizations');
      const auth = await requestResult(authStore.get(authorizationKey(current.accountId)) as IDBRequest<StoredAuthorization | undefined>);
      if (auth) authStore.put({ ...auth, acknowledgedSyncRevision: Math.max(auth.acknowledgedSyncRevision, syncRevision), updatedAt: now.toISOString() });
      await transactionDone(transaction);
      return structuredClone(next);
    },
    async resumeAuthenticationBlocks(accountId) {
      const database = await databasePromise;
      const transaction = database.transaction('operations', 'readwrite');
      const store = transaction.objectStore('operations');
      const values = await requestResult(store.index('account-created').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff'])) as IDBRequest<SyncOutboxOperation[]>);
      let resumed = 0;
      for (const value of values) {
        if (value.state === 'blocked' && (value.blockedReason === 'reauthentication_required' || value.blockedReason === 'account_changed')) {
          store.put({ ...value, state: 'pending', blockedReason: null, nextAttemptAt: null, updatedAt: new Date().toISOString(), lastErrorCode: null });
          resumed += 1;
        }
      }
      await transactionDone(transaction);
      return resumed;
    },
    async settleConflict({ accountId, operationId, acknowledgedSyncRevision, outcome }) {
      const database = await databasePromise;
      const transaction = database.transaction(['operations', 'authorizations'], 'readwrite');
      const store = transaction.objectStore('operations');
      const operations = await requestResult(store.index('account-created').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff'])) as IDBRequest<SyncOutboxOperation[]>);
      const current = operations.find((value) => value.operationId === operationId && value.state === 'conflict');
      if (!current) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* conflict was not locally owned */ }
        throw new Error('The local conflict operation is unavailable.');
      }
      const now = new Date().toISOString();
      store.put({
        ...current,
        state: 'acknowledged',
        acknowledgedSyncRevision,
        updatedAt: now,
        blockedReason: null,
        lastErrorCode: `conflict_${outcome}_selected`,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      for (const operation of operations) {
        if (operation.operationId === operationId || operation.state === 'acknowledged') continue;
        store.put({
          ...operation,
          state: 'blocked',
          blockedReason: 'repair_required',
          updatedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastErrorCode: 'superseded_after_conflict_resolution',
        });
      }
      const authStore = transaction.objectStore('authorizations');
      const auth = await requestResult(authStore.get(authorizationKey(accountId)) as IDBRequest<StoredAuthorization | undefined>);
      if (auth) authStore.put({ ...auth, acknowledgedSyncRevision: Math.max(auth.acknowledgedSyncRevision, acknowledgedSyncRevision), updatedAt: now });
      await transactionDone(transaction);
    },
    async prepareLocalApply(journal) {
      const database = await databasePromise;
      const transaction = database.transaction('local-apply', 'readwrite');
      const store = transaction.objectStore('local-apply');
      const existing = await requestResult(store.index('account-created').getAll(IDBKeyRange.bound([journal.accountId, ''], [journal.accountId, '\uffff'])) as IDBRequest<SyncLocalApplyJournal[]>);
      if (existing.some((entry) => entry.state !== 'completed')) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* unresolved apply is retained */ }
        throw new Error('A local sync recovery is already waiting for repair.');
      }
      store.add(structuredClone(journal));
      await transactionDone(transaction);
    },
    async updateLocalApply(id, update) {
      const database = await databasePromise;
      const transaction = database.transaction('local-apply', 'readwrite');
      const store = transaction.objectStore('local-apply');
      const current = await requestResult(store.get(id) as IDBRequest<SyncLocalApplyJournal | undefined>);
      if (!current) {
        transaction.abort();
        try { await transactionDone(transaction); } catch { /* missing journal */ }
        throw new Error('The local sync recovery journal is unavailable.');
      }
      const next = { ...current, ...structuredClone(update), id: current.id, accountId: current.accountId };
      store.put(next);
      await transactionDone(transaction);
      return structuredClone(next);
    },
    async getOpenLocalApply(accountId) {
      const database = await databasePromise;
      const transaction = database.transaction('local-apply', 'readonly');
      const values = await requestResult(transaction.objectStore('local-apply').index('account-created').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '\uffff'])) as IDBRequest<SyncLocalApplyJournal[]>);
      await transactionDone(transaction);
      const value = values.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).find((entry) => entry.state !== 'completed');
      return value ? structuredClone(value) : null;
    },
    async quarantine(value, reason) {
      const database = await databasePromise;
      const transaction = database.transaction('quarantine', 'readwrite');
      transaction.objectStore('quarantine').add({ quarantinedAt: new Date().toISOString(), reason, value: structuredClone(value) } satisfies SyncOutboxQuarantine);
      await transactionDone(transaction);
    },
  };
}

export function createMemorySyncOutbox(): SyncOutboxRepository {
  const operations = new Map<string, SyncOutboxOperation>();
  const authorizations = new Map<string, SyncAuthorization>();
  const quarantined: SyncOutboxQuarantine[] = [];
  const localApplies = new Map<string, SyncLocalApplyJournal>();
  const repository: SyncOutboxRepository & { quarantined: SyncOutboxQuarantine[] } = {
    quarantined,
    async authorizeWorld({ accountId, worldId, deviceId, acknowledgedSyncRevision }) {
      const current = authorizations.get(accountId); const now = new Date().toISOString();
      const next = { accountId, deviceId: current?.deviceId ?? deviceId ?? `device-${crypto.randomUUID()}`, authorizedWorldIds: [...new Set([...(current?.authorizedWorldIds ?? []), worldId])], acknowledgedSyncRevision: Math.max(current?.acknowledgedSyncRevision ?? 0, acknowledgedSyncRevision), createdAt: current?.createdAt ?? now, updatedAt: now };
      authorizations.set(accountId, next); return structuredClone(next);
    },
    async getAuthorization(accountId) { const value = authorizations.get(accountId); return value ? structuredClone(value) : null; },
    async listAuthorizations() { return [...authorizations.values()].map((value) => structuredClone(value)); },
    async enqueue(operation) {
      const auth = authorizations.get(operation.accountId);
      if (!auth || (operation.worldId && !auth.authorizedWorldIds.includes(operation.worldId))) throw new Error('Sync World was not explicitly authorized for this account.');
      const existing = operations.get(operation.operationId);
      if (existing && existing.contentHash !== operation.contentHash) throw new Error('operationId is already associated with different sync content.');
      if (!existing) operations.set(operation.operationId, structuredClone(operation));
    },
    async get(operationId) { const value = operations.get(operationId); return value ? structuredClone(value) : null; },
    async list(accountId) { return [...operations.values()].filter((value) => value.accountId === accountId).sort(byCreatedAt).map((value) => structuredClone(value)); },
    async claimNext(accountId, leaseOwner, now, leaseMs = SYNC_OUTBOX_LEASE_MS) {
      const values = [...operations.values()].filter((value) => value.accountId === accountId).sort(byCreatedAt);
      if (values.some((value) => value.state === 'conflict' || value.state === 'blocked')) return null;
      const nowMs = now.getTime();
      const next = values.find((value) => (value.state === 'pending' && (!value.nextAttemptAt || Date.parse(value.nextAttemptAt) <= nowMs)) || (value.state === 'sending' && (!value.leaseExpiresAt || Date.parse(value.leaseExpiresAt) <= nowMs)));
      if (!next) return null;
      const claimed = { ...next, state: 'sending' as const, updatedAt: now.toISOString(), leaseOwner, leaseExpiresAt: new Date(nowMs + leaseMs).toISOString() };
      operations.set(claimed.operationId, claimed); return structuredClone(claimed);
    },
    async updateClaimed(operationId, leaseOwner, update) {
      const current = operations.get(operationId);
      if (!current || current.leaseOwner !== leaseOwner || current.state !== 'sending') throw new Error('Sync Outbox lease is no longer owned by this sender.');
      const next = { ...current, ...structuredClone(update), operationId: current.operationId, accountId: current.accountId, bundle: current.bundle };
      operations.set(operationId, next); return structuredClone(next);
    },
    async acknowledge(operationId, leaseOwner, syncRevision, now) {
      const current = operations.get(operationId);
      if (!current || current.leaseOwner !== leaseOwner || current.state !== 'sending') throw new Error('Sync Outbox lease is no longer owned by this sender.');
      const next = { ...current, state: 'acknowledged' as const, updatedAt: now.toISOString(), acknowledgedSyncRevision: syncRevision, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, lastErrorCode: null, blockedReason: null };
      operations.set(operationId, next);
      const auth = authorizations.get(current.accountId); if (auth) authorizations.set(current.accountId, { ...auth, acknowledgedSyncRevision: Math.max(auth.acknowledgedSyncRevision, syncRevision), updatedAt: now.toISOString() });
      return structuredClone(next);
    },
    async resumeAuthenticationBlocks(accountId) {
      let resumed = 0;
      for (const [operationId, value] of operations) {
        if (value.accountId === accountId && value.state === 'blocked' && (value.blockedReason === 'reauthentication_required' || value.blockedReason === 'account_changed')) {
          operations.set(operationId, { ...value, state: 'pending', blockedReason: null, nextAttemptAt: null, updatedAt: new Date().toISOString(), lastErrorCode: null });
          resumed += 1;
        }
      }
      return resumed;
    },
    async settleConflict({ accountId, operationId, acknowledgedSyncRevision, outcome }) {
      const current = operations.get(operationId);
      if (!current || current.accountId !== accountId || current.state !== 'conflict') throw new Error('The local conflict operation is unavailable.');
      const now = new Date().toISOString();
      operations.set(operationId, { ...current, state: 'acknowledged', acknowledgedSyncRevision, updatedAt: now, blockedReason: null, lastErrorCode: `conflict_${outcome}_selected`, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null });
      for (const [id, operation] of operations) {
        if (id === operationId || operation.accountId !== accountId || operation.state === 'acknowledged') continue;
        operations.set(id, { ...operation, state: 'blocked', blockedReason: 'repair_required', updatedAt: now, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, lastErrorCode: 'superseded_after_conflict_resolution' });
      }
      const auth = authorizations.get(accountId);
      if (auth) authorizations.set(accountId, { ...auth, acknowledgedSyncRevision: Math.max(auth.acknowledgedSyncRevision, acknowledgedSyncRevision), updatedAt: now });
    },
    async prepareLocalApply(journal) {
      if ([...localApplies.values()].some((entry) => entry.accountId === journal.accountId && entry.state !== 'completed')) throw new Error('A local sync recovery is already waiting for repair.');
      localApplies.set(journal.id, structuredClone(journal));
    },
    async updateLocalApply(id, update) {
      const current = localApplies.get(id);
      if (!current) throw new Error('The local sync recovery journal is unavailable.');
      const next = { ...current, ...structuredClone(update), id: current.id, accountId: current.accountId };
      localApplies.set(id, next);
      return structuredClone(next);
    },
    async getOpenLocalApply(accountId) {
      const value = [...localApplies.values()].filter((entry) => entry.accountId === accountId && entry.state !== 'completed').sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      return value ? structuredClone(value) : null;
    },
    async quarantine(value, reason) { quarantined.push({ quarantinedAt: new Date().toISOString(), reason, value: structuredClone(value) }); },
  };
  return repository;
}
