import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OwnReviewRecord, PublicReviewRecord, ReviewSubject, ReviewViewer } from './reviewLabContract';
import './reviewLab.css';

type LabActor = 'reviewer-a' | 'reviewer-b' | 'review-admin';
type AdminReview = OwnReviewRecord & { authorId: string; hiddenAt?: string | null };
type AdminReport = { id: string; reviewId: string; reporterId: string; reason: string; details: string; status: string; createdAt: string };
type AdminQueue = { reviews: AdminReview[]; reports: AdminReport[] };
type FormState = { subjectId: string; sourceNodeId: string; age: string; occupation: string; shareAge: boolean; shareOccupation: boolean; body: string };

const actorRole = (actor: LabActor) => actor === 'review-admin' ? 'admin' : 'user';
const emptyForm = (subjectId = ''): FormState => ({ subjectId, sourceNodeId: 'review-lab-node', age: '', occupation: '', shareAge: false, shareOccupation: false, body: '' });

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `Review request failed (${response.status}).`);
  return payload;
}

const kindLabel = (kind: ReviewSubject['kind']) => ({ action_experience: '行動・体験', place: '旧仕様：場所', book: '旧仕様：書籍', event: '旧仕様：イベント', community: '旧仕様：コミュニティ', opportunity: '具体的な機会' })[kind];
const statusLabel: Record<OwnReviewRecord['moderationStatus'], string> = {
  pending_moderation: 'AI審査待ち', approved: '公開済み', rejected: '非公開', needs_human_review: '管理者確認待ち',
};

export function ReviewLab() {
  const [actor, setActor] = useState<LabActor>('reviewer-a');
  const [viewer, setViewer] = useState<ReviewViewer | null>(null);
  const [subjects, setSubjects] = useState<ReviewSubject[]>([]);
  const [form, setForm] = useState<FormState>(() => emptyForm(new URLSearchParams(window.location.search).get('subjectId') ?? ''));
  const [ownReviews, setOwnReviews] = useState<OwnReviewRecord[]>([]);
  const [publicReviews, setPublicReviews] = useState<PublicReviewRecord[]>([]);
  const [adminQueue, setAdminQueue] = useState<AdminQueue>({ reviews: [], reports: [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedSubject = useMemo(() => subjects.find((subject) => subject.id === form.subjectId) ?? null, [form.subjectId, subjects]);
  const refresh = useCallback(async (subjectId: string, role = viewer?.role) => {
    const [own, published] = await Promise.all([
      api<{ reviews: OwnReviewRecord[] }>('/api/reviews/me/reviews'),
      subjectId ? api<{ reviews: PublicReviewRecord[] }>(`/api/reviews/subjects/${encodeURIComponent(subjectId)}/reviews`) : Promise.resolve({ reviews: [] }),
    ]);
    setOwnReviews(own.reviews); setPublicReviews(published.reviews);
    if (role === 'admin') setAdminQueue(await api<AdminQueue>('/api/reviews/admin/queue'));
    else setAdminQueue({ reviews: [], reports: [] });
  }, [viewer?.role]);

  const assumeActor = useCallback(async (nextActor: LabActor, nextSubjectId = form.subjectId) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ viewer: ReviewViewer }>('/api/reviews/session/dev', { method: 'POST', body: JSON.stringify({ userId: nextActor, role: actorRole(nextActor) }) });
      setActor(nextActor); setViewer(result.viewer); await refresh(nextSubjectId, result.viewer.role);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '開発ユーザーを切り替えられませんでした。'); }
    finally { setBusy(false); }
  }, [form.subjectId, refresh]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await api<{ subjects: ReviewSubject[] }>('/api/reviews/subjects');
        if (!active) return;
        const requested = form.subjectId;
        const subjectId = result.subjects.some((subject) => subject.id === requested) ? requested : result.subjects[0]?.id ?? '';
        setSubjects(result.subjects); setForm((current) => ({ ...current, subjectId })); await assumeActor('reviewer-a', subjectId);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Review Labを読み込めませんでした。'); }
    })();
    return () => { active = false; };
    // Initial session setup only. Actor changes are explicit controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => setForm((current) => ({ ...current, [field]: value }));
  const reload = async () => { setBusy(true); setError(''); try { await refresh(form.subjectId); } catch (cause) { setError(cause instanceof Error ? cause.message : '再読み込みできませんでした。'); } finally { setBusy(false); } };
  const resetEditor = () => { setEditingId(null); setForm((current) => ({ ...emptyForm(current.subjectId), sourceNodeId: current.sourceNodeId })); };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = editingId ? { body: form.body } : { subjectId: form.subjectId, sourceNodeId: form.sourceNodeId || null, body: form.body, authorSnapshot: { age: form.age === '' ? null : Number(form.age), occupation: form.occupation || null, shareAge: form.shareAge, shareOccupation: form.shareOccupation } };
      await api(editingId ? `/api/reviews/reviews/${encodeURIComponent(editingId)}` : '/api/reviews/reviews', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setNotice(editingId ? '編集内容を保存し、再審査へ送りました。' : 'レビューを審査待ちとして保存しました。'); resetEditor(); await refresh(form.subjectId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存できませんでした。'); }
    finally { setBusy(false); }
  };
  const beginEdit = (review: OwnReviewRecord) => { setEditingId(review.id); setForm((current) => ({ ...current, subjectId: review.subjectId, sourceNodeId: review.sourceNodeId ?? '', body: review.body })); setNotice(''); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const helpful = async (review: PublicReviewRecord) => { try { await api(`/api/reviews/reviews/${review.id}/helpful`, { method: review.viewerHasHelpful ? 'DELETE' : 'POST', body: '{}' }); await refresh(form.subjectId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Helpfulを更新できませんでした。'); } };
  const report = async (reviewId: string) => { try { await api(`/api/reviews/reviews/${reviewId}/reports`, { method: 'POST', body: JSON.stringify({ reason: 'other', details: 'Review Labから管理者確認を依頼' }) }); setNotice('通報を受け付けました。違反確定ではなく管理者確認へ進みます。'); } catch (cause) { setError(cause instanceof Error ? cause.message : '通報できませんでした。'); } };
  const adminReviewAction = async (reviewId: string, action: 'approve' | 'reject' | 'needs_human_review' | 'hide') => { try { await api(`/api/reviews/admin/reviews/${reviewId}/actions`, { method: 'POST', body: JSON.stringify({ action, note: `Review Lab manual ${action}` }) }); await refresh(form.subjectId, 'admin'); } catch (cause) { setError(cause instanceof Error ? cause.message : '管理者操作に失敗しました。'); } };
  const resolveReport = async (reportId: string) => { try { await api(`/api/reviews/admin/reports/${reportId}/resolve`, { method: 'POST', body: JSON.stringify({ resolution: '確認済み。必要なレビュー操作を別途記録。' }) }); await refresh(form.subjectId, 'admin'); } catch (cause) { setError(cause instanceof Error ? cause.message : '通報を処理できませんでした。'); } };
  const freeze = async (userId: string) => { try { await api(`/api/reviews/admin/users/${encodeURIComponent(userId)}/freeze`, { method: 'POST', body: JSON.stringify({ frozen: true, reason: 'Review Lab repeat violation test' }) }); setNotice(`${userId}のレビュー機能を凍結しました。`); } catch (cause) { setError(cause instanceof Error ? cause.message : 'ユーザーを凍結できませんでした。'); } };
  const setupDevLanding = async () => {
    if (actor === 'review-admin' || !form.sourceNodeId || !form.subjectId) return;
    setBusy(true); setError(''); setNotice('');
    const stepIds = [1, 2, 3].map((index) => `${form.sourceNodeId}-review-lab-step-${index}`);
    try {
      await api('/api/reviews/session/dev', { method: 'POST', body: JSON.stringify({ userId: 'review-admin', role: 'admin' }) });
      await api('/api/reviews/admin/node-subjects', { method: 'POST', body: JSON.stringify({ userId: actor, nodeId: form.sourceNodeId, subjectId: form.subjectId }) });
      const session = await api<{ viewer: ReviewViewer }>('/api/reviews/session/dev', { method: 'POST', body: JSON.stringify({ userId: actor, role: 'user' }) });
      setViewer(session.viewer);
      await api(`/api/reviews/nodes/${encodeURIComponent(form.sourceNodeId)}/journey`, { method: 'POST', body: JSON.stringify({ requiredStepIds: stepIds }) });
      for (const stepId of stepIds) await api(`/api/reviews/nodes/${encodeURIComponent(form.sourceNodeId)}/journey/steps/${encodeURIComponent(stepId)}`, { method: 'POST', body: '{}' });
      await api(`/api/reviews/nodes/${encodeURIComponent(form.sourceNodeId)}/landing`, { method: 'POST', body: JSON.stringify({ ownerNodeId: form.sourceNodeId, ship: { x: 0, y: 0 }, ownerTarget: { x: 0, y: 0 } }) });
      setNotice('DEV専用の正規資格台帳をセットアップしました。Productではこの操作は表示されません。');
      await refresh(form.subjectId, 'user');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'DEV投稿資格を準備できませんでした。'); }
    finally { setBusy(false); }
  };

  return <main className="review-lab-shell" data-review-actor={actor} data-review-role={viewer?.role ?? ''} data-public-count={publicReviews.length} data-own-count={ownReviews.length}>
    <header className="review-lab-header"><div><p className="review-lab-kicker">KUROHIGE MAP · LOCAL DEVELOPMENT</p><h1>Review Lab</h1><p>体験レビューの認証、公開範囲、審査、Helpful、通報、管理者対応を本体と同じAPIで検証します。</p></div><span className="review-lab-dev-badge">DEV ONLY</span></header>
    <section className="review-lab-warning"><strong>Nebius API停止中</strong><span>AI審査は実行されません。投稿は審査待ちで保持し、管理者の明示操作だけをローカル検証します。</span></section>
    <nav className="review-lab-actors" aria-label="開発用ユーザー切り替え">{(['reviewer-a', 'reviewer-b', 'review-admin'] as LabActor[]).map((candidate) => <button key={candidate} type="button" className={actor === candidate ? 'active' : ''} disabled={busy} onClick={() => void assumeActor(candidate)}>{candidate === 'review-admin' ? '管理者' : candidate === 'reviewer-a' ? 'ユーザーA' : 'ユーザーB'}</button>)}<span>サーバー署名済みHttpOnly session · {viewer?.role ?? '接続中'}</span></nav>
    <div className="review-lab-grid">
      <section className="review-lab-panel" aria-labelledby="review-editor-title">
        <div className="review-lab-section-heading"><div><span>01</span><h2 id="review-editor-title">{editingId ? '自分の体験を編集' : '体験レビューを書く'}</h2></div>{editingId && <button type="button" className="review-lab-text-button" onClick={resetEditor}>編集をやめる</button>}</div>
        <label className="review-lab-field"><span>確認済みの共有行動・体験</span><select value={form.subjectId} disabled={Boolean(editingId)} onChange={(event) => { update('subjectId', event.target.value); void refresh(event.target.value); }}>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{kindLabel(subject.kind)}｜{subject.name}</option>)}</select>{selectedSubject && <small>subjectId: {selectedSubject.id} · {selectedSubject.referenceLabel}</small>}</label>
        <label className="review-lab-field"><span>体験本文</span><textarea value={form.body} onChange={(event) => update('body', event.target.value)} maxLength={4000} rows={8} placeholder="実際にしたこと、想像と違ったこと、得たもの・つまずいたこと、次の人へ伝えたいこと"/><small>{form.body.length} / 4000（20文字以上）</small></label>
        {!editingId && <details className="review-lab-dev-controls"><summary>投稿時点のスナップショットと個人Node接続</summary><div className="review-lab-inline-fields"><label className="review-lab-field"><span>年齢</span><input type="number" min="0" max="120" value={form.age} onChange={(event) => update('age', event.target.value)}/></label><label className="review-lab-field"><span>職業</span><input value={form.occupation} maxLength={160} onChange={(event) => update('occupation', event.target.value)}/></label></div><label className="review-lab-check"><input type="checkbox" checked={form.shareAge} onChange={(event) => update('shareAge', event.target.checked)}/>年齢の公開を許可</label><label className="review-lab-check"><input type="checkbox" checked={form.shareOccupation} onChange={(event) => update('shareOccupation', event.target.checked)}/>職業の公開を許可</label><label className="review-lab-field"><span>個人Node ID</span><input value={form.sourceNodeId} onChange={(event) => update('sourceNodeId', event.target.value)} maxLength={160}/><small>共有subjectIdとは別に保存されます。</small></label><button type="button" className="review-lab-secondary" disabled={busy || viewer?.role !== 'user'} onClick={() => void setupDevLanding()}>DEV投稿資格を準備</button></details>}
        {error && <p className="review-lab-error" role="alert">{error}</p>}{notice && <p className="review-lab-notice" role="status">{notice}</p>}<button type="button" className="review-lab-primary" disabled={busy || viewer?.role !== 'user' || !form.subjectId || form.body.trim().length < 20} onClick={() => void save()}>{busy ? '処理中…' : editingId ? '編集して再審査へ' : '審査待ちとして投稿'}</button>
      </section>
      <section className="review-lab-panel review-lab-library"><div className="review-lab-section-heading"><div><span>02</span><h2>公開・自分の投稿</h2></div><button type="button" className="review-lab-text-button" onClick={() => void reload()}>再読み込み</button></div>
        <h3>公開済み</h3>{publicReviews.length === 0 ? <div className="review-lab-empty"><strong>公開済みレビューはありません</strong><p>審査前の投稿や架空例は表示しません。</p></div> : publicReviews.map((review) => <article className="review-lab-card" key={review.id}><div className="review-lab-card-meta"><span>{review.authorSnapshot.age === null ? '' : `${review.authorSnapshot.age}歳`} {review.authorSnapshot.occupation ?? ''}</span><code>approved</code></div><p>{review.body}</p><div className="review-lab-card-actions"><button className="review-lab-secondary" type="button" onClick={() => void helpful(review)}>{review.viewerHasHelpful ? '役に立ったを取り消す' : '役に立った'} · {review.helpfulCount}</button><button className="review-lab-text-button" type="button" onClick={() => void report(review.id)}>通報</button></div></article>)}
        <h3 className="review-lab-subheading">自分の投稿</h3>{ownReviews.length === 0 ? <p className="review-lab-empty">このユーザーの投稿はありません。</p> : ownReviews.map((review) => <article className="review-lab-card" key={review.id}><div className="review-lab-card-meta"><span>{statusLabel[review.moderationStatus]}</span><code>revision {review.revision}</code></div><h3>{subjects.find((subject) => subject.id === review.subjectId)?.name ?? review.subjectId}</h3><p>{review.body}</p>{viewer?.role === 'user' && <button className="review-lab-secondary" type="button" onClick={() => beginEdit(review)}>本人として編集</button>}</article>)}
      </section>
    </div>
    {viewer?.role === 'admin' && <section className="review-lab-panel review-lab-admin"><div className="review-lab-section-heading"><div><span>03</span><h2>管理者確認</h2></div></div><h3>審査キュー</h3>{adminQueue.reviews.length === 0 ? <p>審査待ちはありません。</p> : adminQueue.reviews.map((review) => <article className="review-lab-card" key={review.id}><div className="review-lab-card-meta"><span>{review.authorId}</span><code>{review.moderationStatus}</code></div><p>{review.body}</p><div className="review-lab-card-actions"><button className="review-lab-secondary" onClick={() => void adminReviewAction(review.id, 'approve')}>承認</button><button className="review-lab-secondary" onClick={() => void adminReviewAction(review.id, 'needs_human_review')}>要確認</button><button className="review-lab-secondary" onClick={() => void adminReviewAction(review.id, 'reject')}>差し戻し</button><button className="review-lab-text-button" onClick={() => void freeze(review.authorId)}>投稿者を凍結</button></div></article>)}<h3 className="review-lab-subheading">通報</h3>{adminQueue.reports.length === 0 ? <p>未処理の通報はありません。</p> : adminQueue.reports.map((reportItem) => <article className="review-lab-card" key={reportItem.id}><div className="review-lab-card-meta"><span>{reportItem.reason}</span><code>{reportItem.status}</code></div><p>{reportItem.details}</p><button className="review-lab-secondary" onClick={() => void resolveReport(reportItem.id)}>確認済みにする</button></article>)}</section>}
  </main>;
}
