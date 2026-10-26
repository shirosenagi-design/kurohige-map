BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_sync_heads)
    OR EXISTS (SELECT 1 FROM account_sync_conflicts)
    OR EXISTS (SELECT 1 FROM account_world_revisions)
    OR EXISTS (SELECT 1 FROM account_profile_revisions)
    OR EXISTS (SELECT 1 FROM account_worlds)
    OR EXISTS (SELECT 1 FROM account_sync_operations) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Migration 005 rollback refused: synchronized World/Profile history exists. Export and explicitly remove Stage 1 data before rollback.';
  END IF;
END $$;

DROP TABLE IF EXISTS account_sync_heads;
DROP TABLE IF EXISTS account_sync_conflicts;
DROP TABLE IF EXISTS account_world_revisions;
DROP TABLE IF EXISTS account_profile_revisions;
DROP TABLE IF EXISTS account_worlds;
DROP TABLE IF EXISTS account_sync_operations;
DELETE FROM review_schema_migrations WHERE version = 5;

COMMIT;
