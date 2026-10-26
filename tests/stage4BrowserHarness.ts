import { AccountSyncRuntime } from '../src/accountSyncRuntime.ts';
import { createIndexedDbSyncOutbox } from '../src/syncOutbox.ts';
import { createIndexedDbWorldRepository } from '../src/worldRepository.ts';
import type { BrowserStorage, PersistedProductState, ProductStateRepository } from '../src/productState.ts';
import type { PersistedWorldSnapshotV1 } from '../src/worldState.ts';

const OUTBOX_DB = 'kurohige-stage4-browser-outbox-isolated';
const WORLD_DB = 'kurohige-stage4-browser-world-isolated';
const PRODUCT_KEY = 'kurohige-stage4-browser-product-isolated';
const ACCOUNT_ID = 'sync_stage4_browser_registered';
const WORLD_ID = 'world-stage4-browser-isolated';

const product = (): PersistedProductState => ({
  version: 2,
  personState: { interests: ['航海'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname: 'Stage4 Browser TEST', region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-19T08:00:00.000Z' },
  onboardingComplete: true, personContextRevision: 1, observedPersonSignals: [],
});

const world = (): PersistedWorldSnapshotV1 => ({
  schemaVersion: 1, worldId: WORLD_ID, worldRevision: 1, savedAt: '2026-10-19T08:00:00.000Z', layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-stage4-browser', title: 'Stage 4 TEST航海', shortDescription: '隔離同期経路だけを検証する島。', category: 'test', nodeKind: 'activity', relationToGoal: 'adjacent',
    curiosityFit: .8, accessibility: .8, novelty: .5, friction: .1, portableResourceTags: ['testing'], connectionTags: ['sync'], helpedByTags: [],
    visualRecipe: { visualTheme: 'research', dominantMotif: 'observation_station', secondaryObjects: ['notebook'], terrainProfile: 'gentle_hill', accentPalette: 'sea_green', density: 'sparse', openness: 'open', landmarkEmphasis: 'medium', energyLevel: 'calm' },
  }],
  nodeStates: { 'node-stage4-browser': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] } },
  explorationBands: { 'node-stage4-browser': 0 }, generatedBatches: [{ band: 0, nodeIds: ['node-stage4-browser'] }], stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});

function storage(): BrowserStorage {
  return {
    getItem: () => localStorage.getItem(PRODUCT_KEY),
    setItem: (_key, value) => localStorage.setItem(PRODUCT_KEY, value),
    removeItem: () => localStorage.removeItem(PRODUCT_KEY),
  };
}

function productRepository(): ProductStateRepository {
  const browserStorage = storage();
  return {
    load: () => JSON.parse(browserStorage.getItem(PRODUCT_KEY) ?? JSON.stringify(product())),
    save: (snapshot) => browserStorage.setItem(PRODUCT_KEY, JSON.stringify(snapshot)),
    clear: () => browserStorage.removeItem(PRODUCT_KEY),
  };
}

const deleteDatabase = (name: string) => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error(`Blocked deleting isolated DB ${name}`));
});

export async function resetStage4BrowserIsolation() {
  await Promise.all([deleteDatabase(OUTBOX_DB), deleteDatabase(WORLD_DB)]);
  localStorage.removeItem(PRODUCT_KEY);
  return { reset: true, databases: [OUTBOX_DB, WORLD_DB], productKey: PRODUCT_KEY };
}

export async function stage4QueueOffline() {
  const productRepo = productRepository(); productRepo.save(product());
  const worldRepo = createIndexedDbWorldRepository(indexedDB, { databaseName: WORLD_DB });
  const saved = await worldRepo.save(world());
  const loaded = await worldRepo.loadActive();
  if (!saved || loaded.status !== 'ready') throw new Error(`Isolated World setup failed: saved=${saved}, status=${loaded.status}${loaded.status === 'corrupt' ? `, reason=${loaded.reason}` : ''}`);
  const outbox = createIndexedDbSyncOutbox(indexedDB, { databaseName: OUTBOX_DB });
  const runtime = new AccountSyncRuntime({ productRepository: productRepo, worldRepository: worldRepo, outbox, online: () => false });
  const authorization = await runtime.authorizeCurrentWorld(WORLD_ID);
  if (authorization.accountId !== ACCOUNT_ID) throw new Error(`Unexpected isolated account: ${authorization.accountId}`);
  const operation = await runtime.captureNow(); runtime.stop();
  const stored = await outbox.get(operation.operationId);
  return { operationId: operation.operationId, state: stored?.state, accountId: authorization.accountId, worldId: operation.worldId, contentHash: operation.contentHash };
}

export async function stage4ResumeAndSend() {
  const worldRepo = createIndexedDbWorldRepository(indexedDB, { databaseName: WORLD_DB });
  const outbox = createIndexedDbSyncOutbox(indexedDB, { databaseName: OUTBOX_DB });
  const runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository: worldRepo, outbox });
  const resumed = await runtime.resumeAuthorizedAccount(ACCOUNT_ID);
  await runtime.process();
  const operations = await outbox.list(ACCOUNT_ID);
  const status = await runtime.getStatus(); runtime.stop();
  return { resumed, status, operations: operations.map(({ operationId, state, retryCount, acknowledgedSyncRevision, contentHash }) => ({ operationId, state, retryCount, acknowledgedSyncRevision, contentHash })) };
}

export async function stage4ReadEvidence() {
  const outbox = createIndexedDbSyncOutbox(indexedDB, { databaseName: OUTBOX_DB });
  const operations = await outbox.list(ACCOUNT_ID);
  const authorization = await outbox.getAuthorization(ACCOUNT_ID);
  return { accountId: ACCOUNT_ID, authorization, operations: operations.map(({ operationId, state, retryCount, acknowledgedSyncRevision, contentHash, leaseOwner, leaseExpiresAt }) => ({ operationId, state, retryCount, acknowledgedSyncRevision, contentHash, leaseOwner, leaseExpiresAt })) };
}
