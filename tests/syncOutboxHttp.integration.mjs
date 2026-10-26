import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountSyncRuntime } from '../src/accountSyncRuntime.ts';
import { createAccountSyncBundle } from '../src/accountSyncContract.ts';
import { createMemorySyncOutbox } from '../src/syncOutbox.ts';
import { createMemoryWorldRepository } from '../src/worldRepository.ts';
import { createReviewLabApi } from '../server/reviewLabApi.mjs';
import { createPostgresAccountSyncRepository } from '../server/postgres/postgresAccountSyncRepository.mjs';
import { createPostgresPool, createPostgresReviewRepository } from '../server/postgres/postgresReviewRepository.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionString = process.env.TEST_SYNC_OUTBOX_DATABASE_URL ?? '';
const resetAllowed = process.env.ALLOW_SYNC_OUTBOX_DB_RESET === 'true';
const databaseName = (() => { try { return new URL(connectionString).pathname.slice(1); } catch { return ''; } })();
const canRun = Boolean(connectionString && resetAllowed && /(?:test|isolated)/iu.test(databaseName));
const migrations = await Promise.all(['001_review_platform.sql', '002_account_sessions.sql', '003_email_identity.sql', '004_passkeys.sql', '005_account_world_sync.sql']
  .map((name) => readFile(path.join(root, 'server/postgres/migrations', name), 'utf8')));
const accountId = 'sync_stage4_registered_a';
const worldId = 'world-stage4-http';

const product = (nickname = 'Stage4') => ({
  version: 2, personState: { interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname, region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-19T08:00:00.000Z' },
  onboardingComplete: true, personContextRevision: 1, observedPersonSignals: [],
});
const world = (worldRevision = 1) => ({
  schemaVersion: 1, worldId, worldRevision, savedAt: '2026-10-19T08:00:00.000Z', layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{ id: 'node-stage4-http', title: '音楽を公開する', shortDescription: '作った曲を公開する。', category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent', curiosityFit: .8, accessibility: .7, novelty: .6, friction: .2, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [], visualRecipe: { visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced', accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' } }],
  nodeStates: { 'node-stage4-http': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] } },
  explorationBands: { 'node-stage4-http': 0 }, generatedBatches: [{ band: 0, nodeIds: ['node-stage4-http'] }], stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});
const productRepository = () => { let value = product(); return { load: () => structuredClone(value), save: (next) => { value = structuredClone(next); }, clear: () => {} }; };
const uuidSequence = (start = 1) => { let value = start; return () => `41000000-0000-4000-8000-${String(value++).padStart(12, '0')}`; };
async function reset(pool) { await pool.query('DROP SCHEMA public CASCADE'); await pool.query('CREATE SCHEMA public'); for (const migration of migrations) await pool.query(migration); }
async function startApi(api) {
  const server = createServer((req, res) => { if (!req.url?.startsWith('/api/reviews')) { res.statusCode = 404; res.end(); return; } req.url = req.url.slice('/api/reviews'.length) || '/'; void api.middleware(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function competingBundle(baseRevision, operationId) {
  const state = product('competing-device'); const snapshot = world(99);
  const result = await createAccountSyncBundle({ accountId, syncRevision: baseRevision, operationId, deviceId: 'device.stage4.competing', capturedAt: '2026-10-19T08:10:00.000Z', productBefore: state, productAfter: state, worldBefore: snapshot, worldAfter: snapshot });
  assert.equal(result.status, 'ready'); return result.value;
}

test('persistent Outbox uses the real authenticated HTTP/PostgreSQL path, recovers a lost ACK, and preserves conflicts', { skip: !canRun, timeout: 60_000 }, async () => {
  const pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-stage4-outbox-http', connectionTimeoutMs: 800, statementTimeoutMs: 10_000 });
  let server; let runtime;
  try {
    await reset(pool);
    await pool.query("INSERT INTO review_accounts(id,account_type) VALUES($1,'registered')", [accountId]);
    await pool.query("INSERT INTO auth_email_identities(id,account_id,email_normalized,verified_at) VALUES(gen_random_uuid(),$1,'stage4@example.test',now())", [accountId]);
    await pool.query("INSERT INTO experience_subjects(id,kind,name,sharing_scope,identity_version,semantic_tags) VALUES('stage4-subject','possibility','Stage 4','island_specific',1,'[]'::jsonb)");
    await pool.query(`INSERT INTO landing_journeys(account_id,node_id,subject_id,required_step_ids,completed_step_ids,started_at,updated_at,landed_at,landing_evidence)
      VALUES($1,'node-ledger','stage4-subject','["s1","s2","s3"]'::jsonb,'["s1","s2","s3"]'::jsonb,now(),now(),now(),'{"source":"authoritative"}'::jsonb)`, [accountId]);
    const ledgerBefore = (await pool.query('SELECT row_to_json(j) value FROM landing_journeys j WHERE account_id=$1', [accountId])).rows[0].value;
    const reviewRepository = createPostgresReviewRepository(pool);
    const session = await reviewRepository.sessionStore.issueForVerifiedAccount({ accountId, authMethod: 'email_magic_link' });
    const syncRepository = createPostgresAccountSyncRepository(pool);
    const api = createReviewLabApi({ repository: reviewRepository, syncRepository, productionMode: true, sessionSecret: 'stage4-isolated-secret' });
    const started = await startApi(api); server = started.server;
    let loseNextCommitResponse = false;
    const browserFetch = async (input, init = {}) => {
      const target = new URL(String(input), started.origin);
      const headers = new Headers(init.headers); headers.set('Origin', started.origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Cookie', `kurohige_review_session=${session.token}`);
      const response = await fetch(target, { ...init, headers });
      if (loseNextCommitResponse && target.pathname.endsWith('/account/sync/commits')) { loseNextCommitResponse = false; await response.text(); throw new Error('simulated response loss after server commit'); }
      return response;
    };
    const outbox = createMemorySyncOutbox(); const worldRepository = createMemoryWorldRepository(world()); let nowMs = Date.parse('2026-10-19T08:00:00.000Z');
    runtime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository, outbox, fetch: browserFetch, now: () => new Date(nowMs), randomUUID: uuidSequence(), maxBackoffMs: 1_000 });
    await runtime.authorizeCurrentWorld(worldId);
    const first = await runtime.captureNow(); await runtime.process();
    assert.equal((await outbox.get(first.operationId)).state, 'acknowledged');
    assert.equal(Number((await pool.query('SELECT sync_revision FROM account_sync_heads WHERE account_id=$1', [accountId])).rows[0].sync_revision), 1);

    await worldRepository.save(world(2)); loseNextCommitResponse = true;
    const second = await runtime.captureNow();
    for (let i = 0; i < 50 && (await outbox.get(second.operationId)).retryCount === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await outbox.get(second.operationId)).state, 'pending');
    nowMs += 1_001; await runtime.process();
    assert.equal((await outbox.get(second.operationId)).state, 'acknowledged');
    assert.equal((await pool.query('SELECT count(*) count FROM account_sync_operations WHERE operation_id=$1', [second.operationId])).rows[0].count, '1');

    let online = false;
    const conflictRuntime = new AccountSyncRuntime({ productRepository: productRepository(), worldRepository, outbox, fetch: browserFetch, online: () => online, now: () => new Date(nowMs), randomUUID: uuidSequence(100) });
    assert.equal(await conflictRuntime.resumeAuthorizedAccount(accountId), true);
    await worldRepository.save(world(3)); const conflictCandidate = await conflictRuntime.captureNow();
    const external = await competingBundle(2, '41000000-0000-4000-8000-999999999999');
    assert.equal((await syncRepository.forAccount({ accountId, sessionId: session.session.id }).commit(external)).status, 'committed');
    online = true; await conflictRuntime.process();
    assert.equal((await outbox.get(conflictCandidate.operationId)).state, 'conflict');
    assert.equal((await pool.query("SELECT count(*) count FROM account_sync_conflicts WHERE account_id=$1 AND status='open'", [accountId])).rows[0].count, '1');
    assert.deepEqual((await pool.query('SELECT row_to_json(j) value FROM landing_journeys j WHERE account_id=$1', [accountId])).rows[0].value, ledgerBefore);
    conflictRuntime.stop();
  } finally {
    runtime?.stop(); if (server) await new Promise((resolve) => server.close(resolve)); await pool.end();
  }
});

test('Stage 4 integration requires an explicitly isolated reset target', () => {
  if (connectionString && !/(?:test|isolated)/iu.test(databaseName)) assert.equal(canRun, false);
  if (connectionString && !resetAllowed) assert.equal(canRun, false);
});
