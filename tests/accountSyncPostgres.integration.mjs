import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../server/postgres/postgresReviewRepository.mjs';

const connectionString = process.env.TEST_SYNC_DATABASE_URL;
const resetAllowed = process.env.ALLOW_SYNC_DB_RESET === 'true';
const databaseName = connectionString ? new URL(connectionString).pathname.slice(1).toLowerCase() : '';
const safeDatabaseName = databaseName.includes('test') || databaseName.includes('isolated');
const canRun = Boolean(connectionString && resetAllowed && safeDatabaseName);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrations = path.join(root, 'server/postgres/migrations');
const sql = Object.fromEntries(await Promise.all([
  '001_review_platform.sql', '002_account_sessions.sql', '003_email_identity.sql', '004_passkeys.sql', '005_account_world_sync.sql',
  '001_review_platform.down.sql', '002_account_sessions.down.sql', '003_email_identity.down.sql', '004_passkeys.down.sql', '005_account_world_sync.down.sql',
].map(async (name) => [name, await readFile(path.join(migrations, name), 'utf8')])));

const hash = (letter) => letter.repeat(64);
const accountA = 'sync-stage1-account-a';
const accountB = 'sync-stage1-account-b';
const operationA1 = '10000000-0000-4000-8000-000000000001';
const operationA2 = '10000000-0000-4000-8000-000000000002';
const operationB1 = '20000000-0000-4000-8000-000000000001';
const conflictOperation = '10000000-0000-4000-8000-000000000003';
const conflictId = '30000000-0000-4000-8000-000000000001';
const device = 'device.stage1.integration';

const profile = (nickname) => ({
  version: 2,
  personState: { interests: [], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname, region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-18T00:00:00.000Z' },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
});
const world = (revision) => ({
  schemaVersion: 1, worldId: 'world-stage1-a', worldRevision: revision,
  savedAt: '2026-10-18T00:00:00.000Z', layoutVersion: 1,
  context: { locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [], nodeStates: {}, explorationBands: {}, generatedBatches: [], stepCatalog: {}, detailCache: {},
  ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});

async function tableExists(pool, name) {
  return Boolean((await pool.query('SELECT to_regclass($1) AS name', [`public.${name}`])).rows[0].name);
}

async function resetIsolatedSchema(pool) {
  if (await tableExists(pool, 'account_sync_heads')) await pool.query(sql['005_account_world_sync.down.sql']);
  if (await tableExists(pool, 'auth_webauthn_credentials')) await pool.query(sql['004_passkeys.down.sql']);
  if (await tableExists(pool, 'auth_email_identities')) await pool.query(sql['003_email_identity.down.sql']);
  if (await tableExists(pool, 'auth_migration_settings')) await pool.query(sql['002_account_sessions.down.sql']);
  if (await tableExists(pool, 'review_accounts')) await pool.query(sql['001_review_platform.down.sql']);
}

async function applyAll(pool) {
  for (const name of ['001_review_platform.sql', '002_account_sessions.sql', '003_email_identity.sql', '004_passkeys.sql', '005_account_world_sync.sql']) {
    await pool.query(sql[name]);
  }
}

test('Migration 005 preserves 001-004 and enforces sync history, ownership, revision, and rollback safety', { skip: !canRun }, async () => {
  const pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-sync-stage1-test', connectionTimeoutMs: 1_500 });
  try {
    await resetIsolatedSchema(pool);
    await applyAll(pool);
    assert.deepEqual((await pool.query('SELECT version FROM review_schema_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2, 3, 4, 5]);
    for (const table of ['review_accounts', 'review_sessions', 'auth_email_identities', 'auth_webauthn_credentials']) {
      assert.equal(await tableExists(pool, table), true);
    }
    for (const table of ['account_sync_heads', 'account_profile_revisions', 'account_worlds', 'account_world_revisions', 'account_sync_operations', 'account_sync_conflicts']) {
      assert.equal(await tableExists(pool, table), true);
    }

    await pool.query(sql['005_account_world_sync.down.sql']);
    assert.deepEqual((await pool.query('SELECT version FROM review_schema_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2, 3, 4]);
    assert.equal(await tableExists(pool, 'review_accounts'), true);
    assert.equal(await tableExists(pool, 'account_sync_heads'), false);
    await pool.query(sql['005_account_world_sync.sql']);

    await pool.query(`INSERT INTO review_accounts(id,account_type) VALUES($1,'registered'),($2,'registered')`, [accountA, accountB]);
    await pool.query(`INSERT INTO account_sync_operations(operation_id,account_id,device_id,base_sync_revision,resulting_sync_revision,request_hash,status,completed_at)
      VALUES($1,$2,$3,0,1,$4,'committed',now())`, [operationA1, accountA, device, hash('a')]);
    await pool.query(`INSERT INTO account_worlds(account_id,world_id,status,created_by_operation_id) VALUES($1,'world-stage1-a','active',$2)`, [accountA, operationA1]);
    await pool.query(`INSERT INTO account_profile_revisions(account_id,revision,sync_revision,schema_version,snapshot,content_hash,operation_id,device_id)
      VALUES($1,1,1,2,$2,$3,$4,$5)`, [accountA, JSON.stringify(profile('航海者A')), hash('b'), operationA1, device]);
    await pool.query(`INSERT INTO account_world_revisions(account_id,world_id,revision,sync_revision,source_world_revision,schema_version,layout_version,snapshot,content_hash,operation_id,device_id)
      VALUES($1,'world-stage1-a',1,1,4,1,1,$2,$3,$4,$5)`, [accountA, JSON.stringify(world(4)), hash('c'), operationA1, device]);
    await pool.query(`INSERT INTO account_sync_heads(account_id,sync_revision,profile_revision,active_world_id,profile_hash,world_hash)
      VALUES($1,1,1,'world-stage1-a',$2,$3)`, [accountA, hash('b'), hash('c')]);

    await assert.rejects(pool.query(`INSERT INTO account_worlds(account_id,world_id,status) VALUES($1,'world-stage1-second','active')`, [accountA]),
      (error) => error?.code === '23505');
    await assert.rejects(pool.query(`INSERT INTO account_sync_operations(operation_id,account_id,device_id,base_sync_revision,request_hash,status)
      VALUES($1,$2,$3,1,$4,'pending')`, [operationA1, accountA, device, hash('d')]), (error) => error?.code === '23505');

    await pool.query(`INSERT INTO account_sync_operations(operation_id,account_id,device_id,base_sync_revision,resulting_sync_revision,request_hash,status,completed_at)
      VALUES($1,$2,$3,0,1,$4,'committed',now())`, [operationB1, accountB, device, hash('e')]);
    await assert.rejects(pool.query(`INSERT INTO account_profile_revisions(account_id,revision,sync_revision,schema_version,snapshot,content_hash,operation_id,device_id)
      VALUES($1,2,2,2,$2,$3,$4,$5)`, [accountA, JSON.stringify(profile('混入')), hash('f'), operationB1, device]),
    (error) => error?.code === '23503');

    await pool.query(`INSERT INTO account_sync_operations(operation_id,account_id,device_id,base_sync_revision,resulting_sync_revision,request_hash,status,completed_at)
      VALUES($1,$2,$3,1,2,$4,'committed',now())`, [operationA2, accountA, device, hash('1')]);
    await pool.query(`INSERT INTO account_profile_revisions(account_id,revision,sync_revision,schema_version,snapshot,content_hash,operation_id,device_id)
      VALUES($1,2,2,2,$2,$3,$4,$5)`, [accountA, JSON.stringify(profile('航海者A更新')), hash('2'), operationA2, device]);
    await pool.query(`INSERT INTO account_world_revisions(account_id,world_id,revision,sync_revision,source_world_revision,schema_version,layout_version,snapshot,content_hash,operation_id,device_id)
      VALUES($1,'world-stage1-a',2,2,5,1,1,$2,$3,$4,$5)`, [accountA, JSON.stringify(world(5)), hash('3'), operationA2, device]);
    await pool.query(`UPDATE account_sync_heads SET sync_revision=2,profile_revision=2,profile_hash=$2,world_hash=$3,updated_at=now() WHERE account_id=$1`, [accountA, hash('2'), hash('3')]);
    assert.equal((await pool.query('SELECT count(*) AS count FROM account_profile_revisions WHERE account_id=$1', [accountA])).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) AS count FROM account_world_revisions WHERE account_id=$1', [accountA])).rows[0].count, '2');

    await pool.query(`INSERT INTO account_sync_operations(operation_id,account_id,device_id,base_sync_revision,request_hash,status,completed_at,error_code)
      VALUES($1,$2,$3,1,$4,'conflict',now(),'revision_conflict')`, [conflictOperation, accountA, device, hash('4')]);
    const candidateBundle = { schemaVersion: 1, accountId: accountA, syncRevision: 1, operationId: conflictOperation, deviceId: device };
    await pool.query(`INSERT INTO account_sync_conflicts(id,account_id,operation_id,base_sync_revision,server_sync_revision,candidate_bundle,candidate_hash,status)
      VALUES($1,$2,$3,1,2,$4,$5,'open')`, [conflictId, accountA, conflictOperation, JSON.stringify(candidateBundle), hash('5')]);
    assert.deepEqual((await pool.query('SELECT candidate_bundle,status FROM account_sync_conflicts WHERE id=$1', [conflictId])).rows[0],
      { candidate_bundle: candidateBundle, status: 'open' });

    await assert.rejects(pool.query(`INSERT INTO account_sync_heads(account_id,sync_revision,active_world_id,world_hash)
      VALUES($1,1,'world-stage1-a',$2)`, [accountB, hash('6')]), (error) => error?.code === '23503');

    const rollbackClient = await pool.connect();
    try {
      await assert.rejects(rollbackClient.query(sql['005_account_world_sync.down.sql']), (error) => error?.code === '55000');
      await rollbackClient.query('ROLLBACK');
    } finally { rollbackClient.release(); }
    assert.equal(await tableExists(pool, 'account_sync_heads'), true);
    assert.equal((await pool.query('SELECT sync_revision FROM account_sync_heads WHERE account_id=$1', [accountA])).rows[0].sync_revision, '2');

    await pool.query('DELETE FROM account_sync_heads');
    await pool.query('DELETE FROM account_sync_conflicts');
    await pool.query('DELETE FROM account_world_revisions');
    await pool.query('DELETE FROM account_profile_revisions');
    await pool.query('DELETE FROM account_worlds');
    await pool.query('DELETE FROM account_sync_operations');
    await pool.query('DELETE FROM review_accounts WHERE id IN ($1,$2)', [accountA, accountB]);
    await pool.query(sql['005_account_world_sync.down.sql']);
    await pool.query(sql['005_account_world_sync.sql']);
    assert.deepEqual((await pool.query('SELECT version FROM review_schema_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2, 3, 4, 5]);
    assert.equal((await pool.query('SELECT count(*) AS count FROM account_sync_heads')).rows[0].count, '0');
  } finally {
    await pool.end();
  }
});

test('Stage 1 integration reset is impossible without an explicitly isolated database', () => {
  if (!connectionString) assert.equal(canRun, false);
  if (connectionString && !safeDatabaseName) assert.equal(canRun, false);
  if (connectionString && !resetAllowed) assert.equal(canRun, false);
});
