import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAccountSyncBundle } from '../src/accountSyncContract.ts';
import { createReviewLabApi } from '../server/reviewLabApi.mjs';
import { createPostgresAccountSyncRepository } from '../server/postgres/postgresAccountSyncRepository.mjs';
import { createPostgresPool, createPostgresReviewRepository } from '../server/postgres/postgresReviewRepository.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionString = process.env.TEST_SYNC_HTTP_DATABASE_URL ?? '';
const resetAllowed = process.env.ALLOW_SYNC_HTTP_DB_RESET === 'true';
const databaseName = (() => { try { return new URL(connectionString).pathname.slice(1); } catch { return ''; } })();
const canRun = Boolean(connectionString && resetAllowed && /(?:test|isolated)/iu.test(databaseName));
const migrations = await Promise.all(['001_review_platform.sql', '002_account_sessions.sql', '003_email_identity.sql', '004_passkeys.sql', '005_account_world_sync.sql']
  .map((name) => readFile(path.join(root, 'server/postgres/migrations', name), 'utf8')));

const product = (nickname) => ({
  version: 2,
  personState: { interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [], experiences: [], completedSteps: [], bridgeTags: [] },
  userProfile: { nickname, region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-19T00:00:00.000Z' },
  onboardingComplete: true, personContextRevision: 1, observedPersonSignals: [],
});
const world = (worldRevision) => ({
  schemaVersion: 1, worldId: 'world-stage3-http', worldRevision, savedAt: '2026-10-19T00:00:00.000Z', layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
  nodes: [{
    id: 'node-stage3-http', title: '音楽を公開する', shortDescription: '作った曲を公開して反応を確かめる。', category: 'creative', nodeKind: 'activity', relationToGoal: 'adjacent',
    curiosityFit: .8, accessibility: .7, novelty: .6, friction: .3, portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
    visualRecipe: { visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced', accentPalette: 'coral', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  }],
  nodeStates: { 'node-stage3-http': { visible: true, visited: false, kept: false, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] } },
  explorationBands: { 'node-stage3-http': 0 }, generatedBatches: [{ band: 0, nodeIds: ['node-stage3-http'] }],
  stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
});
async function bundle(accountId, baseRevision, operationId, nickname, worldRevision) {
  const profile = product(nickname); const snapshot = world(worldRevision);
  const result = await createAccountSyncBundle({ accountId, syncRevision: baseRevision, operationId,
    deviceId: 'device.phase2d.stage3.http', capturedAt: '2026-10-19T00:01:00.000Z',
    productBefore: profile, productAfter: profile, worldBefore: snapshot, worldAfter: snapshot });
  assert.equal(result.status, 'ready'); return result.value;
}
async function reset(pool) {
  await pool.query('DROP SCHEMA public CASCADE'); await pool.query('CREATE SCHEMA public');
  for (const migration of migrations) await pool.query(migration);
}
async function startApi(api) {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/api/reviews')) { res.statusCode = 404; res.end(); return; }
    req.url = req.url.slice('/api/reviews'.length) || '/';
    void api.middleware(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}/api/reviews` };
}
async function apiRequest(baseUrl, route, { method = 'GET', token, body, origin = null, rawBody = null } = {}) {
  const headers = { Host: new URL(baseUrl).host, Origin: origin ?? new URL(baseUrl).origin, 'Sec-Fetch-Site': 'same-origin' };
  if (token) headers.Cookie = `kurohige_review_session=${token}`;
  if (body !== undefined || rawBody !== null) headers['Content-Type'] = 'application/json';
  if (origin && origin !== new URL(baseUrl).origin) headers['Sec-Fetch-Site'] = 'cross-site';
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('authenticated Sync HTTP API persists atomically and enforces session/account/security boundaries', { skip: !canRun, timeout: 60_000 }, async () => {
  const pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-sync-http-stage3', connectionTimeoutMs: 800, statementTimeoutMs: 10_000 });
  const accountA = 'sync_stage3_registered_a'; const accountB = 'sync_stage3_registered_b'; const anonymous = 'sync_stage3_anonymous';
  let server;
  try {
    await reset(pool);
    await pool.query(`INSERT INTO review_accounts(id,account_type) VALUES($1,'registered'),($2,'registered'),($3,'anonymous')`, [accountA, accountB, anonymous]);
    await pool.query(`INSERT INTO auth_email_identities(id,account_id,email_normalized,verified_at)
      VALUES(gen_random_uuid(),$1,'stage3-a@example.test',now()),
            (gen_random_uuid(),$2,'stage3-b@example.test',now())`, [accountA, accountB]);
    await pool.query(`INSERT INTO experience_subjects(id,kind,name,sharing_scope,identity_version,semantic_tags)
      VALUES('sync-stage3-subject','possibility','Stage 3 isolated','island_specific',1,'[]'::jsonb)`);
    await pool.query(`INSERT INTO landing_journeys(account_id,node_id,subject_id,required_step_ids,completed_step_ids,started_at,updated_at,landed_at,landing_evidence)
      VALUES($1,'node-ledger','sync-stage3-subject','["s1","s2","s3"]'::jsonb,'["s1","s2","s3"]'::jsonb,now(),now(),now(),'{"source":"authoritative"}'::jsonb)`, [accountA]);
    const ledgerBefore = (await pool.query('SELECT row_to_json(j) AS value FROM landing_journeys j WHERE account_id=$1', [accountA])).rows[0].value;

    const reviewRepository = createPostgresReviewRepository(pool);
    const sessionA = await reviewRepository.sessionStore.issueForVerifiedAccount({ accountId: accountA, authMethod: 'email_magic_link' });
    const sessionB = await reviewRepository.sessionStore.issueForVerifiedAccount({ accountId: accountB, authMethod: 'email_magic_link' });
    const anonymousSession = await reviewRepository.sessionStore.createAnonymous({ accountId: anonymous });
    const api = createReviewLabApi({ repository: reviewRepository, syncRepository: createPostgresAccountSyncRepository(pool), productionMode: true, sessionSecret: 'stage3-isolated-secret' });
    const started = await startApi(api); server = started.server; const { baseUrl } = started;

    assert.equal((await apiRequest(baseUrl, '/account/sync/status')).status, 401);
    assert.equal((await apiRequest(baseUrl, '/account/sync/status', { token: anonymousSession.token })).status, 403);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionA.token, body: {}, origin: 'https://evil.example' })).status, 403);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionA.token, rawBody: '{' })).status, 400);

    const firstBundle = await bundle(accountA, 0, '31000000-0000-4000-8000-000000000001', '端末A', 1);
    const first = await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionA.token, body: firstBundle });
    assert.equal(first.status, 201); assert.equal(first.body.result.syncRevision, 1);
    const fetched = await apiRequest(baseUrl, '/account/sync/bundle', { token: sessionA.token });
    assert.equal(fetched.status, 200); assert.equal(fetched.body.bundle.profile.snapshot.userProfile.nickname, '端末A');
    assert.equal(fetched.body.bundle.world.snapshot.worldId, 'world-stage3-http');
    const replay = await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionA.token, body: firstBundle });
    assert.equal(replay.status, 200); assert.equal(replay.body.result.idempotent, true);

    const changed = await bundle(accountA, 0, firstBundle.operationId, '異なるpayload', 2);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionA.token, body: changed })).status, 409);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: sessionB.token, body: firstBundle })).status, 403);
    assert.equal((await apiRequest(baseUrl, '/account/sync/bundle', { token: sessionB.token })).body.bundle.syncRevision, 0);

    const rotated = await reviewRepository.sessionStore.rotate(sessionA.token);
    assert.equal((await apiRequest(baseUrl, '/account/sync/status', { token: sessionA.token })).status, 401);
    assert.equal((await apiRequest(baseUrl, '/account/sync/status', { token: rotated.token })).status, 200);
    const expired = await reviewRepository.sessionStore.issueForVerifiedAccount({ accountId: accountA, authMethod: 'email_magic_link' });
    await pool.query("UPDATE review_sessions SET expires_at=now()-interval '1 minute',idle_expires_at=now()-interval '1 minute' WHERE id=$1", [expired.session.id]);
    assert.equal((await apiRequest(baseUrl, '/account/sync/status', { token: expired.token })).status, 401);

    const raceA = await bundle(accountA, 1, '31000000-0000-4000-8000-000000000002', '競合A', 2);
    const raceB = await bundle(accountA, 1, '31000000-0000-4000-8000-000000000003', '競合B', 3);
    const race = await Promise.all([
      apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: rotated.token, body: raceA }),
      apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: rotated.token, body: raceB }),
    ]);
    assert.deepEqual(race.map((entry) => entry.status).sort(), [201, 409]);
    const conflictResponse = race.find((entry) => entry.status === 409);
    const conflictId = conflictResponse.body.result.conflict.id;
    assert.equal((await apiRequest(baseUrl, '/account/sync/conflicts?status=open', { token: rotated.token })).body.conflicts.length, 1);
    assert.equal((await apiRequest(baseUrl, '/account/sync/conflicts/' + conflictId, { token: sessionB.token })).status, 404);
    assert.equal((await apiRequest(baseUrl, '/account/sync/history/1', { token: rotated.token })).body.history.syncRevision, 1);

    const current = (await apiRequest(baseUrl, '/account/sync/status', { token: rotated.token })).body.sync.syncRevision;
    const resolutionBundle = await bundle(accountA, current, '31000000-0000-4000-8000-000000000004', '競合を統合', 4);
    const resolved = await apiRequest(baseUrl, `/account/sync/conflicts/${conflictId}/resolve`, { method: 'POST', token: rotated.token, body: { action: 'commit', bundle: resolutionBundle, note: 'isolated merge' } });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.result.status, 'resolved');
    const oldReplayAfterBranchChange = await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: rotated.token, body: firstBundle });
    assert.equal(oldReplayAfterBranchChange.status, 200);
    assert.equal(oldReplayAfterBranchChange.body.result.idempotent, true);
    assert.equal(oldReplayAfterBranchChange.body.result.syncRevision, 1);
    assert.equal(oldReplayAfterBranchChange.body.result.state.syncRevision, 1);

    const invalidHash = structuredClone(resolutionBundle); invalidHash.operationId = '31000000-0000-4000-8000-000000000005'; invalidHash.contentHash = '0'.repeat(64);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: rotated.token, body: invalidHash })).status, 422);
    assert.equal((await apiRequest(baseUrl, '/account/sync/commits', { method: 'POST', token: rotated.token, rawBody: JSON.stringify({ padding: 'x'.repeat(19 * 1024 * 1024) }) })).status, 413);
    assert.deepEqual((await pool.query('SELECT row_to_json(j) AS value FROM landing_journeys j WHERE account_id=$1', [accountA])).rows[0].value, ledgerBefore);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});

test('HTTP sync fails closed when PostgreSQL authentication storage is unreachable', { skip: !canRun, timeout: 10_000 }, async () => {
  const offlineUrl = new URL(connectionString); offlineUrl.port = String(Number(offlineUrl.port || '5432') + 17);
  const pool = await createPostgresPool(offlineUrl.href, { applicationName: 'kurohige-sync-http-offline', connectionTimeoutMs: 250, statementTimeoutMs: 500 });
  const repository = createPostgresReviewRepository(pool);
  const api = createReviewLabApi({ repository, syncRepository: createPostgresAccountSyncRepository(pool), productionMode: true, sessionSecret: 'stage3-isolated-secret' });
  const { server, baseUrl } = await startApi(api);
  try {
    const result = await apiRequest(baseUrl, '/account/sync/status', { token: 'offline-token-value-that-is-long-enough' });
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'authentication_store_unavailable');
  } finally { await new Promise((resolve) => server.close(resolve)); await pool.end(); }
});

test('Stage 3 integration requires an explicitly isolated reset target', () => {
  if (connectionString && !/(?:test|isolated)/iu.test(databaseName)) assert.equal(canRun, false);
  if (connectionString && !resetAllowed) assert.equal(canRun, false);
});
