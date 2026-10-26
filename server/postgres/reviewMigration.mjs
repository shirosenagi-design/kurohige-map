import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewLabRepository } from '../reviewLabApi.mjs';
import { createPostgresPool, loadPostgresReviewDatabase, persistPostgresReviewDatabase } from './postgresReviewRepository.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPaths = [
  path.join(moduleDirectory, 'migrations', '001_review_platform.sql'),
  path.join(moduleDirectory, 'migrations', '002_account_sessions.sql'),
  path.join(moduleDirectory, 'migrations', '003_email_identity.sql'),
  path.join(moduleDirectory, 'migrations', '004_passkeys.sql'),
  path.join(moduleDirectory, 'migrations', '005_account_world_sync.sql'),
];
const importedTables = [
  'review_audit_log', 'subject_corrections', 'experience_subject_links', 'experience_resolutions',
  'moderation_jobs', 'review_reports', 'review_helpful_votes', 'voyage_review_revisions', 'voyage_reviews',
  'landing_journeys', 'review_node_bindings', 'verified_node_subjects', 'experience_subjects', 'review_sessions', 'review_accounts',
];
const collectionNames = ['reviews', 'helpfulVotes', 'reports', 'users', 'bindings', 'reviewSubjects', 'verifiedNodeSubjects', 'landingJourneys', 'moderationJobs', 'experienceResolutions', 'experienceSubjectLinks', 'subjectCorrections', 'auditLog'];

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== null && value[key] !== undefined)
    .map((key) => [key, stable(value[key])]));
  return value;
};
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const keyFor = (collection, value) => ({
  users: value.id,
  reviews: value.id,
  helpfulVotes: `${value.reviewId}:${value.userId}`,
  reports: value.id,
  bindings: `${value.userId}:${value.nodeId}`,
  reviewSubjects: value.id,
  verifiedNodeSubjects: `${value.userId}:${value.nodeId}`,
  landingJourneys: `${value.userId}:${value.nodeId}`,
  moderationJobs: value.id,
  experienceResolutions: value.id,
  experienceSubjectLinks: value.id,
  subjectCorrections: value.id,
  auditLog: value.id,
}[collection]);

function selectedRecords(database, collection, source) {
  const sourceKeys = new Set(source[collection].map((entry) => keyFor(collection, entry)));
  return database[collection].filter((entry) => sourceKeys.has(keyFor(collection, entry)));
}

export function migrationManifest(database, sourceSha256) {
  const counts = Object.fromEntries(collectionNames.map((name) => [name, database[name].length]));
  const records = Object.fromEntries(collectionNames.map((name) => [name, [...database[name]].sort((a, b) => String(keyFor(name, a)).localeCompare(String(keyFor(name, b))))]));
  return { sourceSha256, sourceVersion: database.version, counts, digest: digest(records) };
}

export async function migrateReviewJson({ sourcePath, pool, apply = false }) {
  const absoluteSource = path.resolve(sourcePath);
  const sourceBytes = await readFile(absoluteSource);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const source = await createReviewLabRepository(absoluteSource).readDatabaseForTest();
  const manifest = migrationManifest(source, sourceSha256);
  if (!apply) return { mode: 'dry-run', sourcePath: absoluteSource, ...manifest };

  const client = await pool.connect();
  const batchId = randomUUID();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock($1)', ['741013137']);
    const existing = await client.query('SELECT id, rolled_back_at FROM review_import_batches WHERE source_sha256=$1', [sourceSha256]);
    if (existing.rowCount) throw new Error(`Source was already imported as batch ${existing.rows[0].id}.`);
    const nonEmpty = await client.query(`SELECT EXISTS(
      SELECT 1 FROM voyage_reviews UNION ALL SELECT 1 FROM verified_node_subjects UNION ALL SELECT 1 FROM landing_journeys
    ) AS value`);
    if (nonEmpty.rows[0].value) throw new Error('Target PostgreSQL review database is not empty; merge import is intentionally refused.');
    await client.query(`INSERT INTO review_import_batches(id,source_path,source_sha256,source_version,counts,digest)
      VALUES($1,$2,$3,$4,$5,$6)`, [batchId, absoluteSource, sourceSha256, source.version, JSON.stringify(manifest.counts), JSON.stringify({ sha256: manifest.digest })]);
    await persistPostgresReviewDatabase(client, source);
    for (const table of importedTables) await client.query(`UPDATE ${table} SET import_batch_id=$1 WHERE import_batch_id IS NULL`, [batchId]);

    const imported = await loadPostgresReviewDatabase(client);
    const verification = {};
    for (const name of collectionNames) {
      const expected = [...source[name]].sort((a, b) => String(keyFor(name, a)).localeCompare(String(keyFor(name, b))));
      const actual = selectedRecords(imported, name, source).sort((a, b) => String(keyFor(name, a)).localeCompare(String(keyFor(name, b))));
      verification[name] = { expected: expected.length, actual: actual.length, digestMatch: digest(expected) === digest(actual) };
    }
    if (Object.values(verification).some((entry) => entry.expected !== entry.actual || !entry.digestMatch)) {
      throw new Error(`PostgreSQL migration verification failed: ${JSON.stringify(verification)}`);
    }
    await client.query('COMMIT');
    return { mode: 'applied', batchId, sourcePath: absoluteSource, ...manifest, verification };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally { client.release(); }
}

export async function rollbackReviewImport({ pool, batchId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock($1)', ['741013137']);
    const batch = await client.query('SELECT rolled_back_at FROM review_import_batches WHERE id=$1 FOR UPDATE', [batchId]);
    if (!batch.rowCount) throw new Error('Import batch was not found.');
    if (batch.rows[0].rolled_back_at) throw new Error('Import batch was already rolled back.');
    for (const table of importedTables) await client.query(`DELETE FROM ${table} WHERE import_batch_id=$1`, [batchId]);
    await client.query('UPDATE review_import_batches SET rolled_back_at=now() WHERE id=$1', [batchId]);
    await client.query('COMMIT');
    return { batchId, rolledBack: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally { client.release(); }
}

async function main() {
  const args = process.argv.slice(2);
  const sourcePath = args.find((entry) => entry.startsWith('--source='))?.slice('--source='.length) ?? 'data/review-lab/reviews.json';
  const rollbackId = args.find((entry) => entry.startsWith('--rollback='))?.slice('--rollback='.length);
  const apply = args.includes('--apply');
  if (!apply && !rollbackId) {
    console.log(JSON.stringify(await migrateReviewJson({ sourcePath, pool: null, apply: false }), null, 2));
    return;
  }
  const pool = await createPostgresPool(process.env.REVIEW_DATABASE_URL, { ssl: process.env.REVIEW_DATABASE_SSL === 'true', applicationName: 'kurohige-review-migration' });
  try {
    for (const schemaPath of schemaPaths) await pool.query(await readFile(schemaPath, 'utf8'));
    const result = rollbackId ? await rollbackReviewImport({ pool, batchId: rollbackId }) : await migrateReviewJson({ sourcePath, pool, apply: true });
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

