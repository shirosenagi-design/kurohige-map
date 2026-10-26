BEGIN;
DELETE FROM review_schema_migrations WHERE version = 2;
DROP TABLE IF EXISTS auth_session_audit_log;
DROP TABLE IF EXISTS auth_legacy_cookie_claims;
DROP TABLE IF EXISTS auth_migration_settings;
DROP INDEX IF EXISTS review_sessions_family_idx;
DROP INDEX IF EXISTS review_sessions_active_account_idx;
ALTER TABLE review_sessions DROP CONSTRAINT IF EXISTS review_sessions_role_check;
ALTER TABLE review_sessions ADD CONSTRAINT review_sessions_role_check CHECK (role IN ('user', 'admin'));
ALTER TABLE review_sessions
  DROP COLUMN IF EXISTS auth_method,
  DROP COLUMN IF EXISTS revoke_reason,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS rotated_from_id,
  DROP COLUMN IF EXISTS family_id;
ALTER TABLE review_accounts DROP COLUMN IF EXISTS account_type;
COMMIT;
