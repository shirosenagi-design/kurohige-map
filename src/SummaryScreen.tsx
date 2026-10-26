import { useEffect, useState } from 'react';
import { useProductState } from './ProductStateProvider';
import { isOnboardingProfileComplete } from './productState';
import { t } from './i18n';
import { SailingLoader } from './SailingLoader';

type SummaryDraft = {
  interests: string;
  engagementPatterns: string;
  constraints: string;
  recentChanges: string;
};

const lines = (value: string) => [...new Set(value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean))];
const draftFromState = (state: ReturnType<typeof useProductState>['state']['personState']): SummaryDraft => ({
  interests: state.interests.join('\n'),
  engagementPatterns: state.engagementPatterns.join('\n'),
  constraints: state.constraints.join('\n'),
  recentChanges: state.recentChanges.join('\n'),
});

export function SummaryScreen({ onRequestProfile, onConfirmed, generationStatus = 'idle', generationError = '', onRetry }: {
  onRequestProfile: () => void;
  onConfirmed?: () => void;
  generationStatus?: 'idle' | 'loading' | 'error';
  generationError?: string;
  onRetry?: () => void;
}) {
  const { state, dispatch } = useProductState();
  const [draft, setDraft] = useState<SummaryDraft>(() => draftFromState(state.personState));
  const [saved, setSaved] = useState(false);
  const [profileRequired, setProfileRequired] = useState(false);

  useEffect(() => setDraft(draftFromState(state.personState)), [state.personState]);

  const update = (field: keyof SummaryDraft, value: string) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const confirm = () => {
    dispatch({
      type: 'CONFIRM_PERSON_CONTEXT',
      context: {
        interests: lines(draft.interests),
        engagementPatterns: lines(draft.engagementPatterns),
        constraints: lines(draft.constraints),
        recentChanges: lines(draft.recentChanges),
      },
    });
    setSaved(true);
    if (isOnboardingProfileComplete(state.userProfile)) {
      setProfileRequired(false);
      onConfirmed?.();
    } else {
      setProfileRequired(true);
    }
  };

  const pendingSignals = state.observedPersonSignals.filter((signal) => signal.status === 'pending');

  return <section className="summary-screen" aria-labelledby="summary-title">
    <div className="summary-card">
      <header>
        <p className="summary-eyebrow">{t('summary.eyebrow')}</p>
        <h1 id="summary-title">{t('summary.title')}</h1>
        <p>{t('summary.intro')}</p>
      </header>

      <div className="summary-fields">
        <label>
          <span>{t('summary.interests')}</span>
          <small>{t('summary.interestsHint')}</small>
          <textarea value={draft.interests} onChange={(event) => update('interests', event.target.value)} maxLength={1200} placeholder={t('common.linePlaceholder')} />
        </label>
        <label>
          <span>{t('summary.engagementPatterns')}</span>
          <small>{t('summary.engagementPatternsHint')}</small>
          <textarea value={draft.engagementPatterns} onChange={(event) => update('engagementPatterns', event.target.value)} maxLength={1200} placeholder={t('common.linePlaceholder')} />
        </label>
        <label>
          <span>{t('summary.constraints')}</span>
          <small>{t('summary.constraintsHint')}</small>
          <textarea value={draft.constraints} onChange={(event) => update('constraints', event.target.value)} maxLength={1200} placeholder={t('common.linePlaceholder')} />
        </label>
        <label>
          <span>{t('summary.recentChanges')}</span>
          <small>{t('summary.recentChangesHint')}</small>
          <textarea value={draft.recentChanges} onChange={(event) => update('recentChanges', event.target.value)} maxLength={1200} placeholder={t('common.linePlaceholder')} />
        </label>
      </div>

      {pendingSignals.length > 0 && <section className="summary-observations" aria-label={t('summary.observationsAria')}>
        <h2>{t('summary.observationsTitle')}</h2>
        {pendingSignals.map((signal) => <article key={signal.id}>
          <div><strong>{signal.proposedDomain}</strong><small>{signal.sourceActions.join(t('common.listSeparator'))}</small></div>
          <div className="summary-observation-actions">
            <button type="button" onClick={() => dispatch({ type: 'CONFIRM_OBSERVED_SIGNAL', id: signal.id })}>{t('summary.confirmSignal')}</button>
            <button type="button" onClick={() => dispatch({ type: 'DISMISS_OBSERVED_SIGNAL', id: signal.id })}>{t('summary.dismissSignal')}</button>
          </div>
        </article>)}
      </section>}

      {profileRequired && <div className="summary-profile-required" role="alert">
        <p>{t('summary.profileRequired')}</p>
        <button type="button" onClick={onRequestProfile}>{t('summary.openProfile')}</button>
      </div>}

      {generationStatus === 'loading' && <div className="summary-world-generation"><SailingLoader label={t('summary.worldGenerating')} /></div>}
      {generationStatus === 'error' && <div className="summary-world-error" role="alert"><p>{generationError || t('summary.worldGenerationError')}</p>
        <button type="button" onClick={onRetry}>{t('summary.worldRetry')}</button></div>}

      <footer>
        <div>
          <span>{t('summary.revision', { revision: state.personContextRevision })}</span>
          {saved && <strong role="status">{t('summary.saved')}</strong>}
        </div>
        <button type="button" className="summary-confirm" disabled={generationStatus === 'loading'} onClick={confirm}>{state.onboardingComplete ? t('summary.confirmExisting') : t('summary.confirmFirst')}</button>
      </footer>
    </div>
  </section>;
}
