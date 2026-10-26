import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalEmailDelivery, createReviewLabApi, createReviewLabRepository } from '../server/reviewLabApi.mjs';
import { createPostgresPool, createPostgresReviewRepository, loadPostgresReviewDatabase } from '../server/postgres/postgresReviewRepository.mjs';
import { migrateReviewJson, rollbackReviewImport } from '../server/postgres/reviewMigration.mjs';

const connectionString = process.env.TEST_REVIEW_DATABASE_URL;
const resetAllowed = process.env.ALLOW_REVIEW_DB_RESET === 'true';
const databaseName = connectionString ? new URL(connectionString).pathname.slice(1).toLowerCase() : '';
const safeDatabaseName = databaseName.includes('test') || databaseName.includes('isolated');
const pgCtl = process.env.TEST_POSTGRES_PG_CTL;
const pgData = process.env.TEST_POSTGRES_DATA_DIR;
const pgLog = process.env.TEST_POSTGRES_LOG;
const canRun = Boolean(connectionString && resetAllowed && safeDatabaseName && pgCtl && pgData && pgLog);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaSql = await readFile(path.join(root, 'server/postgres/migrations/001_review_platform.sql'), 'utf8');
const downSql = await readFile(path.join(root, 'server/postgres/migrations/001_review_platform.down.sql'), 'utf8');
const authSchemaSql = await readFile(path.join(root, 'server/postgres/migrations/002_account_sessions.sql'), 'utf8');
const authDownSql = await readFile(path.join(root, 'server/postgres/migrations/002_account_sessions.down.sql'), 'utf8');
const emailSchemaSql = await readFile(path.join(root, 'server/postgres/migrations/003_email_identity.sql'), 'utf8');
const emailDownSql = await readFile(path.join(root, 'server/postgres/migrations/003_email_identity.down.sql'), 'utf8');
const passkeySchemaSql = await readFile(path.join(root, 'server/postgres/migrations/004_passkeys.sql'), 'utf8');
const passkeyDownSql = await readFile(path.join(root, 'server/postgres/migrations/004_passkeys.down.sql'), 'utf8');

const admin = { userId: 'pg-test-admin', role: 'admin' };
const actorA = { userId: 'pg-test-a', role: 'user' };
const actorB = { userId: 'pg-test-b', role: 'user' };
const actorC = { userId: 'pg-test-c', role: 'user' };
const subjectId = 'subject-action-read-galactic-railroad';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => Buffer.from(value, 'utf8').toString('base64url');
const legacyCookie = (actor, secret, issuedAt = Date.now()) => {
  const payload = encode(JSON.stringify({ userId: actor.userId, role: actor.role, issuedAt }));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `kurohige_review_session=${payload}.${signature}`;
};
async function callMiddleware(middleware, {
  method = 'GET', url = '/', body, cookie,
  origin = 'http://127.0.0.1:5173', fetchSite = 'same-origin',
} = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method, url,
    headers: { host: '127.0.0.1:5173', origin, 'sec-fetch-site': fetchSite, ...(cookie ? { cookie } : {}) },
    socket: { encrypted: false },
  });
  let resolveEnd; const ended = new Promise((resolve) => { resolveEnd = resolve; });
  const res = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }, end(value = '') { this.body = String(value); resolveEnd(); } };
  await middleware(req, res); await ended;
  const isJson = String(res.headers['content-type']).includes('application/json');
  return { status: res.statusCode, headers: res.headers, body: isJson ? JSON.parse(res.body) : res.body };
}
function responseCookie(response, name) {
  const values = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']];
  return values.filter(Boolean).map((value) => String(value).split(';')[0]).find((value) => value.startsWith(`${name}=`)) ?? '';
}
const deliveryToken = (delivery) => new URL(delivery.magicUrl).hash.slice('#token='.length);
const runPgCtl = (arguments_) => new Promise((resolve, reject) => {
  const child = spawn(pgCtl, arguments_, { stdio: 'ignore', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pg_ctl exited with code ${code}`)));
});

async function grantLanding(repository, actor, nodeId) {
  await repository.verifyNodeSubject(actor.userId, nodeId, subjectId, admin);
  const requiredStepIds = [`${nodeId}-1`, `${nodeId}-2`, `${nodeId}-3`];
  await repository.startLandingJourney(nodeId, actor, { requiredStepIds });
  for (const stepId of requiredStepIds) await repository.completeLandingStep(nodeId, stepId, actor);
  await repository.commitLanding(nodeId, actor, { ownerNodeId: nodeId, ship: { x: 10, y: 10 }, ownerTarget: { x: 10, y: 10 } });
}

test('isolated PostgreSQL repository preserves permissions and atomically claims jobs', { skip: !canRun }, async () => {
  let pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-review-integration-test', connectionTimeoutMs: 1_500 });
  let temporaryDirectory;
  try {
    if ((await pool.query("SELECT to_regclass('public.auth_webauthn_credentials') AS name")).rows[0].name) await pool.query(passkeyDownSql);
    if ((await pool.query("SELECT to_regclass('public.auth_email_identities') AS name")).rows[0].name) await pool.query(emailDownSql);
    if ((await pool.query("SELECT to_regclass('public.auth_migration_settings') AS name")).rows[0].name) await pool.query(authDownSql);
    await pool.query(downSql);
    await pool.query(schemaSql);
    await pool.query(authSchemaSql);
    await pool.query(emailSchemaSql);
    await pool.query(passkeySchemaSql);
    await pool.query(passkeyDownSql);
    assert.equal((await pool.query('SELECT count(*) AS count FROM review_schema_migrations WHERE version=4')).rows[0].count, '0');
    await pool.query(passkeySchemaSql);
    await pool.query(passkeyDownSql);
    await pool.query(emailDownSql);
    assert.equal((await pool.query('SELECT count(*) AS count FROM review_schema_migrations WHERE version=3')).rows[0].count, '0');
    await pool.query(emailSchemaSql);
    await pool.query(emailDownSql);
    await pool.query(authDownSql);
    assert.equal((await pool.query('SELECT count(*) AS count FROM review_schema_migrations WHERE version=2')).rows[0].count, '0');
    await pool.query(authSchemaSql);
    await pool.query(emailSchemaSql);
    await pool.query(passkeySchemaSql);

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'kurohige-pg-migration-'));
    const sourcePath = path.join(temporaryDirectory, 'isolated-reviews.json');
    const sourceRepository = createReviewLabRepository(sourcePath);
    await grantLanding(sourceRepository, actorA, 'migration-approved-node');
    const approved = await sourceRepository.create({ subjectId, sourceNodeId: 'migration-approved-node', body: '移行後も公開状態と本文、所有者が一致することを確認する承認済みの航海日誌本文です。', authorSnapshot: {} }, actorA);
    await sourceRepository.adminReviewAction(approved.id, admin, { action: 'approve', note: 'isolated fixture' });
    await sourceRepository.setHelpful(approved.id, actorB, true);
    await sourceRepository.report(approved.id, actorB, { reason: 'other', details: 'isolated fixture report' });
    await grantLanding(sourceRepository, actorA, 'migration-pending-node');
    const pending = await sourceRepository.create({ subjectId, sourceNodeId: 'migration-pending-node', body: '移行後も審査待ち状態が第三者へ公開されないことを確認する航海日誌本文です。', authorSnapshot: {} }, actorA);
    await grantLanding(sourceRepository, actorA, 'migration-hidden-node');
    const hidden = await sourceRepository.create({ subjectId, sourceNodeId: 'migration-hidden-node', body: '移行後も非公開状態を維持することを確認するための十分に長い航海日誌本文です。', authorSnapshot: {} }, actorA);
    await sourceRepository.adminReviewAction(hidden.id, admin, { action: 'hide', note: 'isolated fixture hidden' });
    await sourceRepository.verifyNodeSubject(actorB.userId, 'migration-reader-node', subjectId, admin);
    const sourceBefore = await readFile(sourcePath);
    const migration = await migrateReviewJson({ sourcePath, pool, apply: true });
    assert.ok(Object.values(migration.verification).every((entry) => entry.expected === entry.actual && entry.digestMatch));
    const client = await pool.connect();
    const migrated = await loadPostgresReviewDatabase(client);
    client.release();
    assert.deepEqual(migrated.reviews.map((review) => [review.id, review.body, review.authorId, review.moderationStatus, review.subjectId]).sort(), [
      [approved.id, '移行後も公開状態と本文、所有者が一致することを確認する承認済みの航海日誌本文です。', actorA.userId, 'approved', subjectId],
      [hidden.id, '移行後も非公開状態を維持することを確認するための十分に長い航海日誌本文です。', actorA.userId, 'rejected', subjectId],
      [pending.id, '移行後も審査待ち状態が第三者へ公開されないことを確認する航海日誌本文です。', actorA.userId, 'pending_moderation', subjectId],
    ].sort());
    assert.equal(migrated.helpfulVotes.length, 1);
    assert.equal(migrated.reports.length, 1);
    assert.equal((await createPostgresReviewRepository(pool).listPublic(subjectId, actorB.userId)).length, 1);
    assert.equal(sha256(await readFile(sourcePath)), sha256(sourceBefore));
    await rollbackReviewImport({ pool, batchId: migration.batchId });
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM voyage_reviews')).rows[0].count), 0);

    await pool.query(passkeyDownSql);
    await pool.query(emailDownSql);
    await pool.query(authDownSql);
    await pool.query(downSql);
    await pool.query(schemaSql);
    await pool.query(authSchemaSql);
    await pool.query(emailSchemaSql);
    await pool.query(passkeySchemaSql);
    const repository = createPostgresReviewRepository(pool);
    await grantLanding(repository, actorA, 'pg-node-a');
    await repository.verifyNodeSubject(actorB.userId, 'pg-node-b', subjectId, admin);
    const first = await repository.create({
      subjectId, sourceNodeId: 'pg-node-a', body: '隔離PostgreSQLで、本人の体験と公開権限が正しく保存されることを確認するための航海日誌です。',
      authorSnapshot: { age: 30, occupation: 'tester', shareAge: false, shareOccupation: false },
    }, actorA);
    assert.deepEqual(await repository.listPublic(subjectId, actorB.userId), []);
    await assert.rejects(repository.create({ subjectId, sourceNodeId: 'pg-node-b', body: '未上陸の第三者から送ることのできない十分に長い本文です。', authorSnapshot: {} }, actorB), /landed/i);
    const claim = await repository.claimModerationJob(new Date(), 'worker-one');
    assert.equal(claim.review.id, first.id);
    await repository.finishModeration(claim.job.id, { decision: 'approved', reason: 'isolated test approval', policyLabels: ['safe'], model: 'fixture' });
    assert.equal((await repository.listPublic(subjectId, actorB.userId)).length, 1);
    const helpfulResults = await Promise.all([
      repository.setHelpful(first.id, actorB, true),
      repository.setHelpful(first.id, actorB, true),
    ]);
    assert.ok(helpfulResults.every((review) => review.helpfulCount === 1));
    const [report1, report2] = await Promise.all([
      repository.report(first.id, actorB, { reason: 'other', details: 'isolated duplicate report check' }),
      repository.report(first.id, actorB, { reason: 'other', details: 'duplicate' }),
    ]);
    assert.equal(report1.id, report2.id);
    await assert.rejects(repository.update(first.id, { body: '第三者編集を拒否するための十分に長い本文です。' }, actorB), /author/i);
    const editResults = await Promise.all([
      repository.update(first.id, { body: '本人の同時編集その一です。再審査へ戻ることを確認するための十分に長い航海日誌本文です。' }, actorA),
      repository.update(first.id, { body: '本人の同時編集その二です。revision競合が起きないことを確認する十分に長い航海日誌本文です。' }, actorA),
    ]);
    assert.deepEqual(editResults.map((review) => review.revision).sort(), [2, 3]);

    await grantLanding(repository, actorB, 'pg-node-b');
    await repository.create({ subjectId, sourceNodeId: 'pg-node-b', body: '二人目のworker claimを検証するための、別ユーザーによる十分に長い航海日誌です。', authorSnapshot: {} }, actorB);
    await grantLanding(repository, actorC, 'pg-node-c');
    const concurrentPosts = await Promise.allSettled([
      repository.create({ subjectId, sourceNodeId: 'pg-node-c', body: '同じNodeへの同時投稿その一です。DB制約とtransactionを検証する十分に長い本文です。', authorSnapshot: {} }, actorC),
      repository.create({ subjectId, sourceNodeId: 'pg-node-c', body: '同じNodeへの同時投稿その二です。重複航海日誌を防ぐための十分に長い本文です。', authorSnapshot: {} }, actorC),
    ]);
    assert.equal(concurrentPosts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentPosts.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(concurrentPosts.find((result) => result.status === 'rejected').reason.code, 'review_already_exists');
    const [jobA, jobB] = await Promise.all([
      repository.claimModerationJob(new Date(), 'worker-a'),
      repository.claimModerationJob(new Date(), 'worker-b'),
    ]);
    assert.ok(jobA && jobB);
    assert.notEqual(jobA.job.id, jobB.job.id);

    const restarted = createPostgresReviewRepository(pool);
    assert.equal((await restarted.listByAuthor(actorA.userId))[0].revision, 3);
    assert.equal((await restarted.nodeReviewContext('pg-node-a', actorA)).eligibility.canPost, true);

    const sessionSecret = 'isolated-postgres-session-secret';
    const api = createReviewLabApi({ repository: restarted, sessionSecret, productionMode: true, moderator: { available: false } });
    const oldAdminCookie = legacyCookie({ userId: actorA.userId, role: 'admin' }, sessionSecret);
    const migratedSession = await callMiddleware(api.middleware, { method: 'POST', url: '/session/migrate', cookie: oldAdminCookie });
    assert.equal(migratedSession.status, 200);
    assert.deepEqual(migratedSession.body.viewer, { userId: actorA.userId, role: 'user' });
    const opaqueCookie = String(migratedSession.headers['set-cookie']).split(';')[0];
    const opaqueToken = opaqueCookie.split('=')[1];
    assert.equal(opaqueToken.includes('.'), false);
    const storedSession = (await pool.query('SELECT token_hash,role,auth_method FROM review_sessions WHERE account_id=$1', [actorA.userId])).rows[0];
    assert.equal(storedSession.token_hash, sha256(opaqueToken));
    assert.notEqual(storedSession.token_hash, opaqueToken);
    assert.equal(storedSession.role, 'user');
    assert.equal(storedSession.auth_method, 'legacy_cookie');
    const ownedAfterMigration = await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: opaqueCookie });
    assert.equal(ownedAfterMigration.status, 200);
    assert.equal(ownedAfterMigration.body.reviews[0].id, first.id);
    assert.equal((await pool.query('SELECT author_account_id FROM voyage_reviews WHERE id=$1', [first.id])).rows[0].author_account_id, actorA.userId);
    const replay = await callMiddleware(api.middleware, { method: 'POST', url: '/session/migrate', cookie: oldAdminCookie });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'legacy_session_already_migrated');

    const concurrentActor = { userId: 'pg-concurrent-legacy', role: 'user' };
    const concurrentCookie = legacyCookie(concurrentActor, sessionSecret);
    const concurrentClaims = await Promise.all([
      callMiddleware(api.middleware, { method: 'POST', url: '/session/migrate', cookie: concurrentCookie }),
      callMiddleware(api.middleware, { method: 'POST', url: '/session/migrate', cookie: concurrentCookie }),
    ]);
    assert.deepEqual(concurrentClaims.map((entry) => entry.status).sort(), [200, 409]);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM auth_legacy_cookie_claims WHERE account_id=$1', [concurrentActor.userId])).rows[0].count), 1);

    const expiredLegacy = await callMiddleware(api.middleware, {
      method: 'POST', url: '/session/migrate',
      cookie: legacyCookie({ userId: 'pg-expired-legacy', role: 'user' }, sessionSecret, Date.now() - (366 * 24 * 60 * 60 * 1000)),
    });
    assert.equal(expiredLegacy.status, 401);
    await pool.query("UPDATE auth_migration_settings SET migration_cutoff=now() - interval '1 second'");
    const afterCutoff = await callMiddleware(api.middleware, { method: 'POST', url: '/session/migrate', cookie: legacyCookie({ userId: 'pg-after-cutoff', role: 'user' }, sessionSecret) });
    assert.equal(afterCutoff.status, 401);
    await pool.query("UPDATE auth_migration_settings SET migration_cutoff=now() + interval '90 days'");

    const expiredOpaque = await restarted.sessionStore.createAnonymous({ accountId: 'pg-expired-opaque', now: new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)) });
    assert.equal(await restarted.sessionStore.authenticate(expiredOpaque.token), null);

    const rotated = await callMiddleware(api.middleware, { method: 'POST', url: '/session/rotate', cookie: opaqueCookie });
    assert.equal(rotated.status, 200);
    const rotatedCookie = String(rotated.headers['set-cookie']).split(';')[0];
    assert.equal((await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: opaqueCookie })).status, 401);
    assert.equal((await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: rotatedCookie })).status, 200);

    const idleExpired = await restarted.sessionStore.createAnonymous({ accountId: 'pg-idle-expired', now: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)) });
    assert.equal(await restarted.sessionStore.authenticate(idleExpired.token), null);
    await assert.rejects(restarted.sessionStore.rotate(idleExpired.token), (error) => error?.code === 'session_invalid');
    const emailDelivery = createLocalEmailDelivery();
    const emailApi = createReviewLabApi({
      repository: restarted, sessionSecret, productionMode: true, moderator: { available: false },
      emailDelivery, authPublicBaseUrl: 'http://127.0.0.1:5173',
    });
    const crossOriginStart = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/email/start', cookie: rotatedCookie,
      origin: 'https://attacker.example', fetchSite: 'cross-site', body: { email: 'owner@example.test' },
    });
    assert.equal(crossOriginStart.status, 403);
    assert.equal(crossOriginStart.body.error.code, 'cross_origin_rejected');
    assert.equal(emailDelivery.deliveries.length, 0);
    const crossOriginPasskey = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/passkeys/authenticate/options', cookie: rotatedCookie,
      origin: 'https://attacker.example', fetchSite: 'cross-site', body: {},
    });
    assert.equal(crossOriginPasskey.status, 403);
    assert.equal(crossOriginPasskey.body.error.code, 'cross_origin_rejected');
    const ownerStart = await callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: rotatedCookie, body: { email: 'Owner@Example.test' } });
    assert.equal(ownerStart.status, 202);
    assert.deepEqual(ownerStart.body, { accepted: true, message: 'If delivery is available, a sign-in link has been sent.' });
    assert.equal(emailDelivery.deliveries.length, 1);
    assert.equal(emailDelivery.deliveries[0].to, 'owner@example.test');
    assert.ok(emailDelivery.deliveries[0].magicUrl.includes('/api/reviews/auth/magic#token='));
    const ownerFlowCookie = responseCookie(ownerStart, 'kurohige_auth_flow');
    const ownerToken = deliveryToken(emailDelivery.deliveries[0]);
    const crossOriginConfirm = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/magic/confirm', cookie: `${rotatedCookie}; ${ownerFlowCookie}`,
      origin: 'https://attacker.example', fetchSite: 'cross-site', body: { token: ownerToken },
    });
    assert.equal(crossOriginConfirm.status, 403);
    assert.equal(crossOriginConfirm.body.error.code, 'cross_origin_rejected');
    const magicGet = await callMiddleware(emailApi.middleware, { method: 'GET', url: '/auth/magic' });
    assert.equal(magicGet.status, 200);
    assert.match(magicGet.body, /ログインを確定/);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM auth_email_identities')).rows[0].count), 0);
    const ownerConfirm = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/magic/confirm', cookie: `${rotatedCookie}; ${ownerFlowCookie}`, body: { token: ownerToken },
    });
    assert.equal(ownerConfirm.status, 200);
    assert.deepEqual(ownerConfirm.body.viewer, { userId: actorA.userId, role: 'user' });
    const verifiedCookie = responseCookie(ownerConfirm, 'kurohige_review_session');
    assert.ok(verifiedCookie);
    assert.equal((await pool.query('SELECT account_type FROM review_accounts WHERE id=$1', [actorA.userId])).rows[0].account_type, 'registered');
    assert.equal((await restarted.sessionStore.getEmailIdentity(actorA.userId)).email, 'owner@example.test');
    assert.equal((await pool.query('SELECT author_account_id FROM voyage_reviews WHERE id=$1', [first.id])).rows[0].author_account_id, actorA.userId);
    assert.equal((await pool.query('SELECT account_id FROM landing_journeys WHERE account_id=$1 AND node_id=$2', [actorA.userId, 'pg-node-a'])).rows[0].account_id, actorA.userId);

    const passkeyUser = await restarted.sessionStore.passkeyRegistrationUser(actorA.userId);
    assert.equal(passkeyUser.accountId, actorA.userId);
    assert.equal(passkeyUser.userName, 'owner@example.test');
    assert.equal((await restarted.sessionStore.passkeyRegistrationUser(actorA.userId)).userId, passkeyUser.userId);
    const registerChallenge = await restarted.sessionStore.startPasskeyChallenge({
      kind: 'registration', challenge: 'isolated-registration-challenge', requestingAccountId: actorA.userId,
      requestingSessionId: ownerConfirm.body.session.id, requestIpHash: sha256('passkey-register-ip'),
      rpID: 'localhost', expectedOrigin: 'http://localhost:5188',
    });
    const consumedRegister = await restarted.sessionStore.consumePasskeyChallenge({
      kind: 'registration', challenge: 'isolated-registration-challenge', browserBinding: registerChallenge.browserBinding,
      requestingAccountId: actorA.userId, requestingSessionId: ownerConfirm.body.session.id,
    });
    assert.equal(consumedRegister.outcome, 'valid');
    await assert.rejects(restarted.sessionStore.consumePasskeyChallenge({
      kind: 'registration', challenge: 'isolated-registration-challenge', browserBinding: registerChallenge.browserBinding,
      requestingAccountId: actorA.userId, requestingSessionId: ownerConfirm.body.session.id,
    }), (error) => error?.code === 'passkey_challenge_already_used');
    const expiredPasskeyTime = new Date(Date.now() - (6 * 60 * 1000));
    const expiredPasskeyChallenge = await restarted.sessionStore.startPasskeyChallenge({
      kind: 'registration', challenge: 'isolated-expired-passkey-challenge', requestingAccountId: actorA.userId,
      requestingSessionId: ownerConfirm.body.session.id, requestIpHash: sha256('passkey-expiry-ip'),
      rpID: 'localhost', expectedOrigin: 'http://localhost:5188', now: expiredPasskeyTime,
    });
    await assert.rejects(restarted.sessionStore.consumePasskeyChallenge({
      kind: 'registration', challenge: 'isolated-expired-passkey-challenge', browserBinding: expiredPasskeyChallenge.browserBinding,
      requestingAccountId: actorA.userId, requestingSessionId: ownerConfirm.body.session.id,
    }), (error) => error?.code === 'passkey_challenge_expired');
    const bindingChallenge = await restarted.sessionStore.startPasskeyChallenge({
      kind: 'registration', challenge: 'isolated-binding-passkey-challenge', requestingAccountId: actorA.userId,
      requestingSessionId: ownerConfirm.body.session.id, requestIpHash: sha256('passkey-binding-ip'),
      rpID: 'localhost', expectedOrigin: 'http://localhost:5188',
    });
    await assert.rejects(restarted.sessionStore.consumePasskeyChallenge({
      kind: 'registration', challenge: 'isolated-binding-passkey-challenge', browserBinding: 'wrong-browser-binding',
      requestingAccountId: actorA.userId, requestingSessionId: ownerConfirm.body.session.id,
    }), (error) => error?.code === 'passkey_challenge_invalid');
    await restarted.sessionStore.consumePasskeyChallenge({
      kind: 'registration', challenge: 'isolated-binding-passkey-challenge', browserBinding: bindingChallenge.browserBinding,
      requestingAccountId: actorA.userId, requestingSessionId: ownerConfirm.body.session.id,
    });
    const storedPasskey = await restarted.sessionStore.savePasskeyCredential({
      accountId: actorA.userId, challengeId: consumedRegister.id, displayName: 'Isolated test passkey',
      credential: { id: 'isolated-credential-id-0001', publicKey: new Uint8Array([1, 2, 3]), counter: 0,
        deviceType: 'multiDevice', backedUp: true, transports: ['internal'] },
    });
    assert.equal(storedPasskey.accountId, actorA.userId);
    assert.equal((await restarted.sessionStore.listPasskeys(actorA.userId)).length, 1);
    const otherDevice = await restarted.sessionStore.createAnonymous({ accountId: 'pg-passkey-device' });
    const authChallenge = await restarted.sessionStore.startPasskeyChallenge({
      kind: 'authentication', challenge: 'isolated-authentication-challenge', requestingAccountId: 'pg-passkey-device',
      requestingSessionId: otherDevice.session.id, requestIpHash: sha256('passkey-auth-ip'),
      rpID: 'localhost', expectedOrigin: 'http://localhost:5188',
    });
    const consumedAuth = await restarted.sessionStore.consumePasskeyChallenge({
      kind: 'authentication', challenge: 'isolated-authentication-challenge', browserBinding: authChallenge.browserBinding,
      requestingAccountId: 'pg-passkey-device', requestingSessionId: otherDevice.session.id,
    });
    const passkeySession = await restarted.sessionStore.finishPasskeyAuthentication({
      credentialId: storedPasskey.id, expectedCounter: 0, newCounter: 0, requestingAccountId: 'pg-passkey-device',
      requestingSessionId: otherDevice.session.id, challengeId: consumedAuth.id,
    });
    assert.equal(passkeySession.actor.userId, actorA.userId);
    assert.equal(passkeySession.session.authMethod, 'passkey');
    assert.equal(await restarted.sessionStore.authenticate(otherDevice.token), null);
    assert.equal((await pool.query('SELECT author_account_id FROM voyage_reviews WHERE id=$1', [first.id])).rows[0].author_account_id, actorA.userId);
    assert.equal(await restarted.sessionStore.revokePasskey(storedPasskey.id, 'pg-passkey-device'), false);
    assert.equal(await restarted.sessionStore.revokePasskey(storedPasskey.id, actorA.userId), true);
    const passkeyRateAccount = `pg-passkey-rate-${Date.now()}`;
    const passkeyRateSession = await restarted.sessionStore.createAnonymous({ accountId: passkeyRateAccount });
    for (let index = 0; index < 10; index += 1) {
      await restarted.sessionStore.startPasskeyChallenge({
        kind: 'authentication', challenge: `isolated-rate-passkey-${index}`, requestingAccountId: passkeyRateAccount,
        requestingSessionId: passkeyRateSession.session.id, requestIpHash: sha256('passkey-rate-ip'),
        rpID: 'localhost', expectedOrigin: 'http://localhost:5188',
      });
    }
    await assert.rejects(restarted.sessionStore.startPasskeyChallenge({
      kind: 'authentication', challenge: 'isolated-rate-passkey-rejected', requestingAccountId: passkeyRateAccount,
      requestingSessionId: passkeyRateSession.session.id, requestIpHash: sha256('passkey-rate-ip'),
      rpID: 'localhost', expectedOrigin: 'http://localhost:5188',
    }), (error) => error?.code === 'auth_rate_limited');
    const reusedMagic = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/magic/confirm', cookie: `${verifiedCookie}; ${ownerFlowCookie}`, body: { token: ownerToken },
    });
    assert.equal(reusedMagic.status, 409);
    assert.equal(reusedMagic.body.error.code, 'magic_link_already_used');

    const deviceAnonymous = await restarted.sessionStore.createAnonymous({ accountId: 'pg-second-device-anonymous' });
    const deviceCookie = `kurohige_review_session=${deviceAnonymous.token}`;
    const deviceStart = await callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: deviceCookie, body: { email: 'owner@example.test' } });
    assert.equal(deviceStart.status, 202);
    assert.deepEqual(deviceStart.body, ownerStart.body);
    const deviceDelivery = emailDelivery.deliveries.at(-1);
    const deviceConfirm = await callMiddleware(emailApi.middleware, {
      method: 'POST', url: '/auth/magic/confirm',
      cookie: `${deviceCookie}; ${responseCookie(deviceStart, 'kurohige_auth_flow')}`,
      body: { token: deliveryToken(deviceDelivery) },
    });
    assert.equal(deviceConfirm.status, 200);
    assert.equal(deviceConfirm.body.viewer.userId, actorA.userId);
    assert.equal(await restarted.sessionStore.authenticate(deviceAnonymous.token), null);
    assert.equal((await pool.query('SELECT account_type FROM review_accounts WHERE id=$1', ['pg-second-device-anonymous'])).rows[0].account_type, 'anonymous');

    const collisionA = await restarted.sessionStore.createAnonymous({ accountId: 'pg-email-collision-a' });
    const collisionB = await restarted.sessionStore.createAnonymous({ accountId: 'pg-email-collision-b' });
    const collisionStartA = await callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: `kurohige_review_session=${collisionA.token}`, body: { email: 'collision@example.test' } });
    const collisionDeliveryA = emailDelivery.deliveries.at(-1);
    const collisionStartB = await callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: `kurohige_review_session=${collisionB.token}`, body: { email: 'collision@example.test' } });
    const collisionDeliveryB = emailDelivery.deliveries.at(-1);
    const collisionResults = await Promise.all([
      callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/magic/confirm', cookie: `kurohige_review_session=${collisionA.token}; ${responseCookie(collisionStartA, 'kurohige_auth_flow')}`, body: { token: deliveryToken(collisionDeliveryA) } }),
      callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/magic/confirm', cookie: `kurohige_review_session=${collisionB.token}; ${responseCookie(collisionStartB, 'kurohige_auth_flow')}`, body: { token: deliveryToken(collisionDeliveryB) } }),
    ]);
    assert.deepEqual(collisionResults.map((entry) => entry.status).sort(), [200, 409]);
    const collisionIdentity = (await pool.query(`SELECT account_id FROM auth_email_identities WHERE email_normalized='collision@example.test'`)).rows[0];
    assert.ok(['pg-email-collision-a', 'pg-email-collision-b'].includes(collisionIdentity.account_id));
    assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM review_accounts WHERE id IN ('pg-email-collision-a','pg-email-collision-b')`)).rows[0].count), 2);

    const expiryStartTime = new Date(Date.now() - (16 * 60 * 1000));
    const expirySession = await restarted.sessionStore.createAnonymous({ accountId: 'pg-email-expiry', now: new Date(expiryStartTime.getTime() - 60_000) });
    const expiredChallenge = await restarted.sessionStore.startEmailChallenge({
      email: 'expired@example.test', requestingAccountId: 'pg-email-expiry', requestingSessionId: expirySession.session.id,
      requestIpHash: sha256('expiry-ip'), now: expiryStartTime,
    });
    await assert.rejects(restarted.sessionStore.confirmEmailChallenge({
      token: expiredChallenge.token, browserBinding: expiredChallenge.browserBinding,
      requestingAccountId: 'pg-email-expiry', requestingSessionId: expirySession.session.id,
    }), (error) => error?.code === 'magic_link_expired');

    const rateSession = await restarted.sessionStore.createAnonymous({ accountId: 'pg-email-rate' });
    const rateCookie = `kurohige_review_session=${rateSession.token}`;
    const rateResults = [];
    for (let index = 0; index < 4; index += 1) rateResults.push(await callMiddleware(emailApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: rateCookie, body: { email: 'rate@example.test' } }));
    assert.deepEqual(rateResults.map((entry) => entry.status), [202, 202, 202, 429]);

    const extra = await restarted.sessionStore.createAnonymous({ accountId: actorA.userId });
    const sessionList = await callMiddleware(api.middleware, { method: 'GET', url: '/sessions', cookie: verifiedCookie });
    assert.ok(sessionList.body.sessions.length >= 3);
    const revokedOne = await callMiddleware(api.middleware, { method: 'DELETE', url: `/sessions/${extra.session.id}`, cookie: verifiedCookie });
    assert.equal(revokedOne.body.revoked, true);
    assert.equal(await restarted.sessionStore.authenticate(extra.token), null);
    const revokedAll = await callMiddleware(api.middleware, { method: 'DELETE', url: '/sessions', cookie: verifiedCookie });
    assert.ok(revokedAll.body.revoked >= 1);
    assert.equal((await callMiddleware(api.middleware, { method: 'GET', url: '/me/reviews', cookie: verifiedCookie })).status, 401);

    const outageSession = await restarted.sessionStore.createAnonymous({ accountId: actorA.userId });
    const outageCookie = `kurohige_review_session=${outageSession.token}`;

    await pool.end();
    pool = null;
    await runPgCtl(['-D', pgData, '-m', 'fast', '-w', 'stop']);
    const unavailablePool = await createPostgresPool(connectionString, { applicationName: 'kurohige-review-outage-test', connectionTimeoutMs: 1_000 });
    await assert.rejects(createPostgresReviewRepository(unavailablePool).listByAuthor(actorA.userId));
    const unavailableApi = createReviewLabApi({
      repository: createPostgresReviewRepository(unavailablePool), sessionSecret, productionMode: true, moderator: { available: false },
      emailDelivery: createLocalEmailDelivery(), authPublicBaseUrl: 'http://127.0.0.1:5173',
      passkey: { rpID: '127.0.0.1', expectedOrigin: 'http://127.0.0.1:5173' },
    });
    const outageResult = await callMiddleware(unavailableApi.middleware, { method: 'GET', url: '/me/reviews', cookie: outageCookie });
    assert.equal(outageResult.status, 503);
    assert.equal(outageResult.body.error.code, 'authentication_store_unavailable');
    const outageEmail = await callMiddleware(unavailableApi.middleware, { method: 'POST', url: '/auth/email/start', cookie: outageCookie, body: { email: 'outage@example.test' } });
    assert.equal(outageEmail.status, 503);
    assert.equal(outageEmail.body.error.code, 'authentication_store_unavailable');
    const outagePasskey = await callMiddleware(unavailableApi.middleware, { method: 'POST', url: '/auth/passkeys/authenticate/options', cookie: outageCookie, body: {} });
    assert.equal(outagePasskey.status, 503);
    assert.equal(outagePasskey.body.error.code, 'authentication_store_unavailable');
    await unavailablePool.end();
    await runPgCtl(['-D', pgData, '-l', pgLog, '-w', 'start']);
    pool = await createPostgresPool(connectionString, { applicationName: 'kurohige-review-restart-test', connectionTimeoutMs: 1_500 });
    const afterRestart = createPostgresReviewRepository(pool);
    assert.equal((await afterRestart.listByAuthor(actorA.userId))[0].revision, 3);
    assert.equal((await afterRestart.nodeReviewContext('pg-node-a', actorA)).eligibility.canPost, true);
  } finally {
    if (pool) await pool.end();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('integration reset is impossible without an explicitly isolated database', () => {
  if (!connectionString) assert.equal(canRun, false);
  if (connectionString && !safeDatabaseName) assert.equal(canRun, false);
  if (connectionString && !resetAllowed) assert.equal(canRun, false);
});

