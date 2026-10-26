BEGIN;

CREATE TABLE IF NOT EXISTS review_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_import_batches (
  id uuid PRIMARY KEY,
  source_path text NOT NULL,
  source_sha256 text NOT NULL UNIQUE,
  source_version integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  counts jsonb NOT NULL,
  digest jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS review_accounts (
  id text PRIMARY KEY,
  frozen boolean NOT NULL DEFAULT false,
  freeze_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  import_batch_id uuid REFERENCES review_import_batches(id)
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id),
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  import_batch_id uuid REFERENCES review_import_batches(id)
);

CREATE TABLE IF NOT EXISTS experience_subjects (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  reference_label text,
  sharing_scope text NOT NULL CHECK (sharing_scope IN ('shared_confirmed', 'island_specific', 'legacy_entity')),
  identity_version integer NOT NULL DEFAULT 1,
  canonical_experience_key text,
  identity jsonb,
  semantic_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  import_batch_id uuid REFERENCES review_import_batches(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS experience_subjects_confirmed_key_uq
  ON experience_subjects(canonical_experience_key)
  WHERE sharing_scope = 'shared_confirmed' AND canonical_experience_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS verified_node_subjects (
  account_id text NOT NULL REFERENCES review_accounts(id),
  node_id text NOT NULL,
  subject_id text NOT NULL REFERENCES experience_subjects(id),
  verified_at timestamptz NOT NULL,
  verified_by text NOT NULL,
  provenance text NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id),
  PRIMARY KEY (account_id, node_id)
);

CREATE TABLE IF NOT EXISTS review_node_bindings (
  account_id text NOT NULL REFERENCES review_accounts(id),
  node_id text NOT NULL,
  subject_id text NOT NULL REFERENCES experience_subjects(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id),
  PRIMARY KEY (account_id, node_id)
);

CREATE TABLE IF NOT EXISTS landing_journeys (
  account_id text NOT NULL REFERENCES review_accounts(id),
  node_id text NOT NULL,
  subject_id text NOT NULL REFERENCES experience_subjects(id),
  required_step_ids jsonb NOT NULL,
  completed_step_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  landed_at timestamptz,
  landing_evidence jsonb,
  import_batch_id uuid REFERENCES review_import_batches(id),
  PRIMARY KEY (account_id, node_id),
  CHECK (jsonb_typeof(required_step_ids) = 'array'),
  CHECK (jsonb_array_length(required_step_ids) = 3),
  CHECK (jsonb_typeof(completed_step_ids) = 'array')
);

CREATE TABLE IF NOT EXISTS voyage_reviews (
  id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES experience_subjects(id),
  source_node_id text NOT NULL,
  author_account_id text NOT NULL REFERENCES review_accounts(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 4000),
  moderation_status text NOT NULL CHECK (moderation_status IN ('pending_moderation', 'approved', 'rejected', 'needs_human_review')),
  author_snapshot jsonb NOT NULL,
  moderation jsonb,
  hidden_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  import_batch_id uuid REFERENCES review_import_batches(id),
  UNIQUE (author_account_id, source_node_id)
);
CREATE INDEX IF NOT EXISTS voyage_reviews_public_subject_idx
  ON voyage_reviews(subject_id, updated_at DESC)
  WHERE moderation_status = 'approved' AND hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS voyage_reviews_author_idx ON voyage_reviews(author_account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS voyage_review_revisions (
  review_id text NOT NULL REFERENCES voyage_reviews(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  body text NOT NULL,
  moderation_status text NOT NULL,
  moderation jsonb,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id),
  PRIMARY KEY (review_id, revision)
);

CREATE TABLE IF NOT EXISTS review_helpful_votes (
  review_id text NOT NULL REFERENCES voyage_reviews(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES review_accounts(id),
  created_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id),
  PRIMARY KEY (review_id, account_id)
);

CREATE TABLE IF NOT EXISTS review_reports (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES voyage_reviews(id) ON DELETE RESTRICT,
  reporter_account_id text NOT NULL REFERENCES review_accounts(id),
  reason text NOT NULL CHECK (reason IN ('privacy', 'harassment', 'dangerous', 'false_information', 'spam', 'other')),
  details text,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution text,
  import_batch_id uuid REFERENCES review_import_batches(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS review_reports_one_open_per_reporter_uq
  ON review_reports(review_id, reporter_account_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS moderation_jobs (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES voyage_reviews(id) ON DELETE CASCADE,
  review_revision integer NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'processing', 'complete')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id),
  UNIQUE (review_id, review_revision, reason)
);
CREATE INDEX IF NOT EXISTS moderation_jobs_claim_idx ON moderation_jobs(next_attempt_at, created_at) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS experience_resolutions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id),
  node_id text NOT NULL,
  subject_id text NOT NULL REFERENCES experience_subjects(id),
  candidate_signature text NOT NULL,
  candidate jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN ('same', 'different', 'uncertain')),
  confidence text,
  reason text NOT NULL,
  compared_subject_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_subject_id text,
  linked_shared_subject_id text,
  identity jsonb,
  method text,
  model text,
  diagnostic jsonb,
  extraction_diagnostic jsonb,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  created_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id)
);
CREATE INDEX IF NOT EXISTS experience_resolutions_node_idx ON experience_resolutions(account_id, node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS experience_resolutions_signature_idx ON experience_resolutions(candidate_signature, created_at DESC);

CREATE TABLE IF NOT EXISTS experience_subject_links (
  id text PRIMARY KEY,
  island_subject_id text NOT NULL REFERENCES experience_subjects(id),
  shared_subject_id text NOT NULL REFERENCES experience_subjects(id),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  reason text,
  resolution_id text,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  import_batch_id uuid REFERENCES review_import_batches(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS experience_subject_links_one_active_uq
  ON experience_subject_links(island_subject_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS subject_corrections (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id),
  node_id text NOT NULL,
  previous_subject_id text,
  subject_id text NOT NULL,
  previous_shared_subject_id text,
  shared_subject_id text,
  mode text NOT NULL,
  reason text NOT NULL,
  moved_review_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id)
);

CREATE TABLE IF NOT EXISTS review_audit_log (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL,
  import_batch_id uuid REFERENCES review_import_batches(id)
);
CREATE INDEX IF NOT EXISTS review_audit_target_idx ON review_audit_log(target_type, target_id, created_at DESC);

INSERT INTO review_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;

