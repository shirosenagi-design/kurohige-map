import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountSyncRuntime } from '../src/accountSyncRuntime.ts';
import { notifyWorldPersisted } from '../src/localPersistenceSignals.ts';
import { createMemorySyncOutbox } from '../src/syncOutbox.ts';
import type { PersistedProductState, ProductStateRepository } from '../src/productState.ts';
import { createMemoryWorldRepository, type WorldRepository } from '../src/worldRepository.ts';
import type { PersistedWorldSnapshotV1 } from '../src/worldState.ts';

const accountId = 'stage4_registered_account';
const worldId = 'world-stage4-isolated';

const product = (): PersistedProductState => ({
  version: 2,
  personState: { interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname: 'Stage4航海者', region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-19T07:00:00.000Z' },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
});

const world = (revision = 1): PersistedWorldSnapshotV1 => ({
  schemaVersion: 1, worldId, worldRevision: revision, savedAt: `2026-10-19T07:00:0${Math.min(9, revision)}.000Z`, layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-stage4', title: '音楽を公開する', shortDescription: '作品を公開して反応を確かめる。', category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent',
    curiosityFit: .8, accessibility: .7, novelty: .6, friction: .2, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
    visualRecipe: { visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced', accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  }],
  nodeStates: { 'node-stage4': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] } },
  explorationBands: { 'node-stage4': 0 }, generatedBatches: [{ band: 0, nodeIds: ['node-stage4'] }], stepCatalog: {}, detailCache: {},
  ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});

function productRepository(initial = product()): ProductStateRepository & { set(next: PersistedProductState): void } {
  let value = structuredClone(initial);
  return { load: () => structuredClone(value), save: (next) => { value = structuredClone(next); }, clear: () => {}, set: (next) => { value = structuredClone(next); } };
}

function uuidSequence() {
  let count = 1;
  return () => `7d847f19-b5e7-4d36-a122-${String(count++).padStart(12, '0')}`;
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fetchFixture(options: { commits?: Array<Response | Error>; currentAccount?: string | null; serverRevision?: number } = {}) {
  const commits = [...(options.commits ?? [json({ result: { status: 'committed', syncRevision: 1 } }, 201)])];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith('/auth/status')) {
      if (!options.currentAccount) return json({ error: { code: 'authentication_required' } }, 401);
      return json({ viewer: { userId: options.currentAccount }, account: { accountType: 'registered' } });
    }
    if (url.endsWith('/account/sync/status')) return json({ sync: { syncRevision: options.serverRevision ?? 0, activeWorldId: null, hasOpenConflicts: false } });
    if (url.endsWith('/account/sync/commits')) {
      const result = commits.shift() ?? json({ result: { status: 'committed', syncRevision: 1 } }, 200);
      if (result instanceof Error) throw result;
      return result;
    }
    return json({}, 404);
  };
  return { fetch, calls };
}

const delay = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(check: () => Promise<boolean>, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) { if (await check()) return; await delay(); }
  throw new Error('Timed out waiting for sync state.');
}

test('explicit authorization persists the Outbox before HTTP commit and ACKs only the server-confirmed revision', async () => {
  const outbox = createMemorySyncOutbox(); const productRepo = productRepository(); const worldRepo = createMemoryWorldRepository(world());
  let online = false; const network = fetchFixture({ currentAccount: accountId });
  const runtime = new AccountSyncRuntime({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: network.fetch, online: () => online, randomUUID: uuidSequence(), captureDebounceMs: 1 });
  const authorization = await runtime.authorizeCurrentWorld(worldId);
  assert.equal(authorization.accountId, accountId);
  const operation = await runtime.captureNow();
  assert.equal((await outbox.get(operation.operationId))?.state, 'pending');
  assert.equal(network.calls.filter((call) => call.url.endsWith('/commits')).length, 0);
  online = true; await runtime.process();
  assert.equal((await outbox.get(operation.operationId))?.state, 'acknowledged');
  assert.equal((await outbox.get(operation.operationId))?.acknowledgedSyncRevision, 1);
  runtime.stop();
});

test('offline changes queue in revision order and remain durable until reconnect', async () => {
  const outbox = createMemorySyncOutbox(); const productRepo = productRepository(); const worldRepo = createMemoryWorldRepository(world());
  let online = false; const network = fetchFixture({ currentAccount: accountId, commits: [json({ result: { status: 'committed', syncRevision: 1 } }, 201), json({ result: { status: 'committed', syncRevision: 2 } }, 201)] });
  const runtime = new AccountSyncRuntime({ productRepository: productRepo, worldRepository: worldRepo, outbox, fetch: network.fetch, online: () => online, randomUUID: uuidSequence() });
  await runtime.authorizeCurrentWorld(worldId);
  const first = await runtime.captureNow();
  await worldRepo.save(world(2));
  const second = await runtime.captureNow();
  assert.deepEqual((await outbox.list(accountId)).map((entry) => entry.baseSyncRevision), [0, 1]);
  online = true; await runtime.process();
  assert.deepEqual((await outbox.list(accountId)).map((entry) => entry.state), ['acknowledged', 'acknowledged']);
  assert.deepEqual(network.calls.filter((call) => call.url.endsWith('/commits')).map((call) => JSON.parse(String(call.init?.body)).operationId), [first.operationId, second.operationId]);
  runtime.stop();
});

test('a lost HTTP response retries the exact operationId and server idempotency can ACK it', async () => {
  const outbox = createMemorySyncOutbox(); const network = fetchFixture({ currentAccount: accountId, commits: [new Error('response lost'), json({ result: { status: 'committed', syncRevision: 1 } }, 200)] });
  let nowMs = Date.parse('2026-10-19T07:00:00.000Z');
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: network.fetch, now: () => new Date(nowMs), randomUUID: uuidSequence(), maxBackoffMs: 1_000 });
  await runtime.authorizeCurrentWorld(worldId); const operation = await runtime.captureNow();
  await waitFor(async () => (await outbox.get(operation.operationId))?.retryCount === 1);
  nowMs += 1_001; await runtime.process();
  const requestIds = network.calls.filter((call) => call.url.endsWith('/commits')).map((call) => JSON.parse(String(call.init?.body)).operationId);
  assert.deepEqual(requestIds, [operation.operationId, operation.operationId]);
  assert.equal((await outbox.get(operation.operationId))?.state, 'acknowledged');
  runtime.stop();
});

test('two runtimes sharing an Outbox lease cannot double-send the same operation', async () => {
  const outbox = createMemorySyncOutbox(); let online = false; let commitCount = 0;
  const network = fetchFixture({ currentAccount: accountId });
  const countedFetch = async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith('/commits')) commitCount += 1; return network.fetch(input, init); };
  const options = { productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: countedFetch, online: () => online };
  const first = new AccountSyncRuntime({ ...options, randomUUID: uuidSequence() }); await first.authorizeCurrentWorld(worldId); await first.captureNow();
  const second = new AccountSyncRuntime({ ...options, randomUUID: uuidSequence() }); await second.resumeAuthorizedAccount(accountId);
  online = true; await Promise.all([first.process(), second.process()]);
  assert.equal(commitCount, 1);
  first.stop(); second.stop();
});

test('409 preserves the conflict candidate and blocks later queue operations', async () => {
  const outbox = createMemorySyncOutbox(); let online = false;
  const network = fetchFixture({ currentAccount: accountId, commits: [json({ result: { status: 'conflict', conflict: { id: 'conflict-1' } } }, 409)] });
  const worldRepo = createMemoryWorldRepository(world());
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: worldRepo, outbox, fetch: network.fetch, online: () => online, randomUUID: uuidSequence() });
  await runtime.authorizeCurrentWorld(worldId); const first = await runtime.captureNow(); await worldRepo.save(world(2)); const second = await runtime.captureNow();
  online = true; await runtime.process();
  assert.equal((await outbox.get(first.operationId))?.state, 'conflict');
  assert.deepEqual((await outbox.get(first.operationId))?.conflict, { id: 'conflict-1' });
  assert.equal((await outbox.get(second.operationId))?.state, 'pending');
  assert.equal((await runtime.getStatus()).phase, 'conflict');
  runtime.stop();
});

test('expired sessions and account switches stop sending and preserve account-scoped data', async () => {
  for (const currentAccount of [null, 'another_registered_account']) {
    const outbox = createMemorySyncOutbox(); let online = false; const network = fetchFixture({ currentAccount: accountId });
    const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: network.fetch, online: () => online, randomUUID: uuidSequence() });
    await runtime.authorizeCurrentWorld(worldId); const operation = await runtime.captureNow();
    network.fetch = fetchFixture({ currentAccount }).fetch;
    const switched = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: network.fetch, online: () => true, randomUUID: uuidSequence() });
    assert.equal(await switched.resumeAuthorizedAccount(accountId), false);
    assert.equal((await outbox.get(operation.operationId))?.state, 'pending');
    runtime.stop(); switched.stop();
  }
});

test('permanent validation errors stay preserved and are not retried', async () => {
  for (const status of [413, 422]) {
    const outbox = createMemorySyncOutbox(); const network = fetchFixture({ currentAccount: accountId, commits: [json({ error: { code: status === 413 ? 'bundle_too_large' : 'content_hash_mismatch' } }, status)] });
    const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: network.fetch, randomUUID: uuidSequence() });
    await runtime.authorizeCurrentWorld(worldId); const operation = await runtime.captureNow();
    await waitFor(async () => (await outbox.get(operation.operationId))?.state === 'blocked');
    assert.equal((await outbox.get(operation.operationId))?.blockedReason, status === 413 ? 'payload_too_large' : 'invalid_payload');
    assert.equal(network.calls.filter((call) => call.url.endsWith('/commits')).length, 1);
    runtime.stop();
  }
});

test('local mutation during double-read is quarantined and never enqueued', async () => {
  const outbox = createMemorySyncOutbox(); const stable = createMemoryWorldRepository(world()); let reads = 0;
  const racingWorld: WorldRepository = {
    async loadActive() { reads += 1; if (reads === 3) await stable.save(world(2)); return stable.loadActive(); },
    save: (snapshot) => stable.save(snapshot), clearActive: () => stable.clearActive(),
  };
  const network = fetchFixture({ currentAccount: accountId });
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: racingWorld, outbox, fetch: network.fetch, online: () => false, randomUUID: uuidSequence() });
  await runtime.authorizeCurrentWorld(worldId);
  await assert.rejects(runtime.captureNow(), /changed during capture/);
  assert.equal((await outbox.list(accountId)).length, 0);
  assert.equal((outbox as ReturnType<typeof createMemorySyncOutbox> & { quarantined?: unknown[] }).quarantined?.length, 1);
  runtime.stop();
});

test('an acknowledged revision remains distinct from a newer unsent local change', async () => {
  const outbox = createMemorySyncOutbox(); const worldRepo = createMemoryWorldRepository(world()); let online = true;
  const network = fetchFixture({ currentAccount: accountId });
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: worldRepo, outbox, fetch: network.fetch, online: () => online, randomUUID: uuidSequence() });
  await runtime.authorizeCurrentWorld(worldId); const first = await runtime.captureNow(); await runtime.process();
  assert.equal((await outbox.get(first.operationId))?.state, 'acknowledged');
  online = false; await worldRepo.save(world(2)); const second = await runtime.captureNow();
  assert.equal((await outbox.get(second.operationId))?.state, 'pending');
  const status = await runtime.getStatus();
  assert.equal(status.phase, 'offline'); assert.equal(status.acknowledgedCount, 1); assert.equal(status.pendingCount, 1);
  runtime.stop();
});

test('Outbox storage failure preserves local repositories and prevents HTTP transmission', async () => {
  const base = createMemorySyncOutbox(); const worldRepo = createMemoryWorldRepository(world()); const productRepo = productRepository();
  const network = fetchFixture({ currentAccount: accountId });
  const failing = { ...base, async enqueue() { throw new Error('simulated IndexedDB write failure'); } };
  const runtime = new AccountSyncRuntime({ productRepository: productRepo, worldRepository: worldRepo, outbox: failing, fetch: network.fetch, randomUUID: uuidSequence() });
  await runtime.authorizeCurrentWorld(worldId);
  const beforeProduct = productRepo.load(); const beforeWorld = await worldRepo.loadActive();
  await assert.rejects(runtime.captureNow(), /IndexedDB write failure/);
  assert.deepEqual(productRepo.load(), beforeProduct); assert.deepEqual(await worldRepo.loadActive(), beforeWorld);
  assert.equal(network.calls.filter((call) => call.url.endsWith('/commits')).length, 0);
  runtime.stop();
});

test('a locally persisted change is reported as unsynced before durable capture finishes', async () => {
  const outbox = createMemorySyncOutbox(); const network = fetchFixture({ currentAccount: accountId });
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: createMemoryWorldRepository(world()), outbox, fetch: network.fetch, online: () => false, randomUUID: uuidSequence(), captureDebounceMs: 60_000 });
  await runtime.authorizeCurrentWorld(worldId);
  notifyWorldPersisted(world(2));
  assert.equal((await runtime.getStatus()).phase, 'unsynced_changes');
  runtime.stop();
});
