import { useEffect, useMemo, useState } from 'react';
import { ACTIVE_PRODUCT_LOCALE, t } from './i18n.ts';
import type { PossibilityNode, PossibilityNodeState } from './livingFlow.ts';
import type { OwnReviewRecord } from './reviewLabContract.ts';
import { buildVoyageLogEntries, voyageLogModerationLabel, voyageLogOwnerName } from './voyageLog.ts';

type ApiError = { error?: { message?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const payload = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(payload.error?.message ?? `Voyage log request failed (${response.status}).`);
  return payload;
}

const writtenAt = (review: OwnReviewRecord) => {
  const timestamp = review.updatedAt || review.createdAt;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(ACTIVE_PRODUCT_LOCALE === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
};

export function VoyageLogList({
  nodes,
  nodeStates,
  nickname,
  onOpenNode,
  refreshRevision = 0,
  offline = false,
}: {
  nodes: readonly PossibilityNode[];
  nodeStates: Readonly<Record<string, PossibilityNodeState>>;
  nickname?: string;
  onOpenNode: (nodeId: string) => void;
  refreshRevision?: number;
  offline?: boolean;
}) {
  const [ownReviews, setOwnReviews] = useState<OwnReviewRecord[]>([]);
  const [loading, setLoading] = useState(!offline);
  const [error, setError] = useState('');
  const entries = useMemo(() => buildVoyageLogEntries(nodes, nodeStates, ownReviews), [nodes, nodeStates, ownReviews]);
  const ownerName = voyageLogOwnerName(nickname);

  useEffect(() => {
    if (offline) { setLoading(false); setError(''); return; }
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        await api('/api/reviews/session', { method: 'POST', body: '{}' });
        const result = await api<{ reviews: OwnReviewRecord[] }>('/api/reviews/me/reviews');
        if (active) setOwnReviews(result.reviews);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : t('list.voyageLogLoadError'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [offline, refreshRevision]);

  if (entries.length === 0) return <div className="living-list-empty voyage-log-empty">
    <p>{t('list.emptyVoyageLog')}</p>
  </div>;

  return <div className="voyage-log-book" data-voyage-log-count={entries.length} data-voyage-log-written-count={entries.filter((entry) => entry.reviews.length > 0).length}>
    {offline && <p className="voyage-log-service-note">{t('review.offline')}</p>}
    {loading && <p className="voyage-log-service-note" role="status">{t('list.voyageLogLoading')}</p>}
    {error && <p className="voyage-log-service-note voyage-log-service-error" role="alert">{t('list.voyageLogLoadError')}</p>}
    {entries.map(({ node, reviews }, pageIndex) => <article className="voyage-log-page" key={node.id} data-node-id={node.id} data-voyage-log-written={reviews.length > 0 ? '1' : '0'}>
      <div className="voyage-log-page-number">{String(pageIndex + 1).padStart(2, '0')}</div>
      <div className="voyage-log-page-heading">
        <div><span>VOYAGE LOG</span><h2>{node.title}</h2></div>
        <span className="voyage-log-landed-mark">⚑ {t('map.landed')}</span>
      </div>
      {reviews.length === 0 ? <div className="voyage-log-unwritten">
        <strong>{t('list.voyageLogUnwritten')}</strong>
        <p>{t('list.voyageLogUnwrittenHint')}</p>
        <button type="button" onClick={() => onOpenNode(node.id)}>{t('list.voyageLogWrite')}</button>
      </div> : <div className="voyage-log-entries">
        {reviews.map((review) => <section key={review.id} data-review-id={review.id} data-review-status={review.moderationStatus}>
          <div className="voyage-log-entry-meta"><strong>{voyageLogModerationLabel(review.moderationStatus)}</strong><time dateTime={review.updatedAt}>{t('list.voyageLogWrittenAt', { date: writtenAt(review) })}</time></div>
          <p>{review.body}</p>
        </section>)}
        <button type="button" onClick={() => onOpenNode(node.id)}>{t('list.voyageLogOpenEdit')}</button>
      </div>}
      <footer>{nickname?.trim() ? t('list.voyageLogPageOwner', { name: ownerName }) : t('list.voyageLogPageFallback')}</footer>
    </article>)}
  </div>;
}
