import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createReviewLabApi, ReviewLabError } from '../server/reviewLabApi.mjs';
import { AccountSyncRepositoryError } from '../server/postgres/postgresAccountSyncRepository.mjs';

function responseRecorder() {
  let resolveEnd;
  const ended = new Promise((resolve) => { resolveEnd = resolve; });
  return {
    statusCode: 0, headers: {}, body: '', ended,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value = '') { this.body = String(value); resolveEnd(); },
  };
}

async function request(middleware, { method = 'GET', url, body, cookie = 'kurohige_review_session=valid-token-value-which-is-long-enough', origin = 'https://map.example' }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, {
    method, url,
    headers: { host: 'map.example', origin, 'sec-fetch-site': origin === 'https://map.example' ? 'same-origin' : 'cross-site', ...(cookie ? { cookie } : {}) },
    socket: { encrypted: true, remoteAddress: '127.0.0.1' },
  });
  const res = responseRecorder();
  await middleware(req, res); await res.ended;
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

function apiFixture({ accountType = 'registered', authenticated = true, syncRepository = true, commitError = null, rateLimit = false } = {}) {
  const calls = [];
  const scoped = {
    async getLatest() { calls.push(['latest']); return { accountId: 'account-a', syncRevision: 2, activeWorldId: 'world-a', profile: { contentHash: 'p' }, world: { contentHash: 'w' }, updatedAt: '2026-10-19T00:00:00.000Z' }; },
    async listConflicts() { calls.push(['conflicts']); return []; },
    async getConflict(id) { calls.push(['conflict', id]); return { id }; },
    async getHistory(revision) { calls.push(['history', revision]); return { accountId: 'account-a', syncRevision: revision }; },
    async commit(bundle) { calls.push(['commit', bundle]); if (commitError) throw commitError; return { status: 'committed', httpStatus: 201, syncRevision: 3 }; },
    async resolveConflict(id, resolution) { calls.push(['resolve', id, resolution]); return { status: 'discarded' }; },
  };
  const sessionStore = {
    async authenticate() { return authenticated ? { actor: { userId: 'account-a', role: 'user' }, session: { id: 'session-a' } } : null; },
    async authStatus() { return { accountType }; },
    async consumeAccountRateLimit() { if (rateLimit) throw new ReviewLabError(429, 'sync_rate_limited', 'Wait.'); },
  };
  const repository = { sessionStore };
  const api = createReviewLabApi({
    repository, productionMode: true, sessionSecret: 'unit-test-secret',
    syncRepository: syncRepository ? { kind: 'postgres-account-sync', forAccount(context) { calls.push(['scope', context.accountId]); return scoped; } } : null,
  });
  return { api, calls };
}

test('authenticated registered account can read status, bundle, conflicts, and history through its trusted session scope', async () => {
  const { api, calls } = apiFixture();
  assert.equal((await request(api.middleware, { url: '/account/sync/status' })).status, 200);
  assert.equal((await request(api.middleware, { url: '/account/sync/bundle' })).body.bundle.syncRevision, 2);
  assert.equal((await request(api.middleware, { url: '/account/sync/conflicts?status=open' })).status, 200);
  assert.equal((await request(api.middleware, { url: '/account/sync/history/2' })).body.history.syncRevision, 2);
  assert.ok(calls.some(([name, value]) => name === 'scope' && value === 'account-a'));
});

test('commit and conflict resolution use same-origin checks and preserve repository status contracts', async () => {
  const { api, calls } = apiFixture();
  const commit = await request(api.middleware, { method: 'POST', url: '/account/sync/commits', body: { operationId: 'op' } });
  assert.equal(commit.status, 201);
  const resolved = await request(api.middleware, { method: 'POST', url: '/account/sync/conflicts/conflict-a/resolve', body: { action: 'discard' } });
  assert.equal(resolved.status, 200);
  assert.ok(calls.some(([name]) => name === 'commit'));
  assert.ok(calls.some(([name]) => name === 'resolve'));
  const crossOrigin = await request(api.middleware, { method: 'POST', url: '/account/sync/commits', body: {}, origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, 'cross_origin_rejected');
});

test('sync rejects missing, anonymous, revoked, rate-limited, and non-PostgreSQL contexts without fake success', async () => {
  assert.equal((await request(apiFixture({ authenticated: false }).api.middleware, { url: '/account/sync/status', cookie: '' })).status, 401);
  assert.equal((await request(apiFixture({ accountType: 'anonymous' }).api.middleware, { url: '/account/sync/status' })).status, 403);
  assert.equal((await request(apiFixture({ syncRepository: false }).api.middleware, { url: '/account/sync/status' })).status, 503);
  const limited = await request(apiFixture({ rateLimit: true }).api.middleware, { method: 'POST', url: '/account/sync/commits', body: {} });
  assert.equal(limited.status, 429);
});

test('sync validation errors map to stable HTTP status without internal details', async () => {
  const invalid = apiFixture({ commitError: new AccountSyncRepositoryError(400, 'content_hash_mismatch', 'Hash does not match.') });
  const invalidResponse = await request(invalid.api.middleware, { method: 'POST', url: '/account/sync/commits', body: {} });
  assert.equal(invalidResponse.status, 422);
  assert.equal(invalidResponse.body.error.code, 'content_hash_mismatch');
  const oversized = apiFixture({ commitError: new AccountSyncRepositoryError(400, 'bundle_too_large', 'Too large.') });
  assert.equal((await request(oversized.api.middleware, { method: 'POST', url: '/account/sync/commits', body: {} })).status, 413);
  const unavailable = apiFixture({ commitError: new AccountSyncRepositoryError(503, 'sync_repository_unavailable', 'Unavailable.') });
  assert.equal((await request(unavailable.api.middleware, { method: 'POST', url: '/account/sync/commits', body: {} })).status, 503);
  const malformed = await request(apiFixture().api.middleware, { method: 'POST', url: '/account/sync/commits', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'invalid_json');
});
