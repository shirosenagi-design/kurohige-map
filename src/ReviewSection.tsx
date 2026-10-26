import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.ts';
import type { UserProfileState } from './productState.ts';
import type { OwnReviewRecord, PublicReviewRecord, ReviewSubject } from './reviewLabContract.ts';

type Props = {
  nodeId: string;
  nodeTitle: string;
  nodeDescription: string;
  nodeCategory: string;
  nodeKind: string;
  portableResourceTags: string[];
  connectionTags: string[];
  helpedByTags: string[];
  profile: UserProfileState;
  localLanded: boolean;
  eligibilityRevision?: number;
  onOwnReviewsChanged?: () => void;
  offline?: boolean;
};

type NodeReviewContext = {
  nodeId: string;
  subject: ReviewSubject | null;
  eligibility: {
    canPost: boolean;
    landedAt: string | null;
    frozen: boolean;
    reason: 'eligible' | 'landing_required' | 'subject_not_verified' | 'review_access_frozen';
  };
};
type ApiError = { error?: { code?: string; message?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers });
  const payload = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(payload.error?.message ?? `Review request failed (${response.status}).`);
  return payload;
}

function ageFromBirthDate(value?: string) {
  if (!value) return null;
  const birth = new Date(`${value}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date(); let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

const moderationLabel: Record<OwnReviewRecord['moderationStatus'], string> = {
  pending_moderation: t('review.status.pending'), approved: t('review.status.approved'), rejected: t('review.status.rejected'), needs_human_review: t('review.status.humanReview'),
};

export function ReviewSection({ nodeId, nodeTitle, nodeDescription, nodeCategory, nodeKind, portableResourceTags, connectionTags, helpedByTags, profile, localLanded, eligibilityRevision = 0, onOwnReviewsChanged, offline = false }: Props) {
  const [context, setContext] = useState<NodeReviewContext | null>(null);
  const [publicReviews, setPublicReviews] = useState<PublicReviewRecord[]>([]);
  const [ownReviews, setOwnReviews] = useState<OwnReviewRecord[]>([]);
  const [body, setBody] = useState(''); const [editingId, setEditingId] = useState<string | null>(null);
  const [shareAge, setShareAge] = useState(false); const [shareOccupation, setShareOccupation] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!offline);
  const requestGeneration = useRef(0);
  const visibleContext = context?.nodeId === nodeId ? context : null;
  const subjectId = visibleContext?.subject?.id ?? '';
  const age = useMemo(() => ageFromBirthDate(profile.birthDate), [profile.birthDate]);

  const refreshContext = useCallback(async (prepareSubject = false) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true); setError('');
    try {
      if (prepareSubject) {
        await api('/api/reviews/session', { method: 'POST', body: '{}' });
        await api(`/api/reviews/nodes/${encodeURIComponent(nodeId)}/subject`, {
          method: 'POST',
          body: JSON.stringify({ name: nodeTitle, summary: nodeDescription, category: nodeCategory, nodeKind, portableResourceTags, connectionTags, helpedByTags }),
        });
      }
      const next = await api<NodeReviewContext>(`/api/reviews/nodes/${encodeURIComponent(nodeId)}/context`);
      const nextSubjectId = next.subject?.id ?? '';
      const [published, own] = nextSubjectId ? await Promise.all([
        api<{ reviews: PublicReviewRecord[] }>(`/api/reviews/subjects/${encodeURIComponent(nextSubjectId)}/reviews`),
        api<{ reviews: OwnReviewRecord[] }>('/api/reviews/me/reviews'),
      ]) : [{ reviews: [] as PublicReviewRecord[] }, { reviews: [] as OwnReviewRecord[] }];
      if (requestGeneration.current !== generation) return;
      setContext(next);
      setPublicReviews(published.reviews);
      setOwnReviews(own.reviews.filter((review) => review.subjectId === nextSubjectId && review.sourceNodeId === nodeId));
    } catch (cause) {
      if (requestGeneration.current === generation) setError(cause instanceof Error ? cause.message : 'レビューを読み込めませんでした。');
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [nodeId, nodeTitle, nodeDescription, nodeCategory, nodeKind, portableResourceTags, connectionTags, helpedByTags]);

  useEffect(() => {
    if (offline) return;
    setContext(null); setPublicReviews([]); setOwnReviews([]); setEditingId(null); setReportingId(null);
    void refreshContext(true);
    return () => { requestGeneration.current += 1; };
  }, [offline, refreshContext, eligibilityRevision]);

  const saveReview = async () => {
    if (!subjectId || body.trim().length < 20 || (!visibleContext?.eligibility.canPost && !editingId)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = editingId ? { body } : { subjectId, sourceNodeId: nodeId, body, authorSnapshot: { age, occupation: profile.occupation ?? null, shareAge, shareOccupation } };
      await api(editingId ? `/api/reviews/reviews/${encodeURIComponent(editingId)}` : '/api/reviews/reviews', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setNotice(editingId ? '航海日誌の編集内容を保存し、再審査へ送りました。' : '航海日誌を保存し、公開前の審査へ送りました。');
      setBody(''); setEditingId(null); await refreshContext();
      onOwnReviewsChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'レビューを保存できませんでした。'); }
    finally { setBusy(false); }
  };
  const toggleHelpful = async (review: PublicReviewRecord) => {
    setError('');
    try { await api(`/api/reviews/reviews/${encodeURIComponent(review.id)}/helpful`, { method: review.viewerHasHelpful ? 'DELETE' : 'POST', body: '{}' }); await refreshContext(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '「役に立った」を更新できませんでした。'); }
  };
  const report = async (reviewId: string) => {
    setError('');
    try { await api(`/api/reviews/reviews/${encodeURIComponent(reviewId)}/reports`, { method: 'POST', body: JSON.stringify({ reason: 'other', details: '内容を管理者に確認してほしい' }) }); setReportingId(null); setNotice('通報を受け付けました。通報だけで違反確定にはなりません。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '通報を送信できませんでした。'); }
  };

  if (offline) return <section className="island-review-section" aria-label={t('review.publicTitle')}><h2>{t('review.publicTitle')}</h2><p className="island-review-muted">{t('review.offline')}</p></section>;

  return <section className="island-review-section" aria-label={t('review.publicTitle')} data-review-subject-id={subjectId} data-review-can-post={visibleContext?.eligibility.canPost ? '1' : '0'} data-review-loading={loading ? '1' : '0'} data-local-landed={localLanded ? '1' : '0'}>
    <header><div><p>VOYAGE LOGS</p><h2>{t('review.publicTitle')}</h2></div>{visibleContext?.subject && <span>{visibleContext.subject.name}</span>}</header>
    {loading && !visibleContext && <p className="island-review-muted" role="status">{t('list.voyageLogLoading')}</p>}
    {!loading && visibleContext && !visibleContext.subject && <p className="island-review-muted">この島の行動・体験に結びつく航海日誌を準備できませんでした。</p>}
    {visibleContext?.subject && <>
      <div className="island-review-public-list">{publicReviews.length === 0 ? <p className="island-review-muted">{t('review.publicEmpty')}</p> : publicReviews.map((review) => <article key={review.id}><p>{review.body}</p><small>{[review.authorSnapshot.age === null ? '' : `${review.authorSnapshot.age}歳`, review.authorSnapshot.occupation ?? ''].filter(Boolean).join(' · ') || '公開プロフィールなし'}</small><div><button type="button" aria-pressed={review.viewerHasHelpful} onClick={() => void toggleHelpful(review)}>役に立った {review.helpfulCount}</button><button type="button" onClick={() => setReportingId(reportingId === review.id ? null : review.id)}>通報</button></div>{reportingId === review.id && <div className="island-review-report"><p>管理者が内容を確認します。通報だけで違反確定にはなりません。</p><button type="button" onClick={() => void report(review.id)}>管理者へ送る</button></div>}</article>)}</div>

      {!visibleContext.eligibility.canPost && <div className="island-review-locked"><strong>{visibleContext.eligibility.frozen ? '航海日誌機能は現在利用できません' : '上陸すると航海日誌を記入できます'}</strong><p>{localLanded && !visibleContext.eligibility.frozen ? 'この端末の上陸履歴はありますが、サーバー側の正規履歴をまだ確認できません。' : 'Keep・のぞく・航海中だけでは記入資格にはなりません。公開済みの航海日誌はそのまま読めます。'}</p><button type="button" disabled={busy} onClick={() => void refreshContext()}>資格を再確認</button></div>}

      {(visibleContext.eligibility.canPost || editingId) && <div className="island-review-editor"><h3>{editingId ? t('review.edit') : t('review.write')}</h3><p>{nodeTitle}へ実際に上陸して体験したこと、想像との違い、得たもの・つまずいたこと、次の人へ伝えたいことを書いてください。</p><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} rows={6} placeholder="星評価ではなく、実際に踏み込んだ体験を自分の言葉で…" />{!editingId && <div className="island-review-privacy"><label><input type="checkbox" checked={shareAge} onChange={(event) => setShareAge(event.target.checked)} disabled={age === null} /> 投稿時の年齢を公開</label><label><input type="checkbox" checked={shareOccupation} onChange={(event) => setShareOccupation(event.target.checked)} disabled={!profile.occupation} /> 投稿時の職業を公開</label></div>}<div><span>{body.length} / 4000</span>{editingId && <button type="button" onClick={() => { setEditingId(null); setBody(''); }}>編集をやめる</button>}<button type="button" disabled={busy || body.trim().length < 20} onClick={() => void saveReview()}>{busy ? '保存中…' : editingId ? '編集して再審査へ' : '審査待ちとして投稿'}</button></div></div>}

      {ownReviews.length > 0 && <div className="island-review-own"><h3>{t('review.ownTitle')}</h3>{ownReviews.map((review) => <article key={review.id}><div><strong>{moderationLabel[review.moderationStatus]}</strong><small>revision {review.revision}</small></div><p>{review.body}</p><button type="button" onClick={() => { setEditingId(review.id); setBody(review.body); }}>{t('review.edit')}</button></article>)}</div>}
    </>}
    {error && <p className="island-review-error" role="alert">{error}</p>}{notice && <p className="island-review-notice" role="status">{notice}</p>}
  </section>;
}
