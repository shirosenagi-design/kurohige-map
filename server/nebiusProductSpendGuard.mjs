import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNebiusApiEnabled, NebiusLiveGuardError } from './nebiusTransportGuard.mjs';

const TOKEN_FACTORY_HOST = 'api.tokenfactory.nebius.com';
const CONFIG_ENV_NAME = 'NEBIUS_PRODUCT_GUARD_CONFIG_PATH';
const SCOPE_BY_OPERATION = Object.freeze({
  possibility_map_semantic_batch: 'world',
  possibility_map_visual_batch: 'world',
  world_expansion_semantic_batch: 'world',
  world_expansion_visual_batch: 'world',
  local_small_steps: 'world',
  node_detail: 'world',
  visual_recipe: 'world',
  semantic_visual_intent: 'world',
  review_moderation: 'review',
  experience_identity: 'review',
  experience_resolution: 'review',
});

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const roundUsd = (value) => Math.round(value * 1_000_000_000) / 1_000_000_000;
const safeReason = (value) => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);

function configError(message) {
  return new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_CONFIG_INVALID', message);
}

function classifyRequest(input, init = {}) {
  let url;
  try { url = new URL(String(input)); }
  catch { return { kind: 'unsupported' }; }
  if (url.hostname !== TOKEN_FACTORY_HOST) return { kind: 'unsupported' };
  const method = String(init.method ?? 'GET').toUpperCase();
  if (url.pathname.endsWith('/chat/completions') && method === 'POST') return { kind: 'chat' };
  if (url.pathname.endsWith('/models') && method === 'GET') return { kind: 'models' };
  return { kind: 'unsupported' };
}

function parseIso(value, field) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw configError(`${field} must be an ISO date-time.`);
  return parsed;
}

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw configError('The Product guard configuration must be an object.');
  if (raw.schemaVersion !== 1) throw configError('The Product guard configuration schemaVersion must be 1.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(String(raw.runId ?? ''))) throw configError('A non-secret approved runId is required.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(String(raw.approvalId ?? ''))) throw configError('A non-secret approvalId is required.');
  if (!path.isAbsolute(String(raw.ledgerPath ?? ''))) throw configError('ledgerPath must be absolute.');
  const validFromMs = parseIso(raw.validFrom, 'validFrom');
  const validUntilMs = parseIso(raw.validUntil, 'validUntil');
  if (validUntilMs <= validFromMs) throw configError('validUntil must be later than validFrom.');
  if (!positiveInteger(raw.maxTotalChatPosts)) throw configError('maxTotalChatPosts must be a positive integer.');
  if (!nonNegativeInteger(raw.maxModelDiscoveryRequests)) throw configError('maxModelDiscoveryRequests must be a non-negative integer.');
  if (!finitePositive(raw.maxTotalEstimatedUsd)) throw configError('maxTotalEstimatedUsd must be positive.');
  if (!finitePositive(raw.inputUsdPerMillion) || !finitePositive(raw.outputUsdPerMillion)) throw configError('Explicit positive token prices are required.');
  const scopes = {};
  for (const scopeName of ['world', 'review']) {
    const scope = raw.scopes?.[scopeName];
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw configError(`The ${scopeName} scope configuration is required.`);
    if (!nonNegativeInteger(scope.maxChatPosts)) throw configError(`${scopeName}.maxChatPosts must be a non-negative integer.`);
    if (!Number.isFinite(Number(scope.maxEstimatedUsd)) || Number(scope.maxEstimatedUsd) < 0) throw configError(`${scopeName}.maxEstimatedUsd must be non-negative.`);
    if (scope.maxChatPosts > raw.maxTotalChatPosts || Number(scope.maxEstimatedUsd) > Number(raw.maxTotalEstimatedUsd)) throw configError(`${scopeName} limits cannot exceed the aggregate Product limits.`);
    if (!Array.isArray(scope.allowedOperations)) throw configError(`${scopeName}.allowedOperations must be an array.`);
    if (scope.allowedOperations.length === 0 && (scope.maxChatPosts !== 0 || Number(scope.maxEstimatedUsd) !== 0)) throw configError(`${scopeName} disabled scope must have zero limits.`);
    if (scope.allowedOperations.length > 0 && (scope.maxChatPosts === 0 || Number(scope.maxEstimatedUsd) === 0)) throw configError(`${scopeName} enabled scope requires positive limits.`);
    const allowedOperations = [...new Set(scope.allowedOperations.map((value) => String(value ?? '')))].sort();
    if (allowedOperations.length !== scope.allowedOperations.length) throw configError(`${scopeName}.allowedOperations must not contain duplicates.`);
    for (const operation of allowedOperations) {
      if (SCOPE_BY_OPERATION[operation] !== scopeName) throw configError(`${operation || '(empty)'} is not a recognized ${scopeName} operation.`);
    }
    scopes[scopeName] = Object.freeze({
      maxChatPosts: scope.maxChatPosts,
      maxEstimatedUsd: Number(scope.maxEstimatedUsd),
      allowedOperations: Object.freeze(allowedOperations),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: raw.runId,
    approvalId: raw.approvalId,
    ledgerPath: path.resolve(raw.ledgerPath),
    validFrom: new Date(validFromMs).toISOString(),
    validUntil: new Date(validUntilMs).toISOString(),
    validFromMs,
    validUntilMs,
    maxTotalChatPosts: raw.maxTotalChatPosts,
    maxModelDiscoveryRequests: raw.maxModelDiscoveryRequests,
    maxTotalEstimatedUsd: Number(raw.maxTotalEstimatedUsd),
    inputUsdPerMillion: Number(raw.inputUsdPerMillion),
    outputUsdPerMillion: Number(raw.outputUsdPerMillion),
    scopes: Object.freeze(scopes),
  });
}

async function inspectResponse(response) {
  if (!response || typeof response.clone !== 'function') throw new NebiusLiveGuardError('NEBIUS_USAGE_UNAVAILABLE', 'Nebius response cannot be inspected safely.');
  return response.clone().json();
}

export function createNebiusProductSpendGuard(rawConfig, { clock = () => new Date() } = {}) {
  const config = validateConfig(rawConfig);
  const lockPath = `${config.ledgerPath}.lock`;
  const ownerInstanceId = randomUUID();
  let initialized = false;
  const nowIso = () => clock().toISOString();
  const nowMs = () => clock().getTime();

  const readState = async () => {
    let text;
    try { text = await readFile(config.ledgerPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_NOT_INITIALIZED', 'The Product guard ledger does not exist.');
      throw error;
    }
    const records = text.split(/\r?\n/u).filter(Boolean);
    if (records.length === 0) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_LEDGER_CORRUPT', 'The Product guard ledger is empty.');
    try { return JSON.parse(records.at(-1)); }
    catch { throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_LEDGER_CORRUPT', 'The Product guard ledger is unreadable.'); }
  };
  const appendState = (state) => appendFile(config.ledgerPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8' });
  const withLock = async (operation) => {
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_CONCURRENT_RUN_BLOCKED', 'Another Product budget operation is active or a prior operation ended unsafely.');
      throw error;
    }
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  };
  const publicState = (state) => {
    const { ownerInstanceId: _owner, ...safe } = state;
    return safe;
  };
  const assertRunnable = (state) => {
    if (state.runId !== config.runId || state.approvalId !== config.approvalId || state.ownerInstanceId !== ownerInstanceId) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_RUN_REUSE_BLOCKED', 'A Product budget approval cannot be resumed or claimed by another process.');
    if (!['armed', 'running'].includes(state.status)) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_RUN_STOPPED', `The Product budget approval is ${state.status}.`);
    const current = nowMs();
    if (current < config.validFromMs || current >= config.validUntilMs) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_APPROVAL_INACTIVE', 'The Product budget approval is outside its approved validity period.');
    if (state.inFlight) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_CONCURRENT_RUN_BLOCKED', 'A concurrent or abandoned Nebius request was detected.');
  };
  const stopState = async (reason, reservationId = null) => withLock(async () => {
    const state = await readState();
    if (state.runId !== config.runId || state.ownerInstanceId !== ownerInstanceId) return publicState(state);
    if (reservationId && state.inFlight?.reservationId !== reservationId) return publicState(state);
    state.status = 'stopped';
    state.stopReason = safeReason(reason);
    state.stoppedAt = nowIso();
    state.updatedAt = nowIso();
    state.inFlight = null;
    await appendState(state);
    return publicState(state);
  });

  const initialize = async () => {
    await mkdir(path.dirname(config.ledgerPath), { recursive: true });
    const current = nowMs();
    if (current < config.validFromMs || current >= config.validUntilMs) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_APPROVAL_INACTIVE', 'The Product budget approval is outside its approved validity period.');
    await withLock(async () => {
      const scopeState = () => ({ status: 'armed', stopReason: null, chatPostsReserved: 0, chatPostsCompleted: 0, estimatedUsdReserved: 0, actualUsd: 0 });
      const state = {
        schemaVersion: 1,
        mode: 'product',
        runId: config.runId,
        approvalId: config.approvalId,
        ownerInstanceId,
        status: 'armed',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        validFrom: config.validFrom,
        validUntil: config.validUntil,
        limits: {
          maxTotalChatPosts: config.maxTotalChatPosts,
          maxModelDiscoveryRequests: config.maxModelDiscoveryRequests,
          maxTotalEstimatedUsd: config.maxTotalEstimatedUsd,
          scopes: {
            world: { maxChatPosts: config.scopes.world.maxChatPosts, maxEstimatedUsd: config.scopes.world.maxEstimatedUsd, allowedOperations: config.scopes.world.allowedOperations },
            review: { maxChatPosts: config.scopes.review.maxChatPosts, maxEstimatedUsd: config.scopes.review.maxEstimatedUsd, allowedOperations: config.scopes.review.allowedOperations },
          },
        },
        modelDiscoveryRequests: 0,
        chatPostsReserved: 0,
        chatPostsCompleted: 0,
        estimatedInputTokensReserved: 0,
        estimatedOutputTokensReserved: 0,
        estimatedUsdReserved: 0,
        actualPromptTokens: 0,
        actualCompletionTokens: 0,
        actualUsd: 0,
        chatElapsedMs: 0,
        modelDiscoveryElapsedMs: 0,
        operations: {},
        scopes: { world: scopeState(), review: scopeState() },
        inFlight: null,
        stopReason: null,
      };
      try { await writeFile(config.ledgerPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if (error?.code === 'EEXIST') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_RUN_REUSE_BLOCKED', 'The Product budget ledger already exists; restart or reuse is blocked until a new explicit approval is configured.');
        throw error;
      }
    });
    initialized = true;
    return snapshot();
  };

  const snapshot = async () => publicState(await readState());

  const reserveModels = async () => withLock(async () => {
    const state = await readState();
    assertRunnable(state);
    if (state.modelDiscoveryRequests + 1 > config.maxModelDiscoveryRequests) {
      state.status = 'stopped'; state.stopReason = 'model_discovery_limit'; state.stoppedAt = nowIso(); state.updatedAt = nowIso(); await appendState(state);
      throw new NebiusLiveGuardError('NEBIUS_PRODUCT_MODEL_DISCOVERY_LIMIT', 'The next model discovery request would exceed the approved Product limit.');
    }
    const reservationId = randomUUID();
    state.modelDiscoveryRequests += 1;
    state.status = 'running'; state.updatedAt = nowIso();
    state.inFlight = { reservationId, kind: 'models', operation: 'model_discovery', reservedAt: nowIso() };
    await appendState(state);
    return { reservationId };
  });

  const reserveChat = async (operation, init) => {
    const scopeName = SCOPE_BY_OPERATION[operation];
    if (!scopeName || !config.scopes[scopeName].allowedOperations.includes(operation)) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_BLOCKED', 'This server operation is not included in the approved Product budget scope.');
    let body;
    try { body = JSON.parse(String(init?.body ?? '')); }
    catch { throw new NebiusLiveGuardError('NEBIUS_REQUEST_UNESTIMABLE', 'The Chat Completion body is not valid JSON.'); }
    if (!Number.isSafeInteger(body?.max_tokens) || body.max_tokens < 1) throw new NebiusLiveGuardError('NEBIUS_REQUEST_UNESTIMABLE', 'A finite max_tokens value is required before transmission.');
    const responseType = body?.response_format?.type;
    const schemaName = String(body?.response_format?.json_schema?.name ?? '');
    if (responseType === 'json_schema' && schemaName !== operation) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_MISMATCH', 'The server operation does not match the structured-output schema.');
    if (responseType === 'json_object' && operation !== 'visual_recipe') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_MISMATCH', 'JSON-object fallback is approved only for the Visual Recipe operation.');
    if (!['json_schema', 'json_object'].includes(responseType)) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_MISMATCH', 'An approved structured-output response format is required.');
    const estimatedInputTokens = Buffer.byteLength(String(init.body), 'utf8');
    const estimatedOutputTokens = body.max_tokens;
    const estimatedUsd = roundUsd((estimatedInputTokens * config.inputUsdPerMillion + estimatedOutputTokens * config.outputUsdPerMillion) / 1_000_000);
    return withLock(async () => {
      const state = await readState();
      assertRunnable(state);
      const scope = state.scopes[scopeName];
      if (scope.status === 'stopped') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_SCOPE_STOPPED', `The ${scopeName} Product budget scope is stopped.`);
      const aggregateExceeded = state.chatPostsReserved + 1 > config.maxTotalChatPosts
        || roundUsd(state.estimatedUsdReserved + estimatedUsd) > config.maxTotalEstimatedUsd;
      if (aggregateExceeded) {
        state.status = 'stopped'; state.stopReason = 'preflight_budget_limit'; state.stoppedAt = nowIso(); state.updatedAt = nowIso(); await appendState(state);
        throw new NebiusLiveGuardError('NEBIUS_PRODUCT_BUDGET_LIMIT', 'The next Chat Completion would exceed the aggregate approved Product limit.');
      }
      const scopeExceeded = scope.chatPostsReserved + 1 > config.scopes[scopeName].maxChatPosts
        || roundUsd(scope.estimatedUsdReserved + estimatedUsd) > config.scopes[scopeName].maxEstimatedUsd;
      if (scopeExceeded) {
        scope.status = 'stopped'; scope.stopReason = 'preflight_budget_limit'; scope.stoppedAt = nowIso(); state.updatedAt = nowIso(); await appendState(state);
        throw new NebiusLiveGuardError('NEBIUS_PRODUCT_SCOPE_BUDGET_LIMIT', `The next Chat Completion would exceed the approved ${scopeName} scope limit.`);
      }
      const reservationId = randomUUID();
      state.chatPostsReserved += 1;
      state.estimatedInputTokensReserved += estimatedInputTokens;
      state.estimatedOutputTokensReserved += estimatedOutputTokens;
      state.estimatedUsdReserved = roundUsd(state.estimatedUsdReserved + estimatedUsd);
      scope.chatPostsReserved += 1;
      scope.estimatedUsdReserved = roundUsd(scope.estimatedUsdReserved + estimatedUsd);
      scope.status = 'running';
      state.status = 'running'; state.updatedAt = nowIso();
      state.inFlight = { reservationId, kind: 'chat', scope: scopeName, operation, reservedAt: nowIso(), estimatedInputTokens, estimatedOutputTokens, estimatedUsd };
      await appendState(state);
      return { reservationId, scopeName, operation, estimatedInputTokens, estimatedOutputTokens };
    });
  };

  const finalizeModels = async (reservationId, elapsedMs) => withLock(async () => {
    const state = await readState();
    if (state.ownerInstanceId !== ownerInstanceId || state.inFlight?.reservationId !== reservationId) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_STATE_MISMATCH', 'Model discovery reservation does not match the Product ledger.');
    state.modelDiscoveryElapsedMs += elapsedMs;
    state.inFlight = null; state.updatedAt = nowIso(); await appendState(state);
  });

  const finalizeChat = async (reservation, payload, elapsedMs) => {
    const promptTokens = payload?.usage?.prompt_tokens;
    const completionTokens = payload?.usage?.completion_tokens;
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
      await stopState('usage_unavailable', reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_USAGE_UNAVAILABLE', 'Nebius usage metadata is required for every successful Product response.');
    }
    const finishReason = payload?.choices?.[0]?.finish_reason;
    // `length` is the one recoverable finish used by Living Flow's bounded
    // Stage G retry. Account for the billed response, then let the existing
    // parser decide whether the single same-model retry is needed. Every
    // other abnormal finish still stops the approved Product run.
    if (finishReason !== 'stop' && finishReason !== 'length') {
      await stopState(`finish_reason_${finishReason ?? 'unknown'}`, reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_ABNORMAL_FINISH', 'Nebius did not finish normally; the Product budget approval is stopped.');
    }
    if (promptTokens > reservation.estimatedInputTokens || completionTokens > reservation.estimatedOutputTokens) {
      await stopState('usage_exceeded_reservation', reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_USAGE_EXCEEDED_RESERVATION', 'Nebius usage exceeded the pre-send reservation.');
    }
    const actualUsd = roundUsd((promptTokens * config.inputUsdPerMillion + completionTokens * config.outputUsdPerMillion) / 1_000_000);
    await withLock(async () => {
      const state = await readState();
      if (state.ownerInstanceId !== ownerInstanceId || state.inFlight?.reservationId !== reservation.reservationId) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_STATE_MISMATCH', 'Chat Completion reservation does not match the Product ledger.');
      state.chatPostsCompleted += 1;
      state.actualPromptTokens += promptTokens;
      state.actualCompletionTokens += completionTokens;
      state.actualUsd = roundUsd(state.actualUsd + actualUsd);
      state.chatElapsedMs += elapsedMs;
      const operation = state.operations[reservation.operation] ?? { posts: 0, promptTokens: 0, completionTokens: 0, actualUsd: 0, elapsedMs: 0 };
      operation.posts += 1;
      operation.promptTokens += promptTokens;
      operation.completionTokens += completionTokens;
      operation.actualUsd = roundUsd(operation.actualUsd + actualUsd);
      operation.elapsedMs += elapsedMs;
      state.operations[reservation.operation] = operation;
      const scope = state.scopes[reservation.scopeName];
      scope.chatPostsCompleted += 1;
      scope.actualUsd = roundUsd(scope.actualUsd + actualUsd);
      state.inFlight = null; state.updatedAt = nowIso();
      await appendState(state);
    });
  };

  const executeOperation = async (operation, input, init, fetchImpl) => {
    if (!initialized) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_GUARD_NOT_INITIALIZED', 'The Product budget ledger must be initialized explicitly.');
    const classified = classifyRequest(input, init);
    if (classified.kind === 'unsupported') throw new NebiusLiveGuardError('NEBIUS_ENDPOINT_BLOCKED', 'The Product guard allows only Token Factory model discovery and Chat Completions.');
    if (classified.kind === 'models' && operation !== 'model_discovery') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_MISMATCH', 'Model discovery must use the server-owned model_discovery operation.');
    if (classified.kind === 'chat' && operation === 'model_discovery') throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_MISMATCH', 'Chat Completions require a server-owned Product operation.');
    const reservation = classified.kind === 'models' ? await reserveModels() : await reserveChat(operation, init);
    const startedAt = performance.now();
    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) { await stopState('transport_error', reservation.reservationId); throw error; }
    if (!response?.ok) {
      await stopState(`http_${response?.status ?? 'unknown'}`, reservation.reservationId);
      throw new NebiusLiveGuardError('NEBIUS_HTTP_FAILURE', `Nebius returned HTTP ${response?.status ?? 'unknown'}; the Product budget approval is stopped.`);
    }
    if (classified.kind === 'models') { await finalizeModels(reservation.reservationId, Math.round(performance.now() - startedAt)); return response; }
    let payload;
    try { payload = await inspectResponse(response); }
    catch (error) { await stopState('usage_unavailable', reservation.reservationId); throw error; }
    await finalizeChat(reservation, payload, Math.round(performance.now() - startedAt));
    return response;
  };

  const adapters = new Map();
  const forOperation = (operation) => {
    if (operation !== 'model_discovery' && !SCOPE_BY_OPERATION[operation]) throw new NebiusLiveGuardError('NEBIUS_PRODUCT_OPERATION_BLOCKED', 'Unknown server-owned Product operation.');
    if (!adapters.has(operation)) adapters.set(operation, Object.freeze({ execute: (input, init, fetchImpl) => executeOperation(operation, input, init, fetchImpl) }));
    return adapters.get(operation);
  };
  const allowsOperation = (operation) => Boolean(SCOPE_BY_OPERATION[operation]
    && config.scopes[SCOPE_BY_OPERATION[operation]].allowedOperations.includes(operation));
  const stop = (reason = 'caller_stopped') => stopState(reason);
  return Object.freeze({ initialize, snapshot, stop, forOperation, allowsOperation, ledgerPath: config.ledgerPath, runId: config.runId, mode: 'product' });
}

export async function createNebiusProductSpendGuardFromEnv(env = process.env, options = {}) {
  if (!isNebiusApiEnabled(env.NEBIUS_API_ENABLED)) return null;
  if (!env.NEBIUS_API_KEY) throw configError('NEBIUS_API_KEY is required when Product Nebius access is enabled.');
  const configPath = String(env[CONFIG_ENV_NAME] ?? '');
  if (!path.isAbsolute(configPath)) throw configError(`${CONFIG_ENV_NAME} must name an absolute approved configuration file.`);
  let raw;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw configError(`The approved Product guard configuration could not be read: ${error?.code ?? 'invalid_json'}.`); }
  const guard = createNebiusProductSpendGuard(raw, options);
  await guard.initialize();
  return guard;
}

export const NEBIUS_PRODUCT_OPERATION_SCOPES = SCOPE_BY_OPERATION;
export const NEBIUS_PRODUCT_GUARD_CONFIG_ENV = CONFIG_ENV_NAME;
