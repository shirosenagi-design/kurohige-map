import { parsePersistedProductState, type PersistedProductState } from './productState.ts';
import { parsePersistedWorld, type PersistedWorldSnapshotV1 } from './worldState.ts';

export const ACCOUNT_SYNC_SCHEMA_VERSION = 1 as const;
export const MAX_SYNC_AVATAR_BYTES = 256 * 1024;
export const MAX_SYNC_PROFILE_JSON_BYTES = 1024 * 1024;
export const MAX_SYNC_WORLD_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_SYNC_BUNDLE_JSON_BYTES = 18 * 1024 * 1024;

export const ACCOUNT_SYNC_AUTHORITY = {
  worldState: 'client_snapshot',
  landingEligibility: 'server_landing_ledger_only',
  includesAuthoritativeLandingEvidence: false,
} as const;

export type SyncWorldStatus = 'active' | 'archived' | 'conflict';

export type SyncArchiveMetadata = {
  archivedAt: string;
  reason: string;
};

export type SyncConflictMetadata = {
  conflictId: string;
  baseSyncRevision: number;
  serverSyncRevision: number;
  detectedAt: string;
};

export type SyncWorldEnvelopeV1 = {
  schemaVersion: 1;
  layoutVersion: number;
  worldId: string;
  status: SyncWorldStatus;
  snapshot: PersistedWorldSnapshotV1;
  archive: SyncArchiveMetadata | null;
  conflict: SyncConflictMetadata | null;
};

export type SyncProfileEnvelopeV1 = {
  schemaVersion: 2;
  sourceSchemaVersion: 1 | 2;
  snapshot: PersistedProductState;
};

export type AccountSyncBundleContentV1 = {
  schemaVersion: typeof ACCOUNT_SYNC_SCHEMA_VERSION;
  accountId: string;
  syncRevision: number;
  operationId: string;
  deviceId: string;
  capturedAt: string;
  activeWorldId: string | null;
  profile: SyncProfileEnvelopeV1;
  world: SyncWorldEnvelopeV1 | null;
  authority: typeof ACCOUNT_SYNC_AUTHORITY;
};

export type AccountSyncBundleV1 = AccountSyncBundleContentV1 & {
  contentHash: string;
};

export type StableLocalCaptureInput = {
  accountId: string;
  syncRevision: number;
  operationId: string;
  deviceId: string;
  capturedAt: string;
  productBefore: unknown;
  worldBefore: unknown | null;
  productAfter: unknown;
  worldAfter: unknown | null;
  worldStatus?: SyncWorldStatus;
  archive?: SyncArchiveMetadata | null;
  conflict?: SyncConflictMetadata | null;
};

export type SyncContractResult<T> =
  | { status: 'ready'; value: T; byteLength: number }
  | { status: 'invalid'; code: string; reason: string; preservedSource: unknown };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,179}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DATA_AVATAR_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/u;
const INTERNAL_AVATAR_PATTERN = /^(?:\/assets\/|asset:)[^\s]{1,2040}$/u;
const BUNDLE_KEYS = new Set([
  'schemaVersion', 'accountId', 'syncRevision', 'operationId', 'deviceId', 'capturedAt',
  'activeWorldId', 'profile', 'world', 'authority', 'contentHash',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not accept non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  throw new TypeError('Canonical JSON accepts only JSON-compatible values.');
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

export async function sha256ContentHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedProductState(value: unknown): SyncContractResult<SyncProfileEnvelopeV1> {
  const sourceVersion = isRecord(value) ? value.version : undefined;
  if ((sourceVersion !== 1 && sourceVersion !== 2) || !isRecord(value)
    || !isRecord(value.personState) || !isRecord(value.userProfile)
    || typeof value.onboardingComplete !== 'boolean'
    || !isNonNegativeInteger(value.personContextRevision)
    || !Array.isArray(value.observedPersonSignals)) {
    return { status: 'invalid', code: 'invalid_product_state', reason: 'Product State v1 or v2 is required.', preservedSource: value };
  }
  const snapshot = parsePersistedProductState(JSON.stringify(value));
  const avatar = snapshot.userProfile.avatarRef;
  if (avatar) {
    const dataMatch = avatar.match(DATA_AVATAR_PATTERN);
    if (!dataMatch && !INTERNAL_AVATAR_PATTERN.test(avatar)) {
      return { status: 'invalid', code: 'invalid_avatar_format', reason: 'Avatar must be an approved image data URL or internal asset reference.', preservedSource: value };
    }
    if (dataMatch) {
      const padding = dataMatch[2].endsWith('==') ? 2 : dataMatch[2].endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor(dataMatch[2].length * 3 / 4) - padding;
      if (decodedBytes > MAX_SYNC_AVATAR_BYTES) {
        return { status: 'invalid', code: 'avatar_too_large', reason: 'Avatar exceeds the 256 KiB decoded size limit.', preservedSource: value };
      }
    }
  }
  const byteLength = jsonByteLength(snapshot);
  if (byteLength > MAX_SYNC_PROFILE_JSON_BYTES) {
    return { status: 'invalid', code: 'profile_too_large', reason: 'Profile Snapshot exceeds the JSON size limit.', preservedSource: value };
  }
  return { status: 'ready', value: { schemaVersion: 2, sourceSchemaVersion: sourceVersion, snapshot }, byteLength };
}

function normalizedWorld(value: unknown | null, status: SyncWorldStatus, archive: SyncArchiveMetadata | null, conflict: SyncConflictMetadata | null): SyncContractResult<SyncWorldEnvelopeV1 | null> {
  if (value === null) return { status: 'ready', value: null, byteLength: 4 };
  const parsed = parsePersistedWorld(value);
  if (parsed.status !== 'ready') {
    return { status: 'invalid', code: 'invalid_world_snapshot', reason: parsed.reason, preservedSource: value };
  }
  const snapshot = structuredClone(parsed.snapshot);
  const byteLength = jsonByteLength(snapshot);
  if (byteLength > MAX_SYNC_WORLD_JSON_BYTES) {
    return { status: 'invalid', code: 'world_too_large', reason: 'World Snapshot exceeds the JSON size limit.', preservedSource: value };
  }
  if (status === 'active' && (archive !== null || conflict !== null)) {
    return { status: 'invalid', code: 'invalid_world_metadata', reason: 'An active World cannot contain archive or conflict metadata.', preservedSource: value };
  }
  if (status === 'archived' && (!archive || !isIsoDate(archive.archivedAt) || !archive.reason.trim() || conflict !== null)) {
    return { status: 'invalid', code: 'invalid_archive_metadata', reason: 'An archived World requires valid archive metadata only.', preservedSource: value };
  }
  if (status === 'conflict' && (!conflict || !UUID_PATTERN.test(conflict.conflictId)
    || !isNonNegativeInteger(conflict.baseSyncRevision) || !isNonNegativeInteger(conflict.serverSyncRevision)
    || conflict.serverSyncRevision < conflict.baseSyncRevision || !isIsoDate(conflict.detectedAt) || archive !== null)) {
    return { status: 'invalid', code: 'invalid_conflict_metadata', reason: 'A conflict World requires valid conflict metadata only.', preservedSource: value };
  }
  return {
    status: 'ready',
    value: {
      schemaVersion: 1,
      layoutVersion: snapshot.layoutVersion,
      worldId: snapshot.worldId,
      status,
      snapshot,
      archive: archive ? structuredClone(archive) : null,
      conflict: conflict ? structuredClone(conflict) : null,
    },
    byteLength,
  };
}

function contentWithoutHash(bundle: AccountSyncBundleV1): AccountSyncBundleContentV1 {
  const { contentHash: _contentHash, ...content } = bundle;
  return content;
}

function invalid<T>(code: string, reason: string, preservedSource: unknown): SyncContractResult<T> {
  return { status: 'invalid', code, reason, preservedSource };
}

export async function createAccountSyncBundle(input: StableLocalCaptureInput): Promise<SyncContractResult<AccountSyncBundleV1>> {
  if (!ACCOUNT_ID_PATTERN.test(input.accountId)) return invalid('invalid_account_id', 'A valid authenticated accountId is required.', input);
  if (!UUID_PATTERN.test(input.operationId)) return invalid('invalid_operation_id', 'operationId must be a UUID.', input);
  if (!DEVICE_ID_PATTERN.test(input.deviceId)) return invalid('invalid_device_id', 'deviceId has an invalid format.', input);
  if (!isNonNegativeInteger(input.syncRevision)) return invalid('invalid_sync_revision', 'syncRevision must be a non-negative integer.', input);
  if (!isIsoDate(input.capturedAt)) return invalid('invalid_capture_time', 'capturedAt must be an ISO timestamp.', input);

  const beforeProfile = normalizedProductState(input.productBefore);
  if (beforeProfile.status === 'invalid') return beforeProfile;
  const afterProfile = normalizedProductState(input.productAfter);
  if (afterProfile.status === 'invalid') return afterProfile;
  const status = input.worldStatus ?? 'active';
  const archive = input.archive ?? null;
  const conflict = input.conflict ?? null;
  const beforeWorld = normalizedWorld(input.worldBefore, status, archive, conflict);
  if (beforeWorld.status === 'invalid') return beforeWorld;
  const afterWorld = normalizedWorld(input.worldAfter, status, archive, conflict);
  if (afterWorld.status === 'invalid') return afterWorld;

  const [profileBeforeHash, profileAfterHash, worldBeforeHash, worldAfterHash] = await Promise.all([
    sha256ContentHash(beforeProfile.value.snapshot),
    sha256ContentHash(afterProfile.value.snapshot),
    sha256ContentHash(beforeWorld.value?.snapshot ?? null),
    sha256ContentHash(afterWorld.value?.snapshot ?? null),
  ]);
  if (profileBeforeHash !== profileAfterHash || worldBeforeHash !== worldAfterHash) {
    return invalid('local_capture_changed', 'Profile or World changed during capture; retry without uploading either partial read.', {
      productBefore: input.productBefore,
      worldBefore: input.worldBefore,
      productAfter: input.productAfter,
      worldAfter: input.worldAfter,
    });
  }

  const world = afterWorld.value;
  const activeWorldId = status === 'active' && world ? world.worldId : null;
  const content: AccountSyncBundleContentV1 = {
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    accountId: input.accountId,
    syncRevision: input.syncRevision,
    operationId: input.operationId.toLowerCase(),
    deviceId: input.deviceId,
    capturedAt: new Date(input.capturedAt).toISOString(),
    activeWorldId,
    profile: afterProfile.value,
    world,
    authority: ACCOUNT_SYNC_AUTHORITY,
  };
  const contentHash = await sha256ContentHash(content);
  const bundle = { ...content, contentHash };
  const byteLength = jsonByteLength(bundle);
  if (byteLength > MAX_SYNC_BUNDLE_JSON_BYTES) return invalid('bundle_too_large', 'Sync Bundle exceeds the JSON size limit.', input);
  return { status: 'ready', value: bundle, byteLength };
}

export async function validateAccountSyncBundle(value: unknown, expectedAccountId?: string): Promise<SyncContractResult<AccountSyncBundleV1>> {
  if (!isRecord(value)) return invalid('invalid_bundle', 'Sync Bundle must be an object.', value);
  if (Object.keys(value).some((key) => !BUNDLE_KEYS.has(key))) return invalid('unknown_bundle_field', 'Sync Bundle contains an unknown top-level field.', value);
  if (value.schemaVersion !== ACCOUNT_SYNC_SCHEMA_VERSION) return invalid('unsupported_sync_schema', 'Unsupported Sync Bundle schemaVersion.', value);
  if (typeof value.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(value.accountId)) return invalid('invalid_account_id', 'Invalid accountId.', value);
  if (expectedAccountId !== undefined && value.accountId !== expectedAccountId) return invalid('account_mismatch', 'Sync Bundle belongs to a different account.', value);
  if (!isNonNegativeInteger(value.syncRevision) || typeof value.operationId !== 'string' || !UUID_PATTERN.test(value.operationId)
    || typeof value.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.deviceId) || !isIsoDate(value.capturedAt)) {
    return invalid('invalid_bundle_identity', 'Sync revision, operation, device, or capture metadata is invalid.', value);
  }
  if (!isRecord(value.profile)) return invalid('invalid_profile_envelope', 'Profile envelope is required.', value);
  const profile = normalizedProductState(value.profile.snapshot);
  if (profile.status === 'invalid') return profile;
  if (value.profile.schemaVersion !== 2 || (value.profile.sourceSchemaVersion !== 1 && value.profile.sourceSchemaVersion !== 2)) {
    return invalid('invalid_profile_schema', 'Profile envelope schema is invalid.', value);
  }
  if (profile.value.sourceSchemaVersion !== value.profile.sourceSchemaVersion) {
    return invalid('profile_source_schema_mismatch', 'Profile source schema metadata does not match its Snapshot.', value);
  }
  const rawWorld = value.world;
  let world: SyncWorldEnvelopeV1 | null = null;
  if (rawWorld !== null) {
    if (!isRecord(rawWorld) || rawWorld.schemaVersion !== 1 || !isPositiveInteger(rawWorld.layoutVersion)
      || typeof rawWorld.worldId !== 'string' || !['active', 'archived', 'conflict'].includes(String(rawWorld.status))) {
      return invalid('invalid_world_envelope', 'World envelope is invalid.', value);
    }
    const parsedWorld = normalizedWorld(rawWorld.snapshot, rawWorld.status as SyncWorldStatus,
      (rawWorld.archive ?? null) as SyncArchiveMetadata | null, (rawWorld.conflict ?? null) as SyncConflictMetadata | null);
    if (parsedWorld.status === 'invalid') return parsedWorld;
    world = parsedWorld.value;
    if (!world || world.worldId !== rawWorld.worldId || world.layoutVersion !== rawWorld.layoutVersion) {
      return invalid('world_envelope_mismatch', 'World envelope metadata does not match its Snapshot.', value);
    }
  }
  const activeWorldId = typeof value.activeWorldId === 'string' ? value.activeWorldId : value.activeWorldId === null ? null : undefined;
  if (activeWorldId === undefined || (world?.status === 'active' ? activeWorldId !== world.worldId : activeWorldId !== null)) {
    return invalid('active_world_mismatch', 'activeWorldId does not match the active World envelope.', value);
  }
  if (!isRecord(value.authority)
    || value.authority.worldState !== ACCOUNT_SYNC_AUTHORITY.worldState
    || value.authority.landingEligibility !== ACCOUNT_SYNC_AUTHORITY.landingEligibility
    || value.authority.includesAuthoritativeLandingEvidence !== false) {
    return invalid('authority_boundary_violation', 'Landing authority must remain in the Server Landing Ledger.', value);
  }
  if (typeof value.contentHash !== 'string' || !SHA256_PATTERN.test(value.contentHash)) return invalid('invalid_content_hash', 'contentHash must be a lowercase SHA-256 digest.', value);

  const normalized: AccountSyncBundleV1 = {
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    accountId: value.accountId,
    syncRevision: value.syncRevision,
    operationId: value.operationId.toLowerCase(),
    deviceId: value.deviceId,
    capturedAt: new Date(value.capturedAt).toISOString(),
    activeWorldId,
    profile: { ...profile.value, sourceSchemaVersion: value.profile.sourceSchemaVersion },
    world,
    authority: ACCOUNT_SYNC_AUTHORITY,
    contentHash: value.contentHash,
  };
  const expectedHash = await sha256ContentHash(contentWithoutHash(normalized));
  if (expectedHash !== normalized.contentHash) return invalid('content_hash_mismatch', 'Sync Bundle contentHash does not match its content.', value);
  const byteLength = jsonByteLength(normalized);
  if (byteLength > MAX_SYNC_BUNDLE_JSON_BYTES) return invalid('bundle_too_large', 'Sync Bundle exceeds the JSON size limit.', value);
  return { status: 'ready', value: normalized, byteLength };
}
