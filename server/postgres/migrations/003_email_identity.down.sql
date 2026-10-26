BEGIN;
DELETE FROM review_schema_migrations WHERE version = 3;
DROP TABLE IF EXISTS auth_identity_audit_log;
DROP TABLE IF EXISTS auth_rate_limit_buckets;
DROP TABLE IF EXISTS auth_magic_link_challenges;
DROP TABLE IF EXISTS auth_email_identities;
DROP INDEX IF EXISTS review_sessions_idle_expiry_idx;
ALTER TABLE review_sessions DROP COLUMN IF EXISTS idle_expires_at;
COMMIT;
