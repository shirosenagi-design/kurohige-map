import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createGuardedNebiusFetch } from '../server/nebiusTransportGuard.mjs';
import { createLiveAiAccessGate, isChargeableAiRoute } from '../server/liveAiAccessGate.mjs';
import { createPublicSampleApiGuard } from '../server/publicSampleGuard.mjs';
import {
  createNebiusProductSpendGuard,
  createNebiusProductSpendGuardFromEnv,
  NEBIUS_PRODUCT_OPERATION_SCOPES,
} from '../server/nebiusProductSpendGuard.mjs';

const CHAT_URL = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
const MODELS_URL = 'https://api.tokenfactory.nebius.com/v1/models';
const WORLD_OPERATIONS = Object.keys(NEBIUS_PRODUCT_OPERATION_SCOPES).filter((operation) => NEBIUS_PRODUCT_OPERATION_SCOPES[operation] === 'world');
const REVIEW_OPERATIONS = Object.keys(NEBIUS_PRODUCT_OPERATION_SCOPES).filter((operation) => NEBIUS_PRODUCT_OPERATION_SCOPES[operation] === 'review');
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const successPayload = (promptTokens = 8, completionTokens = 4) => ({
  choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
});
const chatInit = (operation, maxTokens = 64, responseType = 'json_schema') => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'mock-nemotron',
    messages: [{ role: 'user', content: 'test' }],
    response_format: responseType === 'json_object'
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: operation, strict: true, schema: { type: 'object' } } },
    max_tokens: maxTokens,
  }),
});

async function productFixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kurohige-product-guard-'));
  const now = Date.now();
  const config = {
    schemaVersion: 1,
    runId: `product-${path.basename(root)}`,
    approvalId: `approval-${path.basename(root)}`,
    ledgerPath: path.join(root, 'product-ledger.jsonl'),
    validFrom: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 3_600_000).toISOString(),
    maxTotalChatPosts: 8,
    maxModelDiscoveryRequests: 4,
    maxTotalEstimatedUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    scopes: {
      world: { maxChatPosts: 5, maxEstimatedUsd: 0.7, allowedOperations: WORLD_OPERATIONS },
      review: { maxChatPosts: 3, maxEstimatedUsd: 0.3, allowedOperations: REVIEW_OPERATIONS },
    },
    ...overrides,
  };
  if (overrides.scopes) config.scopes = overrides.scopes;
  const guard = createNebiusProductSpendGuard(config);
  await guard.initialize();
  return { root, config, guard };
}

function guardedFor(guard, operation, fetchImpl) {
  return createGuardedNebiusFetch({
    enabled: true,
    requireSpendGuard: true,
    spendGuard: guard.forOperation(operation),
    fetchImpl,
  });
}

test('disabled Product API ignores guard configuration and performs no external work', async () => {
  const guard = await createNebiusProductSpendGuardFromEnv({
    NEBIUS_API_ENABLED: 'false',
    NEBIUS_PRODUCT_GUARD_CONFIG_PATH: 'not-an-absolute-path',
  });
  assert.equal(guard, null);
});

test('enabled Product API fails closed when approval configuration is missing', async () => {
  await assert.rejects(
    createNebiusProductSpendGuardFromEnv({ NEBIUS_API_ENABLED: 'true', NEBIUS_API_KEY: 'mock-key' }),
    (error) => error.code === 'NEBIUS_PRODUCT_GUARD_CONFIG_INVALID',
  );
});

test('world and review sends reserve and account against separate scopes and one aggregate ledger', async () => {
  const { guard } = await productFixture();
  let sends = 0;
  const mockFetch = async (url) => {
    sends += 1;
    return String(url).endsWith('/models')
      ? response({ data: [{ id: 'nvidia/Nemotron-3-Ultra-550b-a55b' }] })
      : response(successPayload());
  };
  await guardedFor(guard, 'model_discovery', mockFetch)(MODELS_URL);
  await guardedFor(guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail'));
  await guardedFor(guard, 'review_moderation', mockFetch)(CHAT_URL, chatInit('review_moderation'));
  const state = await guard.snapshot();
  assert.equal(sends, 3);
  assert.equal(state.modelDiscoveryRequests, 1);
  assert.equal(state.chatPostsCompleted, 2);
  assert.equal(state.scopes.world.chatPostsCompleted, 1);
  assert.equal(state.scopes.review.chatPostsCompleted, 1);
  assert.equal(state.actualPromptTokens, 16);
  assert.equal(state.actualCompletionTokens, 8);
  assert.equal(state.operations.node_detail.posts, 1);
  assert.equal(state.operations.review_moderation.posts, 1);
  assert.ok(state.chatElapsedMs >= 0);
  assert.ok(state.modelDiscoveryElapsedMs >= 0);
});

test('filming and reviewer sessions keep independent budgets and stopped states', async () => {
  const filming = await productFixture();
  const reviewer = await productFixture();
  assert.notEqual(filming.config.ledgerPath, reviewer.config.ledgerPath);
  assert.notEqual(filming.config.runId, reviewer.config.runId);
  const mockFetch = async () => response(successPayload());
  await guardedFor(filming.guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail'));
  await filming.guard.stop('session_complete');
  await guardedFor(reviewer.guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail'));
  assert.equal((await filming.guard.snapshot()).status, 'stopped');
  assert.equal((await filming.guard.snapshot()).chatPostsCompleted, 1);
  assert.equal((await reviewer.guard.snapshot()).chatPostsCompleted, 1);
});

test('world-only approval blocks background review AI before transport', async () => {
  const { guard } = await productFixture({ scopes: {
    world: { maxChatPosts: 5, maxEstimatedUsd: 1, allowedOperations: WORLD_OPERATIONS },
    review: { maxChatPosts: 0, maxEstimatedUsd: 0, allowedOperations: [] },
  } });
  assert.equal(guard.allowsOperation('review_moderation'), false);
  let sends = 0;
  await assert.rejects(
    guardedFor(guard, 'review_moderation', async () => { sends += 1; return response(successPayload()); })(CHAT_URL, chatInit('review_moderation')),
    (error) => error.code === 'NEBIUS_PRODUCT_OPERATION_BLOCKED',
  );
  assert.equal(sends, 0);
});

function invokeAccessGate(gate, { method = 'POST', url = '/api/world-expand', authorization = '', host = '127.0.0.1', remoteAddress = '127.0.0.1', protocol = '', proxySecret = '' } = {}) {
  return new Promise((resolve) => {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(body) { resolve({ status: this.statusCode, body, next: false }); },
    };
    gate({ method, url, headers: { host, authorization, ...(protocol ? { 'x-forwarded-proto': protocol } : {}), ...(proxySecret ? { 'x-kurohige-proxy-secret': proxySecret } : {}) }, socket: { remoteAddress } }, response,
      () => resolve({ status: 200, next: true }));
  });
}

test('public sample stays anonymous while every browser AI route requires server credentials', async () => {
  const username = 'filming-access';
  const password = 'a-long-test-password-never-shipped';
  const gate = createLiveAiAccessGate({ enabled: true, username, password });
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  assert.equal((await invokeAccessGate(gate, { method: 'GET', url: '/?sample=1' })).next, true);
  assert.equal((await invokeAccessGate(gate, { method: 'GET', url: '/api/live-ai-access' })).status, 401);
  assert.equal((await invokeAccessGate(gate, { method: 'GET', url: '/api/live-ai-access', authorization: basic })).status, 200);
  assert.equal((await invokeAccessGate(gate, { method: 'POST', url: '/api/possibility-map?sample=1' })).status, 401);
  for (const url of ['/api/possibility-map', '/api/world-expand', '/api/node-steps', '/api/node-detail', '/api/visual-recipe', '/api/reviews/nodes/n1/subject', '/api/reviews/nodes/n1/journey', '/api/reviews/reviews']) {
    assert.equal(isChargeableAiRoute('POST', url), true, url);
    assert.equal((await invokeAccessGate(gate, { url, authorization: basic })).next, true, url);
  }
  for (const url of ['/api/reviews/admin/moderation/process', '/api/review-lab/admin/moderation/process', '/api/review-lab/nodes/n1/subject', '/api/review-lab/nodes/n1/journey', '/api/review-lab/reviews']) {
    assert.equal(isChargeableAiRoute('POST', url), true, url);
    assert.equal((await invokeAccessGate(gate, { url, authorization: basic })).next, true, url);
  }
  assert.equal((await invokeAccessGate(gate, { url: '/api/review-lab/admin/moderation/process' })).status, 401);
  assert.equal(isChargeableAiRoute('PUT', '/api/review-lab/reviews/r1'), true);
  assert.equal((await invokeAccessGate(gate, { method: 'PUT', url: '/api/reviews/reviews/r1', authorization: basic })).next, true);
  assert.equal((await invokeAccessGate(gate, { authorization: basic, host: 'live.example', remoteAddress: '203.0.113.3' })).status, 403);
  assert.equal((await invokeAccessGate(gate, { authorization: basic, host: 'live.example', protocol: 'https' })).status, 403);
  const trustedProxySecret = 'a-private-reverse-proxy-secret-with-at-least-32-chars';
  const productionGate = createLiveAiAccessGate({ enabled: true, username, password, productionMode: true, trustedProxySecret });
  assert.equal((await invokeAccessGate(productionGate, { authorization: basic })).status, 403);
  assert.equal((await invokeAccessGate(productionGate, { authorization: basic, host: 'live.example', protocol: 'https' })).status, 403);
  assert.equal((await invokeAccessGate(productionGate, { authorization: basic, host: 'live.example', protocol: 'https', proxySecret: 'wrong-secret' })).status, 403);
  assert.equal((await invokeAccessGate(productionGate, { authorization: basic, host: 'live.example', protocol: 'http', proxySecret: trustedProxySecret })).status, 403);
  assert.equal((await invokeAccessGate(productionGate, { authorization: basic, host: 'live.example', protocol: 'https', proxySecret: trustedProxySecret })).next, true);
  const sampleServer = createPublicSampleApiGuard({ sampleOnly: true });
  assert.equal((await invokeAccessGate(sampleServer, { method: 'GET', url: '/?sample=1' })).next, true);
  assert.equal((await invokeAccessGate(sampleServer, { method: 'POST', url: '/api/world-expand' })).status, 503);
});

test('Connect-mounted AI handlers cannot bypass Basic auth with path variants', async () => {
  const freshGate = () => createLiveAiAccessGate({ enabled: true, username: 'filming-access', password: 'a-long-test-password-never-shipped' });
  for (const url of [
    '/api/world-expand/', '/api/world-expand/extra', '/api/world-expand.json', '/API/WORLD-EXPAND',
    '/api/possibility-map/', '/api/node-steps/', '/api/node-detail/', '/api/visual-recipe/',
    '/api/reviews/nodes/n1/subject/', '/api/reviews//nodes/n1/journey/',
    '/api/reviews/reviews/', '/api/reviews/admin/moderation/process/',
    '/api/review-lab/nodes/n1/subject/',
  ]) {
    assert.equal(isChargeableAiRoute('POST', url), true, url);
    assert.equal((await invokeAccessGate(freshGate(), { url })).status, 401, url);
  }
  assert.equal(isChargeableAiRoute('PUT', '/api/reviews/reviews/r1/'), true);
  assert.equal((await invokeAccessGate(freshGate(), { method: 'PUT', url: '/api/reviews/reviews/r1/' })).status, 401);
  assert.equal(isChargeableAiRoute('POST', '/api/reviews/reviews/r1/helpful'), false);
});

test('production HTTP rejects forged forwarding headers before Basic or mock transport', async () => {
  const username = 'filming-access';
  const password = 'a-long-test-password-never-shipped';
  const trustedProxySecret = 'isolated-proxy-secret-longer-than-thirty-two-characters';
  const gate = createLiveAiAccessGate({ enabled: true, username, password, productionMode: true, trustedProxySecret });
  let accepted = 0;
  const server = createServer((req, res) => gate(req, res, () => { accepted += 1; res.end('mock accepted'); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/world-expand`;
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const post = (headers) => fetch(url, { method: 'POST', headers });
  try {
    assert.equal((await post({ Authorization: authorization, 'X-Forwarded-Proto': 'https' })).status, 403);
    assert.equal((await post({ Authorization: authorization, 'X-Forwarded-Proto': 'https', 'X-Kurohige-Proxy-Secret': 'forged' })).status, 403);
    assert.equal((await post({ Authorization: authorization, 'X-Forwarded-Proto': 'http', 'X-Kurohige-Proxy-Secret': trustedProxySecret })).status, 403);
    assert.equal((await post({ 'X-Forwarded-Proto': 'https', 'X-Kurohige-Proxy-Secret': trustedProxySecret })).status, 401);
    assert.equal((await post({ Authorization: authorization, 'X-Forwarded-Proto': 'https', 'X-Kurohige-Proxy-Secret': trustedProxySecret })).status, 200);
    assert.equal(accepted, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('isolated filming and reviewer HTTP sessions keep sample public and enforce separate mock budgets', async () => {
  const filming = await productFixture({ maxTotalChatPosts: 1, scopes: {
    world: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: WORLD_OPERATIONS },
    review: { maxChatPosts: 0, maxEstimatedUsd: 0, allowedOperations: [] },
  } });
  const reviewer = await productFixture({ maxTotalChatPosts: 1, scopes: {
    world: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: WORLD_OPERATIONS },
    review: { maxChatPosts: 0, maxEstimatedUsd: 0, allowedOperations: [] },
  } });
  const openSession = async (fixture, username) => {
    const password = `isolated-${username}-password-long-enough`;
    const gate = createLiveAiAccessGate({ enabled: true, username, password });
    let externalMockCalls = 0;
    const server = createServer((req, res) => gate(req, res, async () => {
      if (req.method === 'GET' && req.url === '/?sample=1') { res.end('public sample'); return; }
      try {
        await guardedFor(fixture.guard, 'world_expansion_semantic_batch', async () => {
          externalMockCalls += 1;
          return response(successPayload());
        })(CHAT_URL, chatInit('world_expansion_semantic_batch'));
        res.end('mock generation accepted');
      } catch (error) {
        res.statusCode = 503;
        res.end(error.code);
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      calls: () => externalMockCalls,
    };
  };
  const film = await openSession(filming, 'filming-access');
  const judge = await openSession(reviewer, 'reviewer-access');
  const post = (session, authorization) => fetch(`${session.base}/api/world-expand`, {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  });
  try {
    assert.equal((await fetch(`${film.base}/?sample=1`)).status, 200);
    assert.equal((await fetch(`${judge.base}/?sample=1`)).status, 200);
    assert.equal((await post(film)).status, 401);
    assert.equal((await post(judge, film.authorization)).status, 401);
    assert.equal((await post(film, film.authorization)).status, 200);
    assert.equal((await post(judge, judge.authorization)).status, 200);
    assert.equal((await post(film, film.authorization)).status, 503);
    assert.equal(film.calls(), 1);
    assert.equal(judge.calls(), 1);
    assert.equal((await filming.guard.snapshot()).status, 'stopped');
    assert.equal((await reviewer.guard.snapshot()).chatPostsCompleted, 1);
  } finally {
    await Promise.all([film, judge].map((session) => new Promise((resolve) => session.server.close(resolve))));
  }
});

test('retry and recovery posts use the same operation and each consume a persistent reservation', async () => {
  const { guard } = await productFixture();
  let sends = 0;
  const mockFetch = async () => { sends += 1; return response(successPayload()); };
  const guarded = guardedFor(guard, 'world_expansion_semantic_batch', mockFetch);
  await guarded(CHAT_URL, chatInit('world_expansion_semantic_batch'));
  await guarded(CHAT_URL, chatInit('world_expansion_semantic_batch'));
  const state = await guard.snapshot();
  assert.equal(sends, 2);
  assert.equal(state.scopes.world.chatPostsReserved, 2);
  assert.equal(state.scopes.world.chatPostsCompleted, 2);
});

test('a billed length finish reaches bounded recovery while other abnormal finishes stop', async () => {
  const recoverable = await productFixture();
  let recoverableSends = 0;
  const lengthThenStop = async () => {
    recoverableSends += 1;
    return response(recoverableSends === 1 ? {
      choices: [{ finish_reason: 'length', message: { content: '{"nodes":[' } }],
      usage: { prompt_tokens: 8, completion_tokens: 64, total_tokens: 72 },
    } : successPayload());
  };
  const guarded = guardedFor(recoverable.guard, 'world_expansion_semantic_batch', lengthThenStop);
  const first = await guarded(CHAT_URL, chatInit('world_expansion_semantic_batch'));
  assert.equal((await first.clone().json()).choices[0].finish_reason, 'length');
  await guarded(CHAT_URL, chatInit('world_expansion_semantic_batch'));
  const recovered = await recoverable.guard.snapshot();
  assert.equal(recoverableSends, 2);
  assert.equal(recovered.chatPostsCompleted, 2);
  assert.equal(recovered.status, 'running');

  const abnormal = await productFixture();
  let abnormalSends = 0;
  await assert.rejects(
    guardedFor(abnormal.guard, 'node_detail', async () => {
      abnormalSends += 1;
      return response({
        choices: [{ finish_reason: 'content_filter', message: { content: '{}' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
    })(CHAT_URL, chatInit('node_detail')),
    (error) => error.code === 'NEBIUS_ABNORMAL_FINISH',
  );
  assert.equal(abnormalSends, 1);
  assert.equal((await abnormal.guard.snapshot()).stopReason, 'finish_reason_content_filter');
});

test('a scope cap blocks before transport without consuming the other scope', async () => {
  const scopes = {
    world: { maxChatPosts: 1, maxEstimatedUsd: 0.7, allowedOperations: WORLD_OPERATIONS },
    review: { maxChatPosts: 2, maxEstimatedUsd: 0.3, allowedOperations: REVIEW_OPERATIONS },
  };
  const { guard } = await productFixture({ maxTotalChatPosts: 3, scopes });
  let sends = 0;
  const mockFetch = async () => { sends += 1; return response(successPayload()); };
  await guardedFor(guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail'));
  await assert.rejects(
    guardedFor(guard, 'local_small_steps', mockFetch)(CHAT_URL, chatInit('local_small_steps')),
    (error) => error.code === 'NEBIUS_PRODUCT_SCOPE_BUDGET_LIMIT',
  );
  await guardedFor(guard, 'review_moderation', mockFetch)(CHAT_URL, chatInit('review_moderation'));
  const state = await guard.snapshot();
  assert.equal(sends, 2);
  assert.equal(state.scopes.world.status, 'stopped');
  assert.equal(state.scopes.review.chatPostsCompleted, 1);
  assert.notEqual(state.status, 'stopped');
});

test('aggregate POST cap stops before transport even when the next scope has capacity', async () => {
  const scopes = {
    world: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: WORLD_OPERATIONS },
    review: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: REVIEW_OPERATIONS },
  };
  const { guard } = await productFixture({ maxTotalChatPosts: 1, maxTotalEstimatedUsd: 1, scopes });
  let sends = 0;
  const mockFetch = async () => { sends += 1; return response(successPayload()); };
  await guardedFor(guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail'));
  await assert.rejects(
    guardedFor(guard, 'review_moderation', mockFetch)(CHAT_URL, chatInit('review_moderation')),
    (error) => error.code === 'NEBIUS_PRODUCT_BUDGET_LIMIT',
  );
  assert.equal(sends, 1);
  assert.equal((await guard.snapshot()).status, 'stopped');
});

test('operation identity is server-owned and schema mismatch is blocked before transport', async () => {
  const { guard } = await productFixture();
  let sends = 0;
  const mockFetch = async () => { sends += 1; return response(successPayload()); };
  await assert.rejects(
    guardedFor(guard, 'review_moderation', mockFetch)(CHAT_URL, chatInit('node_detail')),
    (error) => error.code === 'NEBIUS_PRODUCT_OPERATION_MISMATCH',
  );
  await assert.rejects(
    guardedFor(guard, 'node_detail', mockFetch)(CHAT_URL, chatInit('node_detail', 64, 'json_object')),
    (error) => error.code === 'NEBIUS_PRODUCT_OPERATION_MISMATCH',
  );
  await guardedFor(guard, 'visual_recipe', mockFetch)(CHAT_URL, chatInit('visual_recipe', 64, 'json_object'));
  assert.equal(sends, 1);
});

test('missing usage and HTTP failures stop the approval and prevent later sends', async () => {
  const missing = await productFixture();
  let missingSends = 0;
  const missingFetch = async () => { missingSends += 1; return response({ choices: [{ finish_reason: 'stop' }] }); };
  await assert.rejects(
    guardedFor(missing.guard, 'node_detail', missingFetch)(CHAT_URL, chatInit('node_detail')),
    (error) => error.code === 'NEBIUS_USAGE_UNAVAILABLE',
  );
  await assert.rejects(
    guardedFor(missing.guard, 'review_moderation', missingFetch)(CHAT_URL, chatInit('review_moderation')),
    (error) => error.code === 'NEBIUS_PRODUCT_RUN_STOPPED',
  );
  assert.equal(missingSends, 1);

  const http = await productFixture();
  let httpSends = 0;
  const httpFetch = async () => { httpSends += 1; return response({ error: { message: 'mock' } }, 500); };
  await assert.rejects(
    guardedFor(http.guard, 'node_detail', httpFetch)(CHAT_URL, chatInit('node_detail')),
    (error) => error.code === 'NEBIUS_HTTP_FAILURE',
  );
  assert.equal(httpSends, 1);
  assert.equal((await http.guard.snapshot()).stopReason, 'http_500');
});

test('parallel Product sends are rejected while the reserved request remains the only transport call', async () => {
  const { guard } = await productFixture();
  let release;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const slowFetch = async () => { sends += 1; notifyStarted(); await held; return response(successPayload()); };
  const first = guardedFor(guard, 'node_detail', slowFetch)(CHAT_URL, chatInit('node_detail'));
  await started;
  await assert.rejects(
    guardedFor(guard, 'review_moderation', slowFetch)(CHAT_URL, chatInit('review_moderation')),
    (error) => error.code === 'NEBIUS_PRODUCT_CONCURRENT_RUN_BLOCKED',
  );
  release();
  await first;
  assert.equal(sends, 1);
  assert.equal((await guard.snapshot()).chatPostsCompleted, 1);
});

test('existing Product ledger blocks a second process after restart and preserves prior accounting', async () => {
  const { config, guard } = await productFixture();
  await guardedFor(guard, 'node_detail', async () => response(successPayload()))(CHAT_URL, chatInit('node_detail'));
  const restarted = createNebiusProductSpendGuard(config);
  await assert.rejects(restarted.initialize(), (error) => error.code === 'NEBIUS_PRODUCT_RUN_REUSE_BLOCKED');
  const records = (await readFile(config.ledgerPath, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(records.at(-1).chatPostsCompleted, 1);
});

test('environment loader initializes only an explicit valid absolute approval file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kurohige-product-env-'));
  const now = Date.now();
  const config = {
    schemaVersion: 1,
    runId: `product-${path.basename(root)}`,
    approvalId: `approval-${path.basename(root)}`,
    ledgerPath: path.join(root, 'ledger.jsonl'),
    validFrom: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 60_000).toISOString(),
    maxTotalChatPosts: 2,
    maxModelDiscoveryRequests: 1,
    maxTotalEstimatedUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    scopes: {
      world: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: ['node_detail'] },
      review: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: ['review_moderation'] },
    },
  };
  const configPath = path.join(root, 'approval.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  const guard = await createNebiusProductSpendGuardFromEnv({
    NEBIUS_API_ENABLED: 'true',
    NEBIUS_API_KEY: 'mock-key',
    NEBIUS_PRODUCT_GUARD_CONFIG_PATH: configPath,
  });
  assert.equal((await guard.snapshot()).status, 'armed');
});

test('normal Product server wiring assigns every current AI path to a server-owned guard operation', async () => {
  const [living, visual, review, vite] = await Promise.all([
    readFile(new URL('../server/livingFlowApi.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server/visualRecipeApi.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server/reviewLabApi.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../vite.config.mjs', import.meta.url), 'utf8'),
  ]);
  for (const operation of [
    'possibility_map_semantic_batch', 'possibility_map_visual_batch',
    'world_expansion_semantic_batch', 'world_expansion_visual_batch',
    'local_small_steps', 'node_detail',
  ]) assert.equal(NEBIUS_PRODUCT_OPERATION_SCOPES[operation], 'world');
  assert.match(living, /guardedFetchFor\('model_discovery'\)/u);
  assert.match(living, /guardedFetchFor\(kind\)/u);
  assert.match(visual, /guardedFetchFor\('visual_recipe'\)/u);
  assert.match(visual, /operation: 'semantic_visual_intent'/u);
  assert.match(review, /guardedFetchFor\('review_moderation'\)/u);
  assert.match(review, /guardedFetchFor\('experience_identity'\)/u);
  assert.match(review, /guardedFetchFor\('experience_resolution'\)/u);
  assert.match(vite, /createNebiusProductSpendGuardFromEnv\(serverEnv\)/u);
  assert.match(vite, /createLivingFlowApi\(\{ apiKey, apiEnabled, diagnosticEnabled, spendGuard \}\)/u);
  assert.match(vite, /createVisualRecipeMiddleware\(\{ apiKey, apiEnabled, diagnosticEnabled, spendGuard \}\)/u);
  assert.match(vite, /server\.middlewares\.use\(liveAiAccessGate\)/u);
  assert.match(vite, /configurePreviewServer: install/u);
  assert.match(vite, /spendGuard\.allowsOperation\('review_moderation'\)/u);
});
