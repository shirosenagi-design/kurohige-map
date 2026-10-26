import { createAccountSyncBundle, sha256ContentHash, type AccountSyncBundleV1 } from './accountSyncContract.ts';
import { AccountSyncRuntime, type AccountSyncRuntimeOptions, type ClientSyncStatus } from './accountSyncRuntime.ts';
import type { PersistedProductState, ProductStateRepository } from './productState.ts';
import {
  createIndexedDbSyncOutbox,
  type SyncLocalApplyJournal,
  type SyncOutboxRepository,
} from './syncOutbox.ts';
import type { PersistedWorldSnapshotV1 } from './worldState.ts';
import type { WorldLoadResult, WorldRepository } from './worldRepository.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type AuthStatus = {
  viewer?: { userId?: string };
  account?: { accountType?: string };
};

export type ServerSyncState = {
  accountId: string;
  syncRevision: number;
  activeWorldId: string | null;
  profile: { snapshot: PersistedProductState; contentHash: string } | null;
  world: { worldId: string; snapshot: PersistedWorldSnapshotV1; contentHash: string } | null;
  updatedAt: string | null;
};

export type SyncConflictView = {
  id: string;
  operationId: string;
  accountId: string;
  baseSyncRevision: number;
  serverSyncRevision: number;
  candidateBundle: AccountSyncBundleV1;
  status: string;
  detectedAt: string;
};

export type SyncComparisonKind =
  | 'anonymous'
  | 'unavailable'
  | 'repair_required'
  | 'empty'
  | 'local_only'
  | 'server_only'
  | 'aligned'
  | 'choice_required';

export type SyncComparison = {
  kind: SyncComparisonKind;
  accountId: string | null;
  localWorld: WorldLoadResult;
  server: ServerSyncState | null;
  conflicts: SyncConflictView[];
  openJournal: SyncLocalApplyJournal | null;
  localProfileHash: string | null;
  localWorldHash: string | null;
  serverProfileHash: string | null;
  serverWorldHash: string | null;
  hasStoredAuthorization: boolean;
};

export type AccountSyncRecoveryOptions = {
  productRepository: ProductStateRepository;
  worldRepository: WorldRepository;
  outbox?: SyncOutboxRepository;
  fetch?: FetchLike;
  now?: () => Date;
  randomUUID?: () => string;
  authRequestTimeoutMs?: number;
  runtimeOptions?: Partial<Omit<AccountSyncRuntimeOptions, 'productRepository' | 'worldRepository' | 'outbox' | 'fetch' | 'now' | 'randomUUID'>>;
};

const json = async <T>(response: Response): Promise<T> => response.json().catch(() => ({})) as Promise<T>;
const worldRef = (result: WorldLoadResult): { worldId: string; worldRevision: number } | null => (
  result.status === 'ready' ? { worldId: result.snapshot.worldId, worldRevision: result.snapshot.worldRevision } : null
);
const snapshotRef = (snapshot: PersistedWorldSnapshotV1 | null) => snapshot
  ? { worldId: snapshot.worldId, worldRevision: snapshot.worldRevision }
  : null;

function assertServerState(value: unknown, accountId: string): ServerSyncState {
  if (!value || typeof value !== 'object') throw new Error('Server sync state is unavailable.');
  const state = value as ServerSyncState;
  if (state.accountId !== accountId || !Number.isSafeInteger(state.syncRevision) || state.syncRevision < 0) {
    throw new Error('Server sync ownership could not be verified.');
  }
  return state;
}

export class AccountSyncRecoveryCoordinator {
  private readonly productRepository: ProductStateRepository;
  private readonly worldRepository: WorldRepository;
  private readonly outbox: SyncOutboxRepository;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly authRequestTimeoutMs: number;
  private readonly runtime: AccountSyncRuntime;

  constructor(options: AccountSyncRecoveryOptions) {
    this.productRepository = options.productRepository;
    this.worldRepository = options.worldRepository;
    this.outbox = options.outbox ?? createIndexedDbSyncOutbox();
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.authRequestTimeoutMs = options.authRequestTimeoutMs ?? 8_000;
    this.runtime = new AccountSyncRuntime({
      productRepository: this.productRepository,
      worldRepository: this.worldRepository,
      outbox: this.outbox,
      fetch: this.fetcher,
      now: this.now,
      randomUUID: this.randomUUID,
      ...options.runtimeOptions,
    });
  }

  stop(): void { this.runtime.stop(); }
  subscribe(listener: (status: ClientSyncStatus) => void): () => void { return this.runtime.subscribe(listener); }
  getRuntimeStatus(): Promise<ClientSyncStatus> { return this.runtime.getStatus(); }
  resumeCurrentAccount(accountId: string): Promise<boolean> { return this.runtime.resumeAuthorizedAccount(accountId); }

  async inspect(): Promise<SyncComparison> {
    const localWorld = await this.worldRepository.loadActive();
    const localProduct = this.productRepository.load();
    const authResponse = await this.fetchAuthStatus();
    if (!authResponse || authResponse.status >= 500 || authResponse.status === 429) {
      return this.comparison('unavailable', null, localWorld, null, [], null, localProduct);
    }
    const auth = await json<AuthStatus>(authResponse);
    const accountId = auth.viewer?.userId ?? null;
    if (!authResponse.ok || !accountId || auth.account?.accountType !== 'registered') {
      return this.comparison('anonymous', null, localWorld, null, [], null, localProduct);
    }
    const openJournal = await this.outbox.getOpenLocalApply(accountId);
    if (openJournal) return this.comparison('repair_required', accountId, localWorld, null, [], openJournal, localProduct);
    try {
      const [bundleResponse, conflictsResponse] = await Promise.all([
        this.fetcher('/api/reviews/account/sync/bundle', { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
        this.fetcher('/api/reviews/account/sync/conflicts?status=open', { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
      ]);
      if (!bundleResponse.ok || !conflictsResponse.ok) throw new Error('Sync API unavailable.');
      const bundlePayload = await json<{ bundle?: unknown }>(bundleResponse);
      const conflictsPayload = await json<{ conflicts?: SyncConflictView[] }>(conflictsResponse);
      const server = assertServerState(bundlePayload.bundle, accountId);
      await this.validateServerSnapshots(server, accountId);
      const conflicts = Array.isArray(conflictsPayload.conflicts) ? conflictsPayload.conflicts.filter((entry) => entry.accountId === accountId) : [];
      const [localProfileHash, localWorldHash] = await Promise.all([
        sha256ContentHash(localProduct),
        localWorld.status === 'ready' ? sha256ContentHash(localWorld.snapshot) : Promise.resolve(null),
      ]);
      const serverProfileHash = server.profile?.contentHash ?? null;
      const serverWorldHash = server.world?.contentHash ?? null;
      let kind: SyncComparisonKind;
      if (localWorld.status === 'corrupt') kind = 'repair_required';
      else if (!server.profile && !server.world && localWorld.status === 'missing') kind = 'empty';
      else if (!server.profile && !server.world) kind = 'local_only';
      else if (localWorld.status === 'missing') kind = 'server_only';
      else if (localProfileHash === serverProfileHash && localWorldHash === serverWorldHash) kind = 'aligned';
      else kind = 'choice_required';
      return { kind, accountId, localWorld, server, conflicts, openJournal, localProfileHash, localWorldHash, serverProfileHash, serverWorldHash, hasStoredAuthorization: Boolean(await this.outbox.getAuthorization(accountId)) };
    } catch {
      return this.comparison('unavailable', accountId, localWorld, null, [], null, localProduct);
    }
  }

  async chooseLocalWorld(): Promise<ClientSyncStatus> {
    const comparison = await this.inspect();
    if (!comparison.accountId || comparison.localWorld.status !== 'ready' || comparison.kind === 'repair_required') {
      throw new Error('A valid local World and verified account are required.');
    }
    await this.runtime.authorizeCurrentWorld(comparison.localWorld.snapshot.worldId);
    await this.runtime.captureNow();
    await this.runtime.process();
    return this.runtime.getStatus();
  }

  async chooseServerBundle(): Promise<SyncComparison> {
    const comparison = await this.inspect();
    if (!comparison.accountId || !comparison.server || (!comparison.server.profile && !comparison.server.world)) {
      throw new Error('A verified Server Bundle is required.');
    }
    await this.applyServerState(comparison.accountId, comparison.server);
    return this.inspect();
  }

  async resolveConflict(conflictId: string, choice: 'server' | 'candidate'): Promise<SyncComparison> {
    const comparison = await this.inspect();
    if (!comparison.accountId || comparison.kind === 'repair_required') throw new Error('A verified account without pending local repair is required.');
    const detailResponse = await this.fetcher(`/api/reviews/account/sync/conflicts/${encodeURIComponent(conflictId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const detailPayload = await json<{ conflict?: SyncConflictView }>(detailResponse);
    const conflict = detailPayload.conflict;
    if (!detailResponse.ok || !conflict || conflict.accountId !== comparison.accountId || conflict.status !== 'open') throw new Error('The sync conflict is unavailable or belongs to another account.');
    let body: unknown = { action: 'discard', note: 'Server Bundle selected explicitly by the account owner.' };
    if (choice === 'candidate') {
      const candidate = conflict.candidateBundle;
      const prepared = await createAccountSyncBundle({
        accountId: comparison.accountId,
        syncRevision: conflict.serverSyncRevision,
        operationId: this.randomUUID(),
        deviceId: candidate.deviceId,
        capturedAt: this.now().toISOString(),
        productBefore: candidate.profile.snapshot,
        productAfter: candidate.profile.snapshot,
        worldBefore: candidate.world?.snapshot ?? null,
        worldAfter: candidate.world?.snapshot ?? null,
      });
      if (prepared.status !== 'ready') throw new Error(prepared.reason);
      body = { action: 'commit', bundle: prepared.value, note: 'Conflict candidate selected explicitly by the account owner.' };
    }
    const response = await this.fetcher(`/api/reviews/account/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await json<{ result?: { commit?: { syncRevision?: number } }; error?: { message?: string } }>(response);
    if (!response.ok) throw new Error(payload.error?.message ?? 'Conflict resolution failed safely.');
    const latest = await this.fetchServerState(comparison.accountId);
    await this.outbox.settleConflict({
      accountId: comparison.accountId,
      operationId: conflict.operationId,
      acknowledgedSyncRevision: latest.syncRevision,
      outcome: choice,
    });
    await this.applyServerState(comparison.accountId, latest);
    return this.inspect();
  }

  async repairLocalApply(action: 'resume' | 'rollback'): Promise<void> {
    const auth = await this.authenticatedAccount();
    const journal = await this.outbox.getOpenLocalApply(auth.accountId);
    if (!journal) throw new Error('No local sync repair is pending.');
    await this.withLocalApplyLock(auth.accountId, async () => {
      const current = await this.worldRepository.loadActive();
      const currentRef = worldRef(current);
      const previous = journal.previousWorld as PersistedWorldSnapshotV1 | null;
      const target = journal.targetWorld as PersistedWorldSnapshotV1 | null;
      const previousRef = snapshotRef(previous);
      const targetRef = snapshotRef(target);
      if (action === 'rollback') {
        if (JSON.stringify(currentRef) === JSON.stringify(targetRef)) {
          await this.replaceJournalWorld(previous, targetRef);
        } else if (JSON.stringify(currentRef) !== JSON.stringify(previousRef)) {
          throw new Error('Local World changed after the recovery journal was created.');
        }
        this.productRepository.save(journal.previousProduct as PersistedProductState);
        await this.outbox.updateLocalApply(journal.id, { state: 'completed', updatedAt: this.now().toISOString(), errorCode: 'rolled_back_by_user' });
        return;
      }
      if (JSON.stringify(currentRef) === JSON.stringify(previousRef)) {
        await this.replaceJournalWorld(target, previousRef);
      } else if (JSON.stringify(currentRef) !== JSON.stringify(targetRef)) {
        throw new Error('Local World changed after the recovery journal was created.');
      }
      this.productRepository.save(journal.targetProduct as PersistedProductState);
      await this.outbox.updateLocalApply(journal.id, { state: 'completed', updatedAt: this.now().toISOString(), errorCode: null });
    });
  }

  private async applyServerState(accountId: string, server: ServerSyncState): Promise<void> {
    await this.validateServerSnapshots(server, accountId);
    if (!server.profile) throw new Error('Server Profile Snapshot is unavailable.');
    const targetProduct = server.profile.snapshot;
    await this.withLocalApplyLock(accountId, async () => {
      const previousWorldResult = await this.worldRepository.loadActive();
      if (previousWorldResult.status === 'corrupt') throw new Error('The local World is corrupt and was preserved without overwrite.');
      const previousProduct = this.productRepository.load();
      const targetWorld = server.world?.snapshot ?? null;
      const journal: SyncLocalApplyJournal = {
        id: this.randomUUID(), accountId, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(), state: 'prepared',
        previousProduct, previousWorld: previousWorldResult.status === 'ready' ? previousWorldResult.snapshot : null,
        targetProduct, targetWorld, serverSyncRevision: server.syncRevision, errorCode: null,
      };
      await this.outbox.prepareLocalApply(journal);
      try {
        if (!this.worldRepository.replaceActive) throw new Error('The World repository cannot safely replace an active Snapshot.');
        await this.worldRepository.replaceActive(targetWorld, worldRef(previousWorldResult));
        await this.outbox.updateLocalApply(journal.id, { state: 'world_applied', updatedAt: this.now().toISOString() });
        this.productRepository.save(targetProduct);
        await this.outbox.updateLocalApply(journal.id, { state: 'completed', updatedAt: this.now().toISOString(), errorCode: null });
        if (targetWorld) {
          const existing = await this.outbox.getAuthorization(accountId);
          await this.outbox.authorizeWorld({ accountId, worldId: targetWorld.worldId, deviceId: existing?.deviceId ?? `device-${this.randomUUID()}`, acknowledgedSyncRevision: server.syncRevision });
          await this.runtime.resumeAuthorizedAccount(accountId);
        }
      } catch (error) {
        await this.outbox.updateLocalApply(journal.id, { state: 'failed', updatedAt: this.now().toISOString(), errorCode: 'local_apply_failed' }).catch(() => {});
        throw error;
      }
    });
  }

  private async replaceJournalWorld(next: PersistedWorldSnapshotV1 | null, expected: { worldId: string; worldRevision: number } | null): Promise<void> {
    if (!this.worldRepository.replaceActive) throw new Error('The World repository cannot safely repair an active Snapshot.');
    await this.worldRepository.replaceActive(next, expected);
  }

  private async fetchServerState(accountId: string): Promise<ServerSyncState> {
    const response = await this.fetcher('/api/reviews/account/sync/bundle', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const payload = await json<{ bundle?: unknown }>(response);
    if (!response.ok) throw new Error('Server Bundle could not be read after conflict resolution.');
    const server = assertServerState(payload.bundle, accountId);
    await this.validateServerSnapshots(server, accountId);
    return server;
  }

  private async validateServerSnapshots(server: ServerSyncState, accountId: string): Promise<void> {
    if (!server.profile && !server.world && server.syncRevision === 0) return;
    if (!server.profile) throw new Error('Server Profile Snapshot is missing.');
    const validation = await createAccountSyncBundle({
      accountId,
      syncRevision: server.syncRevision,
      operationId: this.randomUUID(),
      deviceId: 'device-stage5-validation',
      capturedAt: this.now().toISOString(),
      productBefore: server.profile.snapshot,
      productAfter: server.profile.snapshot,
      worldBefore: server.world?.snapshot ?? null,
      worldAfter: server.world?.snapshot ?? null,
    });
    if (validation.status !== 'ready') throw new Error(validation.reason);
    const [profileHash, worldHash] = await Promise.all([
      sha256ContentHash(server.profile.snapshot),
      server.world ? sha256ContentHash(server.world.snapshot) : Promise.resolve(null),
    ]);
    if (profileHash !== server.profile.contentHash || worldHash !== (server.world?.contentHash ?? null)) throw new Error('Server Snapshot hash verification failed.');
  }

  private async authenticatedAccount(): Promise<{ accountId: string }> {
    const response = await this.fetcher('/api/reviews/auth/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = await json<AuthStatus>(response);
    if (!response.ok || body.account?.accountType !== 'registered' || !body.viewer?.userId) throw new Error('Reauthentication is required.');
    return { accountId: body.viewer.userId };
  }

  private async fetchAuthStatus(): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetcher('/api/reviews/auth/status', {
          credentials: 'same-origin', headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.authRequestTimeoutMs),
        });
        if (response.status === 503 && attempt === 0) continue;
        return response;
      } catch {
        if (attempt === 1) return null;
      }
    }
    return null;
  }

  private async withLocalApplyLock<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return locks ? locks.request(`kurohige-sync-local-apply:${accountId}`, operation) : operation();
  }

  private async comparison(kind: SyncComparisonKind, accountId: string | null, localWorld: WorldLoadResult, server: ServerSyncState | null,
    conflicts: SyncConflictView[], openJournal: SyncLocalApplyJournal | null, localProduct: PersistedProductState): Promise<SyncComparison> {
    const authorizations = await this.outbox.listAuthorizations();
    return {
      kind, accountId, localWorld, server, conflicts, openJournal,
      localProfileHash: await sha256ContentHash(localProduct),
      localWorldHash: localWorld.status === 'ready' ? await sha256ContentHash(localWorld.snapshot) : null,
      serverProfileHash: server?.profile?.contentHash ?? null,
      serverWorldHash: server?.world?.contentHash ?? null,
      hasStoredAuthorization: accountId
        ? Boolean(authorizations.find((entry) => entry.accountId === accountId))
        : authorizations.length > 0,
    };
  }
}
