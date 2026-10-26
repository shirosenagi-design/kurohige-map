BEGIN;

CREATE TABLE IF NOT EXISTS auth_webauthn_users (
  account_id text PRIMARY KEY REFERENCES review_accounts(id),
  webauthn_user_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(webauthn_user_id) BETWEEN 32 AND 128)
);

CREATE TABLE IF NOT EXISTS auth_webauthn_credentials (
  credential_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id),
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL DEFAULT false,
  transports jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transports) = 'array'),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (length(credential_id) BETWEEN 16 AND 2048),
  CHECK (length(display_name) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS auth_webauthn_credentials_account_idx
  ON auth_webauthn_credentials(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_webauthn_challenges (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge_hash text NOT NULL UNIQUE,
  browser_binding_hash text NOT NULL,
  requesting_account_id text NOT NULL REFERENCES review_accounts(id),
  requesting_session_id uuid NOT NULL REFERENCES review_sessions(id),
  rp_id text NOT NULL,
  expected_origin text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'consumed', 'superseded')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_webauthn_challenges_pending_idx
  ON auth_webauthn_challenges(requesting_account_id, kind, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS auth_webauthn_audit_log (
  id uuid PRIMARY KEY,
  account_id text REFERENCES review_accounts(id),
  challenge_id uuid REFERENCES auth_webauthn_challenges(id),
  credential_id text,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_webauthn_audit_account_idx
  ON auth_webauthn_audit_log(account_id, created_at DESC);

INSERT INTO review_schema_migrations(version) VALUES (4) ON CONFLICT DO NOTHING;
COMMIT;
