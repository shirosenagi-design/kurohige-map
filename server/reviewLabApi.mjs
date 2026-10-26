import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { createGuardedNebiusFetch, isNebiusApiEnabled } from './nebiusTransportGuard.mjs';
import { clientDataChallenge, createPasskeyService } from './passkeyService.mjs';
import { MAX_SYNC_BUNDLE_JSON_BYTES } from '../src/accountSyncContract.ts';
import { AccountSyncRepositoryError } from './postgres/postgresAccountSyncRepository.mjs';

// Section 135: a review subject is the proposed action/experience, never a place,
// book, event or community merely mentioned by the island copy.
export const REVIEW_SUBJECTS = Object.freeze([
  Object.freeze({ id: 'subject-action-visit-ueno-park', kind: 'action_experience', name: '上野公園を訪れる', referenceLabel: '公園を訪れる体験', sharingScope: 'shared_confirmed', identityVersion: 1, canonicalExperienceKey: 'visit-park:ueno', identity: Object.freeze({ action: 'visit', object: 'park', setting: 'ueno-park', qualifiers: Object.freeze([]) }) }),
  Object.freeze({ id: 'subject-action-read-galactic-railroad', kind: 'action_experience', name: '『銀河鉄道の夜』を読む', referenceLabel: '作品を読む体験', sharingScope: 'shared_confirmed', identityVersion: 1, canonicalExperienceKey: 'read-book:galactic-railroad', identity: Object.freeze({ action: 'read', object: 'book:galactic-railroad', setting: '', qualifiers: Object.freeze([]) }) }),
  Object.freeze({ id: 'subject-action-attend-comiket', kind: 'action_experience', name: 'コミックマーケットへ参加する', referenceLabel: 'イベントへ参加する体験', sharingScope: 'shared_confirmed', identityVersion: 1, canonicalExperienceKey: 'attend-event:comiket', identity: Object.freeze({ action: 'attend', object: 'event:comiket', setting: '', qualifiers: Object.freeze([]) }) }),
  Object.freeze({ id: 'subject-action-join-code-for-japan-project', kind: 'action_experience', name: 'Code for Japanのプロジェクトへ参加する', referenceLabel: 'シビックテック活動へ参加する体験', sharingScope: 'shared_confirmed', identityVersion: 1, canonicalExperienceKey: 'join-community-project:code-for-japan', identity: Object.freeze({ action: 'join', object: 'community-project:code-for-japan', setting: '', qualifiers: Object.freeze([]) }) }),
]);

// Read compatibility only. Existing records keep their original subjectId and are
// never reassigned to a new action subject automatically.
export const LEGACY_REVIEW_SUBJECTS = Object.freeze([
  Object.freeze({ id: 'subject-place-ueno-park', kind: 'place', name: '上野恩賜公園', referenceLabel: '旧仕様の場所対象', sharingScope: 'legacy_entity' }),
  Object.freeze({ id: 'subject-book-galactic-railroad', kind: 'book', name: '銀河鉄道の夜', referenceLabel: '旧仕様の書籍対象', sharingScope: 'legacy_entity' }),
  Object.freeze({ id: 'subject-event-comiket', kind: 'event', name: 'コミックマーケット', referenceLabel: '旧仕様のイベント対象', sharingScope: 'legacy_entity' }),
  Object.freeze({ id: 'subject-community-code-for-japan', kind: 'community', name: 'Code for Japan', referenceLabel: '旧仕様のコミュニティ対象', sharingScope: 'legacy_entity' }),
]);

const seedSubjectById = new Map(REVIEW_SUBJECTS.map((subject) => [subject.id, subject]));
const legacySubjectById = new Map(LEGACY_REVIEW_SUBJECTS.map((subject) => [subject.id, subject]));
const MODERATION_STATUSES = new Set(['pending_moderation', 'approved', 'rejected', 'needs_human_review']);
const REPORT_REASONS = new Set(['privacy', 'harassment', 'dangerous', 'false_information', 'spam', 'other']);
const MAX_BODY_BYTES = 32_000;
const MAX_SYNC_HTTP_BODY_BYTES = MAX_SYNC_BUNDLE_JSON_BYTES + 64 * 1024;
const MAX_REVIEW_LENGTH = 4_000;
const MAX_JOB_ATTEMPTS = 3;
const REQUIRED_LOCAL_STEP_COUNT = 3;
const WORLD_LANDING_RADIUS = 92;
const NAVIGATION_VERSION = 1;
const NAVIGATION_BERTH_GAP = 8;
const NAVIGATION_WATER_CLEARANCE = 12;
const NAVIGATION_SHIP_RADIUS = 54;
const NAVIGATION_MIN_FOUNDATION_RADIUS = 132;
const NAVIGATION_MAX_FOUNDATION_RADIUS = 142;
const SESSION_COOKIE = 'kurohige_review_session';
const AUTH_FLOW_COOKIE = 'kurohige_auth_flow';
const PASSKEY_FLOW_COOKIE = 'kurohige_passkey_flow';
const LEGACY_SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_SESSION_SECRET = 'kurohige-review-lab-local-development-session-v1';
const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const TARGET_MODEL_PATTERN = /(?:^|\/)nemotron-3-ultra(?:-|_|$)/iu;

const MODERATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'reason', 'policyLabels'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected', 'needs_human_review'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    policyLabels: {
      type: 'array', maxItems: 8,
      items: { type: 'string', enum: ['safe', 'privacy', 'harassment', 'dangerous', 'sexual', 'hate', 'self_harm', 'illegal', 'spam', 'uncertain'] },
    },
  },
};

const EXPERIENCE_RESOLUTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'confidence', 'matchedSubjectId', 'reason', 'identity'],
  properties: {
    decision: { type: 'string', enum: ['same', 'different', 'uncertain'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    matchedSubjectId: { type: 'string', maxLength: 180 },
    reason: { type: 'string', minLength: 1, maxLength: 700 },
    identity: {
      type: 'object', additionalProperties: false,
      required: ['action', 'object', 'setting', 'qualifiers', 'purpose', 'constraints'],
      properties: {
        action: { type: 'string', minLength: 1, maxLength: 120 },
        object: { type: 'string', maxLength: 180 },
        setting: { type: 'string', maxLength: 180 },
        qualifiers: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
        purpose: { type: 'string', maxLength: 180 },
        constraints: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
  },
};

const EXPERIENCE_IDENTITY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['identity'],
  properties: {
    identity: {
      type: 'object', additionalProperties: false,
      required: ['action', 'object', 'setting', 'qualifiers', 'purpose', 'constraints'],
      properties: {
        action: { type: 'string', minLength: 1, maxLength: 120 }, object: { type: 'string', maxLength: 180 },
        setting: { type: 'string', maxLength: 180 }, purpose: { type: 'string', maxLength: 180 },
        qualifiers: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
        constraints: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
  },
};

const MODERATION_PROMPT = `You moderate first-person experience reviews for a possibility-exploration product.
Return only the strict JSON schema result. Approve ordinary descriptions of lived experience, surprises, gains, difficulties, and advice.
Reject content that clearly exposes sensitive personal data, targets people with harassment or hate, solicits illegal or dangerous acts, contains sexual exploitation, or is obvious spam.
Use needs_human_review when context or severity is uncertain. Do not rewrite the review and do not infer facts about the author.`;

const EXPERIENCE_RESOLUTION_PROMPT = `You resolve whether a newly generated possibility island proposes the SAME action/experience as one existing shared experience subject.
The review subject is the action and lived experience itself, never a location, facility, title, topic, or keyword alone.
Compare action, object, setting, method, purpose, scale, audience, and important constraints. A shared place does not make different actions the same. A larger goal or materially different outcome is different from performing one concrete action.
Return same only with high confidence and only when one supplied subject ID is an exact semantic match despite wording differences. Return different when the proposed experience is sufficiently clear but no candidate is the same. Return uncertain when essential meaning is ambiguous. Never invent a subject ID.
Extract a compact language-neutral identity. Keep action/object/setting/purpose as normalized English identifiers or short phrases, and qualifiers/constraints sparse. Explain the decisive semantic evidence.`;

const EXPERIENCE_IDENTITY_PROMPT = `Extract the concrete action/experience proposed by one possibility island.
Return only the strict schema. Normalize action, object, setting, method qualifiers, purpose, and important constraints into compact English identifiers or short phrases.
Preserve distinctions in objective, scale, audience, method, and outcome. A place or topic is not the experience by itself. Do not decide a match and do not invent details that the proposal does not contain.`;

export class ReviewLabError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, value, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [name, headerValue] of Object.entries(headers)) res.setHeader(name, headerValue);
  res.end(JSON.stringify(value));
}

function html(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.end(value);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ReviewLabError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ReviewLabError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

async function readSyncJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SYNC_HTTP_BODY_BYTES) throw new ReviewLabError(413, 'sync_payload_too_large', 'Sync request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ReviewLabError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

const cleanText = (value, maxLength) => typeof value === 'string'
  ? value.trim().replace(/\r\n/gu, '\n').slice(0, maxLength)
  : '';
const cleanId = (value, maxLength = 160) => {
  const id = cleanText(value, maxLength);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(id) ? id : '';
};
const normalizeEmail = (value) => {
  const input = cleanText(value, 254).normalize('NFKC');
  const at = input.lastIndexOf('@');
  if (at <= 0 || at !== input.indexOf('@')) return '';
  const local = input.slice(0, at).toLowerCase();
  const domain = domainToASCII(input.slice(at + 1)).toLowerCase();
  if (!local || local.length > 64 || !domain || domain.length > 253) return '';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) return '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) return '';
  return `${local}@${domain}`;
};
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseAge(value) {
  if (value === null || value === undefined || value === '') return null;
  const age = Number(value);
  if (!Number.isInteger(age) || age < 0 || age > 120) throw new ReviewLabError(400, 'invalid_age', 'Age must be a whole number between 0 and 120.');
  return age;
}

function validateDraft(value) {
  const subjectId = cleanId(value?.subjectId);
  const sourceNodeId = cleanId(value?.sourceNodeId) || null;
  const body = cleanText(value?.body, MAX_REVIEW_LENGTH);
  const occupation = cleanText(value?.authorSnapshot?.occupation, 160) || null;
  const age = parseAge(value?.authorSnapshot?.age);
  if (!subjectId) throw new ReviewLabError(400, 'unknown_subject', 'Select a known review subject.');
  if (body.length < 20) throw new ReviewLabError(400, 'review_too_short', 'Review body must contain at least 20 characters.');
  return {
    subjectId, sourceNodeId, body,
    authorSnapshot: {
      age, occupation,
      shareAge: value?.authorSnapshot?.shareAge === true,
      shareOccupation: value?.authorSnapshot?.shareOccupation === true,
    },
  };
}

function emptyDatabase() {
  return {
    version: 6, reviews: [], helpfulVotes: [], reports: [], users: [], bindings: [], reviewSubjects: [],
    verifiedNodeSubjects: [], landingJourneys: [], moderationJobs: [], experienceResolutions: [], experienceSubjectLinks: [], subjectCorrections: [], auditLog: [],
  };
}

function migratedReview(review) {
  const status = MODERATION_STATUSES.has(review?.moderationStatus) ? review.moderationStatus : 'pending_moderation';
  return {
    ...review,
    sourceNodeId: cleanId(review?.sourceNodeId) || null,
    moderationStatus: status,
    authorSnapshot: {
      age: Number.isInteger(review?.authorSnapshot?.age) ? review.authorSnapshot.age : null,
      occupation: cleanText(review?.authorSnapshot?.occupation, 160) || null,
      capturedAt: cleanText(review?.authorSnapshot?.capturedAt, 64) || review?.createdAt || new Date(0).toISOString(),
      shareAge: review?.authorSnapshot?.shareAge === true,
      shareOccupation: review?.authorSnapshot?.shareOccupation === true,
    },
    moderation: isObject(review?.moderation) ? review.moderation : null,
    hiddenAt: cleanText(review?.hiddenAt, 64) || null,
  };
}

function normalizeDatabase(value) {
  if (!isObject(value) || !Array.isArray(value.reviews)) return emptyDatabase();
  return {
    version: 6,
    reviews: value.reviews.map(migratedReview),
    helpfulVotes: Array.isArray(value.helpfulVotes) ? value.helpfulVotes : [],
    reports: Array.isArray(value.reports) ? value.reports : [],
    users: Array.isArray(value.users) ? value.users : [],
    bindings: Array.isArray(value.bindings) ? value.bindings : [],
    reviewSubjects: Array.isArray(value.reviewSubjects) ? value.reviewSubjects : [],
    verifiedNodeSubjects: Array.isArray(value.verifiedNodeSubjects) ? value.verifiedNodeSubjects : [],
    landingJourneys: Array.isArray(value.landingJourneys) ? value.landingJourneys : [],
    moderationJobs: Array.isArray(value.moderationJobs) ? value.moderationJobs : [],
    experienceResolutions: Array.isArray(value.experienceResolutions) ? value.experienceResolutions : [],
    experienceSubjectLinks: Array.isArray(value.experienceSubjectLinks) ? value.experienceSubjectLinks : [],
    subjectCorrections: Array.isArray(value.subjectCorrections) ? value.subjectCorrections : [],
    auditLog: Array.isArray(value.auditLog) ? value.auditLog : [],
  };
}

function reviewSubject(database, subjectId) {
  return database.reviewSubjects.find((subject) => subject.id === subjectId)
    ?? seedSubjectById.get(subjectId)
    ?? legacySubjectById.get(subjectId)
    ?? null;
}

function publicSubjectCatalog(database) {
  return [
    ...REVIEW_SUBJECTS,
    ...database.reviewSubjects.filter((subject) => subject.sharingScope === 'shared_confirmed'),
  ];
}

function normalizeIdentityPart(value, maxLength = 240) {
  return cleanText(value, maxLength).normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, ' ');
}

function validateActionIdentity(value) {
  const canonicalExperienceKey = cleanId(value?.canonicalExperienceKey, 180);
  const action = normalizeIdentityPart(value?.action);
  const object = normalizeIdentityPart(value?.object);
  const setting = normalizeIdentityPart(value?.setting);
  const qualifiers = Array.isArray(value?.qualifiers)
    ? [...new Set(value.qualifiers.map((entry) => normalizeIdentityPart(entry, 120)).filter(Boolean))].sort()
    : [];
  if (!canonicalExperienceKey || !action) {
    throw new ReviewLabError(400, 'invalid_action_identity', 'A canonical experience key and explicit action are required.');
  }
  const canonical = { identityVersion: 1, action, object, setting, qualifiers };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { canonicalExperienceKey, ...canonical, fingerprint };
}

function validateIslandSubjectCandidate(value) {
  const name = cleanText(value?.name, 180);
  const summary = cleanText(value?.summary, 600);
  const category = cleanText(value?.category, 120);
  const nodeKind = cleanText(value?.nodeKind, 80);
  const semanticTags = [...new Set([
    ...(Array.isArray(value?.portableResourceTags) ? value.portableResourceTags : []),
    ...(Array.isArray(value?.connectionTags) ? value.connectionTags : []),
    ...(Array.isArray(value?.helpedByTags) ? value.helpedByTags : []),
  ].map((entry) => normalizeIdentityPart(entry, 120)).filter(Boolean))].slice(0, 24);
  if (!name) throw new ReviewLabError(400, 'invalid_action_subject', 'The island action label is required.');
  return { name, summary, category, nodeKind, semanticTags };
}

function candidateSignature(candidate) {
  const canonical = {
    name: normalizeIdentityPart(candidate.name), summary: normalizeIdentityPart(candidate.summary, 600),
    category: normalizeIdentityPart(candidate.category, 120), nodeKind: normalizeIdentityPart(candidate.nodeKind, 80),
    semanticTags: [...candidate.semanticTags].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function normalizeResolvedIdentity(value) {
  const action = normalizeIdentityPart(value?.action, 120);
  const object = normalizeIdentityPart(value?.object, 180);
  const setting = normalizeIdentityPart(value?.setting, 180);
  const purpose = normalizeIdentityPart(value?.purpose, 180);
  const qualifiers = Array.isArray(value?.qualifiers)
    ? [...new Set(value.qualifiers.map((entry) => normalizeIdentityPart(entry, 120)).filter(Boolean))].sort()
    : [];
  const constraints = Array.isArray(value?.constraints)
    ? [...new Set(value.constraints.map((entry) => normalizeIdentityPart(entry, 120)).filter(Boolean))].sort()
    : [];
  if (!action) return null;
  const canonical = { identityVersion: 2, action, object, setting, qualifiers, purpose, constraints };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, fingerprint };
}

function sharedSubjectForFingerprint(database, fingerprint) {
  return publicSubjectCatalog(database).find((subject) => subject.identity?.fingerprint === fingerprint) ?? null;
}

function ensureSharedResolvedSubject(database, candidate, identity, actor) {
  const existing = sharedSubjectForFingerprint(database, identity.fingerprint);
  if (existing) return existing;
  const canonicalExperienceKey = `auto-v2:${identity.fingerprint.slice(0, 32)}`;
  const id = `subject-action-${identity.fingerprint.slice(0, 24)}`;
  const now = new Date().toISOString();
  const subject = {
    id, kind: 'action_experience', name: candidate.name,
    referenceLabel: candidate.summary || 'この島が提案する行動・体験',
    sharingScope: 'shared_confirmed', identityVersion: 2, canonicalExperienceKey,
    identity: { ...identity }, createdAt: now, verifiedAt: now, verifiedBy: actor.userId,
  };
  database.reviewSubjects.push(subject);
  audit(database, actor, 'resolver.shared_subject_created', 'subject', id, { canonicalExperienceKey, fingerprint: identity.fingerprint });
  return subject;
}

function addFeature(features, key, weight) {
  if (key) features.set(key, (features.get(key) ?? 0) + weight);
}

function addTextFeatures(features, value, weight = 1) {
  const normalized = normalizeIdentityPart(value, 2_000);
  for (const token of normalized.split(/[\s,./:;|・、。()（）「」『』]+/u).filter((entry) => entry.length >= 2)) addFeature(features, `token:${token}`, weight * 2);
  const compact = normalized.replace(/[\s,./:;|・、。()（）「」『』「」！？!?ー_-]+/gu, '');
  const characters = [...compact];
  for (const width of [2, 3]) {
    for (let index = 0; index <= characters.length - width; index += 1) addFeature(features, `char${width}:${characters.slice(index, index + width).join('')}`, weight);
  }
}

function candidateFeatures(candidate, resolvedIdentity = null) {
  const features = new Map();
  addTextFeatures(features, candidate.name, 3);
  addTextFeatures(features, candidate.summary, 1);
  addTextFeatures(features, `${candidate.category} ${candidate.nodeKind}`, 1.5);
  for (const tag of candidate.semanticTags) addFeature(features, `semantic:${normalizeIdentityPart(tag, 120)}`, 8);
  if (resolvedIdentity) {
    for (const value of [resolvedIdentity.action, resolvedIdentity.object, resolvedIdentity.setting, resolvedIdentity.purpose, ...(resolvedIdentity.qualifiers ?? []), ...(resolvedIdentity.constraints ?? [])]) {
      const normalized = normalizeIdentityPart(value, 180);
      addTextFeatures(features, normalized, 2);
      addFeature(features, `semantic:${normalized}`, 12);
    }
  }
  return features;
}

function subjectFeatures(subject) {
  const features = new Map(); const identity = subject.identity ?? {};
  addTextFeatures(features, subject.name, 3);
  addTextFeatures(features, subject.referenceLabel, 1);
  for (const value of [identity.action, identity.object, identity.setting, identity.purpose, ...(identity.qualifiers ?? []), ...(identity.constraints ?? [])]) {
    const normalized = normalizeIdentityPart(value, 180);
    addTextFeatures(features, normalized, 1.5);
    addFeature(features, `semantic:${normalized}`, 8);
  }
  return features;
}

function resolverRegistry(database) {
  const dynamic = database.reviewSubjects.filter((subject) => subject.kind === 'action_experience'
    && (subject.sharingScope === 'shared_confirmed'
      || (subject.sharingScope === 'island_specific' && (database.reviews.some((review) => review.subjectId === subject.id)
        || database.landingJourneys.some((journey) => journey.subjectId === subject.id && journey.landedAt)))));
  return [...REVIEW_SUBJECTS, ...dynamic];
}

function createResolverIndex(database) {
  const registry = resolverRegistry(database);
  const targets = registry.map((subject) => ({ subject, features: subjectFeatures(subject) }));
  const documentFrequency = new Map();
  for (const { features } of targets) for (const feature of features.keys()) documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
  return { registrySize: registry.length, targets, documentFrequency };
}

function resolverCandidates(database, candidate, limit = 24, suppliedIndex = null, resolvedIdentity = null) {
  const source = candidateFeatures(candidate, resolvedIdentity);
  const index = suppliedIndex ?? createResolverIndex(database);
  const { registrySize, targets, documentFrequency } = index;
  const idf = (feature) => Math.log((registrySize + 1) / ((documentFrequency.get(feature) ?? 0) + 1)) + 1;
  const sourceNormSquared = [...source].reduce((sum, [feature, weight]) => sum + (weight * idf(feature)) ** 2, 0) || 1;
  return targets
    .map(({ subject, features }) => {
      let dot = 0;
      for (const [feature, weight] of features) {
        if (source.has(feature)) dot += source.get(feature) * weight * idf(feature) ** 2;
      }
      return { subject, score: dot / sourceNormSquared };
    })
    .sort((left, right) => right.score - left.score || left.subject.id.localeCompare(right.subject.id, 'en'))
    .slice(0, limit)
    .map(({ subject }) => subject);
}

function activeExperienceSubjectLink(database, sourceSubjectId) {
  return [...database.experienceSubjectLinks].reverse().find((entry) => entry.sourceSubjectId === sourceSubjectId && entry.status === 'active') ?? null;
}

function ensureExperienceSubjectLink(database, sourceSubjectId, sharedSubjectId, actor, metadata = {}) {
  const existing = activeExperienceSubjectLink(database, sourceSubjectId);
  if (existing?.sharedSubjectId === sharedSubjectId) return existing;
  if (existing) existing.status = 'superseded';
  const link = {
    id: `experience_subject_link_${randomUUID()}`, sourceSubjectId, sharedSubjectId,
    status: 'active', reason: cleanText(metadata.reason, 700) || 'Resolver confirmed the shared action experience.',
    resolutionId: cleanId(metadata.resolutionId) || null, createdAt: new Date().toISOString(), createdBy: actor.userId,
  };
  database.experienceSubjectLinks.push(link);
  audit(database, actor, 'resolver.subject_linked', 'subject', sourceSubjectId, { sharedSubjectId, reason: link.reason });
  return link;
}

function publicExperienceSubjectIds(database, subjectId) {
  const directLink = activeExperienceSubjectLink(database, subjectId);
  const sharedSubjectId = directLink?.sharedSubjectId
    ?? (reviewSubject(database, subjectId)?.sharingScope === 'shared_confirmed' ? subjectId : null);
  if (!sharedSubjectId) return new Set([subjectId]);
  return new Set([
    sharedSubjectId,
    ...database.experienceSubjectLinks.filter((entry) => entry.status === 'active' && entry.sharedSubjectId === sharedSubjectId).map((entry) => entry.sourceSubjectId),
  ]);
}

const terminalExperienceResolution = (entry) => Boolean(entry && !['paused', 'error'].includes(entry.method));

const publicAuthorSnapshot = (snapshot) => ({
  age: snapshot.shareAge ? snapshot.age : null,
  occupation: snapshot.shareOccupation ? snapshot.occupation : null,
});

function audit(database, actor, action, targetType, targetId, metadata = {}) {
  database.auditLog.push({
    id: `audit_${randomUUID()}`, actorId: actor.userId, actorRole: actor.role,
    action, targetType, targetId, at: new Date().toISOString(), metadata,
  });
  if (database.auditLog.length > 10_000) database.auditLog.splice(0, database.auditLog.length - 10_000);
}

const userRecord = (database, userId) => database.users.find((user) => user.id === userId);
function assertNotFrozen(database, userId) {
  if (userRecord(database, userId)?.frozen) throw new ReviewLabError(403, 'review_access_frozen', 'Review access is frozen for this account.');
}

const verifiedNodeSubject = (database, userId, nodeId) => database.verifiedNodeSubjects
  .find((entry) => entry.userId === userId && entry.nodeId === nodeId);
const landingJourney = (database, userId, nodeId) => database.landingJourneys
  .find((entry) => entry.userId === userId && entry.nodeId === nodeId);

function createIslandSpecificSubject(database, candidate, actor) {
  const details = validateIslandSubjectCandidate(candidate);
  const now = new Date().toISOString();
  const subject = {
    id: `subject-action-island-${randomUUID()}`,
    kind: 'action_experience',
    name: details.name,
    referenceLabel: details.summary || 'この島が提案する行動・体験',
    sharingScope: 'island_specific',
    identityVersion: 1,
    canonicalExperienceKey: null,
    identity: { actionLabel: details.name, summary: details.summary, category: details.category, nodeKind: details.nodeKind },
    createdAt: now,
  };
  database.reviewSubjects.push(subject);
  return subject;
}

function ensureIslandSpecificSubject(database, userId, nodeId, candidate, actor) {
  const existingMapping = verifiedNodeSubject(database, userId, nodeId);
  if (existingMapping) return { mapping: existingMapping, subject: reviewSubject(database, existingMapping.subjectId), created: false };
  const subject = createIslandSpecificSubject(database, candidate, actor);
  const now = new Date().toISOString();
  const mapping = {
    userId, nodeId, subjectId: subject.id, verifiedAt: now, verifiedBy: actor.userId,
    provenance: 'island_specific_unresolved',
  };
  database.verifiedNodeSubjects.push(mapping);
  audit(database, actor, 'node_subject.island_specific_created', 'node', nodeId, { subjectId: subject.id });
  return { mapping, subject, created: true };
}
function uniqueStepIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((entry) => cleanId(entry, 180)).filter(Boolean);
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : [];
}
function finitePoint(value) {
  return isObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: Number(value.x), y: Number(value.y) }
    : null;
}
function projectedPoint(value) {
  return { x: value.x + value.y * .1, y: value.y * .72 };
}
function navigationDepthScale(renderY) {
  return .82 + Math.max(0, Math.min(1, (renderY + 230) / 500)) * .26;
}
function validNavigationAnchor(ownerTarget, landingAnchor) {
  const target = projectedPoint(ownerTarget);
  const anchor = projectedPoint(landingAnchor);
  const scale = navigationDepthScale(target.y);
  const distance = Math.hypot(anchor.x - target.x, anchor.y - target.y);
  const minimum = (NAVIGATION_MIN_FOUNDATION_RADIUS + NAVIGATION_SHIP_RADIUS) * scale
    + NAVIGATION_WATER_CLEARANCE + NAVIGATION_BERTH_GAP - 2;
  const maximum = (NAVIGATION_MAX_FOUNDATION_RADIUS + NAVIGATION_SHIP_RADIUS) * scale
    + NAVIGATION_WATER_CLEARANCE + NAVIGATION_BERTH_GAP + 2;
  return { valid: distance >= minimum && distance <= maximum, distance, minimum, maximum };
}

function enqueueJob(database, review, reason, now = new Date().toISOString()) {
  const jobKey = `${review.id}:${review.revision}:${reason}`;
  if (database.moderationJobs.some((job) => job.jobKey === jobKey)) return;
  database.moderationJobs.push({
    id: `moderation_${randomUUID()}`, jobKey, reviewId: review.id, reviewRevision: review.revision,
    reason, status: 'waiting', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
  });
}

function decoratedReview(database, review, viewerId, own = false) {
  const helpfulVotes = database.helpfulVotes.filter((vote) => vote.reviewId === review.id);
  const common = {
    id: review.id, subjectId: review.subjectId, body: review.body,
    authorSnapshot: own ? review.authorSnapshot : publicAuthorSnapshot(review.authorSnapshot),
    createdAt: review.createdAt, updatedAt: review.updatedAt, revision: review.revision,
    helpfulCount: helpfulVotes.length,
    viewerHasHelpful: Boolean(viewerId && helpfulVotes.some((vote) => vote.userId === viewerId)),
  };
  return own ? {
    ...common, sourceNodeId: review.sourceNodeId, moderationStatus: review.moderationStatus,
    moderation: review.moderation ? { reason: review.moderation.reason, checkedAt: review.moderation.checkedAt, method: review.moderation.method } : null,
  } : common;
}

export function createReviewLabRepository(storagePath) {
  let mutation = Promise.resolve();
  const load = async () => {
    try { return normalizeDatabase(JSON.parse(await readFile(storagePath, 'utf8'))); }
    catch (error) { if (error?.code === 'ENOENT') return emptyDatabase(); throw error; }
  };
  const save = async (database) => {
    await mkdir(path.dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporaryPath, storagePath); break; }
      catch (error) {
        if (!['EPERM', 'EACCES'].includes(error?.code) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  };
  const mutate = (operation) => {
    const next = mutation.then(async () => {
      const database = await load();
      const result = await operation(database);
      await save(database);
      return result;
    });
    mutation = next.catch(() => undefined);
    return next;
  };

  return createReviewLabRepositoryFromPersistence({ load, mutate });
}

export function createReviewLabRepositoryFromPersistence({ load, mutate: persistMutation }) {
  if (typeof load !== 'function' || typeof persistMutation !== 'function') {
    throw new TypeError('Review repository persistence requires load and mutate functions.');
  }
  let resolverIndexCache = null;
  const mutate = async (operation) => {
    const result = await persistMutation(operation);
    resolverIndexCache = null;
    return result;
  };
  return {
    async listSubjects() {
      return publicSubjectCatalog(await load()).map((subject) => structuredClone(subject));
    },
    async nodeReviewContext(nodeId, actor) {
      const cleanNodeId = cleanId(nodeId);
      if (!cleanNodeId) throw new ReviewLabError(400, 'invalid_node_id', 'A valid personal Node ID is required.');
      const database = await load();
      const mapping = verifiedNodeSubject(database, actor.userId, cleanNodeId);
      const journey = landingJourney(database, actor.userId, cleanNodeId);
      const frozen = userRecord(database, actor.userId)?.frozen === true;
      return {
        nodeId: cleanNodeId,
        subject: mapping ? reviewSubject(database, mapping.subjectId) : null,
        eligibility: {
          canPost: Boolean(mapping && journey?.landedAt && journey.subjectId === mapping.subjectId && !frozen),
          landedAt: journey?.landedAt ?? null,
          frozen,
          reason: frozen ? 'review_access_frozen' : !mapping ? 'subject_not_verified' : !journey?.landedAt ? 'landing_required' : 'eligible',
        },
      };
    },
    ensureIslandSubject(nodeId, value, actor) {
      const cleanNodeId = cleanId(nodeId);
      if (!cleanNodeId) throw new ReviewLabError(400, 'invalid_node_id', 'A valid personal Node ID is required.');
      const candidate = validateIslandSubjectCandidate(value);
      return mutate((database) => {
        const ensured = ensureIslandSpecificSubject(database, actor.userId, cleanNodeId, candidate, actor);
        return { nodeId: cleanNodeId, subject: structuredClone(ensured.subject), created: ensured.created };
      });
    },
    async prepareExperienceResolution(nodeId, value, actor, retrievalIdentity = null) {
      const cleanNodeId = cleanId(nodeId);
      if (!cleanNodeId) throw new ReviewLabError(400, 'invalid_node_id', 'A valid personal Node ID is required.');
      const candidate = validateIslandSubjectCandidate(value);
      const normalizedRetrievalIdentity = normalizeResolvedIdentity(retrievalIdentity);
      const signature = candidateSignature(candidate);
      const database = await load();
      const existing = verifiedNodeSubject(database, actor.userId, cleanNodeId);
      const existingSubject = existing ? reviewSubject(database, existing.subjectId) : null;
      const previousResolution = [...database.experienceResolutions].reverse()
        .find((entry) => entry.userId === actor.userId && entry.nodeId === cleanNodeId && entry.status === 'active');
      if ((existingSubject && existingSubject.sharingScope !== 'island_specific') || terminalExperienceResolution(previousResolution)) {
        return { nodeId: cleanNodeId, candidate, signature, existingSubject: existingSubject ? structuredClone(existingSubject) : null, cachedSubject: null, candidates: [] };
      }
      const cached = [...database.experienceResolutions].reverse().find((entry) => entry.candidateSignature === signature && entry.status !== 'superseded' && ['same', 'different'].includes(entry.decision));
      const cachedSubject = cached ? reviewSubject(database, cached.subjectId) : null;
      const identityMatchedSubject = normalizedRetrievalIdentity ? sharedSubjectForFingerprint(database, normalizedRetrievalIdentity.fingerprint) : null;
      const index = resolverIndexCache ??= createResolverIndex(database);
      return {
        nodeId: cleanNodeId, candidate, signature, existingSubject: null,
        existingIslandSubject: existingSubject ? structuredClone(existingSubject) : null,
        cachedSubject: cachedSubject?.sharingScope === 'shared_confirmed' ? structuredClone(cachedSubject) : null,
        identityMatchedSubject: identityMatchedSubject?.sharingScope === 'shared_confirmed' ? structuredClone(identityMatchedSubject) : null,
        registrySize: index.registrySize,
        candidates: resolverCandidates(database, candidate, 24, index, normalizedRetrievalIdentity).map((subject) => structuredClone(subject)),
      };
    },
    applyExperienceResolution(nodeId, value, actor, resolution) {
      const cleanNodeId = cleanId(nodeId);
      if (!cleanNodeId) throw new ReviewLabError(400, 'invalid_node_id', 'A valid personal Node ID is required.');
      const candidate = validateIslandSubjectCandidate(value);
      const signature = candidateSignature(candidate);
      return mutate((database) => {
        const existing = verifiedNodeSubject(database, actor.userId, cleanNodeId);
        const existingSubject = existing ? reviewSubject(database, existing.subjectId) : null;
        const previousResolution = [...database.experienceResolutions].reverse()
          .find((entry) => entry.userId === actor.userId && entry.nodeId === cleanNodeId && entry.status === 'active');
        if ((existingSubject && existingSubject.sharingScope !== 'island_specific') || terminalExperienceResolution(previousResolution)) {
          return { nodeId: cleanNodeId, subject: structuredClone(existingSubject), created: false, resolution: previousResolution ? structuredClone(previousResolution) : null };
        }

        const cached = [...database.experienceResolutions].reverse().find((entry) => entry.candidateSignature === signature && entry.status !== 'superseded' && ['same', 'different'].includes(entry.decision));
        const cachedSubject = cached ? reviewSubject(database, cached.subjectId) : null;
        const decision = cleanId(resolution?.decision, 32);
        const confidence = cleanId(resolution?.confidence, 32);
        const matchedSubjectId = cleanId(resolution?.matchedSubjectId);
        const reason = cleanText(resolution?.reason, 700) || 'Resolver did not provide a reason.';
        const comparedSubjectIds = Array.isArray(resolution?.comparedSubjectIds)
          ? [...new Set(resolution.comparedSubjectIds.map((entry) => cleanId(entry)).filter(Boolean))]
          : [];
        const identity = normalizeResolvedIdentity(resolution?.identity);
        const resolutionId = `experience_resolution_${randomUUID()}`;
        let subject = cachedSubject?.sharingScope === 'shared_confirmed' ? cachedSubject : null;
        let effectiveDecision = subject ? cached.decision : decision;
        let method = subject ? 'cache' : cleanId(resolution?.method, 40) || 'fallback';
        let linkedSharedSubjectId = null;

        if (!subject && decision === 'same' && confidence === 'high') {
          const matched = reviewSubject(database, matchedSubjectId);
          if (matched?.sharingScope === 'shared_confirmed' && comparedSubjectIds.includes(matchedSubjectId)) subject = matched;
          else if (matched?.sharingScope === 'island_specific' && comparedSubjectIds.includes(matchedSubjectId) && identity) {
            subject = ensureSharedResolvedSubject(database, candidate, identity, { userId: 'system:experience-resolver', role: 'system' });
            ensureExperienceSubjectLink(database, matched.id, subject.id, { userId: 'system:experience-resolver', role: 'system' }, { reason, resolutionId });
            linkedSharedSubjectId = subject.id;
          }
          else effectiveDecision = 'uncertain';
        }
        if (!subject && decision === 'different' && ['high', 'medium'].includes(confidence) && identity) {
          subject = ensureSharedResolvedSubject(database, candidate, identity, { userId: 'system:experience-resolver', role: 'system' });
        }
        const existingJourney = landingJourney(database, actor.userId, cleanNodeId);
        const existingReviews = database.reviews.filter((entry) => entry.authorId === actor.userId && entry.sourceNodeId === cleanNodeId);
        const canUpgradeExistingIsland = Boolean(existing && existingSubject?.sharingScope === 'island_specific'
          && !existingJourney?.landedAt && existingReviews.length === 0);
        if (subject && existing && !canUpgradeExistingIsland) {
          linkedSharedSubjectId = subject.id;
          ensureExperienceSubjectLink(database, existingSubject.id, subject.id, { userId: 'system:experience-resolver', role: 'system' }, { reason, resolutionId });
          subject = existingSubject;
          method = 'existing_history_link';
        }
        if (!subject) {
          effectiveDecision = 'uncertain';
          const ensured = ensureIslandSpecificSubject(database, actor.userId, cleanNodeId, candidate, actor);
          subject = ensured.subject;
        } else if (!existing) {
          const now = new Date().toISOString();
          database.verifiedNodeSubjects.push({
            userId: actor.userId, nodeId: cleanNodeId, subjectId: subject.id, verifiedAt: now,
            verifiedBy: method === 'cache' ? 'system:experience-cache' : 'system:experience-resolver',
            provenance: method === 'cache' ? 'resolver_cache' : effectiveDecision === 'same' ? 'resolver_semantic_same' : 'resolver_new_shared',
          });
        } else if (canUpgradeExistingIsland) {
          existing.subjectId = subject.id;
          existing.verifiedAt = new Date().toISOString();
          existing.verifiedBy = method === 'cache' ? 'system:experience-cache' : 'system:experience-resolver';
          existing.provenance = method === 'cache' ? 'resolver_cache_upgrade' : effectiveDecision === 'same' ? 'resolver_semantic_same_upgrade' : 'resolver_new_shared_upgrade';
          if (existingJourney) { existingJourney.subjectId = subject.id; existingJourney.updatedAt = existing.verifiedAt; }
          for (const binding of database.bindings.filter((entry) => entry.userId === actor.userId && entry.nodeId === cleanNodeId)) {
            binding.subjectId = subject.id; binding.updatedAt = existing.verifiedAt;
          }
        }

        const now = new Date().toISOString();
        for (const entry of database.experienceResolutions.filter((item) => item.userId === actor.userId && item.nodeId === cleanNodeId && item.status === 'active')) entry.status = 'superseded';
        const record = {
          id: resolutionId, userId: actor.userId, nodeId: cleanNodeId,
          candidateSignature: signature, candidate, decision: effectiveDecision, confidence,
          reason, comparedSubjectIds, matchedSubjectId: effectiveDecision === 'same' ? matchedSubjectId || linkedSharedSubjectId : null,
          subjectId: subject.id, linkedSharedSubjectId, identity, method, model: cleanText(resolution?.model, 180) || null,
          diagnostic: isObject(resolution?.diagnostic) ? {
            finishReason: cleanText(resolution.diagnostic.finishReason, 80) || null,
            usage: isObject(resolution.diagnostic.usage) ? {
              promptTokens: Number.isFinite(resolution.diagnostic.usage.promptTokens) ? resolution.diagnostic.usage.promptTokens : null,
              completionTokens: Number.isFinite(resolution.diagnostic.usage.completionTokens) ? resolution.diagnostic.usage.completionTokens : null,
              totalTokens: Number.isFinite(resolution.diagnostic.usage.totalTokens) ? resolution.diagnostic.usage.totalTokens : null,
              reasoningTokens: Number.isFinite(resolution.diagnostic.usage.reasoningTokens) ? resolution.diagnostic.usage.reasoningTokens : null,
            } : null,
          } : null,
          extractionDiagnostic: isObject(resolution?.extractionDiagnostic) ? structuredClone(resolution.extractionDiagnostic) : null,
          status: 'active', createdAt: now,
        };
        database.experienceResolutions.push(record);
        audit(database, { userId: 'system:experience-resolver', role: 'system' }, `resolver.${effectiveDecision}`, 'node', cleanNodeId, {
          targetUserId: actor.userId, subjectId: subject.id, confidence, method, comparedSubjectIds, reason,
        });
        return { nodeId: cleanNodeId, subject: structuredClone(subject), created: true, resolution: structuredClone(record) };
      });
    },
    async listExperienceResolutions() {
      const database = await load();
      return database.experienceResolutions.slice(-500).reverse().map((entry) => structuredClone(entry));
    },
    correctNodeSubject(userId, nodeId, value, actor) {
      if (actor.role !== 'admin') throw new ReviewLabError(403, 'admin_required', 'Administrator access is required.');
      const targetUserId = cleanId(userId, 120); const cleanNodeId = cleanId(nodeId);
      const reason = cleanText(value?.reason, 700);
      if (!targetUserId || !cleanNodeId || !reason) throw new ReviewLabError(400, 'invalid_subject_correction', 'Account, Node, and correction reason are required.');
      return mutate((database) => {
        const mapping = verifiedNodeSubject(database, targetUserId, cleanNodeId);
        if (!mapping) throw new ReviewLabError(404, 'node_subject_not_found', 'The Node subject mapping was not found.');
        const previousSubject = reviewSubject(database, mapping.subjectId);
        const previousLink = previousSubject?.sharingScope === 'island_specific' ? activeExperienceSubjectLink(database, previousSubject.id) : null;
        let targetSubject = value?.mode === 'isolate' ? null : reviewSubject(database, cleanId(value?.subjectId));
        if (value?.mode !== 'isolate' && targetSubject?.sharingScope !== 'shared_confirmed') {
          throw new ReviewLabError(400, 'invalid_correction_subject', 'Corrections may link only to a confirmed shared experience subject.');
        }
        if (previousSubject?.sharingScope === 'island_specific' && (previousLink || targetSubject)) {
          const now = new Date().toISOString();
          if (previousLink) { previousLink.status = 'revoked'; previousLink.revokedAt = now; previousLink.revokedBy = actor.userId; previousLink.revocationReason = reason; }
          const nextLink = targetSubject
            ? ensureExperienceSubjectLink(database, previousSubject.id, targetSubject.id, actor, { reason })
            : null;
          for (const entry of database.experienceResolutions.filter((item) => item.userId === targetUserId && item.nodeId === cleanNodeId && item.status === 'active')) entry.status = 'superseded';
          const correction = {
            id: `subject_correction_${randomUUID()}`, userId: targetUserId, nodeId: cleanNodeId,
            previousSubjectId: previousSubject.id, subjectId: previousSubject.id,
            previousSharedSubjectId: previousLink?.sharedSubjectId ?? null, sharedSubjectId: nextLink?.sharedSubjectId ?? null,
            mode: targetSubject ? 'link' : 'isolate', reason, movedReviewIds: [], actorId: actor.userId, createdAt: now,
          };
          database.subjectCorrections.push(correction);
          audit(database, actor, 'resolver.subject_corrected', 'node', cleanNodeId, correction);
          return structuredClone(correction);
        }
        if (!targetSubject) {
          targetSubject = createIslandSpecificSubject(database, {
            name: previousSubject?.name ?? cleanNodeId,
            summary: previousSubject?.referenceLabel ?? '管理者によって共有解除された行動・体験',
            category: '', nodeKind: 'experience', semanticTags: [],
          }, actor);
        }
        const previousSubjectId = mapping.subjectId;
        mapping.subjectId = targetSubject.id; mapping.verifiedAt = new Date().toISOString(); mapping.verifiedBy = actor.userId; mapping.provenance = 'admin_corrected';
        const journey = landingJourney(database, targetUserId, cleanNodeId);
        if (journey) { journey.subjectId = targetSubject.id; journey.updatedAt = mapping.verifiedAt; }
        for (const binding of database.bindings.filter((entry) => entry.userId === targetUserId && entry.nodeId === cleanNodeId)) { binding.subjectId = targetSubject.id; binding.updatedAt = mapping.verifiedAt; }
        const movedReviewIds = [];
        for (const review of database.reviews.filter((entry) => entry.authorId === targetUserId && entry.sourceNodeId === cleanNodeId)) {
          review.subjectId = targetSubject.id; movedReviewIds.push(review.id);
        }
        for (const entry of database.experienceResolutions.filter((item) => item.userId === targetUserId && item.nodeId === cleanNodeId && item.status === 'active')) entry.status = 'superseded';
        const correction = {
          id: `subject_correction_${randomUUID()}`, userId: targetUserId, nodeId: cleanNodeId,
          previousSubjectId, subjectId: targetSubject.id, mode: value?.mode === 'isolate' ? 'isolate' : 'link',
          reason, movedReviewIds, actorId: actor.userId, createdAt: mapping.verifiedAt,
        };
        database.subjectCorrections.push(correction);
        audit(database, actor, 'resolver.subject_corrected', 'node', cleanNodeId, correction);
        return structuredClone(correction);
      });
    },
    registerSharedActionSubject(value, actor) {
      if (actor.role !== 'admin') throw new ReviewLabError(403, 'admin_required', 'Administrator access is required.');
      const identity = validateActionIdentity(value?.identity);
      const name = cleanText(value?.name, 180);
      const referenceLabel = cleanText(value?.referenceLabel, 300) || '確認済みの行動・体験';
      if (!name) throw new ReviewLabError(400, 'invalid_action_subject', 'The action experience label is required.');
      return mutate((database) => {
        const matchingKey = publicSubjectCatalog(database).find((subject) => subject.canonicalExperienceKey === identity.canonicalExperienceKey);
        if (matchingKey) {
          const existingIdentity = matchingKey.identity;
          const existingFingerprint = existingIdentity?.fingerprint ?? (existingIdentity?.action
            ? createHash('sha256').update(JSON.stringify({ identityVersion: 1, action: existingIdentity.action, object: existingIdentity.object ?? '', setting: existingIdentity.setting ?? '', qualifiers: existingIdentity.qualifiers ?? [] })).digest('hex')
            : '');
          if (existingFingerprint !== identity.fingerprint) {
            throw new ReviewLabError(409, 'experience_key_conflict', 'The canonical experience key is already assigned to a different action identity.');
          }
          return structuredClone(matchingKey);
        }
        const matchingFingerprint = database.reviewSubjects.find((subject) => subject.sharingScope === 'shared_confirmed' && subject.identity?.fingerprint === identity.fingerprint);
        if (matchingFingerprint) return structuredClone(matchingFingerprint);
        const id = `subject-action-${createHash('sha256').update(`${identity.canonicalExperienceKey}:${identity.fingerprint}`).digest('hex').slice(0, 24)}`;
        const now = new Date().toISOString();
        const subject = {
          id, kind: 'action_experience', name, referenceLabel, sharingScope: 'shared_confirmed', identityVersion: 1,
          canonicalExperienceKey: identity.canonicalExperienceKey,
          identity: { action: identity.action, object: identity.object, setting: identity.setting, qualifiers: identity.qualifiers, fingerprint: identity.fingerprint },
          createdAt: now, verifiedAt: now, verifiedBy: actor.userId,
        };
        database.reviewSubjects.push(subject);
        audit(database, actor, 'admin.action_subject.registered', 'subject', id, { canonicalExperienceKey: identity.canonicalExperienceKey, fingerprint: identity.fingerprint });
        return structuredClone(subject);
      });
    },
    verifyNodeSubject(userId, nodeId, subjectId, actor) {
      if (actor.role !== 'admin') throw new ReviewLabError(403, 'admin_required', 'Administrator access is required.');
      const targetUserId = cleanId(userId, 120); const cleanNodeId = cleanId(nodeId);
      if (!targetUserId || !cleanNodeId) throw new ReviewLabError(400, 'invalid_node_identity', 'A valid account and personal Node ID are required.');
      return mutate((database) => {
        const subject = reviewSubject(database, subjectId);
        if (!subject) throw new ReviewLabError(400, 'unknown_subject', 'Select a known review subject.');
        if (subject.sharingScope === 'island_specific') throw new ReviewLabError(409, 'island_subject_not_shareable', 'An unresolved island-specific subject cannot be assigned to another Node.');
        const existing = verifiedNodeSubject(database, targetUserId, cleanNodeId);
        const journey = landingJourney(database, targetUserId, cleanNodeId);
        if (existing && existing.subjectId !== subjectId && journey?.landedAt) {
          throw new ReviewLabError(409, 'landed_subject_immutable', 'A landed Node cannot be rebound to another shared subject.');
        }
        const now = new Date().toISOString();
        if (existing) { existing.subjectId = subjectId; existing.verifiedAt = now; existing.verifiedBy = actor.userId; }
        else database.verifiedNodeSubjects.push({ userId: targetUserId, nodeId: cleanNodeId, subjectId, verifiedAt: now, verifiedBy: actor.userId, provenance: subject.sharingScope === 'legacy_entity' ? 'legacy_admin_verified' : 'admin_verified_action' });
        audit(database, actor, 'admin.node_subject.verified', 'node', cleanNodeId, { targetUserId, subjectId });
        return { userId: targetUserId, nodeId: cleanNodeId, subjectId };
      });
    },
    startLandingJourney(nodeId, actor, value) {
      const cleanNodeId = cleanId(nodeId); const requiredStepIds = uniqueStepIds(value?.requiredStepIds);
      if (!cleanNodeId || requiredStepIds.length !== REQUIRED_LOCAL_STEP_COUNT) throw new ReviewLabError(400, 'invalid_landing_journey', 'Exactly three canonical Local Step IDs are required.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        let mapping = verifiedNodeSubject(database, actor.userId, cleanNodeId);
        if (!mapping && value?.subjectCandidate) {
          mapping = ensureIslandSpecificSubject(database, actor.userId, cleanNodeId, value.subjectCandidate, actor).mapping;
        }
        if (!mapping) throw new ReviewLabError(403, 'subject_not_verified', 'This personal Node has no review subject.');
        const now = new Date().toISOString(); let journey = landingJourney(database, actor.userId, cleanNodeId);
        if (journey?.landedAt) return structuredClone(journey);
        if (journey) {
          const unchanged = journey.requiredStepIds.length === requiredStepIds.length && journey.requiredStepIds.every((stepId) => requiredStepIds.includes(stepId));
          if (!unchanged) { journey.requiredStepIds = requiredStepIds; journey.completedStepIds = []; }
          journey.subjectId = mapping.subjectId; journey.updatedAt = now;
        } else {
          journey = { userId: actor.userId, nodeId: cleanNodeId, subjectId: mapping.subjectId, requiredStepIds, completedStepIds: [], startedAt: now, updatedAt: now, landedAt: null, landingEvidence: null };
          database.landingJourneys.push(journey);
        }
        audit(database, actor, 'journey.started', 'node', cleanNodeId, { requiredStepIds });
        return structuredClone(journey);
      });
    },
    completeLandingStep(nodeId, stepId, actor) {
      const cleanNodeId = cleanId(nodeId); const cleanStepId = cleanId(stepId, 180);
      if (!cleanNodeId || !cleanStepId) throw new ReviewLabError(400, 'invalid_step_identity', 'A valid Node and Step ID are required.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        const journey = landingJourney(database, actor.userId, cleanNodeId);
        if (!journey || !journey.requiredStepIds.includes(cleanStepId)) throw new ReviewLabError(403, 'step_not_in_journey', 'This Step is not part of the server-recorded landing journey.');
        if (!journey.completedStepIds.includes(cleanStepId)) journey.completedStepIds.push(cleanStepId);
        journey.updatedAt = new Date().toISOString();
        audit(database, actor, 'journey.step_completed', 'node', cleanNodeId, { stepId: cleanStepId });
        return structuredClone(journey);
      });
    },
    commitLanding(nodeId, actor, value) {
      const cleanNodeId = cleanId(nodeId); const ownerNodeId = cleanId(value?.ownerNodeId);
      const ship = finitePoint(value?.ship); const ownerTarget = finitePoint(value?.ownerTarget);
      if (!cleanNodeId || ownerNodeId !== cleanNodeId || !ship || !ownerTarget) throw new ReviewLabError(403, 'invalid_landing_evidence', 'Canonical owner and position evidence are required.');
      const navigationVersion = Number(value?.navigationVersion);
      const landingAnchor = finitePoint(value?.landingAnchor);
      if (value?.landingAnchor !== undefined && (navigationVersion !== NAVIGATION_VERSION || !landingAnchor)) {
        throw new ReviewLabError(403, 'invalid_landing_evidence', 'Canonical navigation evidence is invalid.');
      }
      const navigationAnchor = landingAnchor ? validNavigationAnchor(ownerTarget, landingAnchor) : null;
      if (navigationAnchor && !navigationAnchor.valid) {
        throw new ReviewLabError(403, 'invalid_landing_evidence', 'The landing berth does not match the canonical Island clearance envelope.');
      }
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        const mapping = verifiedNodeSubject(database, actor.userId, cleanNodeId);
        const journey = landingJourney(database, actor.userId, cleanNodeId);
        if (!mapping || !journey || journey.subjectId !== mapping.subjectId) throw new ReviewLabError(403, 'landing_journey_missing', 'A verified server-side landing journey is required.');
        if (journey.landedAt) return structuredClone(journey);
        if (journey.requiredStepIds.length !== REQUIRED_LOCAL_STEP_COUNT || !journey.requiredStepIds.every((stepId) => journey.completedStepIds.includes(stepId))) {
          throw new ReviewLabError(403, 'landing_steps_incomplete', 'All server-recorded Local Steps must be complete before landing.');
        }
        const arrivalTarget = landingAnchor ?? ownerTarget;
        const distance = Math.hypot(arrivalTarget.x - ship.x, arrivalTarget.y - ship.y);
        if (distance > WORLD_LANDING_RADIUS) throw new ReviewLabError(403, 'landing_radius_not_reached', 'Ship has not reached the canonical landing radius.');
        const now = new Date().toISOString(); journey.landedAt = now; journey.updatedAt = now;
        journey.landingEvidence = {
          ownerNodeId: cleanNodeId,
          ship,
          ownerTarget,
          ...(landingAnchor ? { landingAnchor, navigationVersion: NAVIGATION_VERSION, berthDistance: navigationAnchor.distance } : {}),
          distance,
          landingRadius: WORLD_LANDING_RADIUS,
        };
        audit(database, actor, 'journey.landed', 'node', cleanNodeId, { subjectId: mapping.subjectId, distance });
        return structuredClone(journey);
      });
    },
    async listPublic(subjectId, viewerId = null) {
      const database = await load();
      if (!reviewSubject(database, subjectId)) throw new ReviewLabError(404, 'unknown_subject', 'Review subject was not found.');
      const visibleSubjectIds = publicExperienceSubjectIds(database, subjectId);
      return database.reviews
        .filter((review) => visibleSubjectIds.has(review.subjectId) && review.moderationStatus === 'approved' && !review.hiddenAt)
        .map((review) => decoratedReview(database, review, viewerId));
    },
    async listByAuthor(authorId) {
      const cleanAuthorId = cleanId(authorId, 120);
      if (!cleanAuthorId) throw new ReviewLabError(400, 'author_required', 'An authenticated author is required.');
      const database = await load();
      return database.reviews.filter((review) => review.authorId === cleanAuthorId).map((review) => decoratedReview(database, review, authorId, true));
    },
    create(value, actor = { userId: cleanId(value?.authorId, 120), role: 'user' }) {
      const draft = validateDraft(value);
      if (!actor.userId) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        if (!reviewSubject(database, draft.subjectId)) throw new ReviewLabError(400, 'unknown_subject', 'Select a known review subject.');
        if (!draft.sourceNodeId) throw new ReviewLabError(403, 'review_landing_required', 'A server-verified landed Node is required to write a review.');
        const mapping = verifiedNodeSubject(database, actor.userId, draft.sourceNodeId);
        const journey = landingJourney(database, actor.userId, draft.sourceNodeId);
        if (!mapping || mapping.subjectId !== draft.subjectId || !journey?.landedAt || journey.subjectId !== mapping.subjectId) {
          throw new ReviewLabError(403, 'review_landing_required', 'Only an account that landed on this verified Node may write its review.');
        }
        const now = new Date().toISOString();
        const review = {
          id: `review_${randomUUID()}`, subjectId: draft.subjectId, sourceNodeId: draft.sourceNodeId,
          authorId: actor.userId, body: draft.body, moderationStatus: 'pending_moderation',
          authorSnapshot: { ...draft.authorSnapshot, capturedAt: now }, moderation: null, hiddenAt: null,
          createdAt: now, updatedAt: now, revision: 1,
        };
        database.reviews.push(review);
        if (draft.sourceNodeId) {
          const binding = database.bindings.find((candidate) => candidate.userId === actor.userId && candidate.nodeId === draft.sourceNodeId);
          if (binding && binding.subjectId !== draft.subjectId) {
            database.reviews.pop();
            throw new ReviewLabError(409, 'subject_binding_mismatch', 'This personal Node is connected to a different shared subject.');
          }
          if (!binding) database.bindings.push({ userId: actor.userId, nodeId: draft.sourceNodeId, subjectId: draft.subjectId, createdAt: now, updatedAt: now });
        }
        enqueueJob(database, review, 'submission', now);
        audit(database, actor, 'review.created', 'review', review.id, { subjectId: review.subjectId, revision: review.revision });
        return decoratedReview(database, review, actor.userId, true);
      });
    },
    update(reviewId, value, actor = { userId: cleanId(value?.authorId, 120), role: 'user' }) {
      const body = cleanText(value?.body, MAX_REVIEW_LENGTH);
      if (body.length < 20) throw new ReviewLabError(400, 'review_too_short', 'Review body must contain at least 20 characters.');
      if (!actor.userId) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        const review = database.reviews.find((candidate) => candidate.id === reviewId);
        if (!review) throw new ReviewLabError(404, 'review_not_found', 'Review was not found.');
        if (review.authorId !== actor.userId) throw new ReviewLabError(403, 'author_mismatch', 'Only the author can edit this review.');
        review.body = body;
        review.moderationStatus = 'pending_moderation';
        review.moderation = null;
        review.hiddenAt = null;
        review.updatedAt = new Date().toISOString();
        review.revision += 1;
        enqueueJob(database, review, 'edit', review.updatedAt);
        audit(database, actor, 'review.edited', 'review', review.id, { revision: review.revision });
        return decoratedReview(database, review, actor.userId, true);
      });
    },
    setHelpful(reviewId, actor, helpful) {
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        const review = database.reviews.find((candidate) => candidate.id === reviewId);
        if (!review || review.moderationStatus !== 'approved' || review.hiddenAt) throw new ReviewLabError(404, 'review_not_public', 'The review is not public.');
        const index = database.helpfulVotes.findIndex((vote) => vote.reviewId === reviewId && vote.userId === actor.userId);
        if (helpful && index < 0) database.helpfulVotes.push({ reviewId, userId: actor.userId, createdAt: new Date().toISOString() });
        if (!helpful && index >= 0) database.helpfulVotes.splice(index, 1);
        audit(database, actor, helpful ? 'helpful.added' : 'helpful.removed', 'review', reviewId);
        return decoratedReview(database, review, actor.userId);
      });
    },
    report(reviewId, actor, value) {
      const reason = cleanId(value?.reason, 64);
      const details = cleanText(value?.details, 800);
      if (!REPORT_REASONS.has(reason)) throw new ReviewLabError(400, 'invalid_report_reason', 'Select a valid report reason.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        const review = database.reviews.find((candidate) => candidate.id === reviewId);
        if (!review || review.moderationStatus !== 'approved' || review.hiddenAt) throw new ReviewLabError(404, 'review_not_public', 'The review is not public.');
        const existing = database.reports.find((report) => report.reviewId === reviewId && report.reporterId === actor.userId && report.status === 'open');
        if (existing) return existing;
        const reportRecord = { id: `report_${randomUUID()}`, reviewId, reporterId: actor.userId, reason, details, status: 'open', createdAt: new Date().toISOString(), resolvedAt: null, resolution: null };
        database.reports.push(reportRecord);
        audit(database, actor, 'report.created', 'review', reviewId, { reason });
        return reportRecord;
      });
    },
    bindNode(nodeId, subjectId, actor) {
      const cleanNodeId = cleanId(nodeId);
      if (!cleanNodeId) throw new ReviewLabError(400, 'invalid_node_id', 'A valid personal Node ID is required.');
      return mutate((database) => {
        assertNotFrozen(database, actor.userId);
        if (!reviewSubject(database, subjectId)) throw new ReviewLabError(400, 'unknown_subject', 'Select a known review subject.');
        const now = new Date().toISOString();
        let binding = database.bindings.find((candidate) => candidate.userId === actor.userId && candidate.nodeId === cleanNodeId);
        if (binding) { binding.subjectId = subjectId; binding.updatedAt = now; }
        else { binding = { userId: actor.userId, nodeId: cleanNodeId, subjectId, createdAt: now, updatedAt: now }; database.bindings.push(binding); }
        audit(database, actor, 'binding.saved', 'node', cleanNodeId, { subjectId });
        return { nodeId: cleanNodeId, subjectId };
      });
    },
    async getBinding(nodeId, actor) {
      const database = await load();
      const binding = database.bindings.find((candidate) => candidate.userId === actor.userId && candidate.nodeId === nodeId);
      return binding ? { nodeId: binding.nodeId, subjectId: binding.subjectId } : null;
    },
    async adminQueue() {
      const database = await load();
      return {
        reviews: database.reviews.filter((review) => review.moderationStatus === 'pending_moderation' || review.moderationStatus === 'needs_human_review'),
        reports: database.reports.filter((report) => report.status === 'open'),
        moderationJobs: database.moderationJobs.slice(-200).reverse().map((job) => ({
          id: job.id, reviewId: job.reviewId, reviewRevision: job.reviewRevision,
          reason: job.reason, status: job.status, attempts: job.attempts,
          nextAttemptAt: job.nextAttemptAt, lastError: job.lastError ?? null,
          createdAt: job.createdAt, updatedAt: job.updatedAt,
        })),
      };
    },
    adminReviewAction(reviewId, actor, value) {
      const action = cleanId(value?.action, 64);
      const note = cleanText(value?.note, 500);
      if (!['approve', 'reject', 'needs_human_review', 'hide', 'return_to_author'].includes(action)) throw new ReviewLabError(400, 'invalid_admin_action', 'Select a valid moderation action.');
      return mutate((database) => {
        const review = database.reviews.find((candidate) => candidate.id === reviewId);
        if (!review) throw new ReviewLabError(404, 'review_not_found', 'Review was not found.');
        const status = action === 'approve' ? 'approved' : action === 'needs_human_review' ? 'needs_human_review' : 'rejected';
        review.moderationStatus = status;
        review.hiddenAt = action === 'hide' ? new Date().toISOString() : null;
        review.moderation = { method: 'admin', reason: note || action, policyLabels: [], checkedAt: new Date().toISOString(), actorId: actor.userId };
        for (const job of database.moderationJobs.filter((candidate) => candidate.reviewId === reviewId && candidate.status !== 'complete')) { job.status = 'complete'; job.updatedAt = new Date().toISOString(); }
        audit(database, actor, `admin.review.${action}`, 'review', reviewId, { note });
        return review;
      });
    },
    freezeUser(userId, actor, value) {
      const targetUserId = cleanId(userId, 120);
      const frozen = value?.frozen === true;
      const reason = cleanText(value?.reason, 500);
      if (!targetUserId) throw new ReviewLabError(400, 'invalid_user_id', 'A valid user ID is required.');
      return mutate((database) => {
        let user = userRecord(database, targetUserId);
        if (!user) { user = { id: targetUserId, frozen: false, freezeReason: null, updatedAt: new Date().toISOString() }; database.users.push(user); }
        user.frozen = frozen; user.freezeReason = frozen ? reason || 'Administrative review restriction' : null; user.updatedAt = new Date().toISOString();
        audit(database, actor, frozen ? 'admin.user.frozen' : 'admin.user.unfrozen', 'user', targetUserId, { reason });
        return { userId: targetUserId, frozen: user.frozen };
      });
    },
    resolveReport(reportId, actor, value) {
      const resolution = cleanText(value?.resolution, 500);
      return mutate((database) => {
        const report = database.reports.find((candidate) => candidate.id === reportId);
        if (!report) throw new ReviewLabError(404, 'report_not_found', 'Report was not found.');
        report.status = 'resolved'; report.resolvedAt = new Date().toISOString(); report.resolution = resolution || 'reviewed';
        audit(database, actor, 'admin.report.resolved', 'report', reportId, { resolution: report.resolution });
        return report;
      });
    },
    async auditLog() { const database = await load(); return database.auditLog.slice(-500).reverse(); },
    claimModerationJob(now = new Date()) {
      return mutate((database) => {
        const nowIso = now.toISOString();
        for (const job of database.moderationJobs) {
          if (job.status === 'processing' && Date.parse(job.updatedAt) < now.getTime() - 10 * 60_000) job.status = 'waiting';
        }
        const job = database.moderationJobs.find((candidate) => candidate.status === 'waiting' && candidate.nextAttemptAt <= nowIso);
        if (!job) return null;
        const review = database.reviews.find((candidate) => candidate.id === job.reviewId && candidate.revision === job.reviewRevision);
        if (!review) { job.status = 'complete'; job.updatedAt = nowIso; return null; }
        job.status = 'processing'; job.updatedAt = nowIso;
        return { job: structuredClone(job), review: structuredClone(review) };
      });
    },
    finishModeration(jobId, result) {
      return mutate((database) => {
        const job = database.moderationJobs.find((candidate) => candidate.id === jobId);
        if (!job) return null;
        const review = database.reviews.find((candidate) => candidate.id === job.reviewId && candidate.revision === job.reviewRevision);
        job.status = 'complete'; job.updatedAt = new Date().toISOString();
        if (!review) return null;
        review.moderationStatus = result.decision;
        review.moderation = { method: 'ai', reason: result.reason, policyLabels: result.policyLabels, checkedAt: job.updatedAt, model: result.model };
        audit(database, { userId: 'system:moderation', role: 'system' }, `moderation.${result.decision}`, 'review', review.id, { revision: review.revision, policyLabels: result.policyLabels });
        return review;
      });
    },
    failModeration(jobId, errorMessage, now = new Date()) {
      return mutate((database) => {
        const job = database.moderationJobs.find((candidate) => candidate.id === jobId);
        if (!job) return null;
        job.attempts += 1; job.lastError = cleanText(errorMessage, 500); job.updatedAt = now.toISOString();
        const review = database.reviews.find((candidate) => candidate.id === job.reviewId && candidate.revision === job.reviewRevision);
        if (job.attempts >= MAX_JOB_ATTEMPTS) {
          job.status = 'complete';
          if (review) { review.moderationStatus = 'needs_human_review'; review.moderation = { method: 'system', reason: 'AI moderation failed after bounded retries.', policyLabels: ['uncertain'], checkedAt: job.updatedAt }; }
          audit(database, { userId: 'system:moderation', role: 'system' }, 'moderation.retry_exhausted', 'review', job.reviewId, { revision: job.reviewRevision, attempts: job.attempts });
        } else {
          job.status = 'waiting'; job.nextAttemptAt = new Date(now.getTime() + 2 ** job.attempts * 60_000).toISOString();
          audit(database, { userId: 'system:moderation', role: 'system' }, 'moderation.retry_scheduled', 'review', job.reviewId, { revision: job.reviewRevision, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt });
        }
        return review;
      });
    },
    releasePausedJob(jobId) {
      return mutate((database) => {
        const job = database.moderationJobs.find((candidate) => candidate.id === jobId);
        if (job) { job.status = 'waiting'; job.updatedAt = new Date().toISOString(); job.lastError = 'API_PAUSED'; }
        return job ?? null;
      });
    },
    enqueuePeriodicRechecks(now = new Date(), intervalMs = 30 * 24 * 60 * 60_000) {
      return mutate((database) => {
        let count = 0;
        for (const review of database.reviews.filter((candidate) => candidate.moderationStatus === 'approved' && !candidate.hiddenAt)) {
          const checkedAt = Date.parse(review.moderation?.checkedAt ?? review.updatedAt);
          if (Number.isFinite(checkedAt) && checkedAt <= now.getTime() - intervalMs) {
            const period = now.toISOString().slice(0, 10);
            const before = database.moderationJobs.length;
            enqueueJob(database, review, `periodic:${period}`, now.toISOString());
            if (database.moderationJobs.length > before) {
              count += 1;
              audit(database, { userId: 'system:moderation', role: 'system' }, 'moderation.periodic_enqueued', 'review', review.id, { revision: review.revision, period });
            }
          }
        }
        return count;
      });
    },
    async readDatabaseForTest() { return load(); },
  };
}

const encode = (value) => Buffer.from(value, 'utf8').toString('base64url');
const signature = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
function sessionCookie(actor, secret) {
  const payload = encode(JSON.stringify({ userId: actor.userId, role: actor.role, issuedAt: Date.now() }));
  return `${payload}.${signature(payload, secret)}`;
}
function namedCookie(req, name) {
  const cookie = cleanText(req.headers?.cookie, 8_000).split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : '';
}
const cookieToken = (req) => namedCookie(req, SESSION_COOKIE);
function parseLegacySessionToken(token, secret, now = new Date()) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (!payload || !suppliedSignature) return null;
  const expected = signature(payload, secret);
  const left = Buffer.from(suppliedSignature); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const userId = cleanId(parsed.userId, 120); const issuedAtMs = Number(parsed.issuedAt);
    const clockMs = new Date(now).getTime();
    if (!userId || !Number.isFinite(issuedAtMs) || issuedAtMs > clockMs + 60_000) return null;
    const expiresAtMs = issuedAtMs + LEGACY_SESSION_LIFETIME_MS;
    if (expiresAtMs <= clockMs) return null;
    return {
      actor: { userId, role: parsed.role === 'admin' ? 'admin' : 'user' },
      issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), token,
    };
  } catch { return null; }
}
function parseSession(req, secret) {
  return parseLegacySessionToken(cookieToken(req), secret)?.actor ?? null;
}

function cookieHeader(actor, secret, req) {
  const secure = req.socket?.encrypted || cleanText(req.headers?.['x-forwarded-proto'], 20) === 'https';
  return `${SESSION_COOKIE}=${sessionCookie(actor, secret)}; Path=/api/reviews; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

function opaqueCookieHeader(token, req, maxAge = 30 * 24 * 60 * 60) {
  const secure = req.socket?.encrypted || cleanText(req.headers?.['x-forwarded-proto'], 20) === 'https';
  return `${SESSION_COOKIE}=${token}; Path=/api/reviews; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function expiredCookieHeader(req) { return opaqueCookieHeader('', req, 0); }

function authFlowCookieHeader(token, req, maxAge = 15 * 60) {
  const secure = req.socket?.encrypted || cleanText(req.headers?.['x-forwarded-proto'], 20) === 'https';
  return `${AUTH_FLOW_COOKIE}=${token}; Path=/api/reviews/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function passkeyFlowCookieHeader(token, req, maxAge = 5 * 60) {
  const secure = req.socket?.encrypted || cleanText(req.headers?.['x-forwarded-proto'], 20) === 'https';
  return `${PASSKEY_FLOW_COOKIE}=${token}; Path=/api/reviews/auth/passkeys; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function createLocalEmailDelivery() {
  const deliveries = [];
  return {
    kind: 'local-test', available: true, deliveries,
    async sendMagicLink(message) { deliveries.push(structuredClone(message)); return { accepted: true, providerMessageId: `local_${deliveries.length}` }; },
  };
}

export function createEmailDeliveryAdapter({ kind, sendMagicLink }) {
  if (!kind || typeof sendMagicLink !== 'function') throw new TypeError('A named email delivery function is required.');
  return { kind, available: true, sendMagicLink };
}

export function createUnavailableEmailDelivery() {
  return { kind: 'unconfigured', available: false, async sendMagicLink() { throw new Error('Email delivery is not configured.'); } };
}

const magicConfirmationPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KUROHIGE MAP メール確認</title><style>body{font-family:system-ui,sans-serif;background:#eafcff;color:#16424d;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border-radius:20px;padding:28px;max-width:420px;box-shadow:0 12px 40px #176b7a22}button{background:#079b9b;color:white;border:0;border-radius:999px;padding:12px 20px;font-weight:700}p{line-height:1.7}</style></head><body><main class="card"><h1>メールを確認します</h1><p>この操作を確定すると、このブラウザでKUROHIGE MAPへログインします。</p><button id="confirm" type="button">ログインを確定</button><p id="status" role="status"></p></main><script>(()=>{let raw=location.hash.startsWith('#token=')?decodeURIComponent(location.hash.slice(7)):'';history.replaceState(null,'',location.pathname);const button=document.getElementById('confirm');const status=document.getElementById('status');if(!raw){button.disabled=true;status.textContent='リンクが正しくありません。';return}button.addEventListener('click',async()=>{button.disabled=true;status.textContent='確認しています…';try{const response=await fetch('./magic/confirm',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:raw})});const result=await response.json();status.textContent=response.ok?'確認が完了しました。このページを閉じてKUROHIGE MAPへ戻れます。':(result?.error?.message??'確認できませんでした。');}catch{status.textContent='確認できませんでした。時間を置いて再度お試しください。'}finally{raw='';}})})();</script></body></html>`;

function bearerAdmin(req, adminToken) {
  if (!adminToken) return null;
  const value = cleanText(req.headers?.authorization, 1_000);
  if (!value.startsWith('Bearer ')) return null;
  const supplied = Buffer.from(value.slice(7)); const expected = Buffer.from(adminToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? { userId: 'admin:token', role: 'admin' } : null;
}

async function resolveActor(req, secret, adminToken, sessionStore) {
  const admin = bearerAdmin(req, adminToken);
  if (admin) return { actor: admin, session: null };
  if (!sessionStore) return { actor: parseSession(req, secret), session: null };
  const token = cookieToken(req);
  if (!token || token.includes('.')) return { actor: null, session: null };
  try { return (await sessionStore.authenticate(token)) ?? { actor: null, session: null }; }
  catch { throw new ReviewLabError(503, 'authentication_store_unavailable', 'Authentication is temporarily unavailable.'); }
}

async function requireActor(req, secret, adminToken, sessionStore, role = 'user') {
  const { actor } = await resolveActor(req, secret, adminToken, sessionStore);
  if (!actor) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
  if (role === 'admin' && actor.role !== 'admin') throw new ReviewLabError(403, 'admin_required', 'Administrator access is required.');
  return actor;
}

function assertSameOrigin(req, productionMode = false) {
  const origin = cleanText(req.headers?.origin, 500);
  const host = cleanText(req.headers?.host, 300);
  const fetchSite = cleanText(req.headers?.['sec-fetch-site'], 50);
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin review mutations are not allowed.');
  if (!origin || !host) {
    if (productionMode) throw new ReviewLabError(403, 'origin_required', 'A same-origin request is required.');
    return;
  }
  try { if (new URL(origin).host !== host) throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin review mutations are not allowed.'); }
  catch (error) { if (error instanceof ReviewLabError) throw error; throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin review mutations are not allowed.'); }
}

function assertSameOriginRead(req, productionMode = false) {
  const origin = cleanText(req.headers?.origin, 500);
  const host = cleanText(req.headers?.host, 300);
  const fetchSite = cleanText(req.headers?.['sec-fetch-site'], 50);
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin sync requests are not allowed.');
  }
  if (!host && productionMode) throw new ReviewLabError(403, 'origin_required', 'A same-origin request is required.');
  if (!origin) return;
  try {
    if (new URL(origin).host !== host) throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin sync requests are not allowed.');
  } catch (error) {
    if (error instanceof ReviewLabError) throw error;
    throw new ReviewLabError(403, 'cross_origin_rejected', 'Cross-origin sync requests are not allowed.');
  }
}

export function createNebiusReviewModerator({ apiKey, apiEnabled = false, fetchImpl = fetch, spendGuard = null } = {}) {
  const enabled = isNebiusApiEnabled(apiEnabled);
  const guardFor = (operation) => spendGuard?.forOperation ? spendGuard.forOperation(operation) : spendGuard;
  const guardedFetchFor = (operation) => createGuardedNebiusFetch({ enabled, fetchImpl, spendGuard: guardFor(operation) });
  let modelPromise = null;
  const discoverModel = async () => {
    modelPromise ??= guardedFetchFor('model_discovery')(`${NEBIUS_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model discovery failed (${response.status}).`);
        const payload = await response.json();
        const model = payload?.data?.map((entry) => entry?.id).find((id) => typeof id === 'string' && TARGET_MODEL_PATTERN.test(id));
        if (!model) throw new Error('Nemotron 3 Ultra is unavailable.');
        return model;
      })
      .catch((error) => { modelPromise = null; throw error; });
    return modelPromise;
  };
  return {
    available: enabled && Boolean(apiKey),
    async moderate(review) {
      if (!enabled || !apiKey) return { outcome: 'paused' };
      const model = await discoverModel();
      const response = await guardedFetchFor('review_moderation')(`${NEBIUS_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: MODERATION_PROMPT }, { role: 'user', content: review.body }],
          response_format: { type: 'json_schema', json_schema: { name: 'review_moderation', strict: true, schema: MODERATION_SCHEMA } },
          chat_template_kwargs: { enable_thinking: false }, max_tokens: 1024, temperature: 0,
        }),
      });
      if (!response.ok) {
        let providerMessage = '';
        try {
          const errorPayload = await response.json();
          providerMessage = cleanText(errorPayload?.error?.message, 600);
        } catch { /* The status is still sufficient for a bounded retry. */ }
        throw new Error(`Review moderation failed (${response.status})${providerMessage ? `: ${providerMessage}` : '.'}`);
      }
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error('Review moderation returned an empty completion.');
      const result = JSON.parse(content);
      if (!['approved', 'rejected', 'needs_human_review'].includes(result?.decision) || typeof result?.reason !== 'string' || !Array.isArray(result?.policyLabels)) throw new Error('Review moderation returned an invalid structured result.');
      const completionDetails = payload?.usage?.completion_tokens_details;
      return {
        outcome: 'complete', decision: result.decision, reason: result.reason, policyLabels: result.policyLabels, model,
        diagnostic: {
          finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
          usage: {
            promptTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : null,
            completionTokens: Number.isFinite(payload?.usage?.completion_tokens) ? payload.usage.completion_tokens : null,
            totalTokens: Number.isFinite(payload?.usage?.total_tokens) ? payload.usage.total_tokens : null,
            reasoningTokens: Number.isFinite(completionDetails?.reasoning_tokens) ? completionDetails.reasoning_tokens : null,
          },
        },
      };
    },
  };
}

export function createNebiusExperienceResolver({ apiKey, apiEnabled = false, fetchImpl = fetch, spendGuard = null } = {}) {
  const enabled = isNebiusApiEnabled(apiEnabled);
  const guardFor = (operation) => spendGuard?.forOperation ? spendGuard.forOperation(operation) : spendGuard;
  const guardedFetchFor = (operation) => createGuardedNebiusFetch({ enabled, fetchImpl, spendGuard: guardFor(operation) });
  let modelPromise = null;
  const discoverModel = async () => {
    modelPromise ??= guardedFetchFor('model_discovery')(`${NEBIUS_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model discovery failed (${response.status}).`);
        const payload = await response.json();
        const model = payload?.data?.map((entry) => entry?.id).find((id) => typeof id === 'string' && TARGET_MODEL_PATTERN.test(id));
        if (!model) throw new Error('Nemotron 3 Ultra is unavailable.');
        return model;
      })
      .catch((error) => { modelPromise = null; throw error; });
    return modelPromise;
  };
  return {
    available: enabled && Boolean(apiKey),
    async extractIdentity(candidate) {
      if (!enabled || !apiKey) return { outcome: 'paused' };
      const model = await discoverModel();
      const response = await guardedFetchFor('experience_identity')(`${NEBIUS_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: EXPERIENCE_IDENTITY_PROMPT }, { role: 'user', content: JSON.stringify({ proposedExperience: candidate }) }],
          response_format: { type: 'json_schema', json_schema: { name: 'experience_identity', strict: true, schema: EXPERIENCE_IDENTITY_SCHEMA } },
          chat_template_kwargs: { enable_thinking: false }, max_tokens: 700, temperature: 0,
        }),
      });
      if (!response.ok) {
        let providerMessage = '';
        try { providerMessage = cleanText((await response.json())?.error?.message, 600); } catch { /* HTTP status is sufficient. */ }
        throw new Error(`Experience identity extraction failed (${response.status})${providerMessage ? `: ${providerMessage}` : '.'}`);
      }
      const payload = await response.json(); const choice = payload?.choices?.[0]; const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error('Experience identity extraction returned an empty completion.');
      const result = JSON.parse(content); const identity = normalizeResolvedIdentity(result?.identity);
      if (!identity) throw new Error('Experience identity extraction returned an invalid structured result.');
      const completionDetails = payload?.usage?.completion_tokens_details;
      return {
        outcome: 'complete', identity, model,
        diagnostic: {
          finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
          usage: {
            promptTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : null,
            completionTokens: Number.isFinite(payload?.usage?.completion_tokens) ? payload.usage.completion_tokens : null,
            totalTokens: Number.isFinite(payload?.usage?.total_tokens) ? payload.usage.total_tokens : null,
            reasoningTokens: Number.isFinite(completionDetails?.reasoning_tokens) ? completionDetails.reasoning_tokens : null,
          },
        },
      };
    },
    async resolve(candidate, candidates) {
      if (!enabled || !apiKey) return { outcome: 'paused' };
      const model = await discoverModel();
      const comparable = candidates.map((subject) => ({
        subjectId: subject.id, name: subject.name, description: subject.referenceLabel,
        canonicalExperienceKey: subject.canonicalExperienceKey,
        identity: subject.identity ? {
          action: subject.identity.action ?? '', object: subject.identity.object ?? '', setting: subject.identity.setting ?? '',
          qualifiers: subject.identity.qualifiers ?? [], purpose: subject.identity.purpose ?? '', constraints: subject.identity.constraints ?? [],
        } : null,
      }));
      const response = await guardedFetchFor('experience_resolution')(`${NEBIUS_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: EXPERIENCE_RESOLUTION_PROMPT },
            { role: 'user', content: JSON.stringify({ proposedExperience: candidate, existingSharedExperiences: comparable }) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'experience_resolution', strict: true, schema: EXPERIENCE_RESOLUTION_SCHEMA } },
          chat_template_kwargs: { enable_thinking: false }, max_tokens: 1400, temperature: 0,
        }),
      });
      if (!response.ok) {
        let providerMessage = '';
        try { providerMessage = cleanText((await response.json())?.error?.message, 600); }
        catch { /* HTTP status remains diagnostic evidence. */ }
        throw new Error(`Experience resolution failed (${response.status})${providerMessage ? `: ${providerMessage}` : '.'}`);
      }
      const payload = await response.json();
      const choice = payload?.choices?.[0]; const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error('Experience resolution returned an empty completion.');
      const result = JSON.parse(content);
      if (!['same', 'different', 'uncertain'].includes(result?.decision)
        || !['high', 'medium', 'low'].includes(result?.confidence)
        || typeof result?.matchedSubjectId !== 'string'
        || typeof result?.reason !== 'string'
        || !normalizeResolvedIdentity(result?.identity)) {
        throw new Error('Experience resolution returned an invalid structured result.');
      }
      const completionDetails = payload?.usage?.completion_tokens_details;
      return {
        outcome: 'complete', ...result, model,
        diagnostic: {
          finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
          usage: {
            promptTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : null,
            completionTokens: Number.isFinite(payload?.usage?.completion_tokens) ? payload.usage.completion_tokens : null,
            totalTokens: Number.isFinite(payload?.usage?.total_tokens) ? payload.usage.total_tokens : null,
            reasoningTokens: Number.isFinite(completionDetails?.reasoning_tokens) ? completionDetails.reasoning_tokens : null,
          },
        },
      };
    },
  };
}

export function createReviewLabApi({
  enabled = true,
  storagePath = path.resolve('data/review-lab/reviews.json'),
  repository: suppliedRepository,
  sessionSecret = '', adminToken = '', developmentAuthEnabled = false,
  productionMode = false, apiKey = '', apiEnabled = false, fetchImpl = fetch,
  spendGuard = null,
  moderator: suppliedModerator, experienceResolver: suppliedExperienceResolver,
  emailDelivery: suppliedEmailDelivery, authPublicBaseUrl = process.env.AUTH_PUBLIC_BASE_URL ?? '',
  passkey: passkeyOptions = {},
  syncRepository: suppliedSyncRepository = null,
  syncRateLimits = {},
} = {}) {
  const repository = suppliedRepository ?? createReviewLabRepository(storagePath);
  const sessionStore = repository.sessionStore ?? null;
  const secret = sessionSecret || (!productionMode ? DEVELOPMENT_SESSION_SECRET : '');
  const moderator = suppliedModerator ?? createNebiusReviewModerator({ apiKey, apiEnabled, fetchImpl, spendGuard });
  const experienceResolver = suppliedExperienceResolver ?? createNebiusExperienceResolver({ apiKey, apiEnabled, fetchImpl, spendGuard });
  const emailDelivery = suppliedEmailDelivery ?? createUnavailableEmailDelivery();
  const passkey = createPasskeyService(passkeyOptions);
  const syncRateLimit = {
    commit: Number.isSafeInteger(syncRateLimits.commit) && syncRateLimits.commit > 0 ? syncRateLimits.commit : 30,
    resolution: Number.isSafeInteger(syncRateLimits.resolution) && syncRateLimits.resolution > 0 ? syncRateLimits.resolution : 20,
    windowMs: Number.isSafeInteger(syncRateLimits.windowMs) && syncRateLimits.windowMs > 0 ? syncRateLimits.windowMs : 60_000,
  };
  const resolutionInFlight = new Map();
  let timer = null;
  let activeTick = null;
  const schedulerState = {
    running: false, startedAt: null, stoppedAt: null, tickCount: 0, skippedOverlappingTicks: 0,
    lastTickStartedAt: null, lastTickCompletedAt: null, lastEnqueuedCount: 0,
    lastModerationStatus: null, lastError: null,
  };

  const processNextModeration = async () => {
    const claimed = await repository.claimModerationJob();
    if (!claimed) return { status: 'idle' };
    try {
      const result = await moderator.moderate(claimed.review);
      if (result.outcome === 'paused') { await repository.releasePausedJob(claimed.job.id); return { status: 'paused' }; }
      if (developmentAuthEnabled && result.diagnostic) {
        console.info('[review-moderation-diagnostic]', JSON.stringify({
          reviewId: claimed.review.id,
          model: result.model,
          ...result.diagnostic,
        }));
      }
      await repository.finishModeration(claimed.job.id, result);
      return { status: 'complete', reviewId: claimed.review.id, decision: result.decision };
    } catch (error) {
      await repository.failModeration(claimed.job.id, error instanceof Error ? error.message : 'Unknown moderation error.');
      return { status: 'retry_scheduled', reviewId: claimed.review.id };
    }
  };

  const tick = () => {
    if (activeTick) { schedulerState.skippedOverlappingTicks += 1; return activeTick; }
    schedulerState.tickCount += 1;
    schedulerState.lastTickStartedAt = new Date().toISOString();
    schedulerState.lastError = null;
    activeTick = (async () => {
      schedulerState.lastEnqueuedCount = await repository.enqueuePeriodicRechecks();
      const result = await processNextModeration();
      schedulerState.lastModerationStatus = result.status;
      return result;
    })().catch((error) => {
      schedulerState.lastError = cleanText(error instanceof Error ? error.message : 'Unknown scheduler error.', 500);
      return { status: 'scheduler_error' };
    }).finally(() => {
      schedulerState.lastTickCompletedAt = new Date().toISOString();
      activeTick = null;
    });
    return activeTick;
  };

  const startJobs = (intervalMs = 15_000) => {
    if (timer || !moderator.available) return false;
    schedulerState.running = true;
    schedulerState.startedAt = new Date().toISOString();
    schedulerState.stoppedAt = null;
    timer = setInterval(() => void tick(), intervalMs); timer.unref?.(); void tick();
    return true;
  };
  const stopJobs = () => {
    if (timer) clearInterval(timer);
    timer = null;
    schedulerState.running = false;
    schedulerState.stoppedAt = new Date().toISOString();
  };
  const schedulerStatus = () => structuredClone(schedulerState);

  const resolveExperienceSubject = async (nodeId, candidate, actor) => {
    const key = `${actor.userId}:${nodeId}`;
    if (resolutionInFlight.has(key)) return resolutionInFlight.get(key);
    const operation = (async () => {
      let prepared = await repository.prepareExperienceResolution(nodeId, candidate, actor);
      if (prepared.existingSubject) return { nodeId: prepared.nodeId, subject: prepared.existingSubject, created: false, resolution: null };
      if (prepared.cachedSubject) {
        return repository.applyExperienceResolution(nodeId, candidate, actor, {
          decision: 'same', confidence: 'high', matchedSubjectId: prepared.cachedSubject.id,
          reason: 'Exact normalized semantic payload reused a previously confirmed resolver result.',
          comparedSubjectIds: [prepared.cachedSubject.id], method: 'cache', identity: prepared.cachedSubject.identity,
        });
      }
      if (!experienceResolver.available) {
        return repository.applyExperienceResolution(nodeId, candidate, actor, {
          decision: 'uncertain', confidence: 'low', matchedSubjectId: '',
          reason: 'Semantic resolver is paused; the island remains isolated.', comparedSubjectIds: prepared.candidates.map((entry) => entry.id),
          method: 'paused', identity: { action: prepared.candidate.nodeKind || 'experience', object: '', setting: '', qualifiers: [], purpose: '', constraints: [] },
        });
      }
      let extraction = null;
      let extractionError = null;
      if (prepared.registrySize > 100 && typeof experienceResolver.extractIdentity === 'function') {
        try {
          extraction = await experienceResolver.extractIdentity(prepared.candidate);
          if (extraction?.outcome === 'complete') {
            prepared = await repository.prepareExperienceResolution(nodeId, candidate, actor, extraction.identity);
            if (prepared.identityMatchedSubject) {
              return repository.applyExperienceResolution(nodeId, candidate, actor, {
                decision: 'same', confidence: 'high', matchedSubjectId: prepared.identityMatchedSubject.id,
                reason: 'The normalized action identity exactly matches a confirmed shared experience.',
                comparedSubjectIds: [prepared.identityMatchedSubject.id], method: 'identity_exact', identity: extraction.identity,
                model: extraction.model, diagnostic: extraction.diagnostic, extractionDiagnostic: extraction.diagnostic,
              });
            }
          }
        } catch (error) {
          extractionError = cleanText(error instanceof Error ? error.message : 'Unknown identity extraction error.', 500);
        }
      }
      try {
        const result = await experienceResolver.resolve(extraction?.identity
          ? { ...prepared.candidate, normalizedIdentity: extraction.identity }
          : prepared.candidate, prepared.candidates);
        if (result.outcome === 'paused') {
          return repository.applyExperienceResolution(nodeId, candidate, actor, {
            decision: 'uncertain', confidence: 'low', matchedSubjectId: '', reason: 'Semantic resolver is paused; the island remains isolated.',
            comparedSubjectIds: prepared.candidates.map((entry) => entry.id), method: 'paused',
            identity: { action: prepared.candidate.nodeKind || 'experience', object: '', setting: '', qualifiers: [], purpose: '', constraints: [] },
          });
        }
        if (developmentAuthEnabled && result.diagnostic) {
          console.info('[experience-resolver-diagnostic]', JSON.stringify({ nodeId, model: result.model, decision: result.decision, confidence: result.confidence, ...result.diagnostic }));
        }
        return repository.applyExperienceResolution(nodeId, candidate, actor, {
          ...result, comparedSubjectIds: prepared.candidates.map((entry) => entry.id), method: extraction?.identity ? 'ai_two_stage' : 'ai',
          extractionDiagnostic: extraction?.diagnostic ?? (extractionError ? { error: extractionError } : null),
        });
      } catch (error) {
        return repository.applyExperienceResolution(nodeId, candidate, actor, {
          decision: 'uncertain', confidence: 'low', matchedSubjectId: '',
          reason: `Resolver failure: ${cleanText(error instanceof Error ? error.message : 'Unknown resolver error.', 500)}`,
          comparedSubjectIds: prepared.candidates.map((entry) => entry.id), method: 'error',
          identity: { action: prepared.candidate.nodeKind || 'experience', object: '', setting: '', qualifiers: [], purpose: '', constraints: [] },
        });
      }
    })().finally(() => resolutionInFlight.delete(key));
    resolutionInFlight.set(key, operation);
    return operation;
  };

  const requireSyncContext = async (req) => {
    if (!suppliedSyncRepository || suppliedSyncRepository.kind !== 'postgres-account-sync') {
      throw new ReviewLabError(503, 'sync_backend_unavailable', 'Server sync requires the PostgreSQL backend.');
    }
    if (!sessionStore?.authStatus) {
      throw new ReviewLabError(503, 'sync_authentication_unavailable', 'Persistent account authentication is unavailable.');
    }
    const current = await resolveActor(req, secret, adminToken, sessionStore);
    if (!current.actor || !current.session || current.actor.role !== 'user') {
      throw new ReviewLabError(401, 'sync_authentication_required', 'A valid account session is required.');
    }
    let account;
    try { account = await sessionStore.authStatus(current.actor.userId); }
    catch { throw new ReviewLabError(503, 'authentication_store_unavailable', 'Authentication is temporarily unavailable.'); }
    if (account?.accountType !== 'registered') {
      throw new ReviewLabError(403, 'sync_registered_account_required', 'Register the account before enabling server sync.');
    }
    return {
      actor: current.actor,
      session: current.session,
      account,
      repository: suppliedSyncRepository.forAccount({ accountId: current.actor.userId, sessionId: current.session.id }),
    };
  };

  const consumeSyncRateLimit = async (context, action) => {
    if (!sessionStore?.consumeAccountRateLimit) return;
    try {
      await sessionStore.consumeAccountRateLimit({
        accountId: context.actor.userId,
        action: `sync.${action}`,
        limit: action === 'commit' ? syncRateLimit.commit : syncRateLimit.resolution,
        windowMs: syncRateLimit.windowMs,
      });
    } catch (error) {
      if (error instanceof ReviewLabError) throw error;
      throw new ReviewLabError(503, 'sync_rate_limit_unavailable', 'Server sync is temporarily unavailable.');
    }
  };

  const middleware = async (req, res) => {
    if (!enabled) { json(res, 404, { error: { code: 'reviews_disabled', message: 'Reviews are unavailable.' } }); return; }
    try {
      const url = new URL(req.url ?? '/', 'http://reviews.local');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
      if (mutating) assertSameOrigin(req, productionMode);
      if (segments[0] === 'account' && segments[1] === 'sync') {
        // Sync responses contain private account data, so reads also require an
        // explicit same-origin context in production instead of relying only on CORS.
        if (!mutating) assertSameOriginRead(req, productionMode);
        const context = await requireSyncContext(req);
        if (segments[2] === 'status' && segments.length === 3 && req.method === 'GET') {
          const [state, conflicts] = await Promise.all([
            context.repository.getLatest(),
            context.repository.listConflicts({ status: 'open', limit: 1 }),
          ]);
          json(res, 200, {
            sync: {
              available: true,
              accountType: context.account.accountType,
              syncRevision: state.syncRevision,
              activeWorldId: state.activeWorldId,
              profileHash: state.profile?.contentHash ?? null,
              worldHash: state.world?.contentHash ?? null,
              updatedAt: state.updatedAt,
              hasOpenConflicts: conflicts.length > 0,
            },
          }); return;
        }
        if (segments[2] === 'bundle' && segments.length === 3 && req.method === 'GET') {
          json(res, 200, { bundle: await context.repository.getLatest() }); return;
        }
        if (segments[2] === 'commits' && segments.length === 3 && req.method === 'POST') {
          await consumeSyncRateLimit(context, 'commit');
          const result = await context.repository.commit(await readSyncJsonBody(req));
          json(res, result.httpStatus ?? (result.status === 'committed' ? 201 : 409), { result }); return;
        }
        if (segments[2] === 'conflicts' && segments.length === 3 && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const limit = Number(url.searchParams.get('limit') ?? 50);
          json(res, 200, { conflicts: await context.repository.listConflicts({
            status: status || null,
            limit: Number.isSafeInteger(limit) && limit > 0 ? limit : 50,
          }) }); return;
        }
        if (segments[2] === 'conflicts' && segments.length === 4 && req.method === 'GET') {
          json(res, 200, { conflict: await context.repository.getConflict(segments[3]) }); return;
        }
        if (segments[2] === 'conflicts' && segments[4] === 'resolve' && segments.length === 5 && req.method === 'POST') {
          await consumeSyncRateLimit(context, 'resolution');
          json(res, 200, { result: await context.repository.resolveConflict(segments[3], await readSyncJsonBody(req)) }); return;
        }
        if (segments[2] === 'history' && segments.length === 4 && req.method === 'GET') {
          const revision = Number(segments[3]);
          if (!Number.isSafeInteger(revision) || revision <= 0) {
            throw new ReviewLabError(422, 'sync_revision_invalid', 'A positive sync revision is required.');
          }
          json(res, 200, { history: await context.repository.getHistory(revision) }); return;
        }
        throw new ReviewLabError(404, 'sync_endpoint_not_found', 'Sync endpoint was not found.');
      }
      if (req.method === 'GET' && segments.length === 1 && segments[0] === 'subjects') { json(res, 200, { subjects: await repository.listSubjects() }); return; }
      if (segments[0] === 'auth' && segments[1] === 'status' && segments.length === 2 && req.method === 'GET') {
        if (!sessionStore?.authStatus) throw new ReviewLabError(404, 'authentication_not_available', 'Persistent account authentication requires the PostgreSQL backend.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        json(res, 200, { viewer: current.actor, session: current.session,
          account: await sessionStore.authStatus(current.actor.userId), passkeyAvailable: passkey.available }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'dev' && segments[2] === 'mailbox' && segments[3] === 'latest' && segments.length === 4 && req.method === 'GET') {
        if (!developmentAuthEnabled || emailDelivery.kind !== 'local-test') throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        json(res, 200, { delivery: emailDelivery.deliveries.at(-1) ?? null }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'magic' && segments.length === 2 && req.method === 'GET') {
        html(res, 200, magicConfirmationPage); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'email' && segments[2] === 'start' && segments.length === 3 && req.method === 'POST') {
        if (!sessionStore?.startEmailChallenge) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        if (!emailDelivery.available || !authPublicBaseUrl) throw new ReviewLabError(503, 'email_delivery_unavailable', 'Email sign-in is not configured on this server.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'An anonymous or user session is required.');
        const body = await readJsonBody(req); const email = normalizeEmail(body.email);
        if (!email) throw new ReviewLabError(400, 'invalid_email', 'Enter a valid email address.');
        const remoteAddress = cleanText(req.socket?.remoteAddress, 200) || 'unknown';
        const requestIpHash = createHash('sha256').update(`${secret}:auth-ip:${remoteAddress}`).digest('hex');
        const challenge = await sessionStore.startEmailChallenge({
          email, requestingAccountId: current.actor.userId, requestingSessionId: current.session.id, requestIpHash,
        });
        let magicUrl;
        try { magicUrl = `${new URL('/api/reviews/auth/magic', authPublicBaseUrl).toString()}#token=${encodeURIComponent(challenge.token)}`; }
        catch { await sessionStore.markEmailChallengeDeliveryFailed(challenge.id); throw new ReviewLabError(503, 'email_delivery_unavailable', 'Email sign-in is not configured on this server.'); }
        try {
          await emailDelivery.sendMagicLink({ to: email, magicUrl, expiresAt: challenge.expiresAt, purpose: 'verify_or_sign_in' });
        } catch {
          await sessionStore.markEmailChallengeDeliveryFailed(challenge.id);
          throw new ReviewLabError(503, 'email_delivery_failed', 'The sign-in email could not be sent. Try again later.');
        }
        json(res, 202, { accepted: true, message: 'If delivery is available, a sign-in link has been sent.' }, { 'Set-Cookie': authFlowCookieHeader(challenge.browserBinding, req) }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'magic' && segments[2] === 'confirm' && segments.length === 3 && req.method === 'POST') {
        if (!sessionStore?.confirmEmailChallenge) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'An anonymous or user session is required.');
        const body = await readJsonBody(req); const token = cleanText(body.token, 256); const browserBinding = namedCookie(req, AUTH_FLOW_COOKIE);
        if (!token || !browserBinding) throw new ReviewLabError(401, 'magic_link_invalid', 'This sign-in link is invalid.');
        const verification = await sessionStore.confirmEmailChallenge({
          token, browserBinding, requestingAccountId: current.actor.userId, requestingSessionId: current.session.id,
        });
        const verifiedSession = await sessionStore.issueForVerifiedAccount({ accountId: verification.accountId, authMethod: 'email_magic_link' });
        await sessionStore.revokeCurrent(cookieToken(req), current.actor.userId, 'email_auth_replaced');
        json(res, 200, { viewer: verifiedSession.actor, session: verifiedSession.session, identityVerified: true }, {
          'Set-Cookie': [opaqueCookieHeader(verifiedSession.token, req), authFlowCookieHeader('', req, 0)],
        }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments[2] === 'register' && segments[3] === 'options' && segments.length === 4 && req.method === 'POST') {
        if (!sessionStore?.startPasskeyChallenge || !passkey.available) throw new ReviewLabError(503, 'passkey_unavailable', 'Passkey authentication is not configured on this server.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        const user = await sessionStore.passkeyRegistrationUser(current.actor.userId);
        const options = await passkey.registrationOptions(user);
        const remoteAddress = cleanText(req.socket?.remoteAddress, 200) || 'unknown';
        const started = await sessionStore.startPasskeyChallenge({ kind: 'registration', challenge: options.challenge,
          requestingAccountId: current.actor.userId, requestingSessionId: current.session.id,
          requestIpHash: createHash('sha256').update(`${secret}:auth-ip:${remoteAddress}`).digest('hex'),
          rpID: passkey.rpID, expectedOrigin: passkey.expectedOrigin });
        json(res, 200, { options, expiresAt: started.expiresAt }, { 'Set-Cookie': passkeyFlowCookieHeader(started.browserBinding, req) }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments[2] === 'register' && segments[3] === 'verify' && segments.length === 4 && req.method === 'POST') {
        if (!sessionStore?.consumePasskeyChallenge || !passkey.available) throw new ReviewLabError(503, 'passkey_unavailable', 'Passkey authentication is not configured on this server.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        const body = await readJsonBody(req); const response = body.response; const challenge = clientDataChallenge(response);
        const browserBinding = namedCookie(req, PASSKEY_FLOW_COOKIE);
        if (!challenge || !browserBinding) throw new ReviewLabError(401, 'passkey_challenge_invalid', 'This passkey challenge is invalid.');
        const claimed = await sessionStore.consumePasskeyChallenge({ kind: 'registration', challenge, browserBinding,
          requestingAccountId: current.actor.userId, requestingSessionId: current.session.id });
        let verification;
        try {
          verification = await passkey.verifyRegistration({ response,
            challengeHashMatches: (candidate) => createHash('sha256').update(candidate, 'utf8').digest('hex') === claimed.challengeHash });
        } catch { throw new ReviewLabError(401, 'passkey_verification_failed', 'The passkey could not be verified.'); }
        if (!verification.verified || !verification.registrationInfo?.userVerified) throw new ReviewLabError(401, 'passkey_verification_failed', 'The passkey could not be verified.');
        const info = verification.registrationInfo;
        const saved = await sessionStore.savePasskeyCredential({ accountId: current.actor.userId,
          credential: { ...info.credential, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
            transports: Array.isArray(response?.response?.transports) ? response.response.transports : [] },
          displayName: cleanText(body.displayName, 80) || 'Passkey', challengeId: claimed.id });
        json(res, 201, { verified: true, passkey: saved }, { 'Set-Cookie': passkeyFlowCookieHeader('', req, 0) }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments[2] === 'authenticate' && segments[3] === 'options' && segments.length === 4 && req.method === 'POST') {
        if (!sessionStore?.startPasskeyChallenge || !passkey.available) throw new ReviewLabError(503, 'passkey_unavailable', 'Passkey authentication is not configured on this server.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'An anonymous session is required.');
        const options = await passkey.authenticationOptions(); const remoteAddress = cleanText(req.socket?.remoteAddress, 200) || 'unknown';
        const started = await sessionStore.startPasskeyChallenge({ kind: 'authentication', challenge: options.challenge,
          requestingAccountId: current.actor.userId, requestingSessionId: current.session.id,
          requestIpHash: createHash('sha256').update(`${secret}:auth-ip:${remoteAddress}`).digest('hex'),
          rpID: passkey.rpID, expectedOrigin: passkey.expectedOrigin });
        json(res, 200, { options, expiresAt: started.expiresAt }, { 'Set-Cookie': passkeyFlowCookieHeader(started.browserBinding, req) }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments[2] === 'authenticate' && segments[3] === 'verify' && segments.length === 4 && req.method === 'POST') {
        if (!sessionStore?.getPasskeyCredential || !passkey.available) throw new ReviewLabError(503, 'passkey_unavailable', 'Passkey authentication is not configured on this server.');
        const current = await resolveActor(req, secret, adminToken, sessionStore);
        if (!current.actor || !current.session || current.actor.role !== 'user') throw new ReviewLabError(401, 'authentication_required', 'An anonymous session is required.');
        const body = await readJsonBody(req); const response = body.response; const challenge = clientDataChallenge(response);
        const browserBinding = namedCookie(req, PASSKEY_FLOW_COOKIE);
        if (!challenge || !browserBinding) throw new ReviewLabError(401, 'passkey_challenge_invalid', 'This passkey challenge is invalid.');
        const claimed = await sessionStore.consumePasskeyChallenge({ kind: 'authentication', challenge, browserBinding,
          requestingAccountId: current.actor.userId, requestingSessionId: current.session.id });
        const credential = await sessionStore.getPasskeyCredential(cleanText(response?.id, 2048));
        if (!credential || response?.response?.userHandle !== credential.userId) throw new ReviewLabError(401, 'passkey_verification_failed', 'The passkey could not be verified.');
        let verification;
        try {
          verification = await passkey.verifyAuthentication({ response, credential,
            challengeHashMatches: (candidate) => createHash('sha256').update(candidate, 'utf8').digest('hex') === claimed.challengeHash });
        } catch { throw new ReviewLabError(401, 'passkey_verification_failed', 'The passkey could not be verified.'); }
        if (!verification.verified || !verification.authenticationInfo?.userVerified) throw new ReviewLabError(401, 'passkey_verification_failed', 'The passkey could not be verified.');
        const authenticated = await sessionStore.finishPasskeyAuthentication({ credentialId: credential.id,
          expectedCounter: credential.counter, newCounter: verification.authenticationInfo.newCounter,
          requestingAccountId: current.actor.userId, requestingSessionId: current.session.id, challengeId: claimed.id });
        json(res, 200, { viewer: authenticated.actor, session: authenticated.session, identityVerified: true }, {
          'Set-Cookie': [opaqueCookieHeader(authenticated.token, req), passkeyFlowCookieHeader('', req, 0)],
        }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments.length === 2 && req.method === 'GET') {
        if (!sessionStore?.listPasskeys) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        json(res, 200, { passkeys: await sessionStore.listPasskeys(actor.userId) }); return;
      }
      if (segments[0] === 'auth' && segments[1] === 'passkeys' && segments.length === 3 && req.method === 'DELETE') {
        if (!sessionStore?.revokePasskey) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        json(res, 200, { revoked: await sessionStore.revokePasskey(cleanText(segments[2], 2048), actor.userId) }); return;
      }
      if (segments[0] === 'session' && segments.length === 1 && req.method === 'POST') {
        if (!secret) throw new ReviewLabError(503, 'authentication_not_configured', 'Review authentication is not configured on this server.');
        if (!sessionStore) {
          const actor = parseSession(req, secret) ?? { userId: `user_${randomUUID()}`, role: 'user' };
          json(res, 200, { viewer: actor }, { 'Set-Cookie': cookieHeader(actor, secret, req) }); return;
        }
        const token = cookieToken(req);
        try {
          if (token && !token.includes('.')) {
            const current = await sessionStore.authenticate(token);
            if (current) { json(res, 200, { viewer: current.actor, session: current.session }); return; }
          }
          const legacy = token ? parseLegacySessionToken(token, secret) : null;
          const created = legacy
            ? await sessionStore.migrateLegacy({ accountId: legacy.actor.userId, legacyToken: token, legacyIssuedAt: legacy.issuedAt, legacyExpiresAt: legacy.expiresAt })
            : await sessionStore.createAnonymous();
          json(res, 200, { viewer: created.actor, session: created.session, migrated: Boolean(legacy) }, { 'Set-Cookie': opaqueCookieHeader(created.token, req) }); return;
        } catch (error) {
          if (error instanceof ReviewLabError) throw error;
          throw new ReviewLabError(503, 'authentication_store_unavailable', 'Authentication is temporarily unavailable.');
        }
      }
      if (segments[0] === 'session' && segments[1] === 'migrate' && segments.length === 2 && req.method === 'POST') {
        if (!sessionStore || !secret) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const token = cookieToken(req); const legacy = parseLegacySessionToken(token, secret);
        if (!legacy) throw new ReviewLabError(401, 'legacy_session_invalid', 'A valid legacy session is required.');
        const created = await sessionStore.migrateLegacy({ accountId: legacy.actor.userId, legacyToken: token, legacyIssuedAt: legacy.issuedAt, legacyExpiresAt: legacy.expiresAt });
        json(res, 200, { viewer: created.actor, session: created.session, migrated: true }, { 'Set-Cookie': opaqueCookieHeader(created.token, req) }); return;
      }
      if (segments[0] === 'session' && segments[1] === 'rotate' && segments.length === 2 && req.method === 'POST') {
        if (!sessionStore) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        await requireActor(req, secret, adminToken, sessionStore);
        const rotated = await sessionStore.rotate(cookieToken(req));
        json(res, 200, { viewer: rotated.actor, session: rotated.session }, { 'Set-Cookie': opaqueCookieHeader(rotated.token, req) }); return;
      }
      if (segments[0] === 'session' && segments.length === 1 && req.method === 'DELETE') {
        if (!sessionStore) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        await sessionStore.revokeCurrent(cookieToken(req), actor.userId);
        json(res, 200, { revoked: true }, { 'Set-Cookie': expiredCookieHeader(req) }); return;
      }
      if (segments[0] === 'session' && segments[1] === 'dev' && segments.length === 2 && req.method === 'POST') {
        if (!developmentAuthEnabled || !secret) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const body = await readJsonBody(req); const userId = cleanId(body.userId, 120); const role = body.role === 'admin' ? 'admin' : 'user';
        if (!userId) throw new ReviewLabError(400, 'invalid_user_id', 'A valid development user ID is required.');
        const actor = { userId, role };
        if (sessionStore) {
          if (role === 'admin') throw new ReviewLabError(403, 'admin_session_forbidden', 'Administrator sessions use the separate administrator credential path.');
          const created = await sessionStore.createAnonymous({ accountId: userId, authMethod: 'anonymous' });
          json(res, 200, { viewer: created.actor, session: created.session }, { 'Set-Cookie': opaqueCookieHeader(created.token, req) }); return;
        }
        json(res, 200, { viewer: actor }, { 'Set-Cookie': cookieHeader(actor, secret, req) }); return;
      }
      if (segments[0] === 'sessions' && segments.length === 1 && req.method === 'GET') {
        if (!sessionStore) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        json(res, 200, { sessions: await sessionStore.list(actor.userId) }); return;
      }
      if (segments[0] === 'sessions' && segments.length === 1 && req.method === 'DELETE') {
        if (!sessionStore) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        const count = await sessionStore.revokeAll(actor.userId);
        json(res, 200, { revoked: count }, { 'Set-Cookie': expiredCookieHeader(req) }); return;
      }
      if (segments[0] === 'sessions' && segments.length === 2 && req.method === 'DELETE') {
        if (!sessionStore) throw new ReviewLabError(404, 'not_found', 'Endpoint was not found.');
        const actor = await requireActor(req, secret, adminToken, sessionStore);
        json(res, 200, { revoked: await sessionStore.revokeOne(cleanId(segments[1], 120), actor.userId) }); return;
      }
      if (req.method === 'GET' && segments[0] === 'subjects' && segments[2] === 'reviews' && segments.length === 3) {
        const viewer = secret ? (await resolveActor(req, secret, adminToken, sessionStore)).actor : null;
        json(res, 200, { reviews: await repository.listPublic(segments[1], viewer?.userId ?? null) }); return;
      }
      if (req.method === 'GET' && segments[0] === 'me' && segments[1] === 'reviews' && segments.length === 2) {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { reviews: await repository.listByAuthor(actor.userId) }); return;
      }
      if (segments[0] === 'nodes' && segments[2] === 'context' && segments.length === 3 && req.method === 'GET') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, await repository.nodeReviewContext(segments[1], actor)); return;
      }
      if (segments[0] === 'nodes' && segments[2] === 'subject' && segments.length === 3 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, await resolveExperienceSubject(segments[1], await readJsonBody(req), actor)); return;
      }
      if (segments[0] === 'nodes' && segments[2] === 'journey' && segments.length === 3 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); const body = await readJsonBody(req);
        if (body?.subjectCandidate) await resolveExperienceSubject(segments[1], body.subjectCandidate, actor);
        json(res, 200, { journey: await repository.startLandingJourney(segments[1], actor, body) }); return;
      }
      if (segments[0] === 'nodes' && segments[2] === 'journey' && segments[3] === 'steps' && segments.length === 5 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { journey: await repository.completeLandingStep(segments[1], segments[4], actor) }); return;
      }
      if (segments[0] === 'nodes' && segments[2] === 'landing' && segments.length === 3 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { journey: await repository.commitLanding(segments[1], actor, await readJsonBody(req)) }); return;
      }
      if (segments[0] === 'bindings' && segments.length === 2 && req.method === 'GET') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { binding: await repository.getBinding(segments[1], actor) }); return;
      }
      if (segments[0] === 'bindings' && segments.length === 2 && req.method === 'PUT') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); const body = await readJsonBody(req);
        json(res, 200, { binding: await repository.bindNode(segments[1], cleanId(body.subjectId), actor) }); return;
      }
      if (segments[0] === 'reviews' && segments.length === 1 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 201, { review: await repository.create(await readJsonBody(req), actor) }); return;
      }
      if (segments[0] === 'reviews' && segments.length === 2 && req.method === 'PUT') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { review: await repository.update(segments[1], await readJsonBody(req), actor) }); return;
      }
      if (segments[0] === 'reviews' && segments[2] === 'helpful' && segments.length === 3 && (req.method === 'POST' || req.method === 'DELETE')) {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 200, { review: await repository.setHelpful(segments[1], actor, req.method === 'POST') }); return;
      }
      if (segments[0] === 'reviews' && segments[2] === 'reports' && segments.length === 3 && req.method === 'POST') {
        const actor = await requireActor(req, secret, adminToken, sessionStore); json(res, 201, { report: await repository.report(segments[1], actor, await readJsonBody(req)) }); return;
      }
      if (segments[0] === 'admin') {
        const actor = await requireActor(req, secret, adminToken, sessionStore, 'admin');
        if (segments[1] === 'action-subjects' && segments.length === 2 && req.method === 'POST') {
          json(res, 201, { subject: await repository.registerSharedActionSubject(await readJsonBody(req), actor) }); return;
        }
        if (segments[1] === 'node-subjects' && segments.length === 2 && req.method === 'POST') {
          const body = await readJsonBody(req);
          json(res, 200, { mapping: await repository.verifyNodeSubject(cleanId(body.userId, 120), cleanId(body.nodeId), cleanId(body.subjectId), actor) }); return;
        }
        if (segments[1] === 'node-subjects' && segments[2] === 'correct' && segments.length === 3 && req.method === 'POST') {
          const body = await readJsonBody(req);
          json(res, 200, { correction: await repository.correctNodeSubject(cleanId(body.userId, 120), cleanId(body.nodeId), body, actor) }); return;
        }
        if (segments[1] === 'experience-resolutions' && segments.length === 2 && req.method === 'GET') { json(res, 200, { resolutions: await repository.listExperienceResolutions() }); return; }
        if (segments[1] === 'queue' && segments.length === 2 && req.method === 'GET') { json(res, 200, await repository.adminQueue()); return; }
        if (segments[1] === 'audit' && segments.length === 2 && req.method === 'GET') { json(res, 200, { auditLog: await repository.auditLog() }); return; }
        if (segments[1] === 'moderation' && segments[2] === 'status' && segments.length === 3 && req.method === 'GET') { json(res, 200, { scheduler: schedulerStatus(), moderatorAvailable: moderator.available }); return; }
        if (segments[1] === 'reviews' && segments[3] === 'actions' && segments.length === 4 && req.method === 'POST') { json(res, 200, { review: await repository.adminReviewAction(segments[2], actor, await readJsonBody(req)) }); return; }
        if (segments[1] === 'users' && segments[3] === 'freeze' && segments.length === 4 && req.method === 'POST') { json(res, 200, { user: await repository.freezeUser(segments[2], actor, await readJsonBody(req)) }); return; }
        if (segments[1] === 'reports' && segments[3] === 'resolve' && segments.length === 4 && req.method === 'POST') { json(res, 200, { report: await repository.resolveReport(segments[2], actor, await readJsonBody(req)) }); return; }
        if (segments[1] === 'moderation' && segments[2] === 'process' && segments.length === 3 && req.method === 'POST') { json(res, 200, await processNextModeration()); return; }
      }
      json(res, 404, { error: { code: 'not_found', message: 'Review endpoint was not found.' } });
    } catch (error) {
      if (error instanceof ReviewLabError) { json(res, error.status, { error: { code: error.code, message: error.message } }); return; }
      if (error instanceof AccountSyncRepositoryError) {
        let status = error.status;
        if (status === 400) {
          status = error.code === 'bundle_too_large' || error.code === 'world_too_large' || error.code === 'profile_too_large'
            ? 413
            : error.code === 'account_mismatch' ? 403 : 422;
        }
        json(res, status, { error: { code: error.code, message: error.message } }); return;
      }
      console.error('[reviews] persistence or moderation failed', error instanceof Error ? error.message : error);
      json(res, 500, { error: { code: 'review_service_failed', message: 'Review service could not complete the request.' } });
    }
  };

  return {
    middleware, repository, subjects: REVIEW_SUBJECTS, processNextModeration, startJobs, stopJobs, schedulerStatus,
    resolveExperienceSubject, authConfigured: Boolean(secret), moderatorAvailable: moderator.available,
    experienceResolverAvailable: experienceResolver.available, emailDeliveryConfigured: emailDelivery.available && Boolean(authPublicBaseUrl),
  };
}

