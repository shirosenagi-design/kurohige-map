import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountSyncRecoveryCoordinator, type SyncComparison } from './accountSyncRecovery';
import type { ClientSyncStatus } from './accountSyncRuntime';
import { useProductState } from './ProductStateProvider';
import { t, type MessageKey } from './i18n';
import type { WorldRepository } from './worldRepository';

type PendingDecision =
  | { kind: 'local' }
  | { kind: 'server' }
  | { kind: 'conflict-server'; conflictId: string }
  | { kind: 'conflict-candidate'; conflictId: string }
  | null;

export function AccountSyncPanel({ worldRepository }: { worldRepository: WorldRepository }) {
  const { repository } = useProductState();
  const coordinatorRef = useRef<AccountSyncRecoveryCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new AccountSyncRecoveryCoordinator({ productRepository: repository, worldRepository });
  const coordinator = coordinatorRef.current;
  const [comparison, setComparison] = useState<SyncComparison | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<ClientSyncStatus | null>(null);
  const [pending, setPending] = useState<PendingDecision>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const next = await coordinator.inspect();
      setComparison(next);
      if (next.accountId && next.hasStoredAuthorization) {
        await coordinator.resumeCurrentAccount(next.accountId);
        setRuntimeStatus(await coordinator.getRuntimeStatus());
      } else if (!next.accountId && next.hasStoredAuthorization) {
        setRuntimeStatus((current) => ({
          phase: 'reauthentication_required', accountId: current?.accountId ?? null,
          acknowledgedSyncRevision: current?.acknowledgedSyncRevision ?? 0,
          pendingCount: current?.pendingCount ?? 0, sendingCount: 0,
          acknowledgedCount: current?.acknowledgedCount ?? 0,
          conflictCount: current?.conflictCount ?? 0, blockedCount: current?.blockedCount ?? 1,
          lastErrorCode: 'authentication_required',
        }));
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('sync.error')); }
  }, [coordinator]);

  useEffect(() => {
    void refresh();
    const unsubscribe = coordinator.subscribe(setRuntimeStatus);
    const authChanged = () => { setPending(null); void refresh(); };
    window.addEventListener('kurohige-auth-changed', authChanged);
    return () => { unsubscribe(); coordinator.stop(); window.removeEventListener('kurohige-auth-changed', authChanged); };
  }, [coordinator, refresh]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); setPending(null); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('sync.error')); }
    finally { setBusy(false); }
  };

  const confirm = () => run(async () => {
    if (!pending) return;
    if (pending.kind === 'local') {
      const status = await coordinator.chooseLocalWorld();
      setRuntimeStatus(status); setNotice(t('sync.localQueued'));
      return;
    }
    if (pending.kind === 'server') {
      await coordinator.chooseServerBundle();
      setNotice(t('sync.serverApplied'));
      window.location.reload();
      return;
    }
    await coordinator.resolveConflict(pending.conflictId, pending.kind === 'conflict-server' ? 'server' : 'candidate');
    setNotice(t('sync.conflictResolved'));
    window.location.reload();
  });

  const phaseLabel = runtimeStatus ? t(`sync.phase.${runtimeStatus.phase}` as MessageKey) : '';
  const localCount = comparison?.localWorld.status === 'ready' ? comparison.localWorld.snapshot.nodes.length : 0;
  const serverCount = comparison?.server?.world?.snapshot.nodes.length ?? 0;

  return <section className="account-sync-panel" aria-labelledby="account-sync-title">
    <header><p>{t('sync.eyebrow')}</p><h2 id="account-sync-title">{t('sync.title')}</h2><span>{t('sync.intro')}</span></header>
    {!comparison && !error && <p>{t('sync.loading')}</p>}
    {comparison && <>
      <div className={`sync-state sync-${comparison.kind}`}>
        <strong>{t(`sync.state.${comparison.kind}` as MessageKey)}</strong>
        {phaseLabel && <span>{phaseLabel}</span>}
      </div>
      {comparison.accountId && <div className="sync-comparison">
        <article><small>{t('sync.thisDevice')}</small><strong>{comparison.localWorld.status === 'ready' ? comparison.localWorld.snapshot.worldId : t(`sync.world.${comparison.localWorld.status}` as MessageKey)}</strong><span>{t('sync.nodeCount', { count: localCount })}</span></article>
        <article><small>{t('sync.server')}</small><strong>{comparison.server?.activeWorldId ?? t('sync.world.missing')}</strong><span>{t('sync.nodeCount', { count: serverCount })}</span></article>
      </div>}
      {comparison.kind === 'local_only' && <button type="button" disabled={busy} onClick={() => setPending({ kind: 'local' })}>{t('sync.claimLocal')}</button>}
      {comparison.kind === 'server_only' && <button type="button" disabled={busy} onClick={() => setPending({ kind: 'server' })}>{t('sync.restoreServer')}</button>}
      {comparison.kind === 'choice_required' && <div className="sync-actions">
        <button type="button" disabled={busy} onClick={() => setPending({ kind: 'local' })}>{t('sync.chooseLocal')}</button>
        <button type="button" disabled={busy} onClick={() => setPending({ kind: 'server' })}>{t('sync.chooseServer')}</button>
      </div>}
      {comparison.kind === 'repair_required' && comparison.openJournal && <div className="sync-repair">
        <p>{t('sync.repairDescription')}</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await coordinator.repairLocalApply('resume'); setNotice(t('sync.repairResumed')); window.location.reload(); })}>{t('sync.resumeRepair')}</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await coordinator.repairLocalApply('rollback'); setNotice(t('sync.repairRolledBack')); window.location.reload(); })}>{t('sync.rollbackRepair')}</button>
      </div>}
      {comparison.conflicts.length > 0 && <div className="sync-conflicts"><h3>{t('sync.conflicts')}</h3>{comparison.conflicts.map((conflict) => <article key={conflict.id}>
        <div><strong>{t('sync.conflictTitle')}</strong><small>{new Date(conflict.detectedAt).toLocaleString()}</small></div>
        <button type="button" disabled={busy} onClick={() => setPending({ kind: 'conflict-server', conflictId: conflict.id })}>{t('sync.keepServer')}</button>
        <button type="button" disabled={busy} onClick={() => setPending({ kind: 'conflict-candidate', conflictId: conflict.id })}>{t('sync.keepCandidate')}</button>
      </article>)}</div>}
      {pending && <div className="sync-confirm" role="alertdialog" aria-label={t('sync.confirmTitle')}>
        <p>{t('sync.confirmDescription')}</p>
        <button type="button" disabled={busy} onClick={() => setPending(null)}>{t('sync.cancel')}</button>
        <button type="button" disabled={busy} onClick={() => void confirm()}>{t('sync.confirm')}</button>
      </div>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>{t('sync.refresh')}</button>
    </>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
  </section>;
}
