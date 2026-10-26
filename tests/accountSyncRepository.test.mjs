import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountSyncBundle } from '../src/accountSyncContract.ts';
import {
  AccountSyncRepositoryError,
  createPostgresAccountSyncRepository,
} from '../server/postgres/postgresAccountSyncRepository.mjs';

const product = () => ({
  version: 2,
  personState: {
    interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [],
    experiences: [], completedSteps: [], bridgeTags: [],
  },
  userProfile: {
    nickname: '航海者', region: { countryCode: 'JP', administrativeArea: '東京' },
    updatedAt: '2026-10-18T00:00:00.000Z',
  },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
});

const world = () => ({
  schemaVersion: 1,
  worldId: 'world-sync-repository',
  worldRevision: 1,
  savedAt: '2026-10-18T00:00:00.000Z',
  layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-sync-repository', title: '音楽を公開する', shortDescription: '作った曲を公開して反応を確かめる。',
    category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent', curiosityFit: .8, accessibility: .7,
    novelty: .6, friction: .3, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
    visualRecipe: {
      visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced',
      accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate',
    },
  }],
  nodeStates: {
    'node-sync-repository': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] },
  },
  explorationBands: { 'node-sync-repository': 0 },
  generatedBatches: [{ band: 0, nodeIds: ['node-sync-repository'] }],
  stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});

async function bundle(accountId = 'sync_registered_account') {
  const profile = product();
  const snapshot = world();
  const result = await createAccountSyncBundle({
    accountId,
    syncRevision: 0,
    operationId: 'af602bce-c4fb-42de-9f60-e4714a5c8801',
    deviceId: 'device.repository.unit',
    capturedAt: '2026-10-18T00:01:00.000Z',
    productBefore: profile, productAfter: profile,
    worldBefore: snapshot, worldAfter: snapshot,
  });
  assert.equal(result.status, 'ready');
  return result.value;
}

test('repository requires a scoped authenticated account context', () => {
  const pool = { connect() {}, query() {} };
  const repository = createPostgresAccountSyncRepository(pool);
  assert.throws(() => repository.forAccount(null), (error) => error instanceof AccountSyncRepositoryError
    && error.code === 'sync_authentication_required');
  assert.throws(() => repository.forAccount({ accountId: '../other' }), (error) => error.code === 'sync_authentication_required');
});

test('bundle account ownership is validated before any database operation', async () => {
  let databaseCalls = 0;
  const pool = {
    async connect() { databaseCalls += 1; throw new Error('must not connect'); },
    async query() { databaseCalls += 1; throw new Error('must not query'); },
  };
  const repository = createPostgresAccountSyncRepository(pool).forAccount({ accountId: 'sync_registered_account' });
  const foreign = await bundle('sync_foreign_account');
  await assert.rejects(repository.commit(foreign), (error) => error instanceof AccountSyncRepositoryError
    && error.status === 400 && error.code === 'account_mismatch');
  assert.equal(databaseCalls, 0);
});

test('database failures fail closed without returning sync state', async () => {
  const pool = {
    async connect() { throw new Error('database offline'); },
    async query() { throw new Error('database offline'); },
  };
  const scoped = createPostgresAccountSyncRepository(pool).forAccount({ accountId: 'sync_registered_account' });
  await assert.rejects(scoped.getLatest(), (error) => error instanceof AccountSyncRepositoryError
    && error.status === 503 && error.code === 'sync_repository_unavailable');
  await assert.rejects(scoped.commit(await bundle()), (error) => error instanceof AccountSyncRepositoryError
    && error.status === 503 && error.code === 'sync_repository_unavailable');
});
