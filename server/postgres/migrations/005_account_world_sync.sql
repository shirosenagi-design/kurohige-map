BEGIN;

CREATE TABLE IF NOT EXISTS account_sync_operations (
  operation_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  base_sync_revision bigint NOT NULL CHECK (base_sync_revision >= 0),
  resulting_sync_revision bigint,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'committed', 'conflict', 'rejected')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (operation_id, account_id),
  CHECK (length(device_id) BETWEEN 8 AND 180),
  CHECK (resulting_sync_revision IS NULL OR resulting_sync_revision > base_sync_revision),
  CHECK ((status = 'pending' AND completed_at IS NULL AND resulting_sync_revision IS NULL)
    OR (status = 'committed' AND completed_at IS NOT NULL AND resulting_sync_revision IS NOT NULL AND error_code IS NULL)
    OR (status IN ('conflict', 'rejected') AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_sync_operations_result_revision_uq
  ON account_sync_operations(account_id, resulting_sync_revision)
  WHERE resulting_sync_revision IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_sync_operations_account_idx
  ON account_sync_operations(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_worlds (
  account_id text NOT NULL REFERENCES review_accounts(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived', 'conflict')),
  created_by_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archive_reason text,
  PRIMARY KEY (account_id, world_id),
  FOREIGN KEY (created_by_operation_id, account_id)
    REFERENCES account_sync_operations(operation_id, account_id) ON DELETE RESTRICT,
  CHECK (length(world_id) BETWEEN 1 AND 180),
  CHECK ((status = 'archived' AND archived_at IS NOT NULL AND archive_reason IS NOT NULL AND length(archive_reason) > 0)
    OR (status <> 'archived' AND archived_at IS NULL AND archive_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_worlds_one_active_per_account_uq
  ON account_worlds(account_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS account_profile_revisions (
  account_id text NOT NULL REFERENCES review_accounts(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  sync_revision bigint NOT NULL CHECK (sync_revision > 0),
  schema_version integer NOT NULL CHECK (schema_version IN (1, 2)),
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, revision),
  UNIQUE (account_id, sync_revision),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES account_sync_operations(operation_id, account_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK ((snapshot->>'version') ~ '^[0-9]+$' AND (snapshot->>'version')::integer = schema_version),
  CHECK (octet_length(snapshot::text) <= 1048576),
  CHECK (length(device_id) BETWEEN 8 AND 180)
);

CREATE TABLE IF NOT EXISTS account_world_revisions (
  account_id text NOT NULL,
  world_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  sync_revision bigint NOT NULL CHECK (sync_revision > 0),
  source_world_revision bigint NOT NULL CHECK (source_world_revision >= 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  layout_version integer NOT NULL CHECK (layout_version > 0),
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, world_id, revision),
  UNIQUE (account_id, sync_revision),
  FOREIGN KEY (account_id, world_id)
    REFERENCES account_worlds(account_id, world_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, account_id)
    REFERENCES account_sync_operations(operation_id, account_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (snapshot->>'worldId' = world_id),
  CHECK ((snapshot->>'worldRevision') ~ '^[0-9]+$' AND (snapshot->>'worldRevision')::bigint = source_world_revision),
  CHECK ((snapshot->>'schemaVersion') ~ '^[0-9]+$' AND (snapshot->>'schemaVersion')::integer = schema_version),
  CHECK ((snapshot->>'layoutVersion') ~ '^[0-9]+$' AND (snapshot->>'layoutVersion')::integer = layout_version),
  CHECK (octet_length(snapshot::text) <= 16777216),
  CHECK (length(device_id) BETWEEN 8 AND 180)
);

CREATE TABLE IF NOT EXISTS account_sync_heads (
  account_id text PRIMARY KEY REFERENCES review_accounts(id) ON DELETE RESTRICT,
  sync_revision bigint NOT NULL DEFAULT 0 CHECK (sync_revision >= 0),
  profile_revision bigint,
  active_world_id text,
  profile_hash text,
  world_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, profile_revision)
    REFERENCES account_profile_revisions(account_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, active_world_id)
    REFERENCES account_worlds(account_id, world_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((profile_revision IS NULL AND profile_hash IS NULL)
    OR (profile_revision IS NOT NULL AND profile_revision > 0 AND profile_hash ~ '^[0-9a-f]{64}$')),
  CHECK (world_hash IS NULL OR world_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((active_world_id IS NULL AND world_hash IS NULL) OR active_world_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS account_sync_conflicts (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES review_accounts(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  base_sync_revision bigint NOT NULL CHECK (base_sync_revision >= 0),
  server_sync_revision bigint NOT NULL CHECK (server_sync_revision > base_sync_revision),
  candidate_bundle jsonb NOT NULL,
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('open', 'resolved', 'discarded')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_operation_id uuid,
  resolution_note text,
  UNIQUE (operation_id),
  FOREIGN KEY (operation_id, account_id)
    REFERENCES account_sync_operations(operation_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_operation_id, account_id)
    REFERENCES account_sync_operations(operation_id, account_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(candidate_bundle) = 'object'),
  CHECK (octet_length(candidate_bundle::text) <= 18874368),
  CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by_operation_id IS NULL)
    OR (status IN ('resolved', 'discarded') AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS account_sync_conflicts_account_idx
  ON account_sync_conflicts(account_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS account_sync_conflicts_open_idx
  ON account_sync_conflicts(account_id, detected_at DESC) WHERE status = 'open';

INSERT INTO review_schema_migrations(version) VALUES (5) ON CONFLICT DO NOTHING;
COMMIT;
