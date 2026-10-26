import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createReviewLabApi } from '../server/reviewLabApi.mjs';
import { MODERATION_JOB_CLAIM_SQL, assertPostgresReviewSchema } from '../server/postgres/postgresReviewRepository.mjs';
import { migrateReviewJson, migrationManifest } from '../server/postgres/reviewMigration.mjs';

const root = process.cwd();

test('PostgreSQL schema encodes ownership, landing, publication, vote, report and job invariants', async () => {
  const sql = await readFile(path.join(root, 'server/postgres/migrations/001_review_platform.sql'), 'utf8');
  const authSql = await readFile(path.join(root, 'server/postgres/migrations/002_account_sessions.sql'), 'utf8');
  const identitySql = await readFile(path.join(root, 'server/postgres/migrations/003_email_identity.sql'), 'utf8');
  const passkeySql = await readFile(path.join(root, 'server/postgres/migrations/004_passkeys.sql'), 'utf8');
  const syncSql = await readFile(path.join(root, 'server/postgres/migrations/005_account_world_sync.sql'), 'utf8');
  for (const table of [
    'review_accounts', 'review_sessions', 'experience_subjects', 'verified_node_subjects',
    'landing_journeys', 'voyage_reviews', 'voyage_review_revisions', 'review_helpful_votes',
    'review_reports', 'moderation_jobs', 'experience_resolutions', 'review_audit_log',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /UNIQUE \(author_account_id, source_node_id\)/);
  assert.match(sql, /jsonb_array_length\(required_step_ids\) = 3/);
  assert.match(sql, /review_reports_one_open_per_reporter_uq/);
  assert.match(sql, /moderation_jobs_claim_idx/);
  assert.match(authSql, /auth_legacy_cookie_claims/);
  assert.match(authSql, /legacy_token_hash text PRIMARY KEY/);
  assert.match(authSql, /account_id text NOT NULL UNIQUE/);
  assert.match(authSql, /CHECK \(role = 'user'\)/);
  assert.match(authSql, /auth_migration_settings/);
  assert.match(authSql, /review_sessions_active_account_idx/);
  assert.match(identitySql, /auth_email_identities/);
  assert.match(identitySql, /auth_magic_link_challenges/);
  assert.match(identitySql, /auth_rate_limit_buckets/);
  assert.match(identitySql, /idle_expires_at/);
  assert.match(identitySql, /token_hash text NOT NULL UNIQUE/);
  assert.match(passkeySql, /auth_webauthn_users/);
  assert.match(passkeySql, /auth_webauthn_credentials/);
  assert.match(passkeySql, /auth_webauthn_challenges/);
  assert.match(passkeySql, /challenge_hash text NOT NULL UNIQUE/);
  assert.match(passkeySql, /public_key bytea NOT NULL/);
  for (const table of [
    'account_sync_heads', 'account_profile_revisions', 'account_worlds', 'account_world_revisions',
    'account_sync_operations', 'account_sync_conflicts',
  ]) assert.match(syncSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(syncSql, /account_worlds_one_active_per_account_uq/);
  assert.match(syncSql, /UNIQUE \(operation_id, account_id\)/);
  assert.match(syncSql, /REFERENCES review_accounts\(id\) ON DELETE RESTRICT/);
});

test('moderation claim is a single database statement using SKIP LOCKED', () => {
  assert.match(MODERATION_JOB_CLAIM_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(MODERATION_JOB_CLAIM_SQL, /UPDATE moderation_jobs AS job/);
  assert.match(MODERATION_JOB_CLAIM_SQL, /RETURNING job\.\*/);
  assert.match(MODERATION_JOB_CLAIM_SQL, /job\.next_attempt_at <= \$2::timestamptz/);
});

test('JSON migration dry-run is read-only and produces deterministic counts and digest', async () => {
  const sourcePath = path.join(root, 'data/review-lab/reviews.json');
  const before = await readFile(sourcePath);
  const first = await migrateReviewJson({ sourcePath, pool: null, apply: false });
  const second = await migrateReviewJson({ sourcePath, pool: null, apply: false });
  const after = await readFile(sourcePath);
  assert.equal(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'));
  assert.equal(first.mode, 'dry-run');
  assert.deepEqual(first.counts, second.counts);
  assert.equal(first.digest, second.digest);
  assert.equal(first.sourceSha256, second.sourceSha256);
});

test('review API accepts an injected repository and does not silently fall back to JSON', () => {
  const repository = { marker: Symbol('postgres-repository') };
  const api = createReviewLabApi({ repository, enabled: false });
  assert.equal(api.repository, repository);
});

test('PostgreSQL schema check fails closed on connection or migration failure', async () => {
  const failedPool = { async query() { throw new Error('database unavailable'); } };
  await assert.rejects(assertPostgresReviewSchema(failedPool), /review backend is unavailable or not migrated/);
  const missingMigrationPool = { async query() { return { rowCount: 0, rows: [] }; } };
  await assert.rejects(assertPostgresReviewSchema(missingMigrationPool), /review backend is unavailable or not migrated/);
  const completeMigrationPool = { async query() { return { rowCount: 5, rows: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }] }; } };
  await assert.doesNotReject(assertPostgresReviewSchema(completeMigrationPool));
});

test('migration manifest tracks every mutable JSON collection', () => {
  const empty = {
    version: 6, reviews: [], helpfulVotes: [], reports: [], users: [], bindings: [], reviewSubjects: [],
    verifiedNodeSubjects: [], landingJourneys: [], moderationJobs: [], experienceResolutions: [],
    experienceSubjectLinks: [], subjectCorrections: [], auditLog: [],
  };
  const manifest = migrationManifest(empty, 'source-hash');
  assert.equal(Object.keys(manifest.counts).length, 13);
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.digest));
});

