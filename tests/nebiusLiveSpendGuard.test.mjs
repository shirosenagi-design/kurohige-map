import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createGuardedNebiusFetch,
  createNebiusLiveSpendGuard,
  NEBIUS_LIVE_GUARD_REQUIRED_CODE,
} from '../server/nebiusTransportGuard.mjs';

const CHAT_URL = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
const MODELS_URL = 'https://api.tokenfactory.nebius.com/v1/models';
const chatInit = (maxTokens = 32, { stage = 'semantic', count = 3, retry = false } = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'mock-nemotron',
    messages: [{ role: 'user', content: retry ? 'Bounded retry: test' : 'test' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: `possibility_map_${stage}_batch`,
        strict: true,
        schema: { properties: { [stage === 'semantic' ? 'nodes' : 'recipes']: { maxItems: count } } },
      },
    },
    max_tokens: maxTokens,
  }),
});
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

async function guardFixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kurohige-nebius-guard-'));
  const guard = createNebiusLiveSpendGuard({
    ledgerPath: path.join(root, 'ledger.json'),
    runId: `test-run-${path.basename(root)}`,
    mode: 'initial-six',
    maxChatPosts: 8,
    maxEstimatedUsd: 0.35,
    ...options,
  });
  await guard.initialize();
  return guard;
}

test('the separate initial-six runner can explicitly require its persistent spend guard', async () => {
  let sends = 0;
  const guarded = createGuardedNebiusFetch({
    enabled: true,
    requireSpendGuard: true,
    fetchImpl: async () => { sends += 1; return response({}); },
  });
  await assert.rejects(guarded(CHAT_URL, chatInit()), (error) => error.code === NEBIUS_LIVE_GUARD_REQUIRED_CODE);
  assert.equal(sends, 0);
});

test('initial-six guard permits one model lookup and eight bounded Chat Completion sends', async () => {
  const spendGuard = await guardFixture();
  let sends = 0;
  const guarded = createGuardedNebiusFetch({
    enabled: true,
    requireSpendGuard: true,
    spendGuard,
    fetchImpl: async (url) => {
      sends += 1;
      return String(url).endsWith('/models')
        ? response({ data: [{ id: 'nvidia/Nemotron-3-Ultra-550b-a55b' }] })
        : response({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
    },
  });
  await guarded(MODELS_URL);
  for (let index = 0; index < 8; index += 1) {
    const options = index < 2 ? { stage: 'semantic', count: 3 } : { stage: 'visual', count: 1 };
    await guarded(CHAT_URL, chatInit(32, options));
  }
  await assert.rejects(guarded(CHAT_URL, chatInit(32, { stage: 'visual', count: 1 })), (error) => error.code === 'NEBIUS_BUDGET_LIMIT');
  const ledger = await spendGuard.snapshot();
  assert.equal(sends, 9);
  assert.equal(ledger.modelDiscoveryRequests, 1);
  assert.equal(ledger.chatPostsCompleted, 8);
  assert.equal(ledger.status, 'stopped');
  assert.equal(ledger.stopReason, 'preflight_budget_limit');
});

test('pre-send estimated token cost blocks before mock transport', async () => {
  const spendGuard = await guardFixture({ maxEstimatedUsd: 0.000001 });
  let sends = 0;
  const guarded = createGuardedNebiusFetch({ enabled: true, requireSpendGuard: true, spendGuard, fetchImpl: async () => { sends += 1; return response({}); } });
  await assert.rejects(guarded(CHAT_URL, chatInit(4096)), (error) => error.code === 'NEBIUS_BUDGET_LIMIT');
  assert.equal(sends, 0);
  assert.equal((await spendGuard.snapshot()).status, 'stopped');
});

test('missing usage and HTTP failures permanently stop the run', async () => {
  const missingUsage = await guardFixture();
  let missingUsageSends = 0;
  const missingUsageFetch = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard: missingUsage,
    fetchImpl: async () => { missingUsageSends += 1; return response({ choices: [{ finish_reason: 'stop' }] }); },
  });
  await assert.rejects(missingUsageFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_USAGE_UNAVAILABLE');
  await assert.rejects(missingUsageFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_RUN_STOPPED');
  assert.equal(missingUsageSends, 1);

  const httpFailure = await guardFixture();
  let httpSends = 0;
  const httpFetch = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard: httpFailure,
    fetchImpl: async () => { httpSends += 1; return response({ error: { message: 'mock' } }, 429); },
  });
  await assert.rejects(httpFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_HTTP_FAILURE');
  await assert.rejects(httpFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_RUN_STOPPED');
  assert.equal(httpSends, 1);
});

test('transport failures retain a safe cause code and the first stop reason', async () => {
  const spendGuard = await guardFixture();
  let sends = 0;
  const guarded = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard,
    fetchImpl: async () => {
      sends += 1;
      const error = new TypeError('fetch failed with a sensitive diagnostic');
      error.cause = { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' };
      throw error;
    },
  });
  await assert.rejects(guarded(MODELS_URL), (error) => error.code === 'NEBIUS_TRANSPORT_FAILURE');
  assert.equal(sends, 1);
  assert.equal((await spendGuard.snapshot()).stopReason, 'transport_error:UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  await spendGuard.stop('initial_six_runner_failed');
  const stopped = await spendGuard.snapshot();
  assert.equal(stopped.stopReason, 'transport_error:UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  assert.equal(JSON.stringify(stopped).includes('sensitive diagnostic'), false);
});

test('concurrent sends and process-style ledger reuse are rejected without a second send', async () => {
  const spendGuard = await guardFixture();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const guarded = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard,
    fetchImpl: async () => { sends += 1; await pending; return response({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }); },
  });
  const first = guarded(CHAT_URL, chatInit());
  while (sends === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(guarded(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_CONCURRENT_RUN_BLOCKED');
  assert.equal(sends, 1);
  release();
  await first;

  const secondProcess = createNebiusLiveSpendGuard({
    ledgerPath: spendGuard.ledgerPath,
    runId: spendGuard.runId,
    mode: 'initial-six', maxChatPosts: 8, maxEstimatedUsd: 0.35,
  });
  await assert.rejects(secondProcess.initialize(), (error) => error.code === 'EEXIST');
});

test('successful usage is persisted and explicit completion prevents automatic restart', async () => {
  const spendGuard = await guardFixture();
  const guarded = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard,
    fetchImpl: async () => response({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }),
  });
  for (let index = 0; index < 8; index += 1) {
    const options = index < 2 ? { stage: 'semantic', count: 3 } : { stage: 'visual', count: 1 };
    await guarded(CHAT_URL, chatInit(32, options));
  }
  const completed = await spendGuard.complete();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.chatPostsCompleted, 8);
  assert.equal(completed.actualPromptTokens, 64);
  assert.equal(completed.actualCompletionTokens, 32);
  await assert.rejects(guarded(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_RUN_STOPPED');
});

test('abnormal finish and structured retry are stopped before another external send', async () => {
  const abnormal = await guardFixture();
  let abnormalSends = 0;
  const abnormalFetch = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard: abnormal,
    fetchImpl: async () => {
      abnormalSends += 1;
      return response({ choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 8, completion_tokens: 32, total_tokens: 40 } });
    },
  });
  await assert.rejects(abnormalFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_ABNORMAL_FINISH');
  await assert.rejects(abnormalFetch(CHAT_URL, chatInit()), (error) => error.code === 'NEBIUS_RUN_STOPPED');
  assert.equal(abnormalSends, 1);

  const retry = await guardFixture();
  let retrySends = 0;
  const retryFetch = createGuardedNebiusFetch({
    enabled: true, requireSpendGuard: true, spendGuard: retry,
    fetchImpl: async () => { retrySends += 1; return response({}); },
  });
  await assert.rejects(retryFetch(CHAT_URL, chatInit(32, { retry: true })), (error) => error.code === 'NEBIUS_CALL_PLAN_VIOLATION');
  assert.equal(retrySends, 0);
  assert.equal((await retry.snapshot()).stopReason, 'unexpected_retry_or_call_plan');
});
