// Schema-only bootstrap for a new Render PostgreSQL database. Never imports local JSON.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPostgresPool, assertPostgresReviewSchema } from '../server/postgres/postgresReviewRepository.mjs';

export async function applyRenderSchema({ databaseUrl, ssl = false } = {}) {
  if (!databaseUrl) throw new Error('REVIEW_DATABASE_URL is required.');
  const pool = await createPostgresPool(databaseUrl, { ssl, max: 1, applicationName: 'kurohige-render-schema' });
  const client = await pool.connect();
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/postgres/migrations');
  try {
    await client.query('SELECT pg_advisory_lock($1)', ['741013137']);
    for (let revision = 1; revision <= 5; revision += 1) {
      const file = path.join(directory, `${String(revision).padStart(3, '0')}_${[
        'review_platform', 'account_sessions', 'email_identity', 'passkeys', 'account_world_sync',
      ][revision - 1]}.sql`);
      await client.query(await readFile(file, 'utf8'));
    }
    await assertPostgresReviewSchema(client);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', ['741013137']); } finally { client.release(); await pool.end(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--apply') {
    console.error('Schema is unchanged. Pass --apply only for an approved new Render database.');
    process.exitCode = 1;
  } else {
    applyRenderSchema({ databaseUrl: process.env.REVIEW_DATABASE_URL, ssl: process.env.REVIEW_DATABASE_SSL === 'true' })
      .then(() => console.log('Review and sync schema migrations 001-005 verified.'))
      .catch((error) => {
        console.error(`Render schema bootstrap failed (${String(error?.code ?? 'unknown').replace(/[^A-Za-z0-9_]/gu, '')}).`);
        process.exitCode = 1;
      });
  }
}
