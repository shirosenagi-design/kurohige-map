import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const NEBIUS_API_PAUSED_CODE = 'API_PAUSED';
export const NEBIUS_API_PAUSED_MESSAGE = 'Nebius API communication is paused. Set NEBIUS_API_ENABLED=true to resume.';
export const NEBIUS_LIVE_GUARD_REQUIRED_CODE = 'NEBIUS_LIVE_GUARD_REQUIRED';

const TOKEN_FACTORY_HOST = 'api.tokenfactory.nebius.com';
const INITIAL_SIX_MODE = 'initial-six';
const INITIAL_SIX_CHAT_POSTS = 8;
const MAX_INITIAL_SIX_BUDGET_USD = 0.5;

export class NebiusLiveGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NebiusLiveGuardError';
    this.code = code;
    this.status = 503;
  }
}

export const isNebiusApiEnabled = (value) => String(value ?? '').trim().toLowerCase() === 'true';

export function assertNebiusApiEnabled(enabled, errorFactory = null) {
  if (isNebiusApiEnabled(enabled)) return;
  if (errorFactory) throw errorFactory();
  const error = new Error(NEBIUS_API_PAUSED_MESSAGE);
  error.status = 503;
  error.code = NEBIUS_API_PAUSED_CODE;
  throw error;
}

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const roundUsd = (value) => Math.round(value * 1_000_000_000) / 1_000_000_000;
const safeReason = (value) => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
const safeTransportCode = (error) => safeReason(error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown');

function classifyNebiusRequest(input, init = {}) {
  const url = new URL(String(input));
  if (url.hostname !== TOKEN_FACTORY_HOST) return { kind: 'other', url };
  const method = String(init.method ?? 'GET').toUpperCase();
  if (url.pathname.endsWith('/chat/completions') && method === 'POST') return { kind: 'chat', url };
  if (url.pathname.endsWith('/models') && method === 'GET') return { kind: 'models', url };
  return { kind: 'unsupported', url };
}

async function responseJsonClone(response) {
  if (!response || typeof response.clone !== 'function') throw new NebiusLiveGuardError('NEBIUS_USAGE_UNAVAILABLE', 'Nebius response cannot be inspected safely.');
  return response.clone().json();
}

export function createNebiusLiveSpendGuard({
  ledgerPath,
  runId,
  mode = INITIAL_SIX_MODE,
  maxChatPosts = INITIAL_SIX_CHAT_POSTS,
  maxEstimatedUsd = 0.35,
  inputUsdPerMillion = 1,
  outputUsdPerMillion = 3,
  clock = () => new Date(),
} = {}) {
  if (!path.isAbsolute(String(ledgerPath ?? ''))) throw new NebiusLiveGuardError('NEBIUS_GUARD_CONFIG_INVALID', 'The live guard ledger path must be absolute.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(String(runId ?? ''))) throw new NebiusLiveGuardError('NEBIUS_GUARD_CONFIG_INVALID', 'A non-secret live run id is required.');
  if (mode !== INITIAL_SIX_MODE || maxChatPosts !== INITIAL_SIX_CHAT_POSTS) throw new NebiusLiveGuardError('NEBIUS_GUARD_CONFIG_INVALID', 'The current live guard permits only one initial-six run with exactly eight Chat Completion slots.');
  if (!finitePositive(maxEstimatedUsd) || Number(maxEstimatedUsd) > MAX_INITIAL_SIX_BUDGET_USD) throw new NebiusLiveGuardError('NEBIUS_GUARD_CONFIG_INVALID', 'The initial-six estimated budget must be positive and no greater than USD 0.50.');
  if (!finitePositive(inputUsdPerMillion) || !finitePositive(outputUsdPerMillion)) throw new NebiusLiveGuardError('NEBIUS_GUARD_CONFIG_INVALID', 'Token prices must be positive.');

  const absoluteLedgerPath = path.resolve(ledgerPath);
  const lockPath = `${absoluteLedgerPath}.lock`;
  const ownerInstanceId = randomUUID();
  let initialized = false;
  const nowIso = () => clock().toISOString();
  const readState = async () => {
    const records = (await readFile(absoluteLedgerPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
    if (records.length === 0) throw new NebiusLiveGuardError('NEBIUS_GUARD_LEDGER_CORRUPT', 'The live guard ledger is empty.');
    return JSON.parse(records.at(-1));
  };
  const writeState = async (state) => appendFile(absoluteLedgerPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8' });
  const withLock = async (operation) => {
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new NebiusLiveGuardError('NEBIUS_CONCURRENT_RUN_BLOCKED', 'Another live budget operation is active or a prior process ended unsafely.');
      throw error;
    }
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  };
  const assertOwnedRunnable = (state) => {
    if (state.runId !== runId || state.ownerInstanceId !== ownerInstanceId) throw new NebiusLiveGuardError('NEBIUS_RUN_REUSE_BLOCKED', 'This live run cannot be resumed or claimed by another process.');
    if (!['armed', 'running'].includes(state.status)) throw new NebiusLiveGuardError('NEBIUS_RUN_STOPPED', `This live run is ${state.status}.`);
    if (state.inFlight) throw new NebiusLiveGuardError('NEBIUS_CONCURRENT_RUN_BLOCKED', 'A concurrent or abandoned Nebius request was detected.');
  };
  const stopState = async (reason, reservationId = null) => withLock(async () => {
    const state = await readState();
    if (state.runId !== runId || state.ownerInstanceId !== ownerInstanceId) return state;
    if (state.status === 'stopped') return state;
    if (reservationId && state.inFlight?.reservationId !== reservationId) return state;
    state.status = 'stopped';
    state.stopReason = safeReason(reason);
    state.stoppedAt = nowIso();
    state.updatedAt = nowIso();
    state.inFlight = null;
    await writeState(state);
    return state;
  });

  const snapshot = async () => {
    const state = await readState();
    const { ownerInstanceId: _owner, ...safe } = state;
    return safe;
  };
  const initialize = async () => {
    await mkdir(path.dirname(absoluteLedgerPath), { recursive: true });
    await withLock(async () => {
      const state = {
        schemaVersion: 1, runId, mode, ownerInstanceId, status: 'armed', createdAt: nowIso(), updatedAt: nowIso(),
        maxChatPosts, maxEstimatedUsd: Number(maxEstimatedUsd), inputUsdPerMillion: Number(inputUsdPerMillion), outputUsdPerMillion: Number(outputUsdPerMillion),
        modelDiscoveryRequests: 0, chatPostsReserved: 0, chatPostsCompleted: 0,
        estimatedInputTokensReserved: 0, estimatedOutputTokensReserved: 0, estimatedUsdReserved: 0,
        actualPromptTokens: 0, actualCompletionTokens: 0, actualUsd: 0, inFlight: null, stopReason: null,
      };
      await writeFile(absoluteLedgerPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx' });
    });
    initialized = true;
    return snapshot();
  };

  const reserveModels = async () => withLock(async () => {
    const state = await readState();
    assertOwnedRunnable(state);
    if (state.modelDiscoveryRequests >= 1) {
      state.status = 'stopped'; state.stopReason = 'model_discovery_limit'; state.stoppedAt = nowIso(); await writeState(state);
      throw new NebiusLiveGuardError('NEBIUS_MODEL_DISCOVERY_LIMIT', 'The live run permits only one model discovery request.');
    }
    const reservationId = randomUUID();
    state.modelDiscoveryRequests += 1;
    state.status = 'running'; state.updatedAt = nowIso();
    state.inFlight = { reservationId, kind: 'models', reservedAt: nowIso() };
    await writeState(state);
    return { reservationId };
  });

  const reserveChat = async (init) => {
    let body;
    try { body = JSON.parse(String(init?.body ?? '')); }
    catch { throw new NebiusLiveGuardError('NEBIUS_REQUEST_UNESTIMABLE', 'The Chat Completion body is not valid JSON.'); }
    if (!Number.isSafeInteger(body?.max_tokens) || body.max_tokens < 1) throw new NebiusLiveGuardError('NEBIUS_REQUEST_UNESTIMABLE', 'A finite max_tokens value is required before a live send.');
    const schemaName = String(body?.response_format?.json_schema?.name ?? '');
    const messagesText = Array.isArray(body?.messages) ? body.messages.map((message) => String(message?.content ?? '')).join('\n') : '';
    const collectionSchema = body?.response_format?.json_schema?.schema?.properties;
    const candidateCount = collectionSchema?.nodes?.maxItems ?? collectionSchema?.recipes?.maxItems;
    const estimatedInputTokens = Buffer.byteLength(String(init.body), 'utf8');
    const estimatedOutputTokens = body.max_tokens;
    const estimatedUsd = roundUsd((estimatedInputTokens * Number(inputUsdPerMillion) + estimatedOutputTokens * Number(outputUsdPerMillion)) / 1_000_000);
    return withLock(async () => {
      const state = await readState();
      assertOwnedRunnable(state);
      const callIndex = state.chatPostsReserved;
      const expectedStage = callIndex < 2 ? 'semantic' : 'visual';
      const actualStage = schemaName.includes('_semantic_batch') ? 'semantic' : schemaName.includes('_visual_batch') ? 'visual' : 'unknown';
      const expectedCandidateCount = expectedStage === 'semantic' ? 3 : 1;
      const retryAttempt = messagesText.includes('Bounded retry:') || messagesText.includes('candidate recovery round');
      if (retryAttempt || actualStage !== expectedStage || candidateCount !== expectedCandidateCount) {
        state.status = 'stopped'; state.stopReason = 'unexpected_retry_or_call_plan'; state.stoppedAt = nowIso(); await writeState(state);
        throw new NebiusLiveGuardError('NEBIUS_CALL_PLAN_VIOLATION', 'An unexpected retry, recovery, split, or call order was blocked before transmission.');
      }
      if (state.chatPostsReserved + 1 > state.maxChatPosts || roundUsd(state.estimatedUsdReserved + estimatedUsd) > state.maxEstimatedUsd) {
        state.status = 'stopped'; state.stopReason = 'preflight_budget_limit'; state.stoppedAt = nowIso(); await writeState(state);
        throw new NebiusLiveGuardError('NEBIUS_BUDGET_LIMIT', 'The next Chat Completion would exceed the configured live-run limit.');
      }
      const reservationId = randomUUID();
      state.chatPostsReserved += 1;
      state.estimatedInputTokensReserved += estimatedInputTokens;
      state.estimatedOutputTokensReserved += estimatedOutputTokens;
      state.estimatedUsdReserved = roundUsd(state.estimatedUsdReserved + estimatedUsd);
      state.status = 'running'; state.updatedAt = nowIso();
      state.inFlight = { reservationId, kind: 'chat', reservedAt: nowIso(), estimatedInputTokens, estimatedOutputTokens, estimatedUsd };
      await writeState(state);
      return { reservationId, estimatedInputTokens, estimatedOutputTokens };
    });
  };

  const finalizeModels = async (reservationId) => withLock(async () => {
    const state = await readState();
    if (state.ownerInstanceId !== ownerInstanceId || state.inFlight?.reservationId !== reservationId) throw new NebiusLiveGuardError('NEBIUS_GUARD_STATE_MISMATCH', 'Model discovery reservation does not match the live ledger.');
    state.inFlight = null; state.updatedAt = nowIso(); await writeState(state);
  });
  const finalizeChat = async (reservation, payload) => {
    const usage = payload?.usage;
    const promptTokens = usage?.prompt_tokens;
    const completionTokens = usage?.completion_tokens;
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
      await stopState('usage_unavailable', reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_USAGE_UNAVAILABLE', 'Nebius usage metadata is required for every successful live response.');
    }
    const finishReason = payload?.choices?.[0]?.finish_reason;
    if (finishReason !== 'stop') {
      await stopState(`finish_reason_${finishReason ?? 'unknown'}`, reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_ABNORMAL_FINISH', 'Nebius did not finish the structured completion normally; this live run is stopped.');
    }
    if (promptTokens > reservation.estimatedInputTokens || completionTokens > reservation.estimatedOutputTokens) {
      await stopState('usage_exceeded_reservation', reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_USAGE_EXCEEDED_RESERVATION', 'Nebius usage exceeded the pre-send reservation.');
    }
    const actualUsd = roundUsd((promptTokens * Number(inputUsdPerMillion) + completionTokens * Number(outputUsdPerMillion)) / 1_000_000);
    await withLock(async () => {
      const state = await readState();
      if (state.ownerInstanceId !== ownerInstanceId || state.inFlight?.reservationId !== reservation.reservationId) throw new NebiusLiveGuardError('NEBIUS_GUARD_STATE_MISMATCH', 'Chat Completion reservation does not match the live ledger.');
      state.chatPostsCompleted += 1;
      state.actualPromptTokens += promptTokens;
      state.actualCompletionTokens += completionTokens;
      state.actualUsd = roundUsd(state.actualUsd + actualUsd);
      state.inFlight = null; state.updatedAt = nowIso();
      await writeState(state);
    });
  };

  const execute = async (input, init, fetchImpl) => {
    if (!initialized) throw new NebiusLiveGuardError('NEBIUS_GUARD_NOT_INITIALIZED', 'The live budget ledger must be initialized explicitly.');
    const classified = classifyNebiusRequest(input, init);
    if (classified.kind === 'unsupported' || classified.kind === 'other') throw new NebiusLiveGuardError('NEBIUS_ENDPOINT_BLOCKED', 'The live guard allows only Token Factory model discovery and Chat Completions.');
    const reservation = classified.kind === 'models' ? await reserveModels() : await reserveChat(init);
    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) {
      await stopState(`transport_error:${safeTransportCode(error)}`, reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_TRANSPORT_FAILURE', 'Nebius transport failed before a response was received.');
    }
    if (!response?.ok) {
      await stopState(`http_${response?.status ?? 'unknown'}`, reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_HTTP_FAILURE', `Nebius returned HTTP ${response?.status ?? 'unknown'}; this live run is stopped.`);
    }
    if (classified.kind === 'models') { await finalizeModels(reservation.reservationId); return response; }
    let payload;
    try { payload = await responseJsonClone(response); }
    catch (error) { await stopState('usage_unavailable', reservation.reservationId); throw error; }
    await finalizeChat(reservation, payload);
    return response;
  };

  const complete = async ({ expectedChatPosts = INITIAL_SIX_CHAT_POSTS } = {}) => withLock(async () => {
    const state = await readState();
    assertOwnedRunnable(state);
    if (state.chatPostsCompleted !== expectedChatPosts || state.chatPostsReserved !== expectedChatPosts) throw new NebiusLiveGuardError('NEBIUS_RUN_INCOMPLETE', 'The initial-six run did not complete the expected Chat Completion count.');
    state.status = 'completed'; state.completedAt = nowIso(); state.updatedAt = nowIso(); await writeState(state);
    const { ownerInstanceId: _owner, ...safe } = state;
    return safe;
  });
  const stop = async (reason = 'caller_stopped') => stopState(reason);
  return { initialize, execute, complete, stop, snapshot, ledgerPath: absoluteLedgerPath, runId, mode };
}

export function createGuardedNebiusFetch({ enabled = false, fetchImpl = fetch, errorFactory = null, spendGuard = null, requireSpendGuard = false } = {}) {
  return async (...args) => {
    assertNebiusApiEnabled(enabled, errorFactory);
    const classified = classifyNebiusRequest(args[0], args[1]);
    if (classified.kind === 'chat' || classified.kind === 'models') {
      if (spendGuard) return spendGuard.execute(args[0], args[1] ?? {}, fetchImpl);
      if (requireSpendGuard) throw new NebiusLiveGuardError(NEBIUS_LIVE_GUARD_REQUIRED_CODE, 'A persistent Nebius live-run budget guard is required before network access.');
    }
    return fetchImpl(...args);
  };
}
