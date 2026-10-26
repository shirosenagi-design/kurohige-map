import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createAccountSyncBundle,
  sha256ContentHash,
} from '../src/accountSyncContract.ts';
import {
  AccountSyncRepositoryError,
  createPostgresAccountSyncRepository,
} from '../server/postgres/postgresAccountSyncRepository.mjs';
import { createPostgresPool } from '../server/postgres/postgresReviewRepository.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionString = process.env.TEST_SYNC_REPOSITORY_DATABASE_URL ?? '';
const resetAllowed = process.env.ALLOW_SYNC_REPOSITORY_DB_RESET === 'true';
const databaseName = (() => { try { return new URL(connectionString).pathname.slice(1); } catch { return ''; } })();
const safeDatabaseName = /(?:test|isolated)/iu.test(databaseName);
const canRun = Boolean(connectionString && resetAllowed && safeDatabaseName);

const migrationNames = [
  '001_review_platform.sql', '002_account_sessions.sql', '003_email_identity.sql',
  '004_passkeys.sql', '005_account_world_sync.sql',
];
const rollbackNames = [
  '005_account_world_sync.down.sql', '004_passkeys.down.sql', '003_email_identity.down.sql',
  '002_account_sessions.down.sql', '001_review_platform.down.sql',
];

const sql = Object.fromEntries(await Promise.all([...migrationNames, ...rollbackNames].map(async (name) => [
  name, await readFile(path.join(root, 'server', 'postgres', 'migrations', name), 'utf8'),
])));

const product = (nickname) => ({
  version: 2,
  personState: {
    interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [],
    experiences: [], completedSteps: [], bridgeTags: [],
  },
  userProfile: {
    nickname, region: { countryCode: 'JP', administrativeArea: '東京' },
    updatedAt: '2026-10-18T00:00:00.000Z',
  },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
});

const world = (worldId, worldRevision, selectedNodeId = null) => ({
  schemaVersion: 1,
  worldId,
  worldRevision,
  savedAt: '2026-10-18T00:00:00.000Z',
  layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-stage2-main', title: '音楽を公開する', shortDescription: '作った曲を公開して反応を確かめる。',
    category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent', curiosityFit: .8, accessibility: .7,
    novelty: .6, friction: .3, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
    visualRecipe: {
      visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced',
      accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate',
    },
  }],
  nodeStates: {
    'node-stage2-main': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] },
  },
  explorationBands: { 'node-stage2-main': 0 },
  generatedBatches: [{ band: 0, nodeIds: ['node-stage2-main'] }],
  stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId,
});

async function bundle({ accountId, baseRevision, operationId, nickname, worldRevision, worldId = 'world-stage2-main', deviceId = 'device.phase2d.stage2' }) {
  const profile = product(nickname);
  const snapshot = world(worldId, worldRevision);
  const result = await createAccountSyncBundle({
    accountId,
    syncRevision: baseRevision,
    operationId,
    deviceId,
    capturedAt: '2026-10-18T03:00:00.000Z',
    productBefore: profile, productAfter: profile,
    worldBefore: snapshot, worldAfter: snapshot,
  });
  assert.equal(result.status, 'ready');
  return result.value;
}

async function tableExists(pool, tableName) {
  return Boolean((await pool.query('SELECT to_regclass($1) AS name', [`public.${tableName}`])).rows[0].name);
}

async function resetIsolatedSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  for (const name of migrationNames) await pool.query(sql[name]);
}

test('PostgreSQL Sync Repository is atomic, account-scoped, idempotent, and conflict preserving', { skip: !canRun }, async () => {
  const pool = await createPostgresPool(connectionString, {
    applicationName: 'kurohige-sync-repository-integration', connectionTimeoutMs: 800, statementTimeoutMs: 8_000,
  });
  const accountA = 'sync_stage2_registered_a';
  const accountB = 'sync_stage2_registered_b';
  const anonymous = 'sync_stage2_anonymous';
  const subjectId = 'sync-stage2-test-subject';
  const initialOps = [
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
  ];
  try {
    await resetIsolatedSchema(pool);
    assert.deepEqual((await pool.query('SELECT version FROM review_schema_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2, 3, 4, 5]);
    await pool.query(`INSERT INTO review_accounts(id,account_type) VALUES
      ($1,'registered'),($2,'registered'),($3,'anonymous')`, [accountA, accountB, anonymous]);
    await pool.query(`INSERT INTO experience_subjects(id,kind,name,sharing_scope,identity_version,semantic_tags)
      VALUES($1,'possibility','Stage 2 isolated subject','island_specific',1,'[]'::jsonb)`, [subjectId]);
    await pool.query(`INSERT INTO landing_journeys(
      account_id,node_id,subject_id,required_step_ids,completed_step_ids,started_at,updated_at,landed_at,landing_evidence
    ) VALUES($1,'node-ledger',$2,'["s1","s2","s3"]'::jsonb,'["s1","s2","s3"]'::jsonb,now(),now(),now(),'{"source":"isolated-test"}'::jsonb)`, [accountA, subjectId]);
    const ledgerBefore = (await pool.query('SELECT row_to_json(journey) AS value FROM landing_journeys journey WHERE account_id=$1', [accountA])).rows[0].value;

    const repository = createPostgresAccountSyncRepository(pool);
    const scopedA = repository.forAccount({ accountId: accountA });
    const scopedB = repository.forAccount({ accountId: accountB });
    const scopedAnonymous = repository.forAccount({ accountId: anonymous });

    const [raceOne, raceTwo] = await Promise.all([
      scopedA.commit(await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[0], nickname: '端末A', worldRevision: 1, deviceId: 'device.phase2d.race-a' })),
      scopedA.commit(await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[1], nickname: '端末B', worldRevision: 2, deviceId: 'device.phase2d.race-b' })),
    ]);
    const committed = [raceOne, raceTwo].find((result) => result.status === 'committed');
    const conflicted = [raceOne, raceTwo].find((result) => result.status === 'conflict');
    assert.ok(committed);
    assert.ok(conflicted);
    assert.equal(committed.syncRevision, 1);
    assert.equal(conflicted.httpStatus, 409);
    assert.equal(conflicted.conflict.serverSyncRevision, 1);
    assert.equal(conflicted.conflict.candidateBundle.contentHash, conflicted.conflict.candidateHash);

    const latest = await scopedA.getLatest();
    assert.equal(latest.syncRevision, 1);
    assert.equal(latest.profile.contentHash, await sha256ContentHash(latest.profile.snapshot));
    assert.equal(latest.world.contentHash, await sha256ContentHash(latest.world.snapshot));

    const winningBundle = initialOps[0] === committed.operationId
      ? await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[0], nickname: '端末A', worldRevision: 1, deviceId: 'device.phase2d.race-a' })
      : await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[1], nickname: '端末B', worldRevision: 2, deviceId: 'device.phase2d.race-b' });
    const replay = await scopedA.commit(winningBundle);
    assert.equal(replay.status, 'committed');
    assert.equal(replay.idempotent, true);
    assert.equal(replay.syncRevision, 1);
    assert.equal(replay.activeWorldId, committed.activeWorldId);
    assert.deepEqual(replay.state, committed.state);

    const changedPayload = await bundle({
      accountId: accountA, baseRevision: 0, operationId: committed.operationId,
      nickname: '同じIDの別payload', worldRevision: 99, deviceId: 'device.phase2d.mismatch',
    });
    await assert.rejects(scopedA.commit(changedPayload), (error) => error instanceof AccountSyncRepositoryError
      && error.status === 409 && error.code === 'sync_operation_payload_mismatch');

    const conflictBundle = initialOps[0] === conflicted.operationId
      ? await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[0], nickname: '端末A', worldRevision: 1, deviceId: 'device.phase2d.race-a' })
      : await bundle({ accountId: accountA, baseRevision: 0, operationId: initialOps[1], nickname: '端末B', worldRevision: 2, deviceId: 'device.phase2d.race-b' });
    const conflictReplay = await scopedA.commit(conflictBundle);
    assert.equal(conflictReplay.status, 'conflict');
    assert.equal(conflictReplay.idempotent, true);
    assert.equal(conflictReplay.conflict.candidateHash, conflicted.conflict.candidateHash);
    assert.deepEqual(conflictReplay.conflict.serverState, conflicted.conflict.serverState);

    const profileCountBeforeRollback = (await pool.query('SELECT count(*)::int AS count FROM account_profile_revisions WHERE account_id=$1', [accountA])).rows[0].count;
    await pool.query(`CREATE FUNCTION sync_stage2_force_world_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated forced rollback'; END $$`);
    await pool.query(`CREATE TRIGGER sync_stage2_force_world_failure BEFORE INSERT ON account_world_revisions
      FOR EACH ROW EXECUTE FUNCTION sync_stage2_force_world_failure()`);
    const rollbackOperation = 'c0000000-0000-4000-8000-000000000003';
    await assert.rejects(scopedA.commit(await bundle({
      accountId: accountA, baseRevision: 1, operationId: rollbackOperation,
      nickname: 'Rollback candidate', worldRevision: 3,
    })), (error) => error.code === 'sync_repository_unavailable');
    await pool.query('DROP TRIGGER sync_stage2_force_world_failure ON account_world_revisions');
    await pool.query('DROP FUNCTION sync_stage2_force_world_failure()');
    assert.equal((await scopedA.getLatest()).syncRevision, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM account_profile_revisions WHERE account_id=$1', [accountA])).rows[0].count, profileCountBeforeRollback);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM account_sync_operations WHERE operation_id=$1', [rollbackOperation])).rows[0].count, 0);

    const second = await scopedA.commit(await bundle({
      accountId: accountA, baseRevision: 1, operationId: 'd0000000-0000-4000-8000-000000000004',
      nickname: '履歴2', worldRevision: 4,
    }));
    assert.equal(second.status, 'committed');
    assert.equal(second.syncRevision, 2);
    assert.equal((await scopedA.listProfileRevisions()).length, 2);
    assert.equal((await scopedA.listWorldRevisions('world-stage2-main')).length, 2);
    assert.equal((await scopedA.listConflicts({ status: 'open' })).length, 1);
    assert.equal((await scopedB.getLatest()).syncRevision, 0);
    await assert.rejects(scopedB.getConflict(conflicted.conflict.id), (error) => error.code === 'sync_conflict_not_found');

    const foreignBundle = await bundle({
      accountId: accountA, baseRevision: 2, operationId: 'e0000000-0000-4000-8000-000000000005',
      nickname: 'Account混入', worldRevision: 5,
    });
    await assert.rejects(scopedB.commit(foreignBundle), (error) => error.code === 'account_mismatch');
    await assert.rejects(scopedAnonymous.commit(await bundle({
      accountId: anonymous, baseRevision: 0, operationId: 'f0000000-0000-4000-8000-000000000006',
      nickname: '匿名', worldRevision: 1,
    })), (error) => error.code === 'sync_registered_account_required');

    const tampered = structuredClone(foreignBundle);
    tampered.profile.snapshot.userProfile.nickname = '改ざん';
    await assert.rejects(scopedA.commit(tampered), (error) => error.code === 'content_hash_mismatch');
    const invalidSchema = { ...foreignBundle, schemaVersion: 99 };
    await assert.rejects(scopedA.commit(invalidSchema), (error) => error.code === 'unsupported_sync_schema');
    const oversized = structuredClone(foreignBundle);
    oversized.world.snapshot.futurePayload = 'x'.repeat(16 * 1024 * 1024 + 1);
    const { contentHash: _oldHash, ...oversizedContent } = oversized;
    oversized.contentHash = await sha256ContentHash(oversizedContent);
    await assert.rejects(scopedA.commit(oversized), (error) => error.code === 'world_too_large');

    const ledgerAfter = (await pool.query('SELECT row_to_json(journey) AS value FROM landing_journeys journey WHERE account_id=$1', [accountA])).rows[0].value;
    assert.deepEqual(ledgerAfter, ledgerBefore);

    const offlineUrl = new URL(connectionString);
    offlineUrl.port = String(Number(offlineUrl.port || '5432') + 1);
    const offlineQuery = async (text, parameters = []) => {
      const client = new pg.Client({ connectionString: offlineUrl.href, connectionTimeoutMillis: 300, statement_timeout: 500 });
      try {
        await client.connect();
        return await client.query(text, parameters);
      } finally {
        try { await client.end(); } catch { /* connection never opened */ }
      }
    };
    const offlinePool = {
      query: offlineQuery,
      async connect() {
        const client = new pg.Client({ connectionString: offlineUrl.href, connectionTimeoutMillis: 300, statement_timeout: 500 });
        await client.connect();
        return { query: client.query.bind(client), release: () => void client.end() };
      },
    };
    await assert.rejects(
      createPostgresAccountSyncRepository(offlinePool).forAccount({ accountId: accountA }).getLatest(),
      (error) => error.code === 'sync_repository_unavailable',
    );
    const recovered = await createPostgresAccountSyncRepository(pool).forAccount({ accountId: accountA }).getLatest();
    assert.equal(recovered.syncRevision, 2);
    assert.equal(recovered.profile.snapshot.userProfile.nickname, '履歴2');

    assert.deepEqual((await pool.query('SELECT version FROM review_schema_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2, 3, 4, 5]);
  } finally {
    try {
      await pool.query('DROP TRIGGER IF EXISTS sync_stage2_force_world_failure ON account_world_revisions');
      await pool.query('DROP FUNCTION IF EXISTS sync_stage2_force_world_failure()');
      await pool.query('DELETE FROM account_sync_heads');
      await pool.query('DELETE FROM account_sync_conflicts');
      await pool.query('DELETE FROM account_world_revisions');
      await pool.query('DELETE FROM account_profile_revisions');
      await pool.query('DELETE FROM account_worlds');
      await pool.query('DELETE FROM account_sync_operations');
      await pool.query('DELETE FROM landing_journeys WHERE account_id IN ($1,$2,$3)', [accountA, accountB, anonymous]);
      await pool.query('DELETE FROM experience_subjects WHERE id=$1', [subjectId]);
      await pool.query('DELETE FROM review_accounts WHERE id IN ($1,$2,$3)', [accountA, accountB, anonymous]);
    } finally {
      await pool.end();
    }
  }
});

test('Stage 2 integration reset is impossible without explicit isolated settings', () => {
  if (connectionString && !safeDatabaseName) assert.equal(canRun, false);
  if (connectionString && !resetAllowed) assert.equal(canRun, false);
  if (!connectionString) assert.equal(canRun, false);
});
