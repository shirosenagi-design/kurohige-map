import { randomUUID } from 'node:crypto';
import {
  sha256ContentHash,
  validateAccountSyncBundle,
} from '../../src/accountSyncContract.ts';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const MAX_RESOLUTION_NOTE_LENGTH = 1_000;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AccountSyncRepositoryError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'AccountSyncRepositoryError';
    this.status = status;
    this.code = code;
  }
}

const iso = (value) => value instanceof Date ? value.toISOString() : value ?? null;
const jsonParameter = (value) => JSON.stringify(value);
const positiveLimit = (value) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, MAX_HISTORY_LIMIT)
  : DEFAULT_HISTORY_LIMIT;

function trustedAccountId(context) {
  const accountId = context?.accountId;
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new AccountSyncRepositoryError(401, 'sync_authentication_required', 'An authenticated account context is required.');
  }
  return accountId;
}

function profileView(row) {
  if (!row) return null;
  return {
    revision: Number(row.revision),
    syncRevision: Number(row.sync_revision),
    schemaVersion: row.schema_version,
    snapshot: row.snapshot,
    contentHash: row.content_hash,
    operationId: row.operation_id,
    deviceId: row.device_id,
    createdAt: iso(row.created_at),
  };
}

function worldView(row) {
  if (!row) return null;
  return {
    worldId: row.world_id,
    status: row.status ?? null,
    revision: Number(row.revision),
    syncRevision: Number(row.sync_revision),
    sourceWorldRevision: Number(row.source_world_revision),
    schemaVersion: row.schema_version,
    layoutVersion: row.layout_version,
    snapshot: row.snapshot,
    contentHash: row.content_hash,
    operationId: row.operation_id,
    deviceId: row.device_id,
    createdAt: iso(row.created_at),
    archivedAt: iso(row.archived_at),
    archiveReason: row.archive_reason ?? null,
  };
}

function conflictView(row, serverState = null) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    operationId: row.operation_id,
    baseSyncRevision: Number(row.base_sync_revision),
    serverSyncRevision: Number(row.server_sync_revision),
    candidateBundle: row.candidate_bundle,
    candidateHash: row.candidate_hash,
    status: row.status,
    detectedAt: iso(row.detected_at),
    resolvedAt: iso(row.resolved_at),
    resolvedByOperationId: row.resolved_by_operation_id ?? null,
    resolutionNote: row.resolution_note ?? null,
    serverState,
  };
}

async function readRevisionState(client, accountId, syncRevision) {
  if (!Number.isSafeInteger(syncRevision) || syncRevision <= 0) return null;
  const profile = (await client.query(`SELECT * FROM account_profile_revisions
    WHERE account_id=$1 AND sync_revision=$2`, [accountId, syncRevision])).rows[0] ?? null;
  const world = (await client.query(`SELECT * FROM account_world_revisions
    WHERE account_id=$1 AND sync_revision=$2`, [accountId, syncRevision])).rows[0] ?? null;
  return { accountId, syncRevision, profile: profileView(profile), world: worldView(world) };
}

async function readLatestState(client, accountId) {
  const head = (await client.query('SELECT * FROM account_sync_heads WHERE account_id=$1', [accountId])).rows[0];
  if (!head) return {
    accountId,
    syncRevision: 0,
    activeWorldId: null,
    profile: null,
    world: null,
    updatedAt: null,
  };
  const profile = head.profile_revision == null ? null : (await client.query(`SELECT * FROM account_profile_revisions
    WHERE account_id=$1 AND revision=$2`, [accountId, head.profile_revision])).rows[0] ?? null;
  const world = head.active_world_id == null ? null : (await client.query(`SELECT revision.*,world.status,world.archived_at,world.archive_reason
    FROM account_world_revisions revision
    JOIN account_worlds world ON world.account_id=revision.account_id AND world.world_id=revision.world_id
    WHERE revision.account_id=$1 AND revision.world_id=$2
    ORDER BY revision.revision DESC LIMIT 1`, [accountId, head.active_world_id])).rows[0] ?? null;
  return {
    accountId,
    syncRevision: Number(head.sync_revision),
    activeWorldId: head.active_world_id ?? null,
    profile: profileView(profile),
    world: worldView(world),
    updatedAt: iso(head.updated_at),
  };
}

async function assertRegisteredAccount(client, accountId, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const result = await client.query(`SELECT id,account_type FROM review_accounts WHERE id=$1${suffix}`, [accountId]);
  if (!result.rowCount) {
    throw new AccountSyncRepositoryError(403, 'sync_account_unavailable', 'The authenticated account cannot use server sync.');
  }
  if (result.rows[0].account_type !== 'registered') {
    throw new AccountSyncRepositoryError(403, 'sync_registered_account_required', 'Register the account before enabling server sync.');
  }
}

function unavailable(error) {
  if (error instanceof AccountSyncRepositoryError) return error;
  return new AccountSyncRepositoryError(503, 'sync_repository_unavailable', 'Server sync is temporarily unavailable.', { cause: error });
}

export function createPostgresAccountSyncRepository(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL Pool-compatible object is required.');
  }

  const transact = async (operation) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      }
      throw unavailable(error);
    } finally {
      client?.release();
    }
  };

  const safely = async (operation) => {
    try { return await operation(); }
    catch (error) { throw unavailable(error); }
  };

  const prepareBundle = async (candidateBundle, accountId) => {
    const validation = await validateAccountSyncBundle(candidateBundle, accountId);
    if (validation.status !== 'ready') {
      throw new AccountSyncRepositoryError(400, validation.code, validation.reason);
    }
    return {
      bundle: validation.value,
      profileHash: await sha256ContentHash(validation.value.profile.snapshot),
      worldHash: validation.value.world ? await sha256ContentHash(validation.value.world.snapshot) : null,
    };
  };

  const commitValidated = async (client, accountId, bundle, profileHash, worldHash) => {
    await assertRegisteredAccount(client, accountId, true);

    const priorOperation = (await client.query('SELECT * FROM account_sync_operations WHERE operation_id=$1 FOR UPDATE', [bundle.operationId])).rows[0];
    if (priorOperation) {
      if (priorOperation.account_id !== accountId || priorOperation.request_hash !== bundle.contentHash) {
        throw new AccountSyncRepositoryError(409, 'sync_operation_payload_mismatch', 'The operationId was already used for different sync content.');
      }
      if (priorOperation.status === 'committed') {
        return {
          status: 'committed', httpStatus: 200, idempotent: true, operationId: bundle.operationId,
          syncRevision: Number(priorOperation.resulting_sync_revision), activeWorldId: bundle.activeWorldId,
          state: await readRevisionState(client, accountId, Number(priorOperation.resulting_sync_revision)),
        };
      }
      if (priorOperation.status === 'conflict') {
        const conflict = (await client.query('SELECT * FROM account_sync_conflicts WHERE operation_id=$1 AND account_id=$2', [bundle.operationId, accountId])).rows[0];
        return {
          status: 'conflict', httpStatus: 409, idempotent: true, operationId: bundle.operationId,
          conflict: conflictView(conflict, await readRevisionState(client, accountId, Number(conflict.server_sync_revision))),
        };
      }
      if (priorOperation.status === 'rejected') {
        return { status: 'rejected', httpStatus: 409, idempotent: true, operationId: bundle.operationId, code: priorOperation.error_code };
      }
      throw new AccountSyncRepositoryError(409, 'sync_operation_not_reusable', 'The operationId cannot be reused.');
    }

    await client.query(`INSERT INTO account_sync_heads(account_id,sync_revision)
      VALUES($1,0) ON CONFLICT(account_id) DO NOTHING`, [accountId]);
    const head = (await client.query('SELECT * FROM account_sync_heads WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
    const serverSyncRevision = Number(head.sync_revision);

    if (bundle.syncRevision > serverSyncRevision) {
      await client.query(`INSERT INTO account_sync_operations(
        operation_id,account_id,device_id,base_sync_revision,request_hash,status,completed_at,error_code
      ) VALUES($1,$2,$3,$4,$5,'rejected',now(),'base_revision_ahead')`,
      [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);
      return { status: 'rejected', httpStatus: 409, idempotent: false, operationId: bundle.operationId, code: 'sync_base_revision_ahead' };
    }

    if (bundle.syncRevision < serverSyncRevision) {
      const conflictId = randomUUID();
      await client.query(`INSERT INTO account_sync_operations(
        operation_id,account_id,device_id,base_sync_revision,request_hash,status,completed_at,error_code
      ) VALUES($1,$2,$3,$4,$5,'conflict',now(),'revision_conflict')`,
      [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);
      await client.query(`INSERT INTO account_sync_conflicts(
        id,account_id,operation_id,base_sync_revision,server_sync_revision,candidate_bundle,candidate_hash,status
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'open')`,
      [conflictId, accountId, bundle.operationId, bundle.syncRevision, serverSyncRevision, jsonParameter(bundle), bundle.contentHash]);
      return {
        status: 'conflict', httpStatus: 409, idempotent: false, operationId: bundle.operationId,
        conflict: conflictView((await client.query('SELECT * FROM account_sync_conflicts WHERE id=$1', [conflictId])).rows[0],
          await readRevisionState(client, accountId, serverSyncRevision)),
      };
    }

    const nextSyncRevision = serverSyncRevision + 1;
    await client.query(`INSERT INTO account_sync_operations(
      operation_id,account_id,device_id,base_sync_revision,request_hash,status
    ) VALUES($1,$2,$3,$4,$5,'pending')`,
    [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);

    const nextProfileRevision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS revision
      FROM account_profile_revisions WHERE account_id=$1`, [accountId])).rows[0].revision);
    await client.query(`INSERT INTO account_profile_revisions(
      account_id,revision,sync_revision,schema_version,snapshot,content_hash,operation_id,device_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
      accountId, nextProfileRevision, nextSyncRevision, bundle.profile.snapshot.version,
      jsonParameter(bundle.profile.snapshot), profileHash, bundle.operationId, bundle.deviceId,
    ]);

    await client.query(`UPDATE account_worlds SET status='archived',archived_at=now(),
      archive_reason='superseded_by_sync_commit',updated_at=now()
      WHERE account_id=$1 AND status='active' AND ($2::text IS NULL OR world_id<>$2)`,
    [accountId, bundle.world?.status === 'active' ? bundle.world.worldId : null]);

    if (bundle.world) {
      const archivedAt = bundle.world.status === 'archived' ? bundle.world.archive?.archivedAt : null;
      const archiveReason = bundle.world.status === 'archived' ? bundle.world.archive?.reason : null;
      await client.query(`INSERT INTO account_worlds(
          account_id,world_id,status,created_by_operation_id,archived_at,archive_reason
        ) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(account_id,world_id) DO UPDATE SET
          status=EXCLUDED.status,updated_at=now(),archived_at=EXCLUDED.archived_at,archive_reason=EXCLUDED.archive_reason`,
      [accountId, bundle.world.worldId, bundle.world.status, bundle.operationId, archivedAt, archiveReason]);
      const nextWorldRevision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS revision
        FROM account_world_revisions WHERE account_id=$1 AND world_id=$2`, [accountId, bundle.world.worldId])).rows[0].revision);
      await client.query(`INSERT INTO account_world_revisions(
        account_id,world_id,revision,sync_revision,source_world_revision,schema_version,layout_version,
        snapshot,content_hash,operation_id,device_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        accountId, bundle.world.worldId, nextWorldRevision, nextSyncRevision, bundle.world.snapshot.worldRevision,
        bundle.world.schemaVersion, bundle.world.layoutVersion, jsonParameter(bundle.world.snapshot), worldHash,
        bundle.operationId, bundle.deviceId,
      ]);
    }

    const activeWorldId = bundle.world?.status === 'active' ? bundle.world.worldId : null;
    await client.query(`UPDATE account_sync_heads SET
      sync_revision=$2,profile_revision=$3,active_world_id=$4,profile_hash=$5,world_hash=$6,updated_at=now()
      WHERE account_id=$1`, [accountId, nextSyncRevision, nextProfileRevision, activeWorldId, profileHash, activeWorldId ? worldHash : null]);
    await client.query(`UPDATE account_sync_operations SET
      resulting_sync_revision=$2,status='committed',completed_at=now(),error_code=NULL
      WHERE operation_id=$1 AND account_id=$3`, [bundle.operationId, nextSyncRevision, accountId]);

    return {
      status: 'committed', httpStatus: 201, idempotent: false, operationId: bundle.operationId,
      syncRevision: nextSyncRevision, activeWorldId,
      state: await readRevisionState(client, accountId, nextSyncRevision),
    };
  };

  return {
    kind: 'postgres-account-sync',
    forAccount(context) {
      const accountId = trustedAccountId(context);
      return {
        accountId,

        async getLatest() {
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            return readLatestState(pool, accountId);
          });
        },

        async listProfileRevisions({ limit = DEFAULT_HISTORY_LIMIT, beforeRevision = null } = {}) {
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const result = await pool.query(`SELECT * FROM account_profile_revisions
              WHERE account_id=$1 AND ($2::bigint IS NULL OR revision < $2)
              ORDER BY revision DESC LIMIT $3`, [accountId, beforeRevision, positiveLimit(limit)]);
            return result.rows.map(profileView);
          });
        },

        async listWorlds() {
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const result = await pool.query(`SELECT account_id,world_id,status,created_at,updated_at,archived_at,archive_reason
              FROM account_worlds WHERE account_id=$1 ORDER BY created_at,world_id`, [accountId]);
            return result.rows.map((row) => ({
              worldId: row.world_id,
              status: row.status,
              createdAt: iso(row.created_at),
              updatedAt: iso(row.updated_at),
              archivedAt: iso(row.archived_at),
              archiveReason: row.archive_reason ?? null,
            }));
          });
        },

        async listWorldRevisions(worldId, { limit = DEFAULT_HISTORY_LIMIT, beforeRevision = null } = {}) {
          if (typeof worldId !== 'string' || !worldId) {
            throw new AccountSyncRepositoryError(400, 'sync_world_id_invalid', 'A World ID is required.');
          }
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const result = await pool.query(`SELECT revision.*,world.status,world.archived_at,world.archive_reason
              FROM account_world_revisions revision
              JOIN account_worlds world ON world.account_id=revision.account_id AND world.world_id=revision.world_id
              WHERE revision.account_id=$1 AND revision.world_id=$2
                AND ($3::bigint IS NULL OR revision.revision < $3)
              ORDER BY revision.revision DESC LIMIT $4`, [accountId, worldId, beforeRevision, positiveLimit(limit)]);
            return result.rows.map(worldView);
          });
        },

        async listConflicts({ limit = DEFAULT_HISTORY_LIMIT, status = null } = {}) {
          if (status !== null && !['open', 'resolved', 'discarded'].includes(status)) {
            throw new AccountSyncRepositoryError(400, 'sync_conflict_status_invalid', 'Invalid conflict status.');
          }
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const result = await pool.query(`SELECT * FROM account_sync_conflicts
              WHERE account_id=$1 AND ($2::text IS NULL OR status=$2)
              ORDER BY detected_at DESC LIMIT $3`, [accountId, status, positiveLimit(limit)]);
            return result.rows.map((row) => conflictView(row));
          });
        },

        async getConflict(conflictId) {
          if (typeof conflictId !== 'string' || !UUID_PATTERN.test(conflictId)) {
            throw new AccountSyncRepositoryError(400, 'sync_conflict_id_invalid', 'A valid conflict ID is required.');
          }
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const row = (await pool.query('SELECT * FROM account_sync_conflicts WHERE id=$1 AND account_id=$2', [conflictId, accountId])).rows[0];
            if (!row) throw new AccountSyncRepositoryError(404, 'sync_conflict_not_found', 'The sync conflict was not found.');
            return conflictView(row, await readRevisionState(pool, accountId, Number(row.server_sync_revision)));
          });
        },

        async getHistory(syncRevision) {
          if (!Number.isSafeInteger(syncRevision) || syncRevision <= 0) {
            throw new AccountSyncRepositoryError(400, 'sync_revision_invalid', 'A positive sync revision is required.');
          }
          return safely(async () => {
            await assertRegisteredAccount(pool, accountId);
            const state = await readRevisionState(pool, accountId, syncRevision);
            if (!state || !state.profile) {
              throw new AccountSyncRepositoryError(404, 'sync_history_not_found', 'The sync revision was not found.');
            }
            return state;
          });
        },

        async resolveConflict(conflictId, resolution) {
          if (typeof conflictId !== 'string' || !UUID_PATTERN.test(conflictId)) {
            throw new AccountSyncRepositoryError(400, 'sync_conflict_id_invalid', 'A valid conflict ID is required.');
          }
          const action = resolution?.action;
          if (!['discard', 'commit'].includes(action)) {
            throw new AccountSyncRepositoryError(400, 'sync_resolution_action_invalid', 'Conflict resolution must discard or commit a candidate.');
          }
          const note = typeof resolution?.note === 'string'
            ? resolution.note.trim().slice(0, MAX_RESOLUTION_NOTE_LENGTH) || null
            : null;
          const prepared = action === 'commit' ? await prepareBundle(resolution?.bundle, accountId) : null;

          return transact(async (client) => {
            await assertRegisteredAccount(client, accountId, true);
            const conflict = (await client.query(
              'SELECT * FROM account_sync_conflicts WHERE id=$1 AND account_id=$2 FOR UPDATE',
              [conflictId, accountId],
            )).rows[0];
            if (!conflict) throw new AccountSyncRepositoryError(404, 'sync_conflict_not_found', 'The sync conflict was not found.');
            if (conflict.status !== 'open') {
              return { status: conflict.status, idempotent: true, conflict: conflictView(conflict) };
            }
            if (action === 'discard') {
              const updated = (await client.query(`UPDATE account_sync_conflicts SET
                status='discarded',resolved_at=now(),resolution_note=$3
                WHERE id=$1 AND account_id=$2 RETURNING *`, [conflictId, accountId, note])).rows[0];
              return { status: 'discarded', idempotent: false, conflict: conflictView(updated) };
            }

            const result = await commitValidated(client, accountId, prepared.bundle, prepared.profileHash, prepared.worldHash);
            if (result.status !== 'committed' || result.idempotent) {
              throw new AccountSyncRepositoryError(409, 'sync_resolution_commit_conflict', 'The resolution Bundle no longer matches the current server revision.');
            }
            const updated = (await client.query(`UPDATE account_sync_conflicts SET
              status='resolved',resolved_at=now(),resolved_by_operation_id=$3,resolution_note=$4
              WHERE id=$1 AND account_id=$2 RETURNING *`,
            [conflictId, accountId, prepared.bundle.operationId, note])).rows[0];
            return { status: 'resolved', idempotent: false, commit: result, conflict: conflictView(updated) };
          });
        },

        async commit(candidateBundle) {
          const validation = await validateAccountSyncBundle(candidateBundle, accountId);
          if (validation.status !== 'ready') {
            throw new AccountSyncRepositoryError(400, validation.code, validation.reason);
          }
          const bundle = validation.value;
          const profileHash = await sha256ContentHash(bundle.profile.snapshot);
          const worldHash = bundle.world ? await sha256ContentHash(bundle.world.snapshot) : null;

          return transact(async (client) => {
            await assertRegisteredAccount(client, accountId, true);

            const priorOperation = (await client.query('SELECT * FROM account_sync_operations WHERE operation_id=$1 FOR UPDATE', [bundle.operationId])).rows[0];
            if (priorOperation) {
              if (priorOperation.account_id !== accountId || priorOperation.request_hash !== bundle.contentHash) {
                throw new AccountSyncRepositoryError(409, 'sync_operation_payload_mismatch', 'The operationId was already used for different sync content.');
              }
              if (priorOperation.status === 'committed') {
                return {
                  status: 'committed',
                  httpStatus: 200,
                  idempotent: true,
                  operationId: bundle.operationId,
                  syncRevision: Number(priorOperation.resulting_sync_revision),
                  activeWorldId: bundle.activeWorldId,
                  state: await readRevisionState(client, accountId, Number(priorOperation.resulting_sync_revision)),
                };
              }
              if (priorOperation.status === 'conflict') {
                const conflict = (await client.query('SELECT * FROM account_sync_conflicts WHERE operation_id=$1 AND account_id=$2', [bundle.operationId, accountId])).rows[0];
                return {
                  status: 'conflict',
                  httpStatus: 409,
                  idempotent: true,
                  operationId: bundle.operationId,
                  conflict: conflictView(conflict, await readRevisionState(client, accountId, Number(conflict.server_sync_revision))),
                };
              }
              if (priorOperation.status === 'rejected') {
                return {
                  status: 'rejected',
                  httpStatus: 409,
                  idempotent: true,
                  operationId: bundle.operationId,
                  code: priorOperation.error_code,
                };
              }
              throw new AccountSyncRepositoryError(409, 'sync_operation_not_reusable', 'The operationId cannot be reused.');
            }

            await client.query(`INSERT INTO account_sync_heads(account_id,sync_revision)
              VALUES($1,0) ON CONFLICT(account_id) DO NOTHING`, [accountId]);
            const head = (await client.query('SELECT * FROM account_sync_heads WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
            const serverSyncRevision = Number(head.sync_revision);

            if (bundle.syncRevision > serverSyncRevision) {
              await client.query(`INSERT INTO account_sync_operations(
                operation_id,account_id,device_id,base_sync_revision,request_hash,status,completed_at,error_code
              ) VALUES($1,$2,$3,$4,$5,'rejected',now(),'base_revision_ahead')`,
              [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);
              return {
                status: 'rejected',
                httpStatus: 409,
                idempotent: false,
                operationId: bundle.operationId,
                code: 'sync_base_revision_ahead',
              };
            }

            if (bundle.syncRevision < serverSyncRevision) {
              const conflictId = randomUUID();
              await client.query(`INSERT INTO account_sync_operations(
                operation_id,account_id,device_id,base_sync_revision,request_hash,status,completed_at,error_code
              ) VALUES($1,$2,$3,$4,$5,'conflict',now(),'revision_conflict')`,
              [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);
              await client.query(`INSERT INTO account_sync_conflicts(
                id,account_id,operation_id,base_sync_revision,server_sync_revision,candidate_bundle,candidate_hash,status
              ) VALUES($1,$2,$3,$4,$5,$6,$7,'open')`,
              [conflictId, accountId, bundle.operationId, bundle.syncRevision, serverSyncRevision, jsonParameter(bundle), bundle.contentHash]);
              return {
                status: 'conflict',
                httpStatus: 409,
                idempotent: false,
                operationId: bundle.operationId,
                conflict: conflictView((await client.query('SELECT * FROM account_sync_conflicts WHERE id=$1', [conflictId])).rows[0],
                  await readRevisionState(client, accountId, serverSyncRevision)),
              };
            }

            const nextSyncRevision = serverSyncRevision + 1;
            await client.query(`INSERT INTO account_sync_operations(
              operation_id,account_id,device_id,base_sync_revision,request_hash,status
            ) VALUES($1,$2,$3,$4,$5,'pending')`,
            [bundle.operationId, accountId, bundle.deviceId, bundle.syncRevision, bundle.contentHash]);

            const nextProfileRevision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS revision
              FROM account_profile_revisions WHERE account_id=$1`, [accountId])).rows[0].revision);
            await client.query(`INSERT INTO account_profile_revisions(
              account_id,revision,sync_revision,schema_version,snapshot,content_hash,operation_id,device_id
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
              accountId, nextProfileRevision, nextSyncRevision, bundle.profile.snapshot.version,
              jsonParameter(bundle.profile.snapshot), profileHash, bundle.operationId, bundle.deviceId,
            ]);

            await client.query(`UPDATE account_worlds SET status='archived',archived_at=now(),
              archive_reason='superseded_by_sync_commit',updated_at=now()
              WHERE account_id=$1 AND status='active' AND ($2::text IS NULL OR world_id<>$2)`,
            [accountId, bundle.world?.status === 'active' ? bundle.world.worldId : null]);

            let nextWorldRevision = null;
            if (bundle.world) {
              const archivedAt = bundle.world.status === 'archived' ? bundle.world.archive?.archivedAt : null;
              const archiveReason = bundle.world.status === 'archived' ? bundle.world.archive?.reason : null;
              await client.query(`INSERT INTO account_worlds(
                  account_id,world_id,status,created_by_operation_id,archived_at,archive_reason
                ) VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT(account_id,world_id) DO UPDATE SET
                  status=EXCLUDED.status,updated_at=now(),archived_at=EXCLUDED.archived_at,archive_reason=EXCLUDED.archive_reason`,
              [accountId, bundle.world.worldId, bundle.world.status, bundle.operationId, archivedAt, archiveReason]);
              nextWorldRevision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS revision
                FROM account_world_revisions WHERE account_id=$1 AND world_id=$2`, [accountId, bundle.world.worldId])).rows[0].revision);
              await client.query(`INSERT INTO account_world_revisions(
                account_id,world_id,revision,sync_revision,source_world_revision,schema_version,layout_version,
                snapshot,content_hash,operation_id,device_id
              ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
                accountId, bundle.world.worldId, nextWorldRevision, nextSyncRevision, bundle.world.snapshot.worldRevision,
                bundle.world.schemaVersion, bundle.world.layoutVersion, jsonParameter(bundle.world.snapshot), worldHash,
                bundle.operationId, bundle.deviceId,
              ]);
            }

            const activeWorldId = bundle.world?.status === 'active' ? bundle.world.worldId : null;
            await client.query(`UPDATE account_sync_heads SET
              sync_revision=$2,profile_revision=$3,active_world_id=$4,profile_hash=$5,world_hash=$6,updated_at=now()
              WHERE account_id=$1`, [accountId, nextSyncRevision, nextProfileRevision, activeWorldId, profileHash, activeWorldId ? worldHash : null]);
            await client.query(`UPDATE account_sync_operations SET
              resulting_sync_revision=$2,status='committed',completed_at=now(),error_code=NULL
              WHERE operation_id=$1 AND account_id=$3`, [bundle.operationId, nextSyncRevision, accountId]);

            return {
              status: 'committed',
              httpStatus: 201,
              idempotent: false,
              operationId: bundle.operationId,
              syncRevision: nextSyncRevision,
              activeWorldId,
              state: await readRevisionState(client, accountId, nextSyncRevision),
            };
          });
        },
      };
    },
  };
}
