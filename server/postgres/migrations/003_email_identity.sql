BEGIN;

ALTER TABLE review_sessions
  ADD COLUMN IF NOT EXISTS idle_expires_at timestamptz;
UPDATE review_sessions
SET idle_expires_at = LEAST(expires_at, COALESCE(last_seen_at, issued_at) + interval '7 days')
WHERE idle_expires_at IS NULL;
ALTER TABLE review_sessions ALTER COLUMN idle_expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS review_sessions_idle_expiry_idx
  ON review_sessions(idle_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_email_identities (
  id uuid PRIMARY KEY,
  account_id text NOT NULL UNIQUE REFERENCES review_accounts(id),
  email_normalized text NOT NULL UNIQUE,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalized = lower(email_normalized)),
  CHECK (length(email_normalized) BETWEEN 3 AND 254)
);

CREATE TABLE IF NOT EXISTS auth_magic_link_challenges (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  browser_binding_hash text NOT NULL,
  email_normalized text NOT NULL,
  requesting_account_id text NOT NULL REFERENCES review_accounts(id),
  target_account_id text REFERENCES review_accounts(id),
  requesting_session_id uuid NOT NULL REFERENCES review_sessions(id),
  status text NOT NULL CHECK (status IN ('pending', 'consumed', 'superseded', 'delivery_failed')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  confirmation_attempts integer NOT NULL DEFAULT 0 CHECK (confirmation_attempts BETWEEN 0 AND 5),
  request_ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_magic_link_pending_idx
  ON auth_magic_link_challenges(email_normalized, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS auth_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limit_expiry_idx ON auth_rate_limit_buckets(expires_at);

CREATE TABLE IF NOT EXISTS auth_identity_audit_log (
  id uuid PRIMARY KEY,
  account_id text REFERENCES review_accounts(id),
  challenge_id uuid REFERENCES auth_magic_link_challenges(id),
  action text NOT NULL CHECK (action IN (
    'magic_link.requested', 'magic_link.delivery_failed', 'magic_link.expired',
    'magic_link.binding_rejected', 'magic_link.consumed', 'identity.verified',
    'identity.conflict'
  )),
  email_hash text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_identity_audit_account_idx
  ON auth_identity_audit_log(account_id, created_at DESC);

INSERT INTO review_schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
