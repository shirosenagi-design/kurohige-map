BEGIN;

ALTER TABLE review_accounts
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'anonymous'
    CHECK (account_type IN ('anonymous', 'registered', 'service'));

ALTER TABLE review_sessions
  DROP CONSTRAINT IF EXISTS review_sessions_role_check;
UPDATE review_sessions SET role = 'user' WHERE role <> 'user';
ALTER TABLE review_sessions
  ADD CONSTRAINT review_sessions_role_check CHECK (role = 'user');
ALTER TABLE review_sessions
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS rotated_from_id uuid REFERENCES review_sessions(id),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoke_reason text,
  ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'anonymous'
    CHECK (auth_method IN ('anonymous', 'legacy_cookie', 'email_magic_link', 'passkey'));

UPDATE review_sessions SET family_id = id WHERE family_id IS NULL;
ALTER TABLE review_sessions ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS review_sessions_active_account_idx
  ON review_sessions(account_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS review_sessions_family_idx
  ON review_sessions(family_id, issued_at);

CREATE TABLE IF NOT EXISTS auth_migration_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  accept_legacy_issued_after timestamptz NOT NULL,
  migration_cutoff timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (migration_cutoff > accept_legacy_issued_after)
);

INSERT INTO auth_migration_settings(singleton, accept_legacy_issued_after, migration_cutoff)
VALUES (true, now() - interval '1 year', now() + interval '90 days')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS auth_legacy_cookie_claims (
  legacy_token_hash text PRIMARY KEY,
  account_id text NOT NULL UNIQUE REFERENCES review_accounts(id),
  migrated_session_id uuid NOT NULL UNIQUE REFERENCES review_sessions(id),
  legacy_issued_at timestamptz NOT NULL,
  legacy_expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_session_audit_log (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id),
  session_id uuid REFERENCES review_sessions(id),
  action text NOT NULL CHECK (action IN (
    'session.created', 'session.migrated', 'session.rotated',
    'session.revoked', 'session.revoked_all'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_session_audit_account_idx
  ON auth_session_audit_log(account_id, created_at DESC);

INSERT INTO review_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
