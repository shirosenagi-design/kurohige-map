import { randomUUID } from 'node:crypto';
import { conceptIdsForRole, formatSupportedVisualVocabulary } from '../src/visualVocabulary.ts';
import { assertNebiusApiEnabled, createGuardedNebiusFetch, NEBIUS_API_PAUSED_CODE, NEBIUS_API_PAUSED_MESSAGE } from './nebiusTransportGuard.mjs';

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const TARGET_MODEL_PATTERN = /(?:^|\/)nemotron-3-ultra(?:-|_|$)/i;
const MAX_GOAL_LENGTH = 600;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TRUNCATION_RETRIES = 1;
const VISUAL_RECIPE_MAX_TOKENS = 4096;

export const VISUAL_RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'visualTheme', 'dominantMotif', 'secondaryObjects', 'terrainProfile', 'accentPalette',
    'density', 'openness', 'landmarkEmphasis', 'energyLevel',
  ],
  properties: {
    visualTheme: { type: 'string', minLength: 1, maxLength: 80 },
    dominantMotif: { type: 'string', minLength: 1, maxLength: 80 },
    secondaryObjects: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
    terrainProfile: { type: 'string', minLength: 1, maxLength: 80 },
    accentPalette: { type: 'string', minLength: 1, maxLength: 80 },
    density: { type: 'string', enum: ['sparse', 'medium', 'dense'] },
    openness: { type: 'string', enum: ['open', 'balanced', 'compact'] },
    landmarkEmphasis: { type: 'string', enum: ['low', 'medium', 'high'] },
    energyLevel: { type: 'string', enum: ['calm', 'moderate', 'high'] },
  },
};

export const VOCABULARY_CONTRACT_VISUAL_RECIPE_SCHEMA = {
  ...VISUAL_RECIPE_SCHEMA,
  properties: {
    ...VISUAL_RECIPE_SCHEMA.properties,
    visualTheme: { type: 'string', enum: conceptIdsForRole('theme') },
    dominantMotif: { type: 'string', enum: conceptIdsForRole('dominantMotif') },
    secondaryObjects: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', enum: conceptIdsForRole('secondaryObject') },
    },
    terrainProfile: { type: 'string', enum: conceptIdsForRole('terrain') },
    accentPalette: { type: 'string', enum: conceptIdsForRole('palette') },
  },
};

const SYSTEM_PROMPT = `You write Visual Recipes for KUROHIGE MAP possibility islands.
Draw no image. Return only the requested Visual Recipe structure.
Translate the meaning of the user's possibility into a visual island vocabulary.
Prefer reusable visual concepts for terrain, landmarks, structures, vegetation, and props.
Do not choose a world position. Do not create a future route. Do not use a Node ID as visual identity.
Unknown concepts are allowed because the renderer safely normalizes unsupported parts.
Use short snake_case strings for all open vocabulary fields and secondaryObjects.
Prefer this reusable renderer vocabulary when it can express the goal:
- visualTheme: athletics, food_craft, field_science, creative, research, cultivation, culture
- dominantMotif: running_track, bakery_workshop, insect_observation, observatory, camera, windmill, generic
- terrainProfile: open, flat, village, organic, lush, rocky, raised, generic
- accentPalette: warm_red_white, warm_cream_terracotta, green_amber, ocean_teal
- secondaryObjects: sign, table, crate, light, dock, path, observation_box, hurdle, timing_board, plants, cultivation_patch, utility
Choose unknown strings only when the supported vocabulary cannot convey an important part of the goal.`;

const VOCABULARY_CONTRACT_PROMPT = `You write a single strict Visual Recipe for a KUROHIGE MAP possibility island.
Draw no image. Return only the requested Visual Recipe structure. Do not choose a world position or use a Node ID.
Use only values in the supported renderer vocabulary below.
Choose the dominantMotif that most clearly preserves the requested activity, place, tool, or social role.
Choose secondaryObjects that add distinct supporting evidence without repeating the dominant motif.
Use generic only when no more specific supported concept fits.
Keep semantic distinctions visible: outdoor shelter and fire concepts for camping; stage, sound, lighting, and audience concepts for performance; vehicles, routes, stops, boards, and packages for transport; markers, maps, meeting points, and passenger shelter for guided activity; observation equipment and field markers for observation.
Supported renderer vocabulary, generated from the role-aware registry:
${formatSupportedVisualVocabulary()}`;

const SEMANTIC_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['themeConcept', 'dominantVisualIdea', 'supportingVisualConcepts', 'terrainCharacter', 'moodEnergy', 'importantSemanticDistinctions'],
  properties: {
    themeConcept: { type: 'string', minLength: 1, maxLength: 120 },
    dominantVisualIdea: { type: 'string', minLength: 1, maxLength: 160 },
    supportingVisualConcepts: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 100 } },
    terrainCharacter: { type: 'string', minLength: 1, maxLength: 120 },
    moodEnergy: { type: 'string', minLength: 1, maxLength: 120 },
    importantSemanticDistinctions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 140 } },
  },
};

const SEMANTIC_INTENT_PROMPT = `Extract a short semantic visual intent for a KUROHIGE MAP possibility island.
Do not create a VisualRecipe yet. Do not choose a world position. Do not draw an image.
Capture the goal's distinctive meaning rather than collapsing it into a broad generic category.
Keep every field concise. No essay or explanation outside the requested structure.`;

const RECIPE_COMPILER_PROMPT = `Compile the supplied semantic intent into a strict KUROHIGE MAP VisualRecipe.
Do not invent a new meaning. Preserve important distinctions from the semantic intent.
Use supported renderer vocabulary wherever it expresses the intent. Unknown short snake_case concepts are allowed only when the supported vocabulary cannot preserve an important distinction.
Do not choose a world position. Return only the requested structure.
Supported renderer vocabulary:
${formatSupportedVisualVocabulary()}`;

class PublicApiError extends Error {
  constructor(status, code, message, details, diagnostic = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Object.assign(this, diagnostic);
  }
}

function createRequestDiagnostic(requestId) {
  return {
    requestId,
    model: null,
    requestedOutputMethod: 'json_schema',
    actualOutputMethod: null,
    httpStatus: null,
    nebiusRequestSuccess: false,
    finishReason: null,
    responseContentLength: 0,
    rawContentExists: false,
    jsonParseSuccess: false,
    schemaValidationSuccess: false,
    validationFailurePath: null,
    jsonSchemaFallback: false,
    retryCount: 0,
    strictRetryCount: 0,
    maxTruncationRetries: MAX_TRUNCATION_RETRIES,
    failureStage: null,
    fallbackFailureStage: null,
    finalServerResult: 'pending',
    maxOutputTokens: VISUAL_RECIPE_MAX_TOKENS,
    usage: null,
    thinkingOffRequested: false,
    thinkingOffAccepted: null,
    attempts: [],
  };
}

function createAttempt(outputMethod, thinkingOffRequested = false) {
  return {
    attempt: 0,
    outputMethod,
    httpStatus: null,
    nebiusRequestSuccess: false,
    finishReason: null,
    responseContentLength: 0,
    rawContentExists: false,
    jsonParseSuccess: false,
    schemaValidationSuccess: false,
    validationFailurePath: null,
    failureStage: null,
    maxOutputTokens: VISUAL_RECIPE_MAX_TOKENS,
    usage: null,
    thinkingOffRequested,
    thinkingOffAccepted: null,
    latencyMs: 0,
  };
}

function syncDiagnosticSummary(diagnostic, finalServerResult, failureStage = null) {
  const finalAttempt = diagnostic.attempts.at(-1);
  if (finalAttempt) {
    diagnostic.actualOutputMethod = finalAttempt.outputMethod;
    diagnostic.httpStatus = finalAttempt.httpStatus;
    diagnostic.nebiusRequestSuccess = finalAttempt.nebiusRequestSuccess;
    diagnostic.finishReason = finalAttempt.finishReason;
    diagnostic.responseContentLength = finalAttempt.responseContentLength;
    diagnostic.rawContentExists = finalAttempt.rawContentExists;
    diagnostic.jsonParseSuccess = finalAttempt.jsonParseSuccess;
    diagnostic.schemaValidationSuccess = finalAttempt.schemaValidationSuccess;
    diagnostic.validationFailurePath = finalAttempt.validationFailurePath;
    diagnostic.maxOutputTokens = finalAttempt.maxOutputTokens;
    diagnostic.usage = finalAttempt.usage;
    diagnostic.thinkingOffAccepted = finalAttempt.thinkingOffAccepted;
  }
  diagnostic.retryCount = Math.max(0, diagnostic.attempts.length - 1);
  diagnostic.totalRetryCount = diagnostic.retryCount;
  diagnostic.totalLatencyMs = diagnostic.attempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0);
  diagnostic.totalUsage = sumAttemptUsage([{ attempts: diagnostic.attempts }]);
  diagnostic.stageG = diagnostic.attempts.some((attempt) => attempt.failureStage === 'G');
  diagnostic.failureStage = failureStage;
  diagnostic.finalServerResult = finalServerResult;
  return diagnostic;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new PublicApiError(413, 'request_too_large', 'Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new PublicApiError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function safeUpstreamMessage(payload, status) {
  const candidate = payload?.error?.message ?? payload?.message;
  if (typeof candidate !== 'string') return `Nebius request failed with status ${status}.`;
  return candidate.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 360);
}

async function nebiusRequest(fetchImpl, apiKey, path, init = {}, attempt = null) {
  let response;
  try {
    response = await fetchImpl(`${NEBIUS_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    if (attempt) attempt.failureStage = 'A';
    throw new PublicApiError(502, 'nebius_transport_failed', 'Nebius request could not be completed.', undefined, {
      failureStage: 'A', cause,
    });
  }
  if (attempt) attempt.httpStatus = response.status;
  let payload = null;
  let payloadParseFailed = false;
  try {
    payload = await response.json();
  } catch {
    payloadParseFailed = true;
  }
  if (!response.ok) {
    if (attempt) attempt.failureStage = 'A';
    if (attempt?.thinkingOffRequested) attempt.thinkingOffAccepted = false;
    const error = new PublicApiError(502, 'nebius_request_failed', safeUpstreamMessage(payload, response.status), undefined, {
      failureStage: 'A',
    });
    error.upstreamStatus = response.status;
    error.upstreamPayload = payload;
    throw error;
  }
  if (payloadParseFailed) {
    if (attempt) attempt.failureStage = 'H';
    throw new PublicApiError(502, 'invalid_nebius_payload', 'Nebius returned an unreadable response payload.', undefined, {
      failureStage: 'H',
    });
  }
  if (attempt) {
    attempt.nebiusRequestSuccess = true;
    if (attempt.thinkingOffRequested) attempt.thinkingOffAccepted = true;
  }
  return payload;
}

function findNemotronUltra(models) {
  const ids = models.map((model) => model?.id).filter((id) => typeof id === 'string');
  const model = ids.find((id) => TARGET_MODEL_PATTERN.test(id));
  if (model) return model;
  const availableNemotronModels = ids.filter((id) => /nemotron/i.test(id));
  throw new PublicApiError(
    503,
    'nemotron_ultra_unavailable',
    'NVIDIA Nemotron 3 Ultra is not available for this Nebius account.',
    { availableNemotronModels },
  );
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => typeof item?.text === 'string' ? item.text : '').join('');
  return '';
}

function parseStructuredContent(payload, attempt, invalidCode, invalidMessage) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const usage = payload?.usage;
  const completionDetails = usage?.completion_tokens_details;
  attempt.usage = usage && typeof usage === 'object' ? {
    promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    reasoningTokens: Number.isFinite(completionDetails?.reasoning_tokens) ? completionDetails.reasoning_tokens : null,
  } : null;
  attempt.finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  if (!message) {
    attempt.failureStage = 'B';
    throw new PublicApiError(502, 'invalid_nebius_response', 'Nebius returned no assistant message.', undefined, { failureStage: 'B' });
  }
  if (message.parsed && typeof message.parsed === 'object') {
    const serialized = JSON.stringify(message.parsed);
    attempt.responseContentLength = serialized.length;
    attempt.rawContentExists = true;
    attempt.jsonParseSuccess = true;
    return message.parsed;
  }
  const rawText = contentText(message.content);
  attempt.responseContentLength = rawText.length;
  attempt.rawContentExists = rawText.trim().length > 0;
  if (!attempt.rawContentExists) {
    attempt.failureStage = 'B';
    throw new PublicApiError(502, 'empty_recipe_completion', 'Nemotron returned an empty Visual Recipe completion.', undefined, { failureStage: 'B' });
  }
  const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    attempt.jsonParseSuccess = true;
    return parsed;
  } catch {
    const failureStage = attempt.finishReason === 'length' ? 'G' : 'C';
    attempt.failureStage = failureStage;
    throw new PublicApiError(502, invalidCode, invalidMessage, undefined, { failureStage });
  }
}

function parseRecipeContent(payload, attempt) {
  return parseStructuredContent(payload, attempt, 'invalid_recipe_json', 'Nemotron did not return valid Visual Recipe JSON.');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSemanticIntent(value) {
  if (!isPlainObject(value)) throw new PublicApiError(502, 'invalid_semantic_intent', 'Semantic Intent must be a JSON object.', undefined, { failureStage: 'D', validationFailurePath: '$' });
  const required = Object.keys(SEMANTIC_INTENT_SCHEMA.properties);
  const keys = Object.keys(value);
  const missing = required.find((key) => !keys.includes(key));
  const unexpected = keys.find((key) => !required.includes(key));
  if (keys.length !== required.length || missing || unexpected) {
    throw new PublicApiError(502, 'invalid_semantic_intent', 'Semantic Intent fields do not match the required schema.', undefined, {
      failureStage: 'D', validationFailurePath: missing ? `$.${missing}` : unexpected ? `$.${unexpected}` : '$',
    });
  }
  for (const field of ['themeConcept', 'dominantVisualIdea', 'terrainCharacter', 'moodEnergy']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new PublicApiError(502, 'invalid_semantic_intent', `Semantic Intent field ${field} is invalid.`, undefined, {
        failureStage: 'D', validationFailurePath: `$.${field}`,
      });
    }
  }
  for (const field of ['supportingVisualConcepts', 'importantSemanticDistinctions']) {
    if (!Array.isArray(value[field]) || value[field].length === 0 || value[field].some((item) => typeof item !== 'string' || !item.trim())) {
      throw new PublicApiError(502, 'invalid_semantic_intent', `Semantic Intent field ${field} is invalid.`, undefined, {
        failureStage: 'D', validationFailurePath: `$.${field}`,
      });
    }
  }
  return {
    themeConcept: value.themeConcept.trim(),
    dominantVisualIdea: value.dominantVisualIdea.trim(),
    supportingVisualConcepts: value.supportingVisualConcepts.map((item) => item.trim()),
    terrainCharacter: value.terrainCharacter.trim(),
    moodEnergy: value.moodEnergy.trim(),
    importantSemanticDistinctions: value.importantSemanticDistinctions.map((item) => item.trim()),
  };
}

export function validateVisualRecipe(value, { vocabularyContract = false } = {}) {
  if (!isPlainObject(value)) throw new PublicApiError(502, 'invalid_recipe', 'Visual Recipe must be a JSON object.', undefined, { failureStage: 'D', validationFailurePath: '$' });
  const required = Object.keys(VISUAL_RECIPE_SCHEMA.properties);
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
    const missing = required.find((key) => !keys.includes(key));
    const unexpected = keys.find((key) => !required.includes(key));
    throw new PublicApiError(502, 'invalid_recipe', 'Visual Recipe fields do not match the required schema.', undefined, {
      failureStage: 'D', validationFailurePath: missing ? `$.${missing}` : unexpected ? `$.${unexpected}` : '$',
    });
  }
  const shortStringFields = ['visualTheme', 'dominantMotif', 'terrainProfile', 'accentPalette'];
  for (const field of shortStringFields) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 80) {
      throw new PublicApiError(502, 'invalid_recipe', `Visual Recipe field ${field} is invalid.`, undefined, {
        failureStage: 'D', validationFailurePath: `$.${field}`,
      });
    }
  }
  const invalidSecondaryIndex = Array.isArray(value.secondaryObjects)
    ? value.secondaryObjects.findIndex((item) => typeof item !== 'string' || !item.trim() || item.length > 80)
    : -1;
  if (!Array.isArray(value.secondaryObjects) || value.secondaryObjects.length > 12 || invalidSecondaryIndex >= 0) {
    throw new PublicApiError(502, 'invalid_recipe', 'Visual Recipe field secondaryObjects is invalid.', undefined, {
      failureStage: 'D',
      validationFailurePath: invalidSecondaryIndex >= 0 ? `$.secondaryObjects[${invalidSecondaryIndex}]` : '$.secondaryObjects',
    });
  }
  const enums = {
    density: ['sparse', 'medium', 'dense'],
    openness: ['open', 'balanced', 'compact'],
    landmarkEmphasis: ['low', 'medium', 'high'],
    energyLevel: ['calm', 'moderate', 'high'],
  };
  for (const [field, allowed] of Object.entries(enums)) {
    if (!allowed.includes(value[field])) throw new PublicApiError(502, 'invalid_recipe', `Visual Recipe field ${field} is invalid.`, undefined, {
      failureStage: 'D', validationFailurePath: `$.${field}`,
    });
  }
  const recipe = {
    visualTheme: value.visualTheme.trim(),
    dominantMotif: value.dominantMotif.trim(),
    secondaryObjects: value.secondaryObjects.map((item) => item.trim()),
    terrainProfile: value.terrainProfile.trim(),
    accentPalette: value.accentPalette.trim(),
    density: value.density,
    openness: value.openness,
    landmarkEmphasis: value.landmarkEmphasis,
    energyLevel: value.energyLevel,
  };
  if (vocabularyContract) {
    const roleFields = [
      ['visualTheme', 'theme'],
      ['dominantMotif', 'dominantMotif'],
      ['terrainProfile', 'terrain'],
      ['accentPalette', 'palette'],
    ];
    for (const [field, role] of roleFields) {
      if (!conceptIdsForRole(role).includes(recipe[field])) {
        throw new PublicApiError(502, 'invalid_recipe', `Visual Recipe field ${field} is outside the renderer vocabulary.`, undefined, {
          failureStage: 'D', validationFailurePath: `$.${field}`,
        });
      }
    }
    const supportedSecondaryObjects = conceptIdsForRole('secondaryObject');
    const invalidIndex = recipe.secondaryObjects.findIndex((item) => !supportedSecondaryObjects.includes(item));
    if (invalidIndex >= 0) {
      throw new PublicApiError(502, 'invalid_recipe', 'Visual Recipe secondary object is outside the renderer vocabulary.', undefined, {
        failureStage: 'D', validationFailurePath: `$.secondaryObjects[${invalidIndex}]`,
      });
    }
  }
  return recipe;
}

function completionBody(model, goal, responseFormat, thinkingOffRequested = false, systemPrompt = SYSTEM_PROMPT) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Possibility goal: ${goal}` },
    ],
    response_format: responseFormat,
    temperature: 0.55,
    max_tokens: VISUAL_RECIPE_MAX_TOKENS,
    stream: false,
    ...(thinkingOffRequested ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
}

function semanticIntentBody(model, goal) {
  return {
    model,
    messages: [
      { role: 'system', content: SEMANTIC_INTENT_PROMPT },
      { role: 'user', content: `Possibility goal: ${goal}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'semantic_visual_intent', strict: true, schema: SEMANTIC_INTENT_SCHEMA },
    },
    temperature: 0.4,
    max_tokens: VISUAL_RECIPE_MAX_TOKENS,
    stream: false,
  };
}

function recipeCompilerBody(model, goal, semanticIntent) {
  return {
    model,
    messages: [
      { role: 'system', content: RECIPE_COMPILER_PROMPT },
      { role: 'user', content: `Original Goal: ${goal}\nSemantic Intent:\n${JSON.stringify(semanticIntent)}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'visual_recipe', strict: true, schema: VISUAL_RECIPE_SCHEMA },
    },
    temperature: 0.25,
    max_tokens: VISUAL_RECIPE_MAX_TOKENS,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

function sumAttemptUsage(stageDiagnostics) {
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  for (const stage of stageDiagnostics) {
    for (const attempt of stage.attempts) {
      totals.promptTokens += attempt.usage?.promptTokens ?? 0;
      totals.completionTokens += attempt.usage?.completionTokens ?? 0;
      totals.totalTokens += attempt.usage?.totalTokens ?? 0;
      totals.reasoningTokens += attempt.usage?.reasoningTokens ?? 0;
    }
  }
  return totals;
}

function isStructuredOutputCapabilityError(error) {
  if (!(error instanceof PublicApiError) || ![400, 404, 422].includes(error.upstreamStatus)) return false;
  const message = safeUpstreamMessage(error.upstreamPayload, error.upstreamStatus).toLowerCase();
  return message.includes('response_format') || message.includes('json_schema') || message.includes('structured output');
}

export function createVisualRecipeService({ apiKey, apiEnabled = false, fetchImpl = fetch, spendGuard = null }) {
  let modelPromise = null;
  const pausedError = () => new PublicApiError(503, NEBIUS_API_PAUSED_CODE, NEBIUS_API_PAUSED_MESSAGE);
  const guardFor = (operation) => spendGuard?.forOperation ? spendGuard.forOperation(operation) : spendGuard;
  const guardedFetchFor = (operation) => createGuardedNebiusFetch({ enabled: apiEnabled, fetchImpl, errorFactory: pausedError, spendGuard: guardFor(operation) });
  const discoverModel = () => {
    assertNebiusApiEnabled(apiEnabled, pausedError);
    if (!apiKey) throw new PublicApiError(503, 'missing_nebius_api_key', 'NEBIUS_API_KEY is not configured on the server.');
    modelPromise ??= nebiusRequest(guardedFetchFor('model_discovery'), apiKey, '/models').then((payload) => findNemotronUltra(payload?.data ?? []));
    return modelPromise;
  };

  const generate = async (goal, diagnostic = createRequestDiagnostic(randomUUID()), {
    thinkingOffProbe = false,
    vocabularyContractPilot = false,
  } = {}) => {
    const model = await discoverModel();
    diagnostic.model = model;
    diagnostic.thinkingOffRequested = thinkingOffProbe;
    if (vocabularyContractPilot) diagnostic.mode = 'single_stage_role_aware_vocabulary';
    const activeSchema = vocabularyContractPilot
      ? VOCABULARY_CONTRACT_VISUAL_RECIPE_SCHEMA
      : VISUAL_RECIPE_SCHEMA;
    const activeSystemPrompt = vocabularyContractPilot
      ? VOCABULARY_CONTRACT_PROMPT
      : SYSTEM_PROMPT;
    const schemaFormat = {
      type: 'json_schema',
      json_schema: { name: 'visual_recipe', strict: true, schema: activeSchema },
    };
    const runCompletion = async (outputMethod, responseFormat) => {
      const attempt = createAttempt(outputMethod, thinkingOffProbe);
      attempt.attempt = diagnostic.attempts.length + 1;
      diagnostic.attempts.push(attempt);
      const attemptStartedAt = performance.now();
      try {
        const payload = await nebiusRequest(guardedFetchFor('visual_recipe'), apiKey, '/chat/completions', {
          method: 'POST',
          body: JSON.stringify(completionBody(model, goal, responseFormat, thinkingOffProbe, activeSystemPrompt)),
        }, attempt);
        const parsed = parseRecipeContent(payload, attempt);
        const recipe = validateVisualRecipe(parsed, { vocabularyContract: vocabularyContractPilot });
        attempt.schemaValidationSuccess = true;
        return recipe;
      } catch (error) {
        attempt.failureStage ??= error instanceof PublicApiError ? error.failureStage ?? 'H' : 'H';
        attempt.validationFailurePath = error instanceof PublicApiError ? error.validationFailurePath ?? null : null;
        throw error;
      } finally {
        attempt.latencyMs = Math.round(performance.now() - attemptStartedAt);
      }
    };

    let recipe;
    let schemaError = null;
    let structuredOutputMethod = 'json_schema';
    try {
      recipe = await runCompletion('json_schema', schemaFormat);
    } catch (error) {
      schemaError = error;
    }

    if (schemaError instanceof PublicApiError && schemaError.failureStage === 'G') {
      for (let retry = 0; retry < MAX_TRUNCATION_RETRIES; retry++) {
        diagnostic.strictRetryCount += 1;
        try {
          recipe = await runCompletion('json_schema', schemaFormat);
          schemaError = null;
          break;
        } catch (error) {
          schemaError = error;
        }
      }
    }

    if (schemaError) {
      if (!isStructuredOutputCapabilityError(schemaError)) throw schemaError;
      diagnostic.attempts.at(-1).failureStage = 'E';
      diagnostic.jsonSchemaFallback = true;
      structuredOutputMethod = 'json_object_validated';
      try {
        recipe = await runCompletion('json_object', { type: 'json_object' });
      } catch (fallbackError) {
        diagnostic.fallbackFailureStage = diagnostic.attempts.at(-1)?.failureStage ?? 'H';
        if (fallbackError instanceof PublicApiError) fallbackError.failureStage = 'F';
        throw fallbackError;
      }
    }
    return {
      recipe,
      model,
      structuredOutputMethod: vocabularyContractPilot ? `vocabulary_contract_${structuredOutputMethod}` : structuredOutputMethod,
    };
  };

  const generateTwoStage = async (goal, diagnostic = createRequestDiagnostic(randomUUID())) => {
    const startedAt = performance.now();
    const model = await discoverModel();
    diagnostic.mode = 'two_stage_on_off';
    diagnostic.model = model;
    diagnostic.stages = {};

    const finalize = (finalServerResult, failureStage = null) => {
      const stages = Object.values(diagnostic.stages);
      diagnostic.totalLatencyMs = Math.round(performance.now() - startedAt);
      diagnostic.totalUsage = sumAttemptUsage(stages);
      diagnostic.totalRetryCount = stages.reduce((sum, stage) => sum + stage.retryCount, 0);
      diagnostic.stageG = {
        semanticIntent: diagnostic.stages.semanticIntent?.attempts.some((attempt) => attempt.failureStage === 'G') ?? false,
        recipeCompiler: diagnostic.stages.recipeCompiler?.attempts.some((attempt) => attempt.failureStage === 'G') ?? false,
      };
      diagnostic.failureStage = failureStage;
      diagnostic.finalServerResult = finalServerResult;
    };

    const executeStage = async ({ stageName, operation, thinkingOff, body, parse, validate }) => {
      const stageDiagnostic = createRequestDiagnostic(`${diagnostic.requestId}:${stageName}`);
      stageDiagnostic.stage = stageName;
      stageDiagnostic.model = model;
      stageDiagnostic.thinkingOffRequested = thinkingOff;
      diagnostic.stages[stageName] = stageDiagnostic;

      const runAttempt = async () => {
        const attempt = createAttempt('json_schema', thinkingOff);
        attempt.attempt = stageDiagnostic.attempts.length + 1;
        stageDiagnostic.attempts.push(attempt);
        const attemptStartedAt = performance.now();
        try {
          const payload = await nebiusRequest(guardedFetchFor(operation), apiKey, '/chat/completions', {
            method: 'POST', body: JSON.stringify(body()),
          }, attempt);
          const parsed = parse(payload, attempt);
          const validated = validate(parsed);
          attempt.schemaValidationSuccess = true;
          return validated;
        } catch (error) {
          attempt.failureStage ??= error instanceof PublicApiError ? error.failureStage ?? 'H' : 'H';
          attempt.validationFailurePath = error instanceof PublicApiError ? error.validationFailurePath ?? null : null;
          if (isStructuredOutputCapabilityError(error)) {
            attempt.failureStage = 'E';
            if (error instanceof PublicApiError) error.failureStage = 'E';
          }
          throw error;
        } finally {
          attempt.latencyMs = Math.round(performance.now() - attemptStartedAt);
        }
      };

      let value;
      let stageError = null;
      try {
        value = await runAttempt();
      } catch (error) {
        stageError = error;
      }
      if (stageError instanceof PublicApiError && stageError.failureStage === 'G') {
        for (let retry = 0; retry < MAX_TRUNCATION_RETRIES; retry++) {
          stageDiagnostic.strictRetryCount += 1;
          try {
            value = await runAttempt();
            stageError = null;
            break;
          } catch (error) {
            stageError = error;
          }
        }
      }
      if (stageError) {
        syncDiagnosticSummary(stageDiagnostic, `error:${stageError.code ?? 'unknown'}`, stageError.failureStage ?? 'H');
        throw stageError;
      }
      syncDiagnosticSummary(stageDiagnostic, 'success');
      return value;
    };

    try {
      const semanticIntent = await executeStage({
        stageName: 'semanticIntent',
        operation: 'semantic_visual_intent',
        thinkingOff: false,
        body: () => semanticIntentBody(model, goal),
        parse: (payload, attempt) => parseStructuredContent(payload, attempt, 'invalid_semantic_intent_json', 'Nemotron did not return valid Semantic Intent JSON.'),
        validate: validateSemanticIntent,
      });
      const recipe = await executeStage({
        stageName: 'recipeCompiler',
        operation: 'visual_recipe',
        thinkingOff: true,
        body: () => recipeCompilerBody(model, goal, semanticIntent),
        parse: parseRecipeContent,
        validate: validateVisualRecipe,
      });
      finalize('success');
      return { recipe, semanticIntent, model, structuredOutputMethod: 'two_stage_json_schema' };
    } catch (error) {
      finalize(`error:${error instanceof PublicApiError ? error.code : 'internal_server_error'}`, error instanceof PublicApiError ? error.failureStage ?? 'H' : 'H');
      throw error;
    }
  };

  return { discoverModel, generate, generateTwoStage };
}

export function createVisualRecipeMiddleware({ apiKey, apiEnabled = false, fetchImpl = fetch, diagnosticEnabled = false, spendGuard = null }) {
  const service = createVisualRecipeService({ apiKey, apiEnabled, fetchImpl, spendGuard });
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      json(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST /api/visual-recipe.' } });
      return;
    }
    const diagnostic = createRequestDiagnostic(randomUUID());
    try {
      const body = await readJsonBody(req);
      const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
      if (!goal || goal.length > MAX_GOAL_LENGTH) {
        throw new PublicApiError(400, 'invalid_goal', `Goal must contain 1 to ${MAX_GOAL_LENGTH} characters.`);
      }
      const thinkingOffProbe = diagnosticEnabled && body?.devThinkingOffProbe === true;
      const twoStagePilot = diagnosticEnabled && body?.devTwoStagePilot === true;
      const vocabularyContractPilot = diagnosticEnabled && body?.devVocabPilot === true;
      const result = twoStagePilot
        ? await service.generateTwoStage(goal, diagnostic)
        : await service.generate(goal, diagnostic, { thinkingOffProbe, vocabularyContractPilot });
      if (!twoStagePilot) syncDiagnosticSummary(diagnostic, 'success');
      if (diagnosticEnabled) console.info('[visual-recipe-diagnostic]', JSON.stringify(diagnostic));
      json(res, 200, { ...result, ...(diagnosticEnabled ? { diagnostic } : {}) });
    } catch (error) {
      const status = error instanceof PublicApiError ? error.status : 500;
      const code = error instanceof PublicApiError ? error.code : 'internal_server_error';
      const message = error instanceof PublicApiError ? error.message : 'The visual recipe server failed.';
      const details = error instanceof PublicApiError ? error.details : undefined;
      const failureStage = error instanceof PublicApiError ? error.failureStage ?? 'H' : 'H';
      if (diagnostic.mode !== 'two_stage_on_off') syncDiagnosticSummary(diagnostic, `error:${code}`, failureStage);
      if (diagnosticEnabled) console.info('[visual-recipe-diagnostic]', JSON.stringify(diagnostic));
      if (!(error instanceof PublicApiError)) {
        console.error('[visual-recipe-api]', {
          code,
          message: error instanceof Error ? error.message : 'Unknown server error',
          causeCode: error?.cause?.code,
        });
      }
      json(res, status, {
        error: { code, message, ...(details ?? {}) },
        ...(diagnosticEnabled ? { diagnostic } : {}),
      });
    }
  };
}
