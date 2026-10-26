import { createAccountSyncBundle, sha256ContentHash, type AccountSyncBundleV1 } from './accountSyncContract.ts';
import { subscribeToLocalPersistence } from './localPersistenceSignals.ts';
import type { ProductStateRepository } from './productState.ts';
import type { WorldRepository } from './worldRepository.ts';
import {
  createIndexedDbSyncOutbox,
  type SyncAuthorization,
  type SyncBlockReason,
  type SyncOutboxOperation,
  type SyncOutboxRepository,
} from './syncOutbox.ts';

export type ClientSyncPhase =
  | 'unsynced_changes'
  | 'queued'
  | 'sending'
  | 'synced'
  | 'offline'
  | 'reauthentication_required'
  | 'conflict'
  | 'repair_required';

export type ClientSyncStatus = {
  phase: ClientSyncPhase;
  accountId: string | null;
  acknowledgedSyncRevision: number;
  pendingCount: number;
  sendingCount: number;
  acknowledgedCount: number;
  conflictCount: number;
  blockedCount: number;
  lastErrorCode: string | null;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Clock = () => Date;

type AuthStatusPayload = {
  viewer?: { userId?: string };
  account?: { accountType?: string };
};

type SyncStatusPayload = {
  sync?: { syncRevision?: number; activeWorldId?: string | null; hasOpenConflicts?: boolean };
};

type CommitPayload = {
  result?: {
    status?: string;
    syncRevision?: number;
    conflict?: unknown;
    code?: string;
  };
  error?: { code?: string; message?: string };
};

type AuthenticationCheck =
  | { status: 'authenticated'; accountId: string }
  | { status: 'unauthenticated' }
  | { status: 'unavailable' };

export type AccountSyncRuntimeOptions = {
  productRepository: ProductStateRepository;
  worldRepository: WorldRepository;
  outbox?: SyncOutboxRepository;
  fetch?: FetchLike;
  now?: Clock;
  randomUUID?: () => string;
  online?: () => boolean;
  captureDebounceMs?: number;
  maxBackoffMs?: number;
  maxRetryCount?: number;
  leaseMs?: number;
};

export type ExplicitSyncAuthorization = {
  accountId: string;
  worldId: string;
  deviceId: string;
  serverSyncRevision: number;
};

const parseBody = async <T>(response: Response): Promise<T> => response.json().catch(() => ({})) as Promise<T>;

function retryAfterMs(response: Response, now: Date): number | null {
  const value = response.headers.get('Retry-After');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : null;
}

function backoffMs(retryCount: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, 1_000 * (2 ** Math.min(10, Math.max(0, retryCount))));
}

function freshOperation(bundle: AccountSyncBundleV1, now: Date): SyncOutboxOperation {
  return {
    operationId: bundle.operationId,
    accountId: bundle.accountId,
    worldId: bundle.activeWorldId,
    deviceId: bundle.deviceId,
    baseSyncRevision: bundle.syncRevision,
    bundle,
    contentHash: bundle.contentHash,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    state: 'pending',
    retryCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    acknowledgedSyncRevision: null,
    lastHttpStatus: null,
    lastErrorCode: null,
    blockedReason: null,
    conflict: null,
  };
}

export class AccountSyncRuntime {
  private readonly productRepository: ProductStateRepository;
  private readonly worldRepository: WorldRepository;
  private readonly outbox: SyncOutboxRepository;
  private readonly fetcher: FetchLike;
  private readonly now: Clock;
  private readonly randomUUID: () => string;
  private readonly online: () => boolean;
  private readonly captureDebounceMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryCount: number;
  private readonly leaseMs: number;
  private readonly runtimeId: string;
  private authorization: SyncAuthorization | null = null;
  private unsubscribe: (() => void) | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private captureGeneration = 0;
  private processing: Promise<void> | null = null;
  private uncapturedChanges = false;
  private listeners = new Set<(status: ClientSyncStatus) => void>();
  private readonly onlineListener = () => { void this.process(); };

  constructor(options: AccountSyncRuntimeOptions) {
    this.productRepository = options.productRepository;
    this.worldRepository = options.worldRepository;
    this.outbox = options.outbox ?? createIndexedDbSyncOutbox();
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.captureDebounceMs = options.captureDebounceMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    this.maxRetryCount = options.maxRetryCount ?? 10;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.runtimeId = `runtime-${this.randomUUID()}`;
  }

  async authorizeCurrentWorld(worldId: string): Promise<ExplicitSyncAuthorization> {
    const authResponse = await this.fetcher('/api/reviews/auth/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const auth = await parseBody<AuthStatusPayload>(authResponse);
    const accountId = auth.viewer?.userId;
    if (!authResponse.ok || !accountId || auth.account?.accountType !== 'registered') {
      throw new Error('A verified registered account session is required before sync can be enabled.');
    }
    const statusResponse = await this.fetcher('/api/reviews/account/sync/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const status = await parseBody<SyncStatusPayload>(statusResponse);
    if (!statusResponse.ok || !Number.isSafeInteger(status.sync?.syncRevision)) {
      throw new Error('Server sync status could not be verified.');
    }
    const loaded = await this.worldRepository.loadActive();
    if (loaded.status !== 'ready' || loaded.snapshot.worldId !== worldId) {
      throw new Error('Only the currently persisted World can be explicitly authorized.');
    }
    this.authorization = await this.outbox.authorizeWorld({
      accountId,
      worldId,
      acknowledgedSyncRevision: Number(status.sync!.syncRevision),
    });
    this.start();
    return {
      accountId,
      worldId,
      deviceId: this.authorization.deviceId,
      serverSyncRevision: this.authorization.acknowledgedSyncRevision,
    };
  }

  async resumeAuthorizedAccount(accountId: string): Promise<boolean> {
    const authorization = await this.outbox.getAuthorization(accountId);
    if (!authorization) return false;
    const authenticated = await this.currentAuthentication();
    if (authenticated.status !== 'authenticated' || authenticated.accountId !== accountId) return false;
    await this.outbox.resumeAuthenticationBlocks(accountId);
    this.authorization = authorization;
    this.start();
    await this.process();
    return true;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToLocalPersistence(() => {
      if (!this.authorization) return;
      this.uncapturedChanges = true;
      this.captureGeneration += 1;
      if (this.captureTimer) clearTimeout(this.captureTimer);
      const generation = this.captureGeneration;
      this.captureTimer = setTimeout(() => { void this.captureAndEnqueue(generation); }, this.captureDebounceMs);
      void this.emitStatus();
    });
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineListener);
  }

  stop(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.captureTimer = null;
    this.retryTimer = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineListener);
  }

  subscribe(listener: (status: ClientSyncStatus) => void): () => void {
    this.listeners.add(listener);
    void this.getStatus().then(listener);
    return () => this.listeners.delete(listener);
  }

  async captureNow(): Promise<SyncOutboxOperation> {
    return this.captureAndEnqueue(this.captureGeneration);
  }

  async captureAndEnqueue(generation = this.captureGeneration): Promise<SyncOutboxOperation> {
    const authorization = this.authorization
      ? await this.outbox.getAuthorization(this.authorization.accountId) ?? this.authorization
      : null;
    if (!authorization) throw new Error('Sync requires explicit World authorization.');
    this.authorization = authorization;
    const productBefore = this.productRepository.load();
    const worldBefore = await this.worldRepository.loadActive();
    await Promise.resolve();
    const productAfter = this.productRepository.load();
    const worldAfter = await this.worldRepository.loadActive();
    if (generation !== this.captureGeneration) throw new Error('Local state changed during sync capture.');
    if (worldBefore.status !== 'ready' || worldAfter.status !== 'ready') {
      const preserved = { productBefore, worldBefore, productAfter, worldAfter };
      await this.outbox.quarantine(preserved, 'World was unavailable or corrupt during sync capture.');
      throw new Error('World is unavailable or corrupt; the source was preserved without upload.');
    }
    if (!authorization.authorizedWorldIds.includes(worldAfter.snapshot.worldId)) {
      throw new Error('The current World has not been explicitly authorized for this account.');
    }
    const operations = await this.outbox.list(authorization.accountId);
    const activeQueue = operations.filter((operation) => operation.state === 'pending' || operation.state === 'sending');
    const baseSyncRevision = authorization.acknowledgedSyncRevision + activeQueue.length;
    const now = this.now();
    const result = await createAccountSyncBundle({
      accountId: authorization.accountId,
      syncRevision: baseSyncRevision,
      operationId: this.randomUUID(),
      deviceId: authorization.deviceId,
      capturedAt: now.toISOString(),
      productBefore,
      worldBefore: worldBefore.snapshot,
      productAfter,
      worldAfter: worldAfter.snapshot,
    });
    if (result.status !== 'ready') {
      await this.outbox.quarantine(result.preservedSource, `${result.code}: ${result.reason}`);
      throw new Error(result.reason);
    }
    const operation = freshOperation(result.value, now);
    await this.outbox.enqueue(operation);
    this.uncapturedChanges = false;
    await this.emitStatus();
    void this.process();
    return operation;
  }

  async process(): Promise<void> {
    if (this.processing) {
      await this.processing;
      return this.process();
    }
    if (!this.authorization) return;
    const run = (async () => {
      try {
        await this.withProcessLock(async () => {
        while (this.authorization) {
          if (!this.online()) { await this.emitStatus('offline'); return; }
          const authentication = await this.currentAuthentication();
          if (authentication.status === 'unavailable') { await this.deferFirstForAuthenticationOutage(); return; }
          if (authentication.status === 'unauthenticated') { await this.blockFirstForReauthentication(); return; }
          if (authentication.accountId !== this.authorization.accountId) { await this.blockFirstForAccountChange(); return; }
          const operation = await this.outbox.claimNext(authentication.accountId, this.runtimeId, this.now(), this.leaseMs);
          if (!operation) { await this.scheduleNextRetry(); return; }
          await this.emitStatus();
          const keepGoing = await this.send(operation);
          if (!keepGoing) return;
        }
        });
      } finally {
        await this.emitStatus();
      }
    })();
    this.processing = run;
    try { await run; } finally { if (this.processing === run) this.processing = null; }
  }

  async getStatus(forcedPhase?: ClientSyncPhase): Promise<ClientSyncStatus> {
    const authorization = this.authorization
      ? await this.outbox.getAuthorization(this.authorization.accountId) ?? this.authorization
      : null;
    if (!authorization) return { phase: 'synced', accountId: null, acknowledgedSyncRevision: 0, pendingCount: 0, sendingCount: 0, acknowledgedCount: 0, conflictCount: 0, blockedCount: 0, lastErrorCode: null };
    this.authorization = authorization;
    const operations = await this.outbox.list(authorization.accountId);
    const counts = {
      pendingCount: operations.filter((value) => value.state === 'pending').length,
      sendingCount: operations.filter((value) => value.state === 'sending').length,
      acknowledgedCount: operations.filter((value) => value.state === 'acknowledged').length,
      conflictCount: operations.filter((value) => value.state === 'conflict').length,
      blockedCount: operations.filter((value) => value.state === 'blocked').length,
    };
    const latest = operations.at(-1);
    let phase: ClientSyncPhase = forcedPhase ?? 'synced';
    if (!forcedPhase) {
      if (!this.online() && (counts.pendingCount || counts.sendingCount)) phase = 'offline';
      else if (counts.conflictCount) phase = 'conflict';
      else if (operations.some((value) => value.blockedReason === 'reauthentication_required' || value.blockedReason === 'account_changed')) phase = 'reauthentication_required';
      else if (counts.blockedCount) phase = 'repair_required';
      else if (counts.sendingCount) phase = 'sending';
      else if (counts.pendingCount) phase = 'queued';
      else if (this.uncapturedChanges) phase = 'unsynced_changes';
    }
    return { phase, accountId: authorization.accountId, acknowledgedSyncRevision: authorization.acknowledgedSyncRevision, ...counts, lastErrorCode: latest?.lastErrorCode ?? null };
  }

  private async emitStatus(forcedPhase?: ClientSyncPhase): Promise<void> {
    if (this.listeners.size === 0) return;
    const status = await this.getStatus(forcedPhase);
    for (const listener of this.listeners) listener(status);
  }

  private async currentAuthentication(): Promise<AuthenticationCheck> {
    try {
      const response = await this.fetcher('/api/reviews/auth/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.status >= 500 || response.status === 429) return { status: 'unavailable' };
      if (!response.ok) return { status: 'unauthenticated' };
      const body = await parseBody<AuthStatusPayload>(response);
      return body.account?.accountType === 'registered' && typeof body.viewer?.userId === 'string'
        ? { status: 'authenticated', accountId: body.viewer.userId }
        : { status: 'unauthenticated' };
    } catch { return { status: 'unavailable' }; }
  }

  private async send(operation: SyncOutboxOperation): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher('/api/reviews/account/sync/commits', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(operation.bundle),
      });
    } catch {
      await this.retry(operation, null, 'network_unavailable');
      await this.emitStatus('offline');
      return false;
    }
    const payload = await parseBody<CommitPayload>(response);
    if (response.ok && payload.result?.status === 'committed' && Number.isSafeInteger(payload.result.syncRevision)) {
      const acknowledged = await this.outbox.acknowledge(operation.operationId, this.runtimeId, Number(payload.result.syncRevision), this.now());
      if (this.authorization) this.authorization = { ...this.authorization, acknowledgedSyncRevision: Math.max(this.authorization.acknowledgedSyncRevision, acknowledged.acknowledgedSyncRevision ?? 0) };
      return true;
    }
    const code = payload.error?.code ?? payload.result?.code ?? `http_${response.status}`;
    if (response.status === 409) {
      await this.outbox.updateClaimed(operation.operationId, this.runtimeId, { state: 'conflict', updatedAt: this.now().toISOString(), leaseOwner: null, leaseExpiresAt: null, lastHttpStatus: 409, lastErrorCode: code, conflict: payload.result?.conflict ?? payload });
      await this.emitStatus('conflict'); return false;
    }
    if (response.status === 401 || response.status === 403) {
      await this.block(operation, 'reauthentication_required', response.status, code);
      await this.emitStatus('reauthentication_required'); return false;
    }
    if (response.status === 413 || response.status === 422 || response.status === 400) {
      await this.block(operation, response.status === 413 ? 'payload_too_large' : 'invalid_payload', response.status, code);
      await this.emitStatus('repair_required'); return false;
    }
    if (response.status === 429) {
      await this.retry(operation, response.status, code, retryAfterMs(response, this.now())); return false;
    }
    if (response.status === 503 || response.status >= 500) {
      await this.retry(operation, response.status, code); return false;
    }
    await this.block(operation, 'repair_required', response.status, code);
    await this.emitStatus('repair_required'); return false;
  }

  private async retry(operation: SyncOutboxOperation, status: number | null, code: string, explicitDelay?: number | null): Promise<void> {
    const retryCount = operation.retryCount + 1;
    if (retryCount >= this.maxRetryCount) {
      await this.block(operation, 'repair_required', status ?? 503, code);
      await this.emitStatus('repair_required');
      return;
    }
    const delay = explicitDelay ?? backoffMs(retryCount, this.maxBackoffMs);
    const now = this.now();
    await this.outbox.updateClaimed(operation.operationId, this.runtimeId, {
      state: 'pending', retryCount, nextAttemptAt: new Date(now.getTime() + Math.min(this.maxBackoffMs, Math.max(0, delay))).toISOString(),
      updatedAt: now.toISOString(), leaseOwner: null, leaseExpiresAt: null, lastHttpStatus: status, lastErrorCode: code,
    });
    this.scheduleRetryTimer(delay);
  }

  private async scheduleNextRetry(): Promise<void> {
    if (!this.authorization) return;
    const operations = await this.outbox.list(this.authorization.accountId);
    const timestamps = operations.filter((value) => value.state === 'pending' && value.nextAttemptAt).map((value) => Date.parse(value.nextAttemptAt!)).filter(Number.isFinite);
    if (timestamps.length > 0) this.scheduleRetryTimer(Math.max(0, Math.min(...timestamps) - this.now().getTime()));
  }

  private scheduleRetryTimer(delay: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.process(); }, Math.min(this.maxBackoffMs, Math.max(0, delay)));
  }

  private async block(operation: SyncOutboxOperation, reason: SyncBlockReason, status: number, code: string): Promise<void> {
    await this.outbox.updateClaimed(operation.operationId, this.runtimeId, { state: 'blocked', blockedReason: reason, updatedAt: this.now().toISOString(), leaseOwner: null, leaseExpiresAt: null, lastHttpStatus: status, lastErrorCode: code });
  }

  private async blockFirstForReauthentication(): Promise<void> {
    const operation = await this.outbox.claimNext(this.authorization!.accountId, this.runtimeId, this.now(), this.leaseMs);
    if (operation) await this.block(operation, 'reauthentication_required', 401, 'authentication_required');
    await this.emitStatus('reauthentication_required');
  }

  private async blockFirstForAccountChange(): Promise<void> {
    const operation = await this.outbox.claimNext(this.authorization!.accountId, this.runtimeId, this.now(), this.leaseMs);
    if (operation) await this.block(operation, 'account_changed', 403, 'account_changed');
    await this.emitStatus('reauthentication_required');
  }

  private async deferFirstForAuthenticationOutage(): Promise<void> {
    const operation = await this.outbox.claimNext(this.authorization!.accountId, this.runtimeId, this.now(), this.leaseMs);
    if (operation) await this.retry(operation, 503, 'authentication_unavailable');
    await this.emitStatus('offline');
  }

  private async withProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!lockManager || !this.authorization) return operation();
    return lockManager.request(`kurohige-sync:${this.authorization.accountId}`, operation);
  }
}

export async function localSnapshotFingerprint(product: unknown, world: unknown): Promise<string> {
  return sha256ContentHash({ product, world });
}
