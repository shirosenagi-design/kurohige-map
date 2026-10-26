import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_SYNC_AUTHORITY,
  MAX_SYNC_AVATAR_BYTES,
  canonicalJson,
  createAccountSyncBundle,
  jsonByteLength,
  sha256ContentHash,
  validateAccountSyncBundle,
} from '../src/accountSyncContract.ts';
import type { PersistedWorldSnapshotV1 } from '../src/worldState.ts';

const personState = () => ({
  interests: ['音楽'], engagementPatterns: [], constraints: [], recentChanges: [], portableResources: [],
  experiences: [], completedSteps: [], bridgeTags: [],
});

const product = (version: 1 | 2 = 2) => ({
  version,
  personState: personState(),
  userProfile: version === 1
    ? { nickname: '航海者', region: { country: 'JP', prefecture: '東京' }, updatedAt: '2026-10-18T00:00:00.000Z' }
    : { nickname: '航海者', region: { countryCode: 'JP', administrativeArea: '東京' }, updatedAt: '2026-10-18T00:00:00.000Z' },
  onboardingComplete: true,
  personContextRevision: 2,
  observedPersonSignals: [],
});

const node = {
  id: 'node-sync-a', title: '音楽を公開する', shortDescription: 'AIで作った曲を公開して反応を確かめる。',
  category: 'creative', nodeKind: 'activity' as const, relationToGoal: 'adjacent' as const,
  curiosityFit: .8, accessibility: .7, novelty: .6, friction: .3,
  portableResourceTags: ['publishing'], connectionTags: ['music'], helpedByTags: [],
  visualRecipe: {
    visualTheme: 'creative', dominantMotif: 'studio', secondaryObjects: ['speaker'], terrainProfile: 'terraced',
    accentPalette: 'coral', density: 'medium' as const, openness: 'balanced' as const,
    landmarkEmphasis: 'high' as const, energyLevel: 'moderate' as const,
  },
};

const world = (): PersistedWorldSnapshotV1 => ({
  schemaVersion: 1,
  worldId: 'world-sync-a',
  worldRevision: 4,
  savedAt: '2026-10-18T00:00:00.000Z',
  layoutVersion: 1,
  context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 2 },
  nodes: [structuredClone(node)],
  nodeStates: {
    'node-sync-a': { visible: true, visited: false, kept: true, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: [] },
  },
  explorationBands: { 'node-sync-a': 0 },
  generatedBatches: [{ band: 0, nodeIds: ['node-sync-a'] }],
  stepCatalog: {},
  detailCache: {},
  ship: { settledPosition: { x: 0, y: 310 } },
  selectedNodeId: 'node-sync-a',
});

const input = () => ({
  accountId: 'user_sync_owner',
  syncRevision: 0,
  operationId: '7d847f19-b5e7-4d36-a122-46df8200c001',
  deviceId: 'device.phase2d.primary',
  capturedAt: '2026-10-18T00:01:00.000Z',
  productBefore: product(2),
  worldBefore: world(),
  productAfter: product(2),
  worldAfter: world(),
});

test('canonical JSON and SHA-256 content hashes are deterministic', async () => {
  assert.equal(canonicalJson({ z: 1, nested: { b: true, a: 'x' } }), '{"nested":{"a":"x","b":true},"z":1}');
  assert.equal(await sha256ContentHash({ b: 2, a: 1 }), await sha256ContentHash({ a: 1, b: 2 }));
  assert.equal((await sha256ContentHash({ a: 1 })).length, 64);
});

test('stable local reads produce a validated account-owned Sync Bundle', async () => {
  const created = await createAccountSyncBundle(input());
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  assert.equal(created.value.activeWorldId, 'world-sync-a');
  assert.deepEqual(created.value.authority, ACCOUNT_SYNC_AUTHORITY);
  assert.equal(created.value.contentHash.length, 64);
  assert.equal(created.byteLength, jsonByteLength(created.value));
  const validated = await validateAccountSyncBundle(created.value, 'user_sync_owner');
  assert.equal(validated.status, 'ready');
});

test('Product State v1 is normalized while retaining its source schema version', async () => {
  const candidate = input();
  candidate.productBefore = product(1);
  candidate.productAfter = product(1);
  const created = await createAccountSyncBundle(candidate);
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  assert.equal(created.value.profile.sourceSchemaVersion, 1);
  assert.equal(created.value.profile.schemaVersion, 2);
  assert.deepEqual(created.value.profile.snapshot.userProfile.region, { countryCode: 'JP', administrativeArea: '東京' });
});

test('capture rejects Profile or World changes between local reads', async () => {
  const profileRace = input();
  profileRace.productAfter = { ...product(2), personContextRevision: 3 };
  assert.equal((await createAccountSyncBundle(profileRace)).status, 'invalid');
  const worldRace = input();
  worldRace.worldAfter = { ...world(), worldRevision: 5 };
  const result = await createAccountSyncBundle(worldRace);
  assert.equal(result.status, 'invalid');
  if (result.status === 'invalid') assert.equal(result.code, 'local_capture_changed');
});

test('invalid schema and incoherent Node/Step references are rejected without changing the source', async () => {
  const invalidSchema = input();
  invalidSchema.worldBefore = { ...world(), schemaVersion: 99 };
  invalidSchema.worldAfter = structuredClone(invalidSchema.worldBefore);
  const schemaResult = await createAccountSyncBundle(invalidSchema);
  assert.equal(schemaResult.status, 'invalid');
  const invalidReference = world();
  invalidReference.nodeStates['node-sync-a'].completedStepIds = ['missing-step'];
  const referenceInput = input();
  referenceInput.worldBefore = invalidReference;
  referenceInput.worldAfter = structuredClone(invalidReference);
  const referenceResult = await createAccountSyncBundle(referenceInput);
  assert.equal(referenceResult.status, 'invalid');
  assert.deepEqual(invalidReference.nodeStates['node-sync-a'].completedStepIds, ['missing-step']);
});

test('account ownership, authority boundary, unknown bundle fields, and tampering are rejected', async () => {
  const created = await createAccountSyncBundle(input());
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  const otherAccount = await validateAccountSyncBundle(created.value, 'user_other_owner');
  assert.equal(otherAccount.status, 'invalid');
  if (otherAccount.status === 'invalid') assert.equal(otherAccount.code, 'account_mismatch');
  const authorityTamper = structuredClone(created.value) as Record<string, unknown>;
  authorityTamper.authority = { ...ACCOUNT_SYNC_AUTHORITY, includesAuthoritativeLandingEvidence: true };
  assert.equal((await validateAccountSyncBundle(authorityTamper, 'user_sync_owner')).status, 'invalid');
  const unknown = { ...created.value, landingLedger: { landed: true } };
  const unknownResult = await validateAccountSyncBundle(unknown, 'user_sync_owner');
  assert.equal(unknownResult.status, 'invalid');
  if (unknownResult.status === 'invalid') assert.equal(unknownResult.code, 'unknown_bundle_field');
  const tampered = structuredClone(created.value);
  tampered.profile.snapshot.userProfile.nickname = '改ざん';
  const tamperedResult = await validateAccountSyncBundle(tampered, 'user_sync_owner');
  assert.equal(tamperedResult.status, 'invalid');
  if (tamperedResult.status === 'invalid') assert.equal(tamperedResult.code, 'content_hash_mismatch');
});

test('Avatar format and decoded byte limit are enforced', async () => {
  const invalidFormat = input();
  invalidFormat.productBefore.userProfile.avatarRef = 'https://tracker.example/avatar.png';
  invalidFormat.productAfter.userProfile.avatarRef = 'https://tracker.example/avatar.png';
  const formatResult = await createAccountSyncBundle(invalidFormat);
  assert.equal(formatResult.status, 'invalid');
  if (formatResult.status === 'invalid') assert.equal(formatResult.code, 'invalid_avatar_format');

  const oversized = `data:image/png;base64,${Buffer.alloc(MAX_SYNC_AVATAR_BYTES + 1).toString('base64')}`;
  const oversizedInput = input();
  oversizedInput.productBefore.userProfile.avatarRef = oversized;
  oversizedInput.productAfter.userProfile.avatarRef = oversized;
  const sizeResult = await createAccountSyncBundle(oversizedInput);
  assert.equal(sizeResult.status, 'invalid');
  if (sizeResult.status === 'invalid') assert.equal(sizeResult.code, 'avatar_too_large');
});

test('future optional World fields remain hash-protected while unknown Bundle authority fields are forbidden', async () => {
  const extended = { ...world(), futureCameraEnvelope: { schemaVersion: 1, x: 4, y: -20, zoom: 1.2 } };
  const candidate = input();
  candidate.worldBefore = extended;
  candidate.worldAfter = structuredClone(extended);
  const created = await createAccountSyncBundle(candidate);
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  assert.deepEqual((created.value.world?.snapshot as unknown as Record<string, unknown>).futureCameraEnvelope,
    { schemaVersion: 1, x: 4, y: -20, zoom: 1.2 });
  const changed = structuredClone(created.value);
  (changed.world!.snapshot as unknown as Record<string, unknown>).futureCameraEnvelope = { schemaVersion: 1, x: 5, y: -20, zoom: 1.2 };
  assert.equal((await validateAccountSyncBundle(changed, 'user_sync_owner')).status, 'invalid');
});
