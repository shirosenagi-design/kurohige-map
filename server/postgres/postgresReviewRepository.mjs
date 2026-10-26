import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  LEGACY_REVIEW_SUBJECTS,
  REVIEW_SUBJECTS,
  ReviewLabError,
  createReviewLabRepositoryFromPersistence,
} from '../reviewLabApi.mjs';

const LOCK_KEY = '741013137';
const BUILTIN_SUBJECT_IDS = new Set([...REVIEW_SUBJECTS, ...LEGACY_REVIEW_SUBJECTS].map((subject) => subject.id));
const iso = (value) => value instanceof Date ? value.toISOString() : value ?? null;
const jsonValue = (value, fallback = null) => value == null ? fallback : value;
const jsonParameter = (value) => value == null ? null : JSON.stringify(value);

async function rows(client, sql, parameters = []) {
  return (await client.query(sql, parameters)).rows;
}

export async function createPostgresPool(connectionString, options = {}) {
  if (!connectionString) throw new Error('REVIEW_DATABASE_URL is required for the PostgreSQL review backend.');
  let pg;
  try { pg = await import('pg'); }
  catch (error) { throw new Error('The PostgreSQL review backend requires the "pg" package.', { cause: error }); }
  return new pg.Pool({
    connectionString,
    max: Number.isInteger(options.max) ? options.max : 10,
    statement_timeout: Number.isInteger(options.statementTimeoutMs) ? options.statementTimeoutMs : 10_000,
    connectionTimeoutMillis: Number.isInteger(options.connectionTimeoutMs) ? options.connectionTimeoutMs : 3_000,
    application_name: options.applicationName ?? 'kurohige-review-api',
    ssl: options.ssl === true ? { rejectUnauthorized: true } : undefined,
  });
}

export async function assertPostgresReviewSchema(pool) {
  try {
    const result = await pool.query('SELECT version FROM review_schema_migrations WHERE version IN (1, 2, 3, 4, 5)');
    if (result.rowCount !== 5) throw new Error('PostgreSQL schema migrations 001 through 005 are not applied.');
  } catch (error) {
    throw new Error('PostgreSQL review backend is unavailable or not migrated; review APIs remain closed.', { cause: error });
  }
}

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const PASSKEY_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const sessionToken = () => randomBytes(32).toString('base64url');
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const sessionView = (row) => ({
  id: row.id, accountId: row.account_id, familyId: row.family_id,
  issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at), lastSeenAt: iso(row.last_seen_at),
  idleExpiresAt: iso(row.idle_expires_at), revokedAt: iso(row.revoked_at), authMethod: row.auth_method,
});
const credentialView = (row) => ({
  id: row.credential_id,
  accountId: row.account_id,
  displayName: row.display_name,
  transports: Array.isArray(row.transports) ? row.transports : [],
  deviceType: row.device_type,
  backedUp: row.backed_up === true,
  createdAt: iso(row.created_at),
  lastUsedAt: iso(row.last_used_at),
  revokedAt: iso(row.revoked_at),
});

export function createPostgresSessionRepository(pool, {
  lifetimeMs = SESSION_LIFETIME_MS,
  idleLifetimeMs = SESSION_IDLE_LIFETIME_MS,
  magicLinkLifetimeMs = MAGIC_LINK_LIFETIME_MS,
  passkeyChallengeLifetimeMs = PASSKEY_CHALLENGE_LIFETIME_MS,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL Pool-compatible object is required.');
  const transact = async (operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  };
  const issue = async (client, { accountId, authMethod, now, familyId = randomUUID(), rotatedFromId = null }) => {
    const rawToken = sessionToken(); const sessionId = randomUUID();
    const issuedAt = now instanceof Date ? now : new Date(now ?? Date.now());
    const expiresAt = new Date(issuedAt.getTime() + lifetimeMs);
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), issuedAt.getTime() + idleLifetimeMs));
    const inserted = (await client.query(`INSERT INTO review_sessions(
        id,account_id,token_hash,role,issued_at,expires_at,family_id,rotated_from_id,last_seen_at,auth_method,idle_expires_at
      ) VALUES($1,$2,$3,'user',$4,$5,$6,$7,$4,$8,$9) RETURNING *`,
    [sessionId, accountId, tokenHash(rawToken), issuedAt.toISOString(), expiresAt.toISOString(), familyId, rotatedFromId, authMethod, idleExpiresAt.toISOString()])).rows[0];
    return { token: rawToken, actor: { userId: accountId, role: 'user' }, session: sessionView(inserted) };
  };
  const audit = (client, accountId, sessionId, action, details = {}) => client.query(
    `INSERT INTO auth_session_audit_log(id,account_id,session_id,action,details) VALUES($1,$2,$3,$4,$5)`,
    [randomUUID(), accountId, sessionId, action, JSON.stringify(details)],
  );
  const identityAudit = (client, { accountId = null, challengeId = null, action, emailHash = null, details = {} }) => client.query(
    `INSERT INTO auth_identity_audit_log(id,account_id,challenge_id,action,email_hash,details) VALUES($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), accountId, challengeId, action, emailHash, JSON.stringify(details)],
  );
  const consumeRateLimit = async (client, { key, action, limit, windowMs, now,
    errorCode = 'auth_rate_limited', errorMessage = 'Please wait before requesting another sign-in link.' }) => {
    const existing = (await client.query('SELECT * FROM auth_rate_limit_buckets WHERE bucket_key=$1 FOR UPDATE', [key])).rows[0];
    const clock = new Date(now);
    if (!existing) {
      await client.query(`INSERT INTO auth_rate_limit_buckets(bucket_key,action,window_started_at,attempts,expires_at)
        VALUES($1,$2,$3,1,$4)`, [key, action, clock.toISOString(), new Date(clock.getTime() + windowMs).toISOString()]);
      return;
    }
    if (new Date(existing.expires_at) <= clock) {
      await client.query(`UPDATE auth_rate_limit_buckets SET action=$2,window_started_at=$3,attempts=1,expires_at=$4 WHERE bucket_key=$1`,
        [key, action, clock.toISOString(), new Date(clock.getTime() + windowMs).toISOString()]);
      return;
    }
    if (existing.attempts >= limit) throw new ReviewLabError(429, errorCode, errorMessage);
    await client.query('UPDATE auth_rate_limit_buckets SET attempts=attempts+1 WHERE bucket_key=$1', [key]);
  };

  return {
    kind: 'postgres',
    async consumeAccountRateLimit({ accountId, action, limit, windowMs, now = new Date() }) {
      if (typeof accountId !== 'string' || !accountId || typeof action !== 'string' || !action
        || !Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
        throw new TypeError('A valid account rate-limit request is required.');
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await transact((client) => consumeRateLimit(client, {
            key: `account:${tokenHash(accountId)}:${action}`,
            action,
            limit,
            windowMs,
            now,
            errorCode: 'sync_rate_limited',
            errorMessage: 'Please wait before sending another sync request.',
          }));
        } catch (error) {
          if (error?.code !== '40001' || attempt === 2) throw error;
        }
      }
    },
    async createAnonymous({ accountId = `user_${randomUUID()}`, now = new Date(), authMethod = 'anonymous' } = {}) {
      return transact(async (client) => {
        await client.query(`INSERT INTO review_accounts(id,account_type) VALUES($1,'anonymous') ON CONFLICT(id) DO NOTHING`, [accountId]);
        const created = await issue(client, { accountId, authMethod, now });
        await audit(client, accountId, created.session.id, 'session.created', { authMethod });
        return created;
      });
    },
    async issueForVerifiedAccount({ accountId, authMethod, now = new Date() }) {
      if (!['email_magic_link', 'passkey'].includes(authMethod)) throw new TypeError('A supported verified authentication method is required.');
      return transact(async (client) => {
        const account = await client.query(`SELECT account.id FROM review_accounts AS account
          JOIN auth_email_identities AS identity ON identity.account_id=account.id
          WHERE account.id=$1 AND account.account_type='registered' FOR UPDATE OF account`, [accountId]);
        if (!account.rowCount) throw new ReviewLabError(404, 'account_not_found', 'The account was not found.');
        const created = await issue(client, { accountId, authMethod, now });
        await audit(client, accountId, created.session.id, 'session.created', { authMethod });
        return created;
      });
    },
    async authenticate(rawToken, now = new Date()) {
      if (typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 256) return null;
      const idleExpiresAt = new Date(new Date(now).getTime() + idleLifetimeMs);
      const result = await pool.query(`UPDATE review_sessions AS session SET last_seen_at=$2,
          idle_expires_at=LEAST(session.expires_at,$3::timestamptz)
        FROM review_accounts AS account
        WHERE session.token_hash=$1 AND session.account_id=account.id
          AND session.revoked_at IS NULL AND session.expires_at > $2 AND session.idle_expires_at > $2
        RETURNING session.*,account.frozen`, [tokenHash(rawToken), now.toISOString(), idleExpiresAt.toISOString()]);
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return { actor: { userId: row.account_id, role: 'user' }, session: sessionView(row), accountFrozen: row.frozen === true };
    },
    async migrateLegacy({ accountId, legacyToken, legacyIssuedAt, legacyExpiresAt, now = new Date() }) {
      try {
        return await transact(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountId]);
          const settings = (await client.query('SELECT * FROM auth_migration_settings WHERE singleton=true FOR UPDATE')).rows[0];
          if (!settings) throw new ReviewLabError(503, 'legacy_migration_unavailable', 'Legacy session migration is unavailable.');
          const issuedAt = new Date(legacyIssuedAt); const expiresAt = new Date(legacyExpiresAt); const clock = new Date(now);
          if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
            || issuedAt < new Date(settings.accept_legacy_issued_after) || issuedAt > clock
            || expiresAt <= clock || clock > new Date(settings.migration_cutoff)) {
            throw new ReviewLabError(401, 'legacy_session_expired', 'The legacy session is outside the migration window.');
          }
          const legacyHash = tokenHash(legacyToken);
          const prior = await client.query('SELECT account_id FROM auth_legacy_cookie_claims WHERE legacy_token_hash=$1 OR account_id=$2', [legacyHash, accountId]);
          if (prior.rowCount) throw new ReviewLabError(409, 'legacy_session_already_migrated', 'The legacy session or account was already migrated.');
          await client.query(`INSERT INTO review_accounts(id,account_type) VALUES($1,'anonymous') ON CONFLICT(id) DO NOTHING`, [accountId]);
          const created = await issue(client, { accountId, authMethod: 'legacy_cookie', now: clock });
          await client.query(`INSERT INTO auth_legacy_cookie_claims(
            legacy_token_hash,account_id,migrated_session_id,legacy_issued_at,legacy_expires_at,claimed_at
          ) VALUES($1,$2,$3,$4,$5,$6)`, [legacyHash, accountId, created.session.id, issuedAt.toISOString(), expiresAt.toISOString(), clock.toISOString()]);
          await audit(client, accountId, created.session.id, 'session.migrated', { legacyIssuedAt: issuedAt.toISOString() });
          return created;
        });
      } catch (error) {
        if (error?.code === '23505' || error?.code === '40001') throw new ReviewLabError(409, 'legacy_session_already_migrated', 'The legacy session or account was already migrated.');
        throw error;
      }
    },
    async rotate(rawToken, now = new Date()) {
      return transact(async (client) => {
        const current = (await client.query('SELECT * FROM review_sessions WHERE token_hash=$1 FOR UPDATE', [tokenHash(rawToken)])).rows[0];
        const clock = new Date(now);
        if (!current || current.revoked_at || new Date(current.expires_at) <= clock || new Date(current.idle_expires_at) <= clock) {
          throw new ReviewLabError(401, 'session_invalid', 'The session is invalid or expired.');
        }
        await client.query(`UPDATE review_sessions SET revoked_at=$2,revoke_reason='rotation' WHERE id=$1`, [current.id, clock.toISOString()]);
        const created = await issue(client, { accountId: current.account_id, authMethod: current.auth_method, now: clock, familyId: current.family_id, rotatedFromId: current.id });
        await audit(client, current.account_id, created.session.id, 'session.rotated', { rotatedFromId: current.id });
        return created;
      });
    },
    async list(accountId) {
      const result = await pool.query('SELECT * FROM review_sessions WHERE account_id=$1 ORDER BY issued_at DESC', [accountId]);
      return result.rows.map(sessionView);
    },
    async revokeCurrent(rawToken, accountId, reason = 'user_logout', now = new Date()) {
      const result = await pool.query(`UPDATE review_sessions SET revoked_at=$3,revoke_reason=$4
        WHERE token_hash=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id`, [tokenHash(rawToken), accountId, now.toISOString(), reason]);
      if (result.rowCount) await audit(pool, accountId, result.rows[0].id, 'session.revoked', { reason });
      return result.rowCount === 1;
    },
    async revokeOne(sessionId, accountId, now = new Date()) {
      const result = await pool.query(`UPDATE review_sessions SET revoked_at=$3,revoke_reason='user_revoked'
        WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id`, [sessionId, accountId, now.toISOString()]);
      if (result.rowCount) await audit(pool, accountId, result.rows[0].id, 'session.revoked', { reason: 'user_revoked' });
      return result.rowCount === 1;
    },
    async revokeAll(accountId, now = new Date()) {
      return transact(async (client) => {
        const result = await client.query(`UPDATE review_sessions SET revoked_at=$2,revoke_reason='user_revoked_all'
          WHERE account_id=$1 AND revoked_at IS NULL RETURNING id`, [accountId, now.toISOString()]);
        await audit(client, accountId, null, 'session.revoked_all', { count: result.rowCount });
        return result.rowCount;
      });
    },
    async startEmailChallenge({ email, requestingAccountId, requestingSessionId, requestIpHash, now = new Date() }) {
      const clock = new Date(now); const rawToken = sessionToken(); const browserBinding = sessionToken();
      const challengeId = randomUUID(); const normalizedEmailHash = tokenHash(email);
      return transact(async (client) => {
        const activeSession = await client.query(`SELECT id FROM review_sessions
          WHERE id=$1 AND account_id=$2 AND issued_at<=$3 AND revoked_at IS NULL AND expires_at>$3 AND idle_expires_at>$3 FOR UPDATE`,
        [requestingSessionId, requestingAccountId, clock.toISOString()]);
        if (!activeSession.rowCount) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        const windowMs = 15 * 60 * 1000;
        await consumeRateLimit(client, { key: `email:${normalizedEmailHash}`, action: 'magic_link.start.email', limit: 3, windowMs, now: clock });
        await consumeRateLimit(client, { key: `account:${tokenHash(requestingAccountId)}`, action: 'magic_link.start.account', limit: 5, windowMs, now: clock });
        await consumeRateLimit(client, { key: `ip:${requestIpHash}`, action: 'magic_link.start.ip', limit: 10, windowMs, now: clock });
        const identity = (await client.query('SELECT account_id FROM auth_email_identities WHERE email_normalized=$1', [email])).rows[0];
        await client.query(`UPDATE auth_magic_link_challenges SET status='superseded'
          WHERE requesting_account_id=$1 AND email_normalized=$2 AND status='pending'`, [requestingAccountId, email]);
        const expiresAt = new Date(clock.getTime() + magicLinkLifetimeMs);
        await client.query(`INSERT INTO auth_magic_link_challenges(
          id,token_hash,browser_binding_hash,email_normalized,requesting_account_id,target_account_id,
          requesting_session_id,status,expires_at,request_ip_hash,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`, [
          challengeId, tokenHash(rawToken), tokenHash(browserBinding), email, requestingAccountId,
          identity?.account_id ?? null, requestingSessionId, expiresAt.toISOString(), requestIpHash, clock.toISOString(),
        ]);
        await identityAudit(client, { accountId: requestingAccountId, challengeId, action: 'magic_link.requested', emailHash: normalizedEmailHash, details: { existingIdentity: Boolean(identity) } });
        return { id: challengeId, email, token: rawToken, browserBinding, expiresAt: expiresAt.toISOString() };
      });
    },
    async markEmailChallengeDeliveryFailed(challengeId) {
      return transact(async (client) => {
        const challenge = (await client.query(`UPDATE auth_magic_link_challenges SET status='delivery_failed'
          WHERE id=$1 AND status='pending' RETURNING *`, [challengeId])).rows[0];
        if (challenge) await identityAudit(client, { accountId: challenge.requesting_account_id, challengeId, action: 'magic_link.delivery_failed', emailHash: tokenHash(challenge.email_normalized) });
        return Boolean(challenge);
      });
    },
    async confirmEmailChallenge({ token, browserBinding, requestingAccountId, requestingSessionId, now = new Date() }) {
      let result;
      try {
        result = await transact(async (client) => {
          const clock = new Date(now);
          const challenge = (await client.query('SELECT * FROM auth_magic_link_challenges WHERE token_hash=$1 FOR UPDATE', [tokenHash(token)])).rows[0];
          if (!challenge) return { outcome: 'invalid' };
          if (challenge.status === 'consumed') return { outcome: 'consumed' };
          if (challenge.status !== 'pending') return { outcome: 'invalid' };
          if (new Date(challenge.expires_at) <= clock) {
            await client.query(`UPDATE auth_magic_link_challenges SET status='superseded' WHERE id=$1`, [challenge.id]);
            await identityAudit(client, { accountId: challenge.requesting_account_id, challengeId: challenge.id, action: 'magic_link.expired', emailHash: tokenHash(challenge.email_normalized) });
            return { outcome: 'expired' };
          }
          const bindingMatches = challenge.browser_binding_hash === tokenHash(browserBinding)
            && challenge.requesting_account_id === requestingAccountId
            && challenge.requesting_session_id === requestingSessionId;
          if (!bindingMatches) {
            const attempts = Math.min(5, challenge.confirmation_attempts + 1);
            await client.query(`UPDATE auth_magic_link_challenges SET confirmation_attempts=$2,status=CASE WHEN $2>=5 THEN 'superseded' ELSE status END WHERE id=$1`, [challenge.id, attempts]);
            await identityAudit(client, { accountId: challenge.requesting_account_id, challengeId: challenge.id, action: 'magic_link.binding_rejected', emailHash: tokenHash(challenge.email_normalized), details: { attempts } });
            return { outcome: 'binding_rejected' };
          }
          let accountId = challenge.target_account_id;
          const currentIdentity = (await client.query('SELECT * FROM auth_email_identities WHERE email_normalized=$1 FOR UPDATE', [challenge.email_normalized])).rows[0];
          if (accountId) {
            if (!currentIdentity || currentIdentity.account_id !== accountId) {
              await client.query(`UPDATE auth_magic_link_challenges SET status='consumed',consumed_at=$2 WHERE id=$1`, [challenge.id, clock.toISOString()]);
              await identityAudit(client, { accountId: challenge.requesting_account_id, challengeId: challenge.id, action: 'identity.conflict', emailHash: tokenHash(challenge.email_normalized) });
              return { outcome: 'conflict' };
            }
          } else if (currentIdentity) {
            if (currentIdentity.account_id !== challenge.requesting_account_id) {
              await client.query(`UPDATE auth_magic_link_challenges SET status='consumed',consumed_at=$2 WHERE id=$1`, [challenge.id, clock.toISOString()]);
              await identityAudit(client, { accountId: challenge.requesting_account_id, challengeId: challenge.id, action: 'identity.conflict', emailHash: tokenHash(challenge.email_normalized) });
              return { outcome: 'conflict' };
            }
            accountId = currentIdentity.account_id;
          } else {
            accountId = challenge.requesting_account_id;
            await client.query(`INSERT INTO auth_email_identities(id,account_id,email_normalized,verified_at,created_at,updated_at)
              VALUES($1,$2,$3,$4,$4,$4)`, [randomUUID(), accountId, challenge.email_normalized, clock.toISOString()]);
            await client.query(`UPDATE review_accounts SET account_type='registered',updated_at=$2 WHERE id=$1`, [accountId, clock.toISOString()]);
            await identityAudit(client, { accountId, challengeId: challenge.id, action: 'identity.verified', emailHash: tokenHash(challenge.email_normalized) });
          }
          await client.query(`UPDATE auth_magic_link_challenges SET status='consumed',consumed_at=$2 WHERE id=$1`, [challenge.id, clock.toISOString()]);
          await identityAudit(client, { accountId, challengeId: challenge.id, action: 'magic_link.consumed', emailHash: tokenHash(challenge.email_normalized) });
          return { outcome: 'verified', accountId, challengeId: challenge.id };
        });
      } catch (error) {
        if (error?.code === '23505' || error?.code === '40001') result = { outcome: 'conflict' };
        else throw error;
      }
      if (result.outcome === 'verified') return result;
      if (result.outcome === 'consumed') throw new ReviewLabError(409, 'magic_link_already_used', 'This sign-in link was already used.');
      if (result.outcome === 'expired') throw new ReviewLabError(401, 'magic_link_expired', 'This sign-in link expired.');
      if (result.outcome === 'conflict') throw new ReviewLabError(409, 'email_identity_conflict', 'This email identity is already attached to another account. No accounts were merged.');
      throw new ReviewLabError(401, 'magic_link_invalid', 'This sign-in link is invalid.');
    },
    async getEmailIdentity(accountId) {
      const row = (await pool.query('SELECT id,account_id,email_normalized,verified_at FROM auth_email_identities WHERE account_id=$1', [accountId])).rows[0];
      return row ? { id: row.id, accountId: row.account_id, email: row.email_normalized, verifiedAt: iso(row.verified_at) } : null;
    },
    async authStatus(accountId) {
      const result = await pool.query(`SELECT account.account_type,identity.email_normalized,identity.verified_at,
          (SELECT count(*)::integer FROM auth_webauthn_credentials credential
            WHERE credential.account_id=account.id AND credential.revoked_at IS NULL) AS passkey_count
        FROM review_accounts account LEFT JOIN auth_email_identities identity ON identity.account_id=account.id
        WHERE account.id=$1`, [accountId]);
      if (!result.rowCount) throw new ReviewLabError(404, 'account_not_found', 'The account was not found.');
      const row = result.rows[0];
      return { accountType: row.account_type, email: row.email_normalized ?? null, emailVerifiedAt: iso(row.verified_at), passkeyCount: row.passkey_count };
    },
    async passkeyRegistrationUser(accountId) {
      return transact(async (client) => {
        const account = (await client.query(`SELECT account.id,identity.email_normalized
          FROM review_accounts account JOIN auth_email_identities identity ON identity.account_id=account.id
          WHERE account.id=$1 AND account.account_type='registered' FOR UPDATE OF account`, [accountId])).rows[0];
        if (!account) throw new ReviewLabError(403, 'verified_email_required', 'Verify an email address before registering a passkey.');
        let user = (await client.query('SELECT webauthn_user_id FROM auth_webauthn_users WHERE account_id=$1', [accountId])).rows[0];
        if (!user) {
          user = (await client.query(`INSERT INTO auth_webauthn_users(account_id,webauthn_user_id)
            VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET account_id=excluded.account_id
            RETURNING webauthn_user_id`, [accountId, randomBytes(32).toString('base64url')])).rows[0];
        }
        const credentials = await client.query(`SELECT credential_id,transports FROM auth_webauthn_credentials
          WHERE account_id=$1 AND revoked_at IS NULL`, [accountId]);
        return { accountId, userId: user.webauthn_user_id, userName: account.email_normalized,
          credentials: credentials.rows.map((row) => ({ id: row.credential_id, transports: row.transports })) };
      });
    },
    async startPasskeyChallenge({ kind, challenge, requestingAccountId, requestingSessionId, requestIpHash, rpID, expectedOrigin, now = new Date() }) {
      if (!['registration', 'authentication'].includes(kind)) throw new TypeError('A valid passkey challenge kind is required.');
      const clock = new Date(now); const browserBinding = sessionToken(); const challengeId = randomUUID();
      return transact(async (client) => {
        const active = await client.query(`SELECT session.id,account.account_type FROM review_sessions session
          JOIN review_accounts account ON account.id=session.account_id
          WHERE session.id=$1 AND session.account_id=$2 AND session.revoked_at IS NULL
            AND session.expires_at>$3 AND session.idle_expires_at>$3 FOR UPDATE OF session`,
        [requestingSessionId, requestingAccountId, clock.toISOString()]);
        if (!active.rowCount) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        if (kind === 'registration') {
          const verified = await client.query('SELECT 1 FROM auth_email_identities WHERE account_id=$1', [requestingAccountId]);
          if (active.rows[0].account_type !== 'registered' || !verified.rowCount) throw new ReviewLabError(403, 'verified_email_required', 'Verify an email address before registering a passkey.');
        }
        const windowMs = 15 * 60 * 1000;
        await consumeRateLimit(client, { key: `passkey-account:${tokenHash(requestingAccountId)}:${kind}`, action: `passkey.${kind}.start.account`, limit: 10, windowMs, now: clock });
        await consumeRateLimit(client, { key: `passkey-ip:${requestIpHash}:${kind}`, action: `passkey.${kind}.start.ip`, limit: 20, windowMs, now: clock });
        await client.query(`UPDATE auth_webauthn_challenges SET status='superseded'
          WHERE requesting_session_id=$1 AND kind=$2 AND status='pending'`, [requestingSessionId, kind]);
        const expiresAt = new Date(clock.getTime() + passkeyChallengeLifetimeMs);
        await client.query(`INSERT INTO auth_webauthn_challenges(
          id,kind,challenge_hash,browser_binding_hash,requesting_account_id,requesting_session_id,
          rp_id,expected_origin,status,expires_at,request_ip_hash,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11)`, [challengeId, kind, tokenHash(challenge),
          tokenHash(browserBinding), requestingAccountId, requestingSessionId, rpID, expectedOrigin,
          expiresAt.toISOString(), requestIpHash, clock.toISOString()]);
        await client.query(`INSERT INTO auth_webauthn_audit_log(id,account_id,challenge_id,action,details)
          VALUES($1,$2,$3,$4,$5)`, [randomUUID(), requestingAccountId, challengeId, `passkey.${kind}.requested`, JSON.stringify({ rpID })]);
        return { id: challengeId, browserBinding, expiresAt: expiresAt.toISOString() };
      });
    },
    async consumePasskeyChallenge({ kind, challenge, browserBinding, requestingAccountId, requestingSessionId, now = new Date() }) {
      const clock = new Date(now);
      const result = await transact(async (client) => {
        const row = (await client.query('SELECT * FROM auth_webauthn_challenges WHERE challenge_hash=$1 FOR UPDATE', [tokenHash(challenge)])).rows[0];
        if (!row || row.kind !== kind) return { outcome: 'invalid' };
        if (row.status === 'consumed') return { outcome: 'consumed' };
        if (row.status !== 'pending') return { outcome: 'invalid' };
        if (new Date(row.expires_at) <= clock) {
          await client.query("UPDATE auth_webauthn_challenges SET status='superseded' WHERE id=$1", [row.id]);
          return { outcome: 'expired' };
        }
        if (row.browser_binding_hash !== tokenHash(browserBinding) || row.requesting_account_id !== requestingAccountId
          || row.requesting_session_id !== requestingSessionId) return { outcome: 'binding_rejected' };
        await client.query("UPDATE auth_webauthn_challenges SET status='consumed',consumed_at=$2 WHERE id=$1", [row.id, clock.toISOString()]);
        await client.query(`INSERT INTO auth_webauthn_audit_log(id,account_id,challenge_id,action)
          VALUES($1,$2,$3,$4)`, [randomUUID(), requestingAccountId, row.id, `passkey.${kind}.challenge_consumed`]);
        return { outcome: 'valid', id: row.id, challengeHash: row.challenge_hash, rpID: row.rp_id, expectedOrigin: row.expected_origin };
      });
      if (result.outcome === 'valid') return result;
      if (result.outcome === 'consumed') throw new ReviewLabError(409, 'passkey_challenge_already_used', 'This passkey challenge was already used.');
      if (result.outcome === 'expired') throw new ReviewLabError(401, 'passkey_challenge_expired', 'This passkey challenge expired.');
      throw new ReviewLabError(401, 'passkey_challenge_invalid', 'This passkey challenge is invalid.');
    },
    async savePasskeyCredential({ accountId, credential, displayName, challengeId, now = new Date() }) {
      try {
        return await transact(async (client) => {
          const clock = new Date(now);
          const result = await client.query(`INSERT INTO auth_webauthn_credentials(
            credential_id,account_id,public_key,counter,device_type,backed_up,transports,display_name,created_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [credential.id, accountId, Buffer.from(credential.publicKey),
            credential.counter, credential.deviceType, credential.backedUp, JSON.stringify(credential.transports ?? []), displayName,
            clock.toISOString()]);
          await client.query(`INSERT INTO auth_webauthn_audit_log(id,account_id,challenge_id,credential_id,action)
            VALUES($1,$2,$3,$4,'passkey.registered')`, [randomUUID(), accountId, challengeId, credential.id]);
          return credentialView(result.rows[0]);
        });
      } catch (error) {
        if (error?.code === '23505') throw new ReviewLabError(409, 'passkey_already_registered', 'This passkey is already registered.');
        throw error;
      }
    },
    async getPasskeyCredential(credentialId) {
      const row = (await pool.query(`SELECT credential.*,user_record.webauthn_user_id FROM auth_webauthn_credentials credential
        JOIN auth_webauthn_users user_record ON user_record.account_id=credential.account_id
        JOIN auth_email_identities identity ON identity.account_id=credential.account_id
        WHERE credential.credential_id=$1 AND credential.revoked_at IS NULL`, [credentialId])).rows[0];
      return row ? { ...credentialView(row), userId: row.webauthn_user_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter) } : null;
    },
    async finishPasskeyAuthentication({ credentialId, expectedCounter, newCounter, requestingAccountId, requestingSessionId, challengeId, now = new Date() }) {
      return transact(async (client) => {
        const clock = new Date(now);
        const credential = (await client.query('SELECT * FROM auth_webauthn_credentials WHERE credential_id=$1 FOR UPDATE', [credentialId])).rows[0];
        if (!credential || credential.revoked_at || Number(credential.counter) !== Number(expectedCounter)) throw new ReviewLabError(401, 'passkey_invalid', 'The passkey could not be verified.');
        const requestSession = await client.query(`SELECT id FROM review_sessions WHERE id=$1 AND account_id=$2
          AND revoked_at IS NULL AND expires_at>$3 AND idle_expires_at>$3 FOR UPDATE`, [requestingSessionId, requestingAccountId, clock.toISOString()]);
        if (!requestSession.rowCount) throw new ReviewLabError(401, 'authentication_required', 'Authentication is required.');
        await client.query('UPDATE auth_webauthn_credentials SET counter=$2,last_used_at=$3 WHERE credential_id=$1', [credentialId, newCounter, clock.toISOString()]);
        await client.query("UPDATE review_sessions SET revoked_at=$2,revoke_reason='passkey_auth_replaced' WHERE id=$1", [requestingSessionId, clock.toISOString()]);
        const created = await issue(client, { accountId: credential.account_id, authMethod: 'passkey', now: clock });
        await audit(client, credential.account_id, created.session.id, 'session.created', { authMethod: 'passkey' });
        await client.query(`INSERT INTO auth_webauthn_audit_log(id,account_id,challenge_id,credential_id,action)
          VALUES($1,$2,$3,$4,'passkey.authenticated')`, [randomUUID(), credential.account_id, challengeId, credentialId]);
        return created;
      });
    },
    async listPasskeys(accountId) {
      const result = await pool.query('SELECT * FROM auth_webauthn_credentials WHERE account_id=$1 ORDER BY created_at DESC', [accountId]);
      return result.rows.map(credentialView);
    },
    async revokePasskey(credentialId, accountId, now = new Date()) {
      const result = await pool.query(`UPDATE auth_webauthn_credentials SET revoked_at=$3
        WHERE credential_id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING credential_id`, [credentialId, accountId, now.toISOString()]);
      if (result.rowCount) await pool.query(`INSERT INTO auth_webauthn_audit_log(id,account_id,credential_id,action)
        VALUES($1,$2,$3,'passkey.revoked')`, [randomUUID(), accountId, credentialId]);
      return result.rowCount === 1;
    },
  };
}

export async function loadPostgresReviewDatabase(client) {
  const accounts = await rows(client, 'SELECT id, frozen, freeze_reason, updated_at FROM review_accounts');
  const subjects = await rows(client, 'SELECT * FROM experience_subjects');
  const mappings = await rows(client, 'SELECT * FROM verified_node_subjects');
  const bindings = await rows(client, 'SELECT * FROM review_node_bindings');
  const journeys = await rows(client, 'SELECT * FROM landing_journeys');
  const reviews = await rows(client, 'SELECT * FROM voyage_reviews');
  const votes = await rows(client, 'SELECT * FROM review_helpful_votes');
  const reports = await rows(client, 'SELECT * FROM review_reports');
  const jobs = await rows(client, 'SELECT * FROM moderation_jobs');
  const resolutions = await rows(client, 'SELECT * FROM experience_resolutions');
  const links = await rows(client, 'SELECT * FROM experience_subject_links');
  const corrections = await rows(client, 'SELECT * FROM subject_corrections');
  const audit = await rows(client, 'SELECT * FROM review_audit_log ORDER BY created_at');
  return {
    version: 6,
    users: accounts.map((r) => ({ id: r.id, frozen: r.frozen, freezeReason: r.freeze_reason, updatedAt: iso(r.updated_at) })),
    reviewSubjects: subjects.filter((r) => !BUILTIN_SUBJECT_IDS.has(r.id)).map((r) => ({
      id: r.id, kind: r.kind, name: r.name, referenceLabel: r.reference_label,
      sharingScope: r.sharing_scope, identityVersion: r.identity_version,
      canonicalExperienceKey: r.canonical_experience_key, identity: r.identity,
      ...(Array.isArray(r.semantic_tags) && r.semantic_tags.length ? { semanticTags: r.semantic_tags } : {}),
      createdAt: iso(r.created_at), ...(r.created_by ? { createdBy: r.created_by } : {}),
    })),
    verifiedNodeSubjects: mappings.map((r) => ({ userId: r.account_id, nodeId: r.node_id, subjectId: r.subject_id, verifiedAt: iso(r.verified_at), verifiedBy: r.verified_by, provenance: r.provenance })),
    bindings: bindings.map((r) => ({ userId: r.account_id, nodeId: r.node_id, subjectId: r.subject_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })),
    landingJourneys: journeys.map((r) => ({ userId: r.account_id, nodeId: r.node_id, subjectId: r.subject_id, requiredStepIds: r.required_step_ids, completedStepIds: r.completed_step_ids, startedAt: iso(r.started_at), updatedAt: iso(r.updated_at), landedAt: iso(r.landed_at), landingEvidence: r.landing_evidence })),
    reviews: reviews.map((r) => ({ id: r.id, subjectId: r.subject_id, sourceNodeId: r.source_node_id, authorId: r.author_account_id, body: r.body, moderationStatus: r.moderation_status, authorSnapshot: r.author_snapshot, moderation: r.moderation, hiddenAt: iso(r.hidden_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), revision: r.revision })),
    helpfulVotes: votes.map((r) => ({ reviewId: r.review_id, userId: r.account_id, createdAt: iso(r.created_at) })),
    reports: reports.map((r) => ({ id: r.id, reviewId: r.review_id, reporterId: r.reporter_account_id, reason: r.reason, details: r.details, status: r.status, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at), resolution: r.resolution })),
    moderationJobs: jobs.map((r) => ({ id: r.id, jobKey: `${r.review_id}:${r.review_revision}:${r.reason}`, reviewId: r.review_id, reviewRevision: r.review_revision, reason: r.reason, status: r.status, attempts: r.attempts, nextAttemptAt: iso(r.next_attempt_at), lastError: r.last_error, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })),
    experienceResolutions: resolutions.map((r) => ({ id: r.id, userId: r.account_id, nodeId: r.node_id, subjectId: r.subject_id, candidateSignature: r.candidate_signature, candidate: r.candidate, decision: r.decision, confidence: r.confidence, reason: r.reason, comparedSubjectIds: r.compared_subject_ids, matchedSubjectId: r.matched_subject_id, linkedSharedSubjectId: r.linked_shared_subject_id, identity: r.identity, method: r.method, model: r.model, diagnostic: r.diagnostic, extractionDiagnostic: r.extraction_diagnostic, status: r.status, createdAt: iso(r.created_at) })),
    experienceSubjectLinks: links.map((r) => ({ id: r.id, sourceSubjectId: r.island_subject_id, sharedSubjectId: r.shared_subject_id, status: r.status, reason: r.reason, resolutionId: r.resolution_id, createdAt: iso(r.created_at), createdBy: r.created_by, revokedAt: iso(r.revoked_at), revokedBy: r.revoked_by, revocationReason: r.revocation_reason })),
    subjectCorrections: corrections.map((r) => ({ id: r.id, userId: r.account_id, nodeId: r.node_id, previousSubjectId: r.previous_subject_id, subjectId: r.subject_id, previousSharedSubjectId: r.previous_shared_subject_id, sharedSubjectId: r.shared_subject_id, mode: r.mode, reason: r.reason, movedReviewIds: r.moved_review_ids, actorId: r.actor_id, createdAt: iso(r.created_at) })),
    auditLog: audit.map((r) => ({ id: r.id, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, targetType: r.target_type, targetId: r.target_id, at: iso(r.created_at), metadata: r.details })),
  };
}

async function queryEach(client, sql, records, values) {
  for (const record of records) await client.query(sql, values(record));
}

function referencedAccounts(database) {
  const ids = new Set(database.users.map((entry) => entry.id));
  for (const entry of database.verifiedNodeSubjects) ids.add(entry.userId);
  for (const entry of database.bindings) ids.add(entry.userId);
  for (const entry of database.landingJourneys) ids.add(entry.userId);
  for (const entry of database.reviews) ids.add(entry.authorId);
  for (const entry of database.helpfulVotes) ids.add(entry.userId);
  for (const entry of database.reports) ids.add(entry.reporterId);
  for (const entry of database.experienceResolutions) ids.add(entry.userId);
  for (const entry of database.subjectCorrections) ids.add(entry.userId);
  return [...ids].filter(Boolean);
}

export async function persistPostgresReviewDatabase(client, database) {
  const now = new Date().toISOString();
  const users = new Map(database.users.map((entry) => [entry.id, entry]));
  await queryEach(client, `INSERT INTO review_accounts(id,frozen,freeze_reason,updated_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET frozen=EXCLUDED.frozen,freeze_reason=EXCLUDED.freeze_reason,updated_at=EXCLUDED.updated_at`, referencedAccounts(database), (id) => {
      const user = users.get(id); return [id, user?.frozen === true, user?.freezeReason ?? null, user?.updatedAt ?? now];
    });

  const subjects = [...REVIEW_SUBJECTS, ...LEGACY_REVIEW_SUBJECTS, ...database.reviewSubjects];
  const uniqueSubjects = [...new Map(subjects.map((entry) => [entry.id, entry])).values()];
  await queryEach(client, `INSERT INTO experience_subjects(id,kind,name,reference_label,sharing_scope,identity_version,canonical_experience_key,identity,semantic_tags,created_at,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,reference_label=EXCLUDED.reference_label,sharing_scope=EXCLUDED.sharing_scope,identity_version=EXCLUDED.identity_version,canonical_experience_key=EXCLUDED.canonical_experience_key,identity=EXCLUDED.identity,semantic_tags=EXCLUDED.semantic_tags`, uniqueSubjects,
  (s) => [s.id, s.kind, s.name, s.referenceLabel ?? null, s.sharingScope, s.identityVersion ?? 1, s.canonicalExperienceKey ?? null, jsonParameter(jsonValue(s.identity)), jsonParameter(jsonValue(s.semanticTags, [])), s.createdAt ?? now, s.createdBy ?? s.verifiedBy ?? null]);

  await queryEach(client, `INSERT INTO verified_node_subjects(account_id,node_id,subject_id,verified_at,verified_by,provenance) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(account_id,node_id) DO UPDATE SET subject_id=EXCLUDED.subject_id,verified_at=EXCLUDED.verified_at,verified_by=EXCLUDED.verified_by,provenance=EXCLUDED.provenance`, database.verifiedNodeSubjects,
  (r) => [r.userId, r.nodeId, r.subjectId, r.verifiedAt, r.verifiedBy, r.provenance]);
  await queryEach(client, `INSERT INTO review_node_bindings(account_id,node_id,subject_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(account_id,node_id) DO UPDATE SET subject_id=EXCLUDED.subject_id,updated_at=EXCLUDED.updated_at`, database.bindings,
  (r) => [r.userId, r.nodeId, r.subjectId, r.createdAt, r.updatedAt]);
  await queryEach(client, `INSERT INTO landing_journeys(account_id,node_id,subject_id,required_step_ids,completed_step_ids,started_at,updated_at,landed_at,landing_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(account_id,node_id) DO UPDATE SET subject_id=EXCLUDED.subject_id,required_step_ids=EXCLUDED.required_step_ids,completed_step_ids=EXCLUDED.completed_step_ids,updated_at=EXCLUDED.updated_at,landed_at=EXCLUDED.landed_at,landing_evidence=EXCLUDED.landing_evidence`, database.landingJourneys,
  (r) => [r.userId, r.nodeId, r.subjectId, jsonParameter(r.requiredStepIds), jsonParameter(r.completedStepIds), r.startedAt, r.updatedAt, r.landedAt, jsonParameter(r.landingEvidence)]);

  for (const review of database.reviews) {
    await client.query(`INSERT INTO voyage_review_revisions(review_id,revision,body,moderation_status,moderation,created_at,created_by)
      SELECT id,revision,body,moderation_status,moderation,updated_at,author_account_id FROM voyage_reviews WHERE id=$1 AND revision < $2
      ON CONFLICT(review_id,revision) DO NOTHING`, [review.id, review.revision]);
    await client.query(`INSERT INTO voyage_reviews(id,subject_id,source_node_id,author_account_id,body,moderation_status,author_snapshot,moderation,hidden_at,created_at,updated_at,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,body=EXCLUDED.body,moderation_status=EXCLUDED.moderation_status,author_snapshot=EXCLUDED.author_snapshot,moderation=EXCLUDED.moderation,hidden_at=EXCLUDED.hidden_at,updated_at=EXCLUDED.updated_at,revision=EXCLUDED.revision`,
    [review.id, review.subjectId, review.sourceNodeId, review.authorId, review.body, review.moderationStatus, jsonParameter(review.authorSnapshot), jsonParameter(review.moderation), review.hiddenAt, review.createdAt, review.updatedAt, review.revision]);
  }

  const voteKeys = database.helpfulVotes.map((r) => `${r.reviewId}\u001f${r.userId}`);
  await client.query(`DELETE FROM review_helpful_votes WHERE (review_id || chr(31) || account_id) <> ALL($1::text[])`, [voteKeys]);
  await queryEach(client, `INSERT INTO review_helpful_votes(review_id,account_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, database.helpfulVotes, (r) => [r.reviewId, r.userId, r.createdAt]);
  await queryEach(client, `INSERT INTO review_reports(id,review_id,reporter_account_id,reason,details,status,created_at,resolved_at,resolution) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,resolved_at=EXCLUDED.resolved_at,resolution=EXCLUDED.resolution`, database.reports,
  (r) => [r.id, r.reviewId, r.reporterId, r.reason, r.details, r.status, r.createdAt, r.resolvedAt, r.resolution]);
  await queryEach(client, `INSERT INTO moderation_jobs(id,review_id,review_revision,reason,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at,last_error=EXCLUDED.last_error,updated_at=EXCLUDED.updated_at`, database.moderationJobs,
  (r) => [r.id, r.reviewId, r.reviewRevision, r.reason, r.status, r.attempts, r.nextAttemptAt, r.lastError ?? null, r.createdAt, r.updatedAt]);
  await queryEach(client, `INSERT INTO experience_resolutions(id,account_id,node_id,subject_id,candidate_signature,candidate,decision,confidence,reason,compared_subject_ids,matched_subject_id,linked_shared_subject_id,identity,method,model,diagnostic,extraction_diagnostic,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,status=EXCLUDED.status`, database.experienceResolutions,
  (r) => [r.id, r.userId, r.nodeId, r.subjectId, r.candidateSignature, jsonParameter(r.candidate), r.decision, r.confidence, r.reason, jsonParameter(r.comparedSubjectIds), r.matchedSubjectId, r.linkedSharedSubjectId, jsonParameter(r.identity), r.method, r.model, jsonParameter(r.diagnostic), jsonParameter(r.extractionDiagnostic), r.status, r.createdAt]);
  await queryEach(client, `INSERT INTO experience_subject_links(id,island_subject_id,shared_subject_id,status,reason,resolution_id,created_at,created_by,revoked_at,revoked_by,revocation_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,revoked_at=EXCLUDED.revoked_at,revoked_by=EXCLUDED.revoked_by,revocation_reason=EXCLUDED.revocation_reason`, database.experienceSubjectLinks,
  (r) => [r.id, r.sourceSubjectId, r.sharedSubjectId, r.status, r.reason, r.resolutionId, r.createdAt, r.createdBy, r.revokedAt, r.revokedBy, r.revocationReason]);
  await queryEach(client, `INSERT INTO subject_corrections(id,account_id,node_id,previous_subject_id,subject_id,previous_shared_subject_id,shared_subject_id,mode,reason,moved_review_ids,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`, database.subjectCorrections,
  (r) => [r.id, r.userId, r.nodeId, r.previousSubjectId, r.subjectId, r.previousSharedSubjectId, r.sharedSubjectId, r.mode, r.reason, jsonParameter(r.movedReviewIds), r.actorId, r.createdAt]);
  await queryEach(client, `INSERT INTO review_audit_log(id,actor_id,actor_role,action,target_type,target_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`, database.auditLog,
  (r) => [r.id ?? `audit_${randomUUID()}`, r.actorId, r.actorRole, r.action, r.targetType, r.targetId, jsonParameter(r.metadata ?? {}), r.at]);
}

export function createPostgresReviewRepository(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL Pool-compatible object is required.');
  const load = async () => {
    const client = await pool.connect();
    try { return await loadPostgresReviewDatabase(client); } finally { client.release(); }
  };
  const mutate = async (operation) => {
    const client = await pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
      locked = true;
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const database = await loadPostgresReviewDatabase(client);
      const result = await operation(database);
      await persistPostgresReviewDatabase(client, database);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      if (error?.code === '23505' && error?.constraint === 'voyage_reviews_author_account_id_source_node_id_key') {
        throw new ReviewLabError(409, 'review_already_exists', 'This account already has a voyage log for the Node.');
      }
      throw error;
    } finally {
      let releaseError = null;
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]); }
        catch (error) { releaseError = error; }
      }
      client.release(releaseError ?? undefined);
    }
  };
  const repository = createReviewLabRepositoryFromPersistence({ load, mutate });
  repository.sessionStore = createPostgresSessionRepository(pool);
  repository.claimModerationJob = async (now = new Date(), workerId = `worker:${process.pid}`) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE moderation_jobs SET status='waiting',claimed_by=NULL,claimed_at=NULL,updated_at=$1
        WHERE status='processing' AND updated_at < $1::timestamptz - interval '10 minutes'`, [now.toISOString()]);
      await client.query(`UPDATE moderation_jobs AS job SET status='complete',updated_at=$1
        WHERE job.status='waiting' AND NOT EXISTS (
          SELECT 1 FROM voyage_reviews AS review
          WHERE review.id=job.review_id AND review.revision=job.review_revision
        )`, [now.toISOString()]);
      const claimed = (await client.query(MODERATION_JOB_CLAIM_SQL, [workerId, now.toISOString()])).rows[0];
      if (!claimed) { await client.query('COMMIT'); return null; }
      const review = (await client.query('SELECT * FROM voyage_reviews WHERE id=$1 AND revision=$2', [claimed.review_id, claimed.review_revision])).rows[0];
      if (!review) {
        await client.query(`UPDATE moderation_jobs SET status='complete',updated_at=$2 WHERE id=$1`, [claimed.id, now.toISOString()]);
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return {
        job: { id: claimed.id, reviewId: claimed.review_id, reviewRevision: claimed.review_revision, reason: claimed.reason, status: claimed.status, attempts: claimed.attempts, nextAttemptAt: iso(claimed.next_attempt_at), lastError: claimed.last_error, createdAt: iso(claimed.created_at), updatedAt: iso(claimed.updated_at) },
        review: { id: review.id, subjectId: review.subject_id, sourceNodeId: review.source_node_id, authorId: review.author_account_id, body: review.body, moderationStatus: review.moderation_status, authorSnapshot: review.author_snapshot, moderation: review.moderation, hiddenAt: iso(review.hidden_at), createdAt: iso(review.created_at), updatedAt: iso(review.updated_at), revision: review.revision },
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  };
  return repository;
}

export const MODERATION_JOB_CLAIM_SQL = `
WITH candidate AS (
  SELECT job.id
  FROM moderation_jobs AS job
  JOIN voyage_reviews AS review ON review.id=job.review_id AND review.revision=job.review_revision
  WHERE job.status = 'waiting' AND job.next_attempt_at <= $2::timestamptz
  ORDER BY job.next_attempt_at, job.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE moderation_jobs AS job
SET status = 'processing', claimed_by = $1, claimed_at = $2::timestamptz, updated_at = $2::timestamptz
FROM candidate
WHERE job.id = candidate.id
RETURNING job.*`;

