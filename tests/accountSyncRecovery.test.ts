import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountSyncBundle, sha256ContentHash } from '../src/accountSyncContract.ts';
import { AccountSyncRecoveryCoordinator, type ServerSyncState, type SyncConflictView } from '../src/accountSyncRecovery.ts';
import { createMemorySyncOutbox, type SyncOutboxOperation } from '../src/syncOutbox.ts';
import type { PersistedProductState, ProductStateRepository } from '../src/productState.ts';
import { createMemoryWorldRepository } from '../src/worldRepository.ts';
import type { PersistedWorldSnapshotV1 } from '../src/worldState.ts';

const accountId = 'stage5_registered_account';
const localWorldId = 'world-stage5-local';
const serverWorldId = 'world-stage5-server';

const product = (nickname: string): PersistedProductState => ({
  version: 2,
  personState: { interests: ['海'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname, region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-24T00:00:00.000Z' },
  onboardingComplete: true, personContextRevision: 1, observedPersonSignals: [],
});

const world = (worldId: string, revision: number, title: string): PersistedWorldSnapshotV1 => ({
  schemaVersion: 1, worldId, worldRevision: revision, savedAt: '2026-10-24T00:00:00.000Z', layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: `node-${worldId}`, title, shortDescription: '隔離された同期検証用の島。', category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent',
    curiosityFit: .7, accessibility: .7, novelty: .7, friction: .2, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
    visualRecipe: { visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced', accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  }],
  nodeStates: { [`node-${worldId}`]: { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] } },
  explorationBands: { [`node-${worldId}`]: 0 }, generatedBatches: [{ band: 0, nodeIds: [`node-${worldId}`] }], stepCatalog: {}, detailCache: {},
  ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});

function productRepository(initial: PersistedProductState, failNickname = ''): ProductStateRepository {
  let value = structuredClone(initial);
  return {
    load: () => structuredClone(value),
    save: (next) => { if (next.userProfile.nickname === failNickname) throw new Error('simulated localStorage failure'); value = structuredClone(next); },
    clear: () => {},
  };
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function serverState(profile: PersistedProductState | null, snapshot: PersistedWorldSnapshotV1 | null, revision = 1): Promise<ServerSyncState> {
  return {
    accountId, syncRevision: profile ? revision : 0, activeWorldId: snapshot?.worldId ?? null,
    profile: profile ? { snapshot: profile, contentHash: await sha256ContentHash(profile) } : null,
    world: snapshot ? { worldId: snapshot.worldId, snapshot, contentHash: await sha256ContentHash(snapshot) } : null,
    updatedAt: profile ? '2026-10-24T00:00:00.000Z' : null,
  };
}

function network(initial: ServerSyncState, options: { conflicts?: SyncConflictView[]; detail?: SyncConflictView; afterResolve?: ServerSyncState } = {}) {
  let state = initial;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith('/auth/status')) return response({ viewer: { userId: accountId }, account: { accountType: 'registered' } });
    if (url.endsWith('/account/sync/status')) return response({ sync: { syncRevision: state.syncRevision, activeWorldId: state.activeWorldId, hasOpenConflicts: Boolean(options.conflicts?.length) } });
    if (url.endsWith('/account/sync/bundle')) return response({ bundle: state });
    if (url.includes('/account/sync/conflicts?')) return response({ conflicts: options.conflicts ?? [] });
    if (options.detail && url.endsWith(`/account/sync/conflicts/${options.detail.id}`)) return response({ conflict: options.detail });
    if (options.detail && url.endsWith(`/account/sync/conflicts/${options.detail.id}/resolve`)) { state = options.afterResolve ?? state; return response({ result: { status: 'discarded' } }); }
    if (url.endsWith('/account/sync/commits')) { state = { ...state, syncRevision: state.syncRevision + 1 }; return response({ result: { status: 'committed', syncRevision: state.syncRevision } }, 201); }
    return response({}, 404);
  };
  return { fetch, calls, state: () => state };
}

let uuidCounter = 1;
const uuid = () => `77777777-7777-4777-8777-${String(uuidCounter++).padStart(12, '0')}`;

test('inspection compares local and server state without claiming or uploading the local World', async () => {
  const outbox = createMemorySyncOutbox(); const localProduct = product('Local'); const localWorld = world(localWorldId, 7, 'Local島');
  const server = await serverState(null, null, 0); const remote = network(server);
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepository(localProduct), worldRepository: createMemoryWorldRepository(localWorld), outbox, fetch: remote.fetch, randomUUID: uuid });
  const comparison = await coordinator.inspect();
  assert.equal(comparison.kind, 'local_only');
  assert.equal(await outbox.getAuthorization(accountId), null);
  assert.equal(remote.calls.filter((call) => call.url.endsWith('/commits')).length, 0);
  coordinator.stop();
});

test('transient authentication 503 is retried without treating the account as anonymous', async () => {
  const remote = network(await serverState(product('Server'), world(serverWorldId, 4, 'Server島'), 3));
  let authAttempts = 0;
  const fetch: typeof remote.fetch = (input, init) => {
    if (String(input).endsWith('/auth/status') && ++authAttempts === 1) return Promise.resolve(response({ error: { code: 'authentication_store_unavailable' } }, 503));
    return remote.fetch(input, init);
  };
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepository(product('Local')),
    worldRepository: createMemoryWorldRepository(world(localWorldId, 8, 'Local島')), outbox: createMemorySyncOutbox(), fetch });
  const comparison = await coordinator.inspect();
  assert.equal(authAttempts, 2);
  assert.equal(comparison.kind, 'choice_required');
  coordinator.stop();
});

test('repeated authentication 503 and a stalled request fail closed without local writes', async () => {
  const localProduct = product('Local'); const localWorld = world(localWorldId, 8, 'Local島');
  for (const failure of ['503', 'stalled'] as const) {
    let authAttempts = 0;
    const fetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      authAttempts += 1;
      if (failure === '503') return Promise.resolve(response({ error: { code: 'authentication_store_unavailable' } }, 503));
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const productRepo = productRepository(localProduct); const worldRepo = createMemoryWorldRepository(localWorld);
    const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepo, worldRepository: worldRepo,
      outbox: createMemorySyncOutbox(), fetch, authRequestTimeoutMs: 5 });
    const comparison = await coordinator.inspect();
    assert.equal(authAttempts, 2);
    assert.equal(comparison.kind, 'unavailable');
    assert.equal(productRepo.load().userProfile.nickname, 'Local');
    assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldRevision, 8);
    coordinator.stop();
  }
});

test('explicit local choice authorizes exactly the persisted World and waits for server ACK', async () => {
  const outbox = createMemorySyncOutbox(); const localWorld = world(localWorldId, 2, 'Local島'); const remote = network(await serverState(null, null, 0));
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepository(product('Local')), worldRepository: createMemoryWorldRepository(localWorld), outbox, fetch: remote.fetch, randomUUID: uuid });
  const status = await coordinator.chooseLocalWorld();
  assert.equal(status.acknowledgedSyncRevision, 1);
  assert.deepEqual((await outbox.getAuthorization(accountId))?.authorizedWorldIds, [localWorldId]);
  assert.equal(remote.calls.filter((call) => call.url.endsWith('/commits')).length, 1);
  coordinator.stop();
});

test('explicit server choice journals, verifies, and applies Profile and World without an upload', async () => {
  const outbox = createMemorySyncOutbox(); const targetProduct = product('Server'); const targetWorld = world(serverWorldId, 4, 'Server島');
  const remote = network(await serverState(targetProduct, targetWorld, 3)); const productRepo = productRepository(product('Local')); const worldRepo = createMemoryWorldRepository(world(localWorldId, 8, 'Local島'));
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: remote.fetch, randomUUID: uuid });
  const comparison = await coordinator.chooseServerBundle();
  assert.equal(comparison.kind, 'aligned');
  assert.equal(productRepo.load().userProfile.nickname, 'Server');
  assert.equal((await worldRepo.loadActive()).status, 'ready');
  assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldId, serverWorldId);
  assert.equal(await outbox.getOpenLocalApply(accountId), null);
  assert.equal(remote.calls.filter((call) => call.url.endsWith('/commits')).length, 0);
  coordinator.stop();
});

test('failed local apply preserves a repair journal and rollback restores the prior World', async () => {
  const outbox = createMemorySyncOutbox(); const targetProduct = product('FailTarget'); const targetWorld = world(serverWorldId, 4, 'Server島'); const priorWorld = world(localWorldId, 8, 'Local島');
  const remote = network(await serverState(targetProduct, targetWorld, 3)); const productRepo = productRepository(product('Local'), 'FailTarget'); const worldRepo = createMemoryWorldRepository(priorWorld);
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: remote.fetch, randomUUID: uuid });
  await assert.rejects(coordinator.chooseServerBundle(), /localStorage failure/);
  assert.equal((await outbox.getOpenLocalApply(accountId))?.state, 'failed');
  assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldId, serverWorldId);
  await coordinator.repairLocalApply('rollback');
  assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldId, localWorldId);
  assert.equal(productRepo.load().userProfile.nickname, 'Local');
  assert.equal(await outbox.getOpenLocalApply(accountId), null);
  coordinator.stop();
});

test('server conflict choice is atomic remotely and preserves the local candidate record', async () => {
  const outbox = createMemorySyncOutbox(); const targetProduct = product('Server'); const targetWorld = world(serverWorldId, 4, 'Server島');
  const candidateResult = await createAccountSyncBundle({ accountId, syncRevision: 1, operationId: uuid(), deviceId: 'device-stage5-test', capturedAt: '2026-10-24T00:00:00.000Z', productBefore: product('Candidate'), productAfter: product('Candidate'), worldBefore: world(localWorldId, 3, 'Candidate島'), worldAfter: world(localWorldId, 3, 'Candidate島') });
  assert.equal(candidateResult.status, 'ready'); if (candidateResult.status !== 'ready') return;
  await outbox.authorizeWorld({ accountId, worldId: localWorldId, deviceId: 'device-stage5-test', acknowledgedSyncRevision: 1 });
  const operation: SyncOutboxOperation = {
    operationId: candidateResult.value.operationId, accountId, worldId: localWorldId, deviceId: candidateResult.value.deviceId, baseSyncRevision: 1,
    bundle: candidateResult.value, contentHash: candidateResult.value.contentHash, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', state: 'conflict', retryCount: 0,
    nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, acknowledgedSyncRevision: null, lastHttpStatus: 409, lastErrorCode: 'revision_conflict', blockedReason: null, conflict: { id: '88888888-8888-4888-8888-888888888888' },
  };
  await outbox.enqueue(operation);
  const conflict: SyncConflictView = { id: '88888888-8888-4888-8888-888888888888', operationId: operation.operationId, accountId, baseSyncRevision: 1, serverSyncRevision: 2, candidateBundle: candidateResult.value, status: 'open', detectedAt: '2026-10-24T00:00:00.000Z' };
  const latest = await serverState(targetProduct, targetWorld, 2); const remote = network(latest, { conflicts: [conflict], detail: conflict, afterResolve: latest });
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepository(product('Candidate')), worldRepository: createMemoryWorldRepository(world(localWorldId, 3, 'Candidate島')), outbox, fetch: remote.fetch, randomUUID: uuid });
  await coordinator.resolveConflict(conflict.id, 'server');
  const preserved = await outbox.get(operation.operationId);
  assert.equal(preserved?.state, 'acknowledged');
  assert.equal(preserved?.lastErrorCode, 'conflict_server_selected');
  assert.ok(preserved?.conflict);
  assert.equal(remote.calls.filter((call) => call.url.endsWith('/resolve')).length, 1);
  coordinator.stop();
});

test('candidate conflict choice rebases through the atomic server resolver without mixing accounts', async () => {
  const outbox = createMemorySyncOutbox(); const candidateProduct = product('Candidate'); const candidateWorld = world(localWorldId, 5, 'Candidate島');
  const candidateResult = await createAccountSyncBundle({ accountId, syncRevision: 1, operationId: uuid(), deviceId: 'device-stage5-test', capturedAt: '2026-10-24T00:00:00.000Z', productBefore: candidateProduct, productAfter: candidateProduct, worldBefore: candidateWorld, worldAfter: candidateWorld });
  assert.equal(candidateResult.status, 'ready'); if (candidateResult.status !== 'ready') return;
  await outbox.authorizeWorld({ accountId, worldId: localWorldId, deviceId: 'device-stage5-test', acknowledgedSyncRevision: 1 });
  const operation: SyncOutboxOperation = { operationId: candidateResult.value.operationId, accountId, worldId: localWorldId, deviceId: candidateResult.value.deviceId, baseSyncRevision: 1, bundle: candidateResult.value, contentHash: candidateResult.value.contentHash, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', state: 'conflict', retryCount: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, acknowledgedSyncRevision: null, lastHttpStatus: 409, lastErrorCode: 'revision_conflict', blockedReason: null, conflict: { id: '99999999-9999-4999-8999-999999999999' } };
  await outbox.enqueue(operation);
  const conflict: SyncConflictView = { id: '99999999-9999-4999-8999-999999999999', operationId: operation.operationId, accountId, baseSyncRevision: 1, serverSyncRevision: 2, candidateBundle: candidateResult.value, status: 'open', detectedAt: '2026-10-24T00:00:00.000Z' };
  const initial = await serverState(product('Server'), world(serverWorldId, 4, 'Server島'), 2);
  const resolved = await serverState(candidateProduct, candidateWorld, 3);
  const remote = network(initial, { conflicts: [conflict], detail: conflict, afterResolve: resolved });
  const productRepo = productRepository(product('Before')); const worldRepo = createMemoryWorldRepository(world(serverWorldId, 4, 'Server島'));
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: remote.fetch, randomUUID: uuid });
  await coordinator.resolveConflict(conflict.id, 'candidate');
  const resolveCall = remote.calls.find((call) => call.url.endsWith('/resolve'));
  const body = JSON.parse(String(resolveCall?.init?.body));
  assert.equal(body.action, 'commit');
  assert.equal(body.bundle.accountId, accountId);
  assert.equal(body.bundle.syncRevision, 2);
  assert.equal(productRepo.load().userProfile.nickname, 'Candidate');
  assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldId, localWorldId);
  coordinator.stop();
});

test('a server state scoped to another account is rejected without local writes', async () => {
  const outbox = createMemorySyncOutbox(); const localProduct = product('Local'); const localWorld = world(localWorldId, 2, 'Local島');
  const mismatched = { ...(await serverState(product('Other'), world(serverWorldId, 1, 'Other島'), 1)), accountId: 'different_account' };
  const remote = network(mismatched); const productRepo = productRepository(localProduct); const worldRepo = createMemoryWorldRepository(localWorld);
  const coordinator = new AccountSyncRecoveryCoordinator({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: remote.fetch, randomUUID: uuid });
  const comparison = await coordinator.inspect();
  assert.equal(comparison.kind, 'unavailable');
  assert.equal(productRepo.load().userProfile.nickname, 'Local');
  assert.equal((await worldRepo.loadActive() as { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }).snapshot.worldId, localWorldId);
  assert.equal(remote.calls.filter((call) => call.url.endsWith('/commits') || call.url.endsWith('/resolve')).length, 0);
  coordinator.stop();
});
