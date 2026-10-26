import { randomUUID } from 'node:crypto';
import { assertNebiusApiEnabled, createGuardedNebiusFetch, NEBIUS_API_PAUSED_CODE, NEBIUS_API_PAUSED_MESSAGE } from './nebiusTransportGuard.mjs';
import {
  VOCABULARY_CONTRACT_VISUAL_RECIPE_SCHEMA,
  validateVisualRecipe,
} from './visualRecipeApi.mjs';
import { formatSupportedVisualVocabulary } from '../src/visualVocabulary.ts';
import {
  CANONICAL_BRIDGE_TAGS,
  canonicalBridgeTags,
  formatCanonicalBridgeVocabulary,
  normalizeBridgeTag,
} from '../src/semanticBridgeVocabulary.ts';
import {
  MAX_WORLD_EXPANSION_BATCH,
  MAX_WORLD_NODE_SUMMARIES,
  TARGET_WORLD_NODE_COUNT,
  semanticDriftGuidance,
} from '../src/worldCapacity.ts';

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const TARGET_MODEL_PATTERN = /(?:^|\/)nemotron-3-ultra(?:-|_|$)/i;
const MAX_TOKENS_BY_KIND = {
  possibility_map_semantic_batch: 4096,
  possibility_map_visual_batch: 4096,
  world_expansion_semantic_batch: 4096,
  world_expansion_visual_batch: 4096,
  local_small_steps: 4096,
  node_detail: 2048,
};
const MAX_RETRIES = 1;
const MAX_CANDIDATE_RECOVERY_ROUNDS = 3;
const MAX_BODY_BYTES = 256 * 1024;
const USER_FACING_LOCALE = 'ja-JP';

const POSSIBILITY_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'title', 'shortDescription', 'category', 'nodeKind', 'relationToGoal',
    'curiosityFit', 'accessibility', 'novelty', 'friction',
    'portableResourceTags', 'connectionTags', 'helpedByTags', 'visualRecipe',
  ],
  properties: {
    id: { type: 'string', minLength: 2, maxLength: 64 },
    title: { type: 'string', minLength: 2, maxLength: 80 },
    shortDescription: { type: 'string', minLength: 4, maxLength: 180 },
    category: { type: 'string', minLength: 2, maxLength: 48 },
    nodeKind: { type: 'string', enum: ['activity', 'experience', 'information', 'opportunity', 'skill', 'community'] },
    relationToGoal: { type: 'string', enum: ['direct', 'adjacent', 'exploratory'] },
    curiosityFit: { type: 'number', minimum: 0, maximum: 1 },
    accessibility: { type: 'number', minimum: 0, maximum: 1 },
    novelty: { type: 'number', minimum: 0, maximum: 1 },
    friction: { type: 'number', minimum: 0, maximum: 1 },
    portableResourceTags: {
      type: 'array', minItems: 1, maxItems: 6,
      items: { type: 'string', minLength: 2, maxLength: 48 },
    },
    connectionTags: {
      type: 'array', minItems: 1, maxItems: 6,
      items: { type: 'string', minLength: 2, maxLength: 48 },
    },
    helpedByTags: {
      type: 'array', minItems: 2, maxItems: 6,
      items: { type: 'string', enum: CANONICAL_BRIDGE_TAGS },
    },
    visualRecipe: VOCABULARY_CONTRACT_VISUAL_RECIPE_SCHEMA,
  },
};

const possibilityCollectionSchema = (count) => ({
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: { type: 'array', minItems: count, maxItems: count, items: POSSIBILITY_NODE_SCHEMA },
  },
});

export const POSSIBILITY_MAP_SCHEMA = possibilityCollectionSchema(6);

const POSSIBILITY_SEMANTIC_NODE_SCHEMA = {
  ...POSSIBILITY_NODE_SCHEMA,
  required: POSSIBILITY_NODE_SCHEMA.required.filter((field) => field !== 'id' && field !== 'visualRecipe'),
  properties: Object.fromEntries(
    Object.entries(POSSIBILITY_NODE_SCHEMA.properties).filter(([field]) => field !== 'id' && field !== 'visualRecipe'),
  ),
};

const possibilitySemanticCollectionSchema = (count) => ({
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: { type: 'array', minItems: count, maxItems: count, items: POSSIBILITY_SEMANTIC_NODE_SCHEMA },
  },
});

const visualRecipeCollectionSchema = (nodeIds) => ({
  type: 'object',
  additionalProperties: false,
  required: ['recipes'],
  properties: {
    recipes: {
      type: 'array',
      minItems: nodeIds.length,
      maxItems: nodeIds.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'visualRecipe'],
        properties: {
          nodeId: { type: 'string', enum: nodeIds },
          visualRecipe: VOCABULARY_CONTRACT_VISUAL_RECIPE_SCHEMA,
        },
      },
    },
  },
});

const LOCAL_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'title', 'shortDescription', 'portableResources', 'connectionTags', 'experienceTag',
    'resourceBridges', 'connectionBridgeTags', 'experienceBridgeTags',
  ],
  properties: {
    id: { type: 'string', minLength: 2, maxLength: 64 },
    title: { type: 'string', minLength: 2, maxLength: 100 },
    shortDescription: { type: 'string', minLength: 4, maxLength: 180 },
    portableResources: {
      type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'string', minLength: 2, maxLength: 48 },
    },
    connectionTags: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'string', minLength: 2, maxLength: 48 },
    },
    experienceTag: { type: 'string', minLength: 2, maxLength: 48 },
    resourceBridges: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['resource', 'bridgeTags'],
        properties: {
          resource: { type: 'string', minLength: 2, maxLength: 48 },
          bridgeTags: {
            type: 'array', minItems: 1, maxItems: 4,
            items: { type: 'string', enum: CANONICAL_BRIDGE_TAGS },
          },
        },
      },
    },
    connectionBridgeTags: {
      type: 'array', minItems: 0, maxItems: 4,
      items: { type: 'string', enum: CANONICAL_BRIDGE_TAGS },
    },
    experienceBridgeTags: {
      type: 'array', minItems: 0, maxItems: 4,
      items: { type: 'string', enum: CANONICAL_BRIDGE_TAGS },
    },
  },
};

export const NODE_STEPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: { type: 'array', minItems: 3, maxItems: 3, items: LOCAL_STEP_SCHEMA },
  },
};

const NODE_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'expectedOutcomes', 'personConnection'],
  properties: {
    overview: { type: 'string', minLength: 20, maxLength: 420 },
    expectedOutcomes: {
      type: 'array', minItems: 2, maxItems: 5,
      items: { type: 'string', minLength: 4, maxLength: 140 },
    },
    personConnection: { type: 'string', minLength: 20, maxLength: 360 },
  },
};

const JAPANESE_OUTPUT_REQUIREMENT = `User-facing locale is ja-JP. Write every user-facing title and description in natural Japanese.
Internal IDs, enum values, category keys, tags, and VisualRecipe vocabulary must remain in their required English contract form.
Do not return an English-only title or description.`;

const POSSIBILITY_MAP_PROMPT = `Create a living possibility map from a person's current context.
The Person Map is a set of soft signals, not a single goal or required destination. An optional Context Seed is only a lens and must never become a node or island title.
Return the exact number of distinct possibility nodes required by the supplied schema. A node is a small activity, touchable experience, skill, information source, opportunity, or community.
Do not output a roadmap, ordered sequence, progress percentage, destination, future route, or world coordinates.
Include direct possibilities and at least one adjacent or exploratory possibility that remains meaningfully connected and expands the person's options.
Titles must name concrete possibilities rather than restate the person's input.
Build a reusable tag graph: some portableResourceTags and connectionTags should be shared across related nodes, while other tags remain distinct.
For helpedByTags, select only the canonical capabilities that would genuinely reduce this node's challenge. Keep the set sparse and specific. Do not attach one generic tag to every node.
Scores are semantic inputs between 0 and 1. Distance is computed later by the layout engine; distance never means low value or failure.
Every node must contain a strict VisualRecipe using only the renderer vocabulary below.
${JAPANESE_OUTPUT_REQUIREMENT}
${formatCanonicalBridgeVocabulary()}
${formatSupportedVisualVocabulary()}`;

const NODE_STEPS_PROMPT = `Create exactly 3 independent local small-step choices for one kept possibility node.
The choices are peers. Do not number them, order them, or imply that one must follow another.
Each choice must be small enough to try locally and must change real person state when marked Done.
Return portable resources and connection tags that the action can actually produce.
For every portable resource, return exactly one resourceBridges entry and classify where that resource can be reused with the canonical bridge vocabulary.
connectionBridgeTags and experienceBridgeTags may be empty when there is no portable cross-possibility meaning.
Make the three actions semantically distinct: their bridge tags must describe the performed action, not the parent goal or a generic domain shared by every node.
Do not create a roadmap, progress percentage, XP, level, streak, future route, or world coordinates.
${JAPANESE_OUTPUT_REQUIREMENT}
${formatCanonicalBridgeVocabulary()}`;

const NODE_DETAIL_PROMPT = `Explain one possibility node in useful, approachable Japanese.
Return a concise overview of what the person could actually do, 2 to 5 plausible outcomes, and a hypothesis about how this possibility may connect to the person's current context.
The person connection must use tentative language such as 「〜かもしれません」「〜という接点がありそうです」 and must not diagnose or make claims about the person.
Expected outcomes may include skills, knowledge, experiences, connections, artifacts, or confidence when supported by the node.
Do not output world coordinates, progress, Keep state, Active Pursuit, Landed state, completion state, or route instructions.
${JAPANESE_OUTPUT_REQUIREMENT}`;

const WORLD_EXPAND_PROMPT = `Expand an existing living possibility world with the exact number of new possibility nodes required by the supplied schema.
The Person Map and optional Context Seed are soft context only and must never become a node or island title.
Every new node must be distinct from the existing IDs and titles supplied by the caller. Avoid near-duplicate concepts even when wording differs.
Use the current Person State, portable resources, kept context, and landed context to create meaningful new branches. Include adjacent or exploratory possibilities as well as direct ones.
Maintain domain variety across activity, learning, people or community, making or creating, place or experience, practical investigation, and cross-domain bridges where they fit the person. Do not saturate the batch with one category.
Do not output a roadmap, ordered sequence, progress percentage, destination, future route, or world coordinates.
For helpedByTags, select a sparse, specific subset of canonical capabilities that would genuinely help with that node. Preserve variation across the batch.
Every node must contain a strict VisualRecipe using only the renderer vocabulary below.
${JAPANESE_OUTPUT_REQUIREMENT}
${formatCanonicalBridgeVocabulary()}
${formatSupportedVisualVocabulary()}`;

class LivingFlowApiError extends Error {
  constructor(status, code, message, failureStage = 'H', validationFailurePath = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.failureStage = failureStage;
    this.validationFailurePath = validationFailurePath;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value) => typeof value === 'string' ? value.trim() : '';
const cleanStringList = (value) => Array.isArray(value) ? [...new Set(value.map(cleanText).filter(Boolean))] : [];
export function readGenerationContext(body) {
  const supplied = isObject(body?.generationContext) ? body.generationContext : null;
  if (supplied) {
    const locale = supplied.locale === 'en' ? 'en' : supplied.locale === 'ja' ? 'ja' : '';
    const contextSeed = cleanText(supplied.contextSeed);
    if (supplied.mode !== 'person_map' || !locale || !isObject(supplied.personState) || !isObject(supplied.userProfile) || contextSeed.length > 600) {
      throw new LivingFlowApiError(400, 'invalid_generation_context', 'A valid person_map generationContext is required.', 'D');
    }
    const profile = supplied.userProfile;
    return {
      mode: 'person_map', locale, contextSeed,
      semanticLens: contextSeed || '__person_map_exploration__',
      personState: supplied.personState,
      userProfile: {
        birthDate: cleanText(profile.birthDate),
        selfIdentifiedGender: cleanText(profile.selfIdentifiedGender),
        region: isObject(profile.region) ? { countryCode: cleanText(profile.region.countryCode), administrativeArea: cleanText(profile.region.administrativeArea) } : {},
        occupation: cleanText(profile.occupation),
        practicalProfile: cleanStringList(profile.practicalProfile),
      },
      legacy: false,
    };
  }
  const parentGoal = cleanText(body?.parentGoal);
  if (!parentGoal || parentGoal.length > 600) throw new LivingFlowApiError(400, 'invalid_generation_context', 'generationContext is required for Product requests.', 'D');
  return {
    mode: 'legacy_goal', locale: 'ja', contextSeed: parentGoal, semanticLens: parentGoal,
    personState: isObject(body?.personState) ? body.personState : { portableResources: [], experiences: [], completedSteps: [] },
    userProfile: {}, legacy: true,
  };
}
const generationPrompt = (context) => `User-facing locale: ${context.locale}\nGeneration mode: ${context.mode}\nOptional Context Seed: ${context.contextSeed || '(none)'}\nCurrent Person State:\n${JSON.stringify(context.personState)}\nUser Profile context (soft signals only):\n${JSON.stringify(context.userProfile)}`;
const normalizePhrase = (value) => cleanText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const containsJapanese = (value) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(cleanText(value));
const RECOVERY_NODE_KINDS = ['community', 'skill', 'information', 'opportunity', 'experience', 'activity'];
const RECOVERY_CAPABILITY_LENSES = [
  'accessibility and translation',
  'mentoring and teaching',
  'logistics and venue operations',
  'fundraising and sponsorship',
  'design and prototyping',
  'data analysis and research synthesis',
  'legal administration and preservation',
  'cataloging and discoverability',
];

const EXPLORATION_DOMAIN_LENSES = [
  'oral history, language, and memory',
  'ecology, habitat, and stewardship',
  'food, agriculture, and local production',
  'mobility, access, and navigation',
  'education, mentoring, and peer learning',
  'music, performance, and gathering',
  'craft, repair, and fabrication',
  'field science, observation, and experimentation',
  'publishing, media, and public communication',
  'digital tools, data, and information design',
  'care, wellbeing, and mutual support',
  'civic practice, policy, and public participation',
  'tourism, interpretation, and local guiding',
  'enterprise, funding, and sustainable livelihoods',
  'spaces, architecture, and adaptive reuse',
  'events, facilitation, and community rituals',
  'energy, reuse, and circular systems',
  'sports, outdoor activity, and embodied learning',
  'archives, museums, and cultural preservation',
  'preparedness, safety, and local resilience',
  'logistics, distribution, and shared infrastructure',
  'weather, astronomy, and environmental sensing',
  'biodiversity, species observation, and citizen science',
  'photography, film, and visual storytelling',
];

const EXPLORATION_TRANSFORMATION_LENSES = [
  'a small paid service with a concrete customer',
  'a shared toolkit or lending system',
  'a recurring peer-learning format',
  'a distributed observation or monitoring network',
  'an apprenticeship or mentoring pathway',
  'an exchange program connecting distinct groups',
  'a microgrant or sponsorship mechanism',
  'a public exhibit, demonstration, or showcase',
  'a reusable open guide, catalog, or dataset',
  'a temporary pilot in an underused place',
  'a cooperative operating model',
  'a guided field experience with a clear participant journey',
];

function explorationDiversityDirective(depth, internalBatch, count, recoveryRound = 0) {
  const numericBatch = Number.parseInt(String(internalBatch), 10) || 1;
  const offset = Math.max(0, depth) * 6 + (numericBatch - 1) * 3 + recoveryRound * 7;
  const domains = Array.from({ length: count }, (_, index) => {
    const position = offset + index;
    const domain = EXPLORATION_DOMAIN_LENSES[position % EXPLORATION_DOMAIN_LENSES.length];
    const transformation = EXPLORATION_TRANSFORMATION_LENSES[Math.floor(position / EXPLORATION_DOMAIN_LENSES.length) % EXPLORATION_TRANSFORMATION_LENSES.length];
    return `${domain} through ${transformation}`;
  });
  const initialRelationContract = depth === 0
    ? ` For initial-world candidates, use these relationToGoal values in candidate order: ${Array.from({ length: count }, (_, index) => ['direct', 'adjacent', 'exploratory'][index % 3]).join(', ')}.`
    : '';
  return ` Candidate diversity contract: use these domain-and-transformation pairs in candidate order: ${domains.join('; ')}.${initialRelationContract} Each candidate must use a distinct primary activity pattern, medium, audience, and concrete outcome. Use each pair only through a plausible semantic bridge to the person and current drift zone; do not add filler.`;
}

function recoveryDiversityDirective(depth, batch, count, recoveryRound) {
  if (recoveryRound <= 0) return '';
  const seed = [...`${depth}:${batch}`].reduce((sum, character) => sum + character.charCodeAt(0), recoveryRound * 7);
  const nodeKinds = Array.from({ length: count }, (_, index) => RECOVERY_NODE_KINDS[(seed + index) % RECOVERY_NODE_KINDS.length]);
  const lenses = Array.from({ length: count }, (_, index) => RECOVERY_CAPABILITY_LENSES[(seed + recoveryRound + index) % RECOVERY_CAPABILITY_LENSES.length]);
  return ` Candidate recovery diversity contract: use these nodeKind values in candidate order: ${nodeKinds.join(', ')}. Use these primary capability lenses in candidate order: ${lenses.join('; ')}. Choose a different primary activity pattern, medium, audience, and outcome from every rejected candidate. Apply each lens only through a plausible connection to the person; do not add generic filler.`;
}

const titleBigrams = (value) => {
  const normalized = normalizePhrase(value);
  return new Set([...normalized].slice(0, -1).map((character, index) => character + normalized[index + 1]));
};

function titleBigramSimilarity(left, right) {
  const aPairs = titleBigrams(left);
  const bPairs = titleBigrams(right);
  const intersection = [...aPairs].filter((pair) => bPairs.has(pair)).length;
  const union = new Set([...aPairs, ...bPairs]).size;
  return union > 0 ? intersection / union : 0;
}

function nearDuplicateTitle(left, right) {
  const a = normalizePhrase(left);
  const b = normalizePhrase(right);
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter >= 8 && shorter / longer >= .82 && (a.includes(b) || b.includes(a))) return true;
  return titleBigramSimilarity(a, b) >= .8;
}

function semanticSignature(node) {
  const tags = [
    ...(Array.isArray(node?.portableResourceTags) ? node.portableResourceTags : []),
    ...(Array.isArray(node?.connectionTags) ? node.connectionTags : []),
    ...(Array.isArray(node?.helpedByTags) ? node.helpedByTags : []),
  ].map(normalizeBridgeTag).filter(Boolean).sort();
  return `${normalizePhrase(node?.category)}|${cleanText(node?.nodeKind)}|${[...new Set(tags)].join('|')}`;
}

function semanticDuplicate(left, right) {
  return nearDuplicateTitle(left?.title, right?.title)
    || (
      semanticSignature(left) === semanticSignature(right)
      && semanticSignature(left) !== '||'
      && titleBigramSimilarity(left?.title, right?.title) >= .55
    );
}

function assignServerNodeIds(nodes, existingNodes) {
  const usedIds = new Set(existingNodes.map((node) => cleanText(node?.id)).filter(Boolean));
  return nodes.map((node) => {
    let id;
    do { id = `node_${randomUUID().replaceAll('-', '')}`; } while (usedIds.has(id));
    usedIds.add(id);
    return { ...node, id };
  });
}

function requireJapaneseText(value, path) {
  const text = cleanText(value);
  if (!text || !containsJapanese(text)) {
    throw new LivingFlowApiError(502, 'non_japanese_output', 'Nemotron returned non-Japanese user-facing text.', 'D', path);
  }
  return text;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new LivingFlowApiError(413, 'request_too_large', 'Request body is too large.', 'A'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new LivingFlowApiError(400, 'invalid_json', 'Request body must be valid JSON.', 'C')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function usageFrom(payload) {
  const usage = payload?.usage;
  const details = usage?.completion_tokens_details;
  return usage && typeof usage === 'object' ? {
    promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    reasoningTokens: Number.isFinite(details?.reasoning_tokens) ? details.reasoning_tokens : null,
  } : null;
}

function responseText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => typeof item?.text === 'string' ? item.text : '').join('');
  return '';
}

function parseStructured(payload, attempt) {
  const choice = payload?.choices?.[0];
  attempt.finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  attempt.usage = usageFrom(payload);
  const message = choice?.message;
  if (!message) throw new LivingFlowApiError(502, 'empty_completion', 'Nemotron returned no assistant message.', 'B');
  attempt.reasoningContentLength = responseText(message.reasoning_content).length;
  if (message.parsed && typeof message.parsed === 'object') {
    attempt.contentLength = JSON.stringify(message.parsed).length;
    attempt.parseSuccess = true;
    return message.parsed;
  }
  const raw = responseText(message.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  attempt.contentLength = raw.length;
  if (!raw) throw new LivingFlowApiError(502, 'empty_completion', 'Nemotron returned an empty completion.', 'B');
  try {
    const value = JSON.parse(raw);
    attempt.parseSuccess = true;
    return value;
  } catch {
    const sanitizeExcerpt = (value) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    attempt.contentExcerpt = {
      start: sanitizeExcerpt(raw.slice(0, 180)),
      end: sanitizeExcerpt(raw.slice(-180)),
    };
    throw new LivingFlowApiError(
      502,
      'invalid_structured_output',
      'Nemotron did not return valid structured JSON.',
      attempt.finishReason === 'length' ? 'G' : 'C',
    );
  }
}

function validateStringArray(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => !cleanText(item))) {
    throw new LivingFlowApiError(502, 'schema_invalid', `Invalid field ${path}.`, 'D', path);
  }
  return [...new Set(value.map(cleanText))];
}

function validateCanonicalBridgeTags(value, path, min, max) {
  const tags = validateStringArray(value, path, min, max);
  const canonical = canonicalBridgeTags(tags);
  if (canonical.length !== tags.length || tags.some((tag, index) => normalizeBridgeTag(tag) !== canonical[index])) {
    throw new LivingFlowApiError(502, 'schema_invalid', `Unsupported canonical bridge tag in ${path}.`, 'D', path);
  }
  return canonical;
}

function validatePossibilityNodes(
  value,
  parentGoal,
  expectedCount,
  requireExploratory = true,
  requireVisualRecipe = true,
  requireIdentity = true,
) {
  if (!isObject(value) || !Array.isArray(value.nodes) || value.nodes.length !== expectedCount) {
    throw new LivingFlowApiError(502, 'schema_invalid', `Possibility map must contain exactly ${expectedCount} nodes.`, 'D', '$.nodes');
  }
  const ids = new Set();
  const nodes = value.nodes.map((node, index) => {
    const path = `$.nodes[${index}]`;
    if (!isObject(node)) throw new LivingFlowApiError(502, 'schema_invalid', 'Possibility node is invalid.', 'D', path);
    const id = requireIdentity ? cleanText(node.id) : '';
    const title = requireJapaneseText(node.title, `${path}.title`);
    const shortDescription = requireJapaneseText(node.shortDescription, `${path}.shortDescription`);
    if (requireIdentity && (!id || ids.has(id))) throw new LivingFlowApiError(502, 'schema_invalid', 'Possibility node id is invalid or duplicated.', 'D', `${path}.id`);
    if (!title || normalizePhrase(title) === normalizePhrase(parentGoal)) {
      throw new LivingFlowApiError(502, 'parent_goal_island', 'Parent Goal cannot be emitted as a possibility island.', 'D', `${path}.title`);
    }
    if (requireIdentity) ids.add(id);
    const scores = ['curiosityFit', 'accessibility', 'novelty', 'friction'];
    for (const field of scores) {
      if (!Number.isFinite(node[field]) || node[field] < 0 || node[field] > 1) {
        throw new LivingFlowApiError(502, 'schema_invalid', `Possibility score ${field} is invalid.`, 'D', `${path}.${field}`);
      }
    }
    let visualRecipe;
    if (requireVisualRecipe) {
      try { visualRecipe = validateVisualRecipe(node.visualRecipe, { vocabularyContract: true }); }
      catch { throw new LivingFlowApiError(502, 'schema_invalid', 'Node VisualRecipe is invalid.', 'D', `${path}.visualRecipe`); }
    }
    return {
      ...(requireIdentity ? { id } : {}),
      title,
      shortDescription,
      category: cleanText(node.category),
      nodeKind: node.nodeKind,
      relationToGoal: node.relationToGoal,
      curiosityFit: node.curiosityFit,
      accessibility: node.accessibility,
      novelty: node.novelty,
      friction: node.friction,
      portableResourceTags: validateStringArray(node.portableResourceTags, `${path}.portableResourceTags`, 1, 6),
      connectionTags: validateStringArray(node.connectionTags, `${path}.connectionTags`, 1, 6),
      helpedByTags: validateCanonicalBridgeTags(node.helpedByTags, `${path}.helpedByTags`, 2, 6),
      ...(requireVisualRecipe ? { visualRecipe } : {}),
    };
  });
  if (requireExploratory && !nodes.some((node) => node.relationToGoal === 'adjacent' || node.relationToGoal === 'exploratory')) {
    throw new LivingFlowApiError(502, 'missing_exploratory_node', 'Possibility map must include an adjacent or exploratory node.', 'D', '$.nodes');
  }
  return { nodes };
}

function validatePossibilityMap(value, parentGoal) {
  return validatePossibilityNodes(value, parentGoal, 6, true);
}

function validateNodeSteps(value) {
  if (!isObject(value) || !Array.isArray(value.steps) || value.steps.length !== 3) {
    throw new LivingFlowApiError(502, 'schema_invalid', 'Local Small Steps must contain exactly 3 choices.', 'D', '$.steps');
  }
  const ids = new Set();
  return { steps: value.steps.map((step, index) => {
    const path = `$.steps[${index}]`;
    if (!isObject(step)) throw new LivingFlowApiError(502, 'schema_invalid', 'Local Small Step is invalid.', 'D', path);
    const id = cleanText(step.id);
    if (!id || ids.has(id)) throw new LivingFlowApiError(502, 'schema_invalid', 'Local Small Step id is invalid or duplicated.', 'D', `${path}.id`);
    ids.add(id);
    const portableResources = validateStringArray(step.portableResources, `${path}.portableResources`, 1, 4);
    if (!Array.isArray(step.resourceBridges) || step.resourceBridges.length !== portableResources.length) {
      throw new LivingFlowApiError(502, 'schema_invalid', 'Every portable resource requires exactly one bridge mapping.', 'D', `${path}.resourceBridges`);
    }
    const resourceBridges = step.resourceBridges.map((bridge, bridgeIndex) => {
      const bridgePath = `${path}.resourceBridges[${bridgeIndex}]`;
      if (!isObject(bridge)) throw new LivingFlowApiError(502, 'schema_invalid', 'Resource bridge is invalid.', 'D', bridgePath);
      return {
        resource: cleanText(bridge.resource),
        bridgeTags: validateCanonicalBridgeTags(bridge.bridgeTags, `${bridgePath}.bridgeTags`, 1, 4),
      };
    });
    const expectedResources = new Set(portableResources.map(normalizeBridgeTag));
    const mappedResources = resourceBridges.map((bridge) => normalizeBridgeTag(bridge.resource));
    if (new Set(mappedResources).size !== portableResources.length || mappedResources.some((resource) => !expectedResources.has(resource))) {
      throw new LivingFlowApiError(502, 'schema_invalid', 'Resource bridge mappings must match portableResources exactly.', 'D', `${path}.resourceBridges`);
    }
    return {
      id,
      title: requireJapaneseText(step.title, `${path}.title`),
      shortDescription: requireJapaneseText(step.shortDescription, `${path}.shortDescription`),
      portableResources,
      connectionTags: validateStringArray(step.connectionTags, `${path}.connectionTags`, 1, 3),
      experienceTag: cleanText(step.experienceTag),
      resourceBridges,
      connectionBridgeTags: validateCanonicalBridgeTags(step.connectionBridgeTags, `${path}.connectionBridgeTags`, 0, 4),
      experienceBridgeTags: validateCanonicalBridgeTags(step.experienceBridgeTags, `${path}.experienceBridgeTags`, 0, 4),
    };
  }) };
}

function validateNodeDetail(value) {
  if (!isObject(value)) throw new LivingFlowApiError(502, 'schema_invalid', 'Node detail is invalid.', 'D', '$');
  const overview = requireJapaneseText(value.overview, '$.overview');
  const personConnection = requireJapaneseText(value.personConnection, '$.personConnection');
  const expectedOutcomes = validateStringArray(value.expectedOutcomes, '$.expectedOutcomes', 2, 5);
  if (expectedOutcomes.some((outcome) => !containsJapanese(outcome))) {
    throw new LivingFlowApiError(502, 'non_japanese_output', 'Nemotron returned non-Japanese user-facing text.', 'D', '$.expectedOutcomes');
  }
  return { overview, expectedOutcomes, personConnection };
}

function validateWorldExpansion(
  value,
  parentGoal,
  existingNodes,
  expectedCount = 6,
  requireExploratory = true,
  requireVisualRecipe = true,
  requireIdentity = true,
) {
  const result = validatePossibilityNodes(value, parentGoal, expectedCount, requireExploratory, requireVisualRecipe, requireIdentity);
  const existingIds = new Set(existingNodes.map((node) => cleanText(node?.id)).filter(Boolean));
  const accepted = [...existingNodes];
  for (let index = 0; index < result.nodes.length; index++) {
    const node = result.nodes[index];
    if (requireIdentity && existingIds.has(node.id)) {
      throw new LivingFlowApiError(502, 'duplicate_world_identity', 'World expansion identity collided with an existing node.', 'D', `$.nodes[${index}].id`);
    }
    if (accepted.some((candidate) => semanticDuplicate(candidate, node))) {
      throw new LivingFlowApiError(502, 'duplicate_world_semantic', 'World expansion regenerated an existing semantic possibility.', 'D', `$.nodes[${index}].title`);
    }
    accepted.push(node);
  }
  return result;
}

function validateSemanticCandidates(value, parentGoal, existingNodes, expectedCount) {
  if (!isObject(value) || !Array.isArray(value.nodes) || value.nodes.length !== expectedCount) {
    throw new LivingFlowApiError(502, 'schema_invalid', `Possibility batch must contain exactly ${expectedCount} candidates.`, 'D', '$.nodes');
  }
  const accepted = [];
  const rejected = [];
  value.nodes.forEach((candidate, index) => {
    try {
      const node = validatePossibilityNodes(
        { nodes: [candidate] },
        parentGoal,
        1,
        false,
        false,
        false,
      ).nodes[0];
      const duplicate = [...existingNodes, ...accepted].some((existing) => semanticDuplicate(existing, node));
      if (duplicate) {
        rejected.push({
          index,
          code: 'duplicate_world_semantic',
          path: `$.nodes[${index}].title`,
          reason: 'semantic_duplicate',
          candidate: {
            title: node.title,
            category: node.category,
            nodeKind: node.nodeKind,
            portableResourceTags: node.portableResourceTags,
            connectionTags: node.connectionTags,
            helpedByTags: node.helpedByTags,
          },
        });
        return;
      }
      accepted.push(node);
    } catch (error) {
      rejected.push({
        index,
        code: error instanceof LivingFlowApiError ? error.code : 'unknown_candidate_validation',
        path: error instanceof LivingFlowApiError ? error.validationFailurePath : `$.nodes[${index}]`,
        reason: error instanceof Error ? error.message : 'Candidate validation failed.',
        candidate: isObject(candidate) ? {
          title: cleanText(candidate.title),
          category: cleanText(candidate.category),
          nodeKind: cleanText(candidate.nodeKind),
          portableResourceTags: Array.isArray(candidate.portableResourceTags) ? candidate.portableResourceTags.map(cleanText) : [],
          connectionTags: Array.isArray(candidate.connectionTags) ? candidate.connectionTags.map(cleanText) : [],
          helpedByTags: Array.isArray(candidate.helpedByTags) ? candidate.helpedByTags.map(cleanText) : [],
        } : null,
      });
    }
  });
  return { nodes: accepted, rejected };
}

function validateVisualRecipeCollection(value, nodeIds) {
  if (!isObject(value) || !Array.isArray(value.recipes) || value.recipes.length !== nodeIds.length) {
    throw new LivingFlowApiError(502, 'schema_invalid', `Visual recipe batch must contain exactly ${nodeIds.length} recipes.`, 'D', '$.recipes');
  }
  const expectedIds = new Set(nodeIds);
  const seenIds = new Set();
  const recipes = value.recipes.map((entry, index) => {
    const path = `$.recipes[${index}]`;
    if (!isObject(entry) || !expectedIds.has(cleanText(entry.nodeId)) || seenIds.has(cleanText(entry.nodeId))) {
      throw new LivingFlowApiError(502, 'schema_invalid', 'Visual recipe node id is missing, unexpected, or duplicated.', 'D', `${path}.nodeId`);
    }
    const nodeId = cleanText(entry.nodeId);
    seenIds.add(nodeId);
    let visualRecipe;
    try { visualRecipe = validateVisualRecipe(entry.visualRecipe, { vocabularyContract: true }); }
    catch { throw new LivingFlowApiError(502, 'schema_invalid', 'Compiled VisualRecipe is invalid.', 'D', `${path}.visualRecipe`); }
    return { nodeId, visualRecipe };
  });
  if (seenIds.size !== expectedIds.size) {
    throw new LivingFlowApiError(502, 'schema_invalid', 'Visual recipe batch did not cover every node.', 'D', '$.recipes');
  }
  return { recipes };
}

function createDiagnostic(requestId, kind, maxTokens) {
  return { requestId, kind, model: null, maxTokens, retryCount: 0, stageG: false, attempts: [], finalResult: 'pending' };
}

function finishDiagnostic(diagnostic, result) {
  diagnostic.retryCount = Math.max(0, diagnostic.attempts.length - 1);
  diagnostic.stageG = diagnostic.attempts.some((attempt) => attempt.failureStage === 'G');
  diagnostic.totalLatencyMs = diagnostic.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
  diagnostic.totalUsage = diagnostic.attempts.reduce((sum, attempt) => ({
    promptTokens: sum.promptTokens + (attempt.usage?.promptTokens ?? 0),
    completionTokens: sum.completionTokens + (attempt.usage?.completionTokens ?? 0),
    totalTokens: sum.totalTokens + (attempt.usage?.totalTokens ?? 0),
    reasoningTokens: sum.reasoningTokens + (attempt.usage?.reasoningTokens ?? 0),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 });
  diagnostic.finalResult = result;
}

export function createLivingFlowApi({ apiKey, apiEnabled = false, fetchImpl = fetch, diagnosticEnabled = false, spendGuard = null }) {
  let modelPromise = null;
  const pausedError = () => new LivingFlowApiError(503, NEBIUS_API_PAUSED_CODE, NEBIUS_API_PAUSED_MESSAGE, 'A');
  const guardFor = (operation) => spendGuard?.forOperation ? spendGuard.forOperation(operation) : spendGuard;
  const guardedFetchFor = (operation) => createGuardedNebiusFetch({
    enabled: apiEnabled,
    fetchImpl,
    errorFactory: pausedError,
    spendGuard: guardFor(operation),
  });
  const discoverModel = async () => {
    assertNebiusApiEnabled(apiEnabled, pausedError);
    if (!apiKey) throw new LivingFlowApiError(503, 'missing_nebius_api_key', 'NEBIUS_API_KEY is not configured.', 'A');
    modelPromise ??= guardedFetchFor('model_discovery')(`${NEBIUS_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(async (response) => {
        if (!response.ok) throw new LivingFlowApiError(502, 'model_discovery_failed', 'Nemotron model discovery failed.', 'A');
        let payload;
        try { payload = await response.json(); }
        catch { throw new LivingFlowApiError(502, 'model_discovery_invalid_response', 'Nemotron model discovery returned an invalid response.', 'A'); }
        if (!Array.isArray(payload?.data)) {
          throw new LivingFlowApiError(502, 'model_discovery_invalid_response', 'Nemotron model discovery returned an invalid response.', 'A');
        }
        const model = payload.data.map((item) => item?.id).find((id) => typeof id === 'string' && TARGET_MODEL_PATTERN.test(id));
        if (!model) throw new LivingFlowApiError(503, 'nemotron_unavailable', 'NVIDIA Nemotron 3 Ultra is unavailable.', 'A');
        return model;
      })
      .catch((error) => {
        if (error instanceof LivingFlowApiError) throw error;
        if (error?.code === 'NEBIUS_TRANSPORT_FAILURE') {
          throw new LivingFlowApiError(502, 'nebius_transport_failed', 'Nebius model discovery could not be completed.', 'A');
        }
        if (error?.code === 'NEBIUS_HTTP_FAILURE') {
          throw new LivingFlowApiError(502, 'model_discovery_failed', 'Nemotron model discovery failed.', 'A');
        }
        throw error;
      });
    return modelPromise;
  };

  const runStructured = async ({ kind, messages, schema, validate, thinkingEnabled = false }) => {
    const maxTokens = MAX_TOKENS_BY_KIND[kind] ?? 4096;
    const diagnostic = createDiagnostic(randomUUID(), kind, maxTokens);
    diagnostic.thinkingEnabled = thinkingEnabled;
    const model = await discoverModel();
    diagnostic.model = model;
    const runAttempt = async (retryReason = '') => {
      const attempt = {
        attempt: diagnostic.attempts.length + 1,
        httpStatus: null,
        finishReason: null,
        parseSuccess: false,
        validationSuccess: false,
        validationFailurePath: null,
        failureStage: null,
        contentLength: 0,
        reasoningContentLength: 0,
        usage: null,
        latencyMs: 0,
      };
      diagnostic.attempts.push(attempt);
      const started = performance.now();
      try {
        let response;
        try {
          response = await guardedFetchFor(kind)(`${NEBIUS_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: attempt.attempt === 1 ? messages : [...messages, {
                role: 'system',
                content: `Bounded retry: return one complete JSON object only. Keep all text concise and within schema limits. Include every required field. Do not add commentary.${retryReason ? ` Correct the prior failure: ${retryReason}` : ''}`,
              }],
              response_format: { type: 'json_schema', json_schema: { name: kind, strict: true, schema } },
              temperature: 0,
              max_tokens: maxTokens,
              chat_template_kwargs: { enable_thinking: thinkingEnabled },
              stream: false,
            }),
          });
        } catch {
          throw new LivingFlowApiError(502, 'nebius_transport_failed', 'Nebius request could not be completed.', 'A');
        }
        attempt.httpStatus = response.status;
        let payload;
        try { payload = await response.json(); }
        catch { throw new LivingFlowApiError(502, 'invalid_nebius_payload', 'Nebius returned an unreadable response.', 'H'); }
        if (!response.ok) throw new LivingFlowApiError(502, 'nebius_request_failed', 'Nebius request failed.', 'A');
        const parsed = parseStructured(payload, attempt);
        const result = validate(parsed);
        attempt.validationSuccess = true;
        return result;
      } catch (error) {
        attempt.failureStage = error instanceof LivingFlowApiError ? error.failureStage : 'H';
        attempt.validationFailurePath = error instanceof LivingFlowApiError ? error.validationFailurePath : null;
        throw error;
      } finally {
        attempt.latencyMs = Math.round(performance.now() - started);
      }
    };
    let result;
    let error = null;
    try { result = await runAttempt(); }
    catch (caught) { error = caught; }
    if (error instanceof LivingFlowApiError && (
      error.failureStage === 'G'
      || error.code === 'non_japanese_output'
      || error.code === 'duplicate_world_semantic'
    )) {
      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        const retryReason = error.code === 'duplicate_world_semantic'
          ? 'A node duplicated an existing semantic possibility by title or semantic signature. Replace every duplicate with a genuinely distinct possibility absent from the supplied existing world; changing only an id is not sufficient.'
          : error.message;
        try { result = await runAttempt(retryReason); error = null; break; }
        catch (caught) { error = caught; }
      }
    }
    if (error) {
      finishDiagnostic(diagnostic, `error:${error.code ?? 'unknown'}`);
      error.diagnostic = diagnostic;
      throw error;
    }
    finishDiagnostic(diagnostic, 'success');
    return { ...result, model, diagnostic };
  };

  const combineBatchDiagnostics = (kind, batchDiagnostics, finalResult) => {
    const attempts = batchDiagnostics.flatMap(({ diagnostic, stage, batch }) => diagnostic.attempts.map((attempt) => ({
      ...attempt,
      stage,
      batch,
    })));
    return {
      requestId: randomUUID(),
      kind,
      model: batchDiagnostics[0]?.diagnostic.model ?? null,
      maxTokens: 4096,
      maxTokensPerInternalCall: 4096,
      internalCallCount: batchDiagnostics.length,
      semanticBatchCount: new Set(batchDiagnostics.filter((entry) => entry.stage === 'semantic').map((entry) => entry.batch)).size,
      visualBatchCount: new Set(batchDiagnostics.filter((entry) => entry.stage === 'visual').map((entry) => entry.batch)).size,
      retryCount: batchDiagnostics.reduce((sum, entry) => sum + entry.diagnostic.retryCount, 0),
      stageG: attempts.some((attempt) => attempt.failureStage === 'G'),
      candidateRejections: batchDiagnostics.flatMap(({ diagnostic, stage, batch }) =>
        (diagnostic.candidateRejections ?? []).map((rejection) => ({ ...rejection, stage, batch }))),
      attempts,
      finalResult,
      thinkingEnabled: false,
      totalLatencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      totalUsage: attempts.reduce((sum, attempt) => ({
        promptTokens: sum.promptTokens + (attempt.usage?.promptTokens ?? 0),
        completionTokens: sum.completionTokens + (attempt.usage?.completionTokens ?? 0),
        totalTokens: sum.totalTokens + (attempt.usage?.totalTokens ?? 0),
        reasoningTokens: sum.reasoningTokens + (attempt.usage?.reasoningTokens ?? 0),
      }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 }),
    };
  };

  const runPossibilityBatches = async ({ kind, parentGoal, systemPrompt, userPrompt, existingNodes = [], diversityDepth = 0 }) => {
    const generatedNodes = [];
    const batchDiagnostics = [];
    const recordedDiagnostics = new Set();
    let model = null;
    const recordBatchDiagnostic = (diagnostic, stage, batch) => {
      if (!diagnostic || recordedDiagnostics.has(diagnostic)) return;
      recordedDiagnostics.add(diagnostic);
      batchDiagnostics.push({ diagnostic, stage, batch });
    };
    const semanticSystemPrompt = systemPrompt
      .replace('Every node must contain a strict VisualRecipe using only the renderer vocabulary below.', 'VisualRecipe is compiled in a separate internal stage. Do not return visualRecipe in this semantic stage.')
      .replace(formatSupportedVisualVocabulary(), '');

    const runSemanticBatch = async (count, batch, acceptedNodes, recoveryRound = 0, rejectedCandidates = []) => {
      try {
        const result = await runStructured({
          kind: `${kind}_semantic_batch`,
          messages: [
            { role: 'system', content: `${semanticSystemPrompt}\nInternal semantic stage: return exactly ${count} nodes without id or visualRecipe. The server owns stable unique identity, compiles VisualRecipe separately, and deterministically merges both stages. Keep titles and descriptions concise.${explorationDiversityDirective(diversityDepth, batch, count, recoveryRound)}${recoveryRound > 0 ? ` This is candidate recovery round ${recoveryRound}; replace only rejected or missing candidates with genuinely different concepts.` : ''}${recoveryDiversityDirective(diversityDepth, batch, count, recoveryRound)}` },
            { role: 'user', content: `${userPrompt}\nNodes already accepted from earlier internal batches; do not duplicate titles, semantic signatures, or concepts:\n${JSON.stringify(acceptedNodes.map((node) => ({
              title: node.title,
              category: node.category,
              nodeKind: node.nodeKind,
              portableResourceTags: node.portableResourceTags,
              connectionTags: node.connectionTags,
              helpedByTags: node.helpedByTags,
            })))}\nCandidates rejected by prior recovery attempts; do not repeat or paraphrase these concepts:\n${JSON.stringify(rejectedCandidates)}` },
          ],
          schema: possibilitySemanticCollectionSchema(count),
          validate: (value) => validateSemanticCandidates(
            value,
            parentGoal,
            [...existingNodes, ...acceptedNodes],
            count,
          ),
          thinkingEnabled: false,
        });
        model ??= result.model;
        result.diagnostic.identitySource = 'server_uuid';
        result.diagnostic.candidateRejections = result.rejected;
        recordBatchDiagnostic(result.diagnostic, 'semantic', batch);
        const acceptedWithIds = assignServerNodeIds(result.nodes, [...existingNodes, ...acceptedNodes]);
        const missingCount = count - acceptedWithIds.length;
        if (missingCount === 0) return acceptedWithIds;
        if (recoveryRound >= MAX_CANDIDATE_RECOVERY_ROUNDS) {
          const error = new LivingFlowApiError(
            502,
            'candidate_recovery_exhausted',
            'World expansion could not produce enough safe unique candidates.',
            'D',
            result.rejected[0]?.path ?? '$.nodes',
          );
          error.diagnostic = result.diagnostic;
          throw error;
        }

        const exclusionContext = [...acceptedNodes, ...acceptedWithIds];
        const nextRejectedCandidates = [
          ...rejectedCandidates,
          ...result.rejected.map((rejection) => rejection.candidate).filter(Boolean),
        ];
        if (missingCount > 1 && recoveryRound === MAX_CANDIDATE_RECOVERY_ROUNDS - 1) {
          const recovered = [];
          for (let slot = 0; slot < missingCount; slot++) {
            const candidate = await runSemanticBatch(
              1,
              `${batch}.slot${slot + 1}`,
              [...exclusionContext, ...recovered],
              recoveryRound + 1,
              nextRejectedCandidates,
            );
            recovered.push(...candidate);
          }
          return [...acceptedWithIds, ...recovered];
        }
        const recovered = await runSemanticBatch(
          missingCount,
          `${batch}.recover${recoveryRound + 1}`,
          exclusionContext,
          recoveryRound + 1,
          nextRejectedCandidates,
        );
        return [...acceptedWithIds, ...recovered];
      } catch (error) {
        if (error?.diagnostic) recordBatchDiagnostic(error.diagnostic, 'semantic', batch);
        if (error instanceof LivingFlowApiError
          && (['A', 'C', 'D', 'G'].includes(error.failureStage) || error.code === 'duplicate_world_semantic')
          && count > 1) {
          const firstCount = Math.floor(count / 2);
          const first = await runSemanticBatch(firstCount, `${batch}.1`, acceptedNodes, recoveryRound, rejectedCandidates);
          const second = await runSemanticBatch(count - firstCount, `${batch}.2`, [...acceptedNodes, ...first], recoveryRound, rejectedCandidates);
          return [...first, ...second];
        }
        throw error;
      }
    };

    const runVisualBatch = async (nodes, batch) => {
      const nodeIds = nodes.map((node) => node.id);
      try {
        const result = await runStructured({
          kind: `${kind}_visual_batch`,
          messages: [
            {
              role: 'system',
              content: `Compile a strict VisualRecipe for every supplied semantic node. Return each nodeId exactly once. Do not alter or invent node semantics. Use only the supported renderer vocabulary. Keep arrays sparse and specific.\n${formatSupportedVisualVocabulary()}`,
            },
            {
              role: 'user',
              content: `Parent Goal context: ${parentGoal}\nSemantic nodes to compile:\n${JSON.stringify(nodes)}`,
            },
          ],
          schema: visualRecipeCollectionSchema(nodeIds),
          validate: (value) => validateVisualRecipeCollection(value, nodeIds),
          thinkingEnabled: false,
        });
        model ??= result.model;
        recordBatchDiagnostic(result.diagnostic, 'visual', batch);
        return result.recipes;
      } catch (error) {
        if (error?.diagnostic) recordBatchDiagnostic(error.diagnostic, 'visual', batch);
        if (error instanceof LivingFlowApiError && ['A', 'C', 'D', 'G'].includes(error.failureStage) && nodes.length > 1) {
          const splitAt = Math.floor(nodes.length / 2);
          const first = await runVisualBatch(nodes.slice(0, splitAt), `${batch}.1`);
          const second = await runVisualBatch(nodes.slice(splitAt), `${batch}.2`);
          return [...first, ...second];
        }
        throw error;
      }
    };

    const compileNodeWithCandidateRecovery = async (nodeIndex, recoveryRound = 0) => {
      const node = generatedNodes[nodeIndex];
      try {
        const [recipe] = await runVisualBatch([node], `node${nodeIndex + 1}.try${recoveryRound + 1}`);
        return recipe;
      } catch (error) {
        if (!(error instanceof LivingFlowApiError)
          || !['A', 'C', 'D', 'G'].includes(error.failureStage)
          || recoveryRound >= MAX_CANDIDATE_RECOVERY_ROUNDS) throw error;
        const acceptedNodes = [...generatedNodes.filter((_, index) => index !== nodeIndex), node];
        const rejectedCandidate = {
          title: node.title,
          category: node.category,
          nodeKind: node.nodeKind,
          portableResourceTags: node.portableResourceTags,
          connectionTags: node.connectionTags,
          helpedByTags: node.helpedByTags,
        };
        const [replacement] = await runSemanticBatch(
          1,
          `visual-replacement-${nodeIndex + 1}`,
          acceptedNodes,
          recoveryRound + 1,
          [rejectedCandidate],
        );
        generatedNodes[nodeIndex] = replacement;
        return compileNodeWithCandidateRecovery(nodeIndex, recoveryRound + 1);
      }
    };

    try {
      for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
        const semanticNodes = await runSemanticBatch(3, batchIndex + 1, generatedNodes);
        generatedNodes.push(...semanticNodes);
      }
      const compiledRecipes = [];
      for (let nodeIndex = 0; nodeIndex < generatedNodes.length; nodeIndex++) {
        compiledRecipes.push(await compileNodeWithCandidateRecovery(nodeIndex));
      }
      const recipeByNodeId = new Map(compiledRecipes.map((entry) => [entry.nodeId, entry.visualRecipe]));
      for (const node of generatedNodes) node.visualRecipe = recipeByNodeId.get(node.id);
    } catch (error) {
      error.diagnostic = combineBatchDiagnostics(kind, batchDiagnostics, `error:${error.code ?? 'unknown'}`);
      throw error;
    }

    const finalResult = existingNodes.length > 0
      ? validateWorldExpansion({ nodes: generatedNodes }, parentGoal, existingNodes)
      : validatePossibilityMap({ nodes: generatedNodes }, parentGoal);
    return {
      ...finalResult,
      model,
      diagnostic: combineBatchDiagnostics(kind, batchDiagnostics, 'success'),
    };
  };

  const possibilityMapMiddleware = async (req, res) => {
    try {
      if (req.method !== 'POST') throw new LivingFlowApiError(405, 'method_not_allowed', 'Use POST /api/possibility-map.', 'A');
      const body = await readJsonBody(req);
      const context = readGenerationContext(body);
      const result = await runPossibilityBatches({
        kind: 'possibility_map',
        parentGoal: context.semanticLens,
        systemPrompt: POSSIBILITY_MAP_PROMPT,
        userPrompt: generationPrompt(context),
      });
      if (diagnosticEnabled) console.info('[living-flow-diagnostic]', JSON.stringify(result.diagnostic));
      json(res, 200, { contextSeed: context.contextSeed || null, ...(context.legacy ? { parentGoal: context.contextSeed } : {}), nodes: result.nodes, model: result.model, ...(diagnosticEnabled ? { diagnostic: result.diagnostic } : {}) });
    } catch (error) {
      const status = error instanceof LivingFlowApiError ? error.status : 500;
      const code = error instanceof LivingFlowApiError ? error.code : 'internal_server_error';
      const message = error instanceof LivingFlowApiError ? error.message : 'Possibility Map generation failed.';
      if (diagnosticEnabled && error?.diagnostic) console.info('[living-flow-diagnostic]', JSON.stringify(error.diagnostic));
      json(res, status, { error: { code, message }, ...(diagnosticEnabled && error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    }
  };

  const nodeStepsMiddleware = async (req, res) => {
    try {
      if (req.method !== 'POST') throw new LivingFlowApiError(405, 'method_not_allowed', 'Use POST /api/node-steps.', 'A');
      const body = await readJsonBody(req);
      const context = readGenerationContext(body);
      const keptNode = body?.keptNode;
      if (!isObject(keptNode) || !cleanText(keptNode.title)) {
        throw new LivingFlowApiError(400, 'invalid_step_context', 'Generation context and kept node are required.', 'D');
      }
      const mapContext = Array.isArray(body?.mapContext) ? body.mapContext.map((node) => ({
        id: cleanText(node?.id),
        title: cleanText(node?.title),
        portableResourceTags: Array.isArray(node?.portableResourceTags) ? node.portableResourceTags.map(cleanText) : [],
        connectionTags: Array.isArray(node?.connectionTags) ? node.connectionTags.map(cleanText) : [],
        helpedByTags: canonicalBridgeTags(Array.isArray(node?.helpedByTags) ? node.helpedByTags : []),
      })) : [];
      const result = await runStructured({
        kind: 'local_small_steps',
        messages: [
          { role: 'system', content: NODE_STEPS_PROMPT },
          { role: 'user', content: `${generationPrompt(context)}\nKept Possibility Node:\n${JSON.stringify(keptNode)}\nSibling map tag context:\n${JSON.stringify(mapContext)}` },
        ],
        schema: NODE_STEPS_SCHEMA,
        validate: validateNodeSteps,
        thinkingEnabled: false,
      });
      if (diagnosticEnabled) console.info('[living-flow-diagnostic]', JSON.stringify(result.diagnostic));
      json(res, 200, { steps: result.steps, model: result.model, ...(diagnosticEnabled ? { diagnostic: result.diagnostic } : {}) });
    } catch (error) {
      const status = error instanceof LivingFlowApiError ? error.status : 500;
      const code = error instanceof LivingFlowApiError ? error.code : 'internal_server_error';
      const message = error instanceof LivingFlowApiError ? error.message : 'Local Small Step generation failed.';
      if (diagnosticEnabled && error?.diagnostic) console.info('[living-flow-diagnostic]', JSON.stringify(error.diagnostic));
      json(res, status, { error: { code, message }, ...(diagnosticEnabled && error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    }
  };

  const nodeDetailMiddleware = async (req, res) => {
    try {
      if (req.method !== 'POST') throw new LivingFlowApiError(405, 'method_not_allowed', 'Use POST /api/node-detail.', 'A');
      const body = await readJsonBody(req);
      const context = readGenerationContext(body);
      const node = isObject(body?.node) ? {
        id: cleanText(body.node.id),
        title: cleanText(body.node.title),
        shortDescription: cleanText(body.node.shortDescription),
        category: cleanText(body.node.category),
        nodeKind: cleanText(body.node.nodeKind),
        relationToGoal: cleanText(body.node.relationToGoal),
        portableResourceTags: Array.isArray(body.node.portableResourceTags) ? body.node.portableResourceTags.map(cleanText) : [],
        connectionTags: Array.isArray(body.node.connectionTags) ? body.node.connectionTags.map(cleanText) : [],
        helpedByTags: canonicalBridgeTags(Array.isArray(body.node.helpedByTags) ? body.node.helpedByTags : []),
      } : null;
      if (!node?.id || !node.title || !node.shortDescription) {
        throw new LivingFlowApiError(400, 'invalid_node_detail_context', 'Generation context and a complete node are required.', 'D');
      }
      const result = await runStructured({
        kind: 'node_detail',
        messages: [
          { role: 'system', content: NODE_DETAIL_PROMPT },
          { role: 'user', content: `${generationPrompt(context)}\nPossibility Node:\n${JSON.stringify(node)}` },
        ],
        schema: NODE_DETAIL_SCHEMA,
        validate: validateNodeDetail,
        thinkingEnabled: false,
      });
      if (diagnosticEnabled) console.info('[living-flow-diagnostic]', JSON.stringify(result.diagnostic));
      json(res, 200, {
        overview: result.overview,
        expectedOutcomes: result.expectedOutcomes,
        personConnection: result.personConnection,
        model: result.model,
        ...(diagnosticEnabled ? { diagnostic: result.diagnostic } : {}),
      });
    } catch (error) {
      const status = error instanceof LivingFlowApiError ? error.status : 500;
      const code = error instanceof LivingFlowApiError ? error.code : 'internal_server_error';
      const message = error instanceof LivingFlowApiError ? error.message : 'Node detail generation failed.';
      if (diagnosticEnabled && error?.diagnostic) console.info('[living-flow-diagnostic]', JSON.stringify(error.diagnostic));
      json(res, status, { error: { code, message }, ...(diagnosticEnabled && error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    }
  };

  const worldExpandMiddleware = async (req, res) => {
    try {
      if (req.method !== 'POST') throw new LivingFlowApiError(405, 'method_not_allowed', 'Use POST /api/world-expand.', 'A');
      const body = await readJsonBody(req);
      const context = readGenerationContext(body);
      const explorationBand = Number(body?.explorationBand ?? 0);
      const existingNodes = Array.isArray(body?.existingNodes) ? body.existingNodes.map((node) => ({
        id: cleanText(node?.id),
        title: cleanText(node?.title),
        shortDescription: cleanText(node?.shortDescription),
        category: cleanText(node?.category),
        nodeKind: cleanText(node?.nodeKind),
        relationToGoal: cleanText(node?.relationToGoal),
        portableResourceTags: Array.isArray(node?.portableResourceTags) ? node.portableResourceTags.map(cleanText) : [],
        connectionTags: Array.isArray(node?.connectionTags) ? node.connectionTags.map(cleanText) : [],
        helpedByTags: canonicalBridgeTags(Array.isArray(node?.helpedByTags) ? node.helpedByTags : []),
      })).filter((node) => node.id && node.title) : [];
      if (existingNodes.length < 1 || existingNodes.length > MAX_WORLD_NODE_SUMMARIES
        || !Number.isInteger(explorationBand) || explorationBand < 0 || explorationBand > MAX_WORLD_EXPANSION_BATCH) {
        throw new LivingFlowApiError(400, 'invalid_world_context', `Generation context and 1 to ${MAX_WORLD_NODE_SUMMARIES} existing node summaries are required.`, 'D');
      }
      const keptNodeIds = Array.isArray(body?.keptNodeIds) ? body.keptNodeIds.map(cleanText).filter(Boolean) : [];
      const landedNodeIds = Array.isArray(body?.landedNodeIds) ? body.landedNodeIds.map(cleanText).filter(Boolean) : [];
      const result = await runPossibilityBatches({
        kind: 'world_expansion',
        parentGoal: context.semanticLens,
        existingNodes,
        diversityDepth: explorationBand,
        systemPrompt: `${WORLD_EXPAND_PROMPT}\n${semanticDriftGuidance(explorationBand)}`,
        userPrompt: `${generationPrompt(context)}\nExploration batch / depth: ${explorationBand}\nExisting world summaries for semantic and paraphrase dedupe:\n${JSON.stringify(existingNodes)}\nExisting categories: ${JSON.stringify([...new Set(existingNodes.map((node) => node.category).filter(Boolean))])}\nExisting semantic tags: ${JSON.stringify([...new Set(existingNodes.flatMap((node) => [...node.portableResourceTags, ...node.connectionTags, ...node.helpedByTags]))])}\nKept node IDs: ${JSON.stringify(keptNodeIds)}\nLanded node IDs: ${JSON.stringify(landedNodeIds)}`,
      });
      if (diagnosticEnabled) console.info('[living-flow-diagnostic]', JSON.stringify(result.diagnostic));
      json(res, 200, { nodes: result.nodes, model: result.model, ...(diagnosticEnabled ? { diagnostic: result.diagnostic } : {}) });
    } catch (error) {
      const status = error instanceof LivingFlowApiError ? error.status : 500;
      const code = error instanceof LivingFlowApiError ? error.code : 'internal_server_error';
      const message = error instanceof LivingFlowApiError ? error.message : 'World expansion failed.';
      if (diagnosticEnabled && error?.diagnostic) console.info('[living-flow-diagnostic]', JSON.stringify(error.diagnostic));
      json(res, status, { error: { code, message }, ...(diagnosticEnabled && error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    }
  };

  return { possibilityMapMiddleware, nodeStepsMiddleware, nodeDetailMiddleware, worldExpandMiddleware };
}
