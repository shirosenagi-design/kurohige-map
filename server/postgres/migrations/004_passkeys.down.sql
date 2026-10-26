BEGIN;
DELETE FROM review_schema_migrations WHERE version = 4;
DROP TABLE IF EXISTS auth_webauthn_audit_log;
DROP TABLE IF EXISTS auth_webauthn_challenges;
DROP TABLE IF EXISTS auth_webauthn_credentials;
DROP TABLE IF EXISTS auth_webauthn_users;
COMMIT;
