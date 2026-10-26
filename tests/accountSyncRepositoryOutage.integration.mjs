import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createAccountSyncBundle, sha256ContentHash } from '../src/accountSyncContract.ts';
import { createPostgresAccountSyncRepository } from '../server/postgres/postgresAccountSyncRepository.mjs';
import { createPostgresPool } from '../server/postgres/postgresReviewRepository.mjs';

const connectionString = process.env.TEST_SYNC_REPOSITORY_DATABASE_URL ?? '';
const phase = process.env.SYNC_OUTAGE_PHASE ?? '';
const accountId = 'sync_stage2_outage_evidence';
const operationId = '90000000-0000-4000-8000-000000000009';

const profile = {
  version: 2,
  personState: {
    interests: ['復旧検証'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [],
    experiences: [], completedSteps: [], bridgeTags: [],
  },
  userProfile: {
    nickname: 'Stage 2復旧証跡', region: { countryCode: 'JP', administrativeArea: '東京' },
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
};

const world = {
  schemaVersion: 1, worldId: 'world-stage2-outage', worldRevision: 1,
  savedAt: '2026-10-19T00:00:00.000Z', layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-stage2-outage', title: '同期を復旧する', shortDescription: 'DB停止後に同じWorldを復旧できるか確かめる。',
    category: 'research', nodeKind: 'activity', relationToGoal: 'adjacent', curiosityFit: .8, accessibility: .8,
    novelty: .4, friction: .2, portableResourceTags: ['verification'], connectionTags: ['sync'], helpedByTags: [],
    visualRecipe: {
      visualTheme: 'research', dominantMotif: 'observatory', secondaryObjects: ['telescope'], terrainProfile: 'terraced',
      accentPalette: 'cyan', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'calm',
    },
  }],
  nodeStates: {
    'node-stage2-outage': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] },
  },
  explorationBands: { 'node-stage2-outage': 0 },
  generatedBatches: [{ band: 0, nodeIds: ['node-stage2-outage'] }],
  stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
};

async function candidate() {
  const result = await createAccountSyncBundle({
    accountId, syncRevision: 0, operationId, deviceId: 'device.phase2d.outage',
    capturedAt: '2026-10-19T00:01:00.000Z',
    productBefore: profile, productAfter: profile, worldBefore: world, worldAfter: world,
  });
  assert.equal(result.status, 'ready');
  return result.value;
}

if (!connectionString || !['seed', 'offline', 'recover'].includes(phase)) {
  throw new Error('A dedicated TEST_SYNC_REPOSITORY_DATABASE_URL and SYNC_OUTAGE_PHASE are required.');
}

if (phase === 'seed') {
  test('seed a committed Sync Bundle before the real database outage', async () => {
    const pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-sync-outage-seed' });
    try {
      await pool.query(`INSERT INTO review_accounts(id,account_type) VALUES($1,'registered')`, [accountId]);
      const result = await createPostgresAccountSyncRepository(pool).forAccount({ accountId }).commit(await candidate());
      assert.equal(result.status, 'committed');
      assert.equal(result.syncRevision, 1);
    } finally { await pool.end(); }
  });
}

if (phase === 'offline') {
  test('a real stopped database fails closed', async () => {
    const query = async (text, parameters = []) => {
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 400, statement_timeout: 500 });
      try {
        await client.connect();
        return await client.query(text, parameters);
      } finally {
        try { await client.end(); } catch { /* connection was never established */ }
      }
    };
    const unavailablePool = {
      query,
      async connect() {
        const client = new pg.Client({ connectionString, connectionTimeoutMillis: 400, statement_timeout: 500 });
        await client.connect();
        return { query: client.query.bind(client), release: () => void client.end() };
      },
    };
    const repository = createPostgresAccountSyncRepository(unavailablePool).forAccount({ accountId });
    await assert.rejects(repository.getLatest(), (error) => error.status === 503 && error.code === 'sync_repository_unavailable');
  });
}

if (phase === 'recover') {
  test('the committed Bundle survives restart and cleanup remains account-scoped', async () => {
    const pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-sync-outage-recovery' });
    try {
      const latest = await createPostgresAccountSyncRepository(pool).forAccount({ accountId }).getLatest();
      assert.equal(latest.syncRevision, 1);
      assert.equal(latest.profile.snapshot.userProfile.nickname, 'Stage 2復旧証跡');
      assert.equal(latest.profile.contentHash, await sha256ContentHash(latest.profile.snapshot));
      assert.equal(latest.world.contentHash, await sha256ContentHash(latest.world.snapshot));
      await pool.query('DELETE FROM account_sync_heads WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM account_sync_conflicts WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM account_world_revisions WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM account_profile_revisions WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM account_worlds WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM account_sync_operations WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM review_accounts WHERE id=$1', [accountId]);
    } finally { await pool.end(); }
  });
}
