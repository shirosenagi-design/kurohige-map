import { useEffect, useRef, useState } from 'react';
import { CoverScreen } from './CoverScreen';
import { resolveCoverDestination, type CoverWorldAvailability } from './coverRouting';
import { LivingFlowPilot, type WorldHydrationSnapshot } from './LivingFlowPilot';
import { ProfileEditor } from './ProfileEditor';
import { useProductState } from './ProductStateProvider';
import { SummaryScreen } from './SummaryScreen';
import { isOnboardingProfileComplete, type ProductSection, type WorldGenerationCommand } from './productState';
import { ACTIVE_PRODUCT_LOCALE, t } from './i18n';
import { createIndexedDbWorldRepository, type WorldRepository } from './worldRepository';

export function ProductShell({ devOffline = false, sampleMode = false, worldRepository }: { devOffline?: boolean; sampleMode?: boolean; worldRepository?: WorldRepository } = {}) {
  const { state, dispatch } = useProductState();
  const [profileOpen, setProfileOpen] = useState(false);
  const [coverEntered, setCoverEntered] = useState(false);
  const [world, setWorld] = useState<CoverWorldAvailability>({ status: 'hydrating', hasWorld: false });
  const [worldNodeCount, setWorldNodeCount] = useState(0);
  const [initialWorldRequestId, setInitialWorldRequestId] = useState(0);
  const [initialWorldCommand, setInitialWorldCommand] = useState<WorldGenerationCommand | null>(null);
  const [initialWorldStatus, setInitialWorldStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [initialWorldError, setInitialWorldError] = useState('');
  const [initialWorldRequested, setInitialWorldRequested] = useState(false);
  const sharedWorldRepository = useRef<WorldRepository | null>(null);
  if (!sharedWorldRepository.current) sharedWorldRepository.current = worldRepository ?? createIndexedDbWorldRepository();
  const mapSection = state.section === 'list' ? 'list' : 'map';
  const canOpenMap = state.onboardingComplete && isOnboardingProfileComplete(state.userProfile)
    && world.status === 'ready' && world.hasWorld;
  const concealed = !coverEntered || state.section === 'summary';

  useEffect(() => {
    if (!initialWorldRequested || !state.onboardingComplete || !isOnboardingProfileComplete(state.userProfile)) return;
    setInitialWorldRequested(false);
    if (world.status === 'ready' && world.hasWorld) {
      setInitialWorldStatus('loading');
      setInitialWorldError('');
      setInitialWorldCommand({ type: 'PERSON_CONTEXT_EXPANSION_REQUESTED', personContextRevision: state.personContextRevision, locale: ACTIVE_PRODUCT_LOCALE });
      setInitialWorldRequestId((current) => current + 1);
      return;
    }
    if (world.status !== 'missing') {
      setInitialWorldStatus('error');
      setInitialWorldError(world.status === 'corrupt' ? t('summary.worldCorrupt') : t('summary.worldUnavailable'));
      return;
    }
    setInitialWorldStatus('loading');
    setInitialWorldError('');
    setInitialWorldCommand({ type: 'INITIAL_WORLD_GENERATION_REQUESTED', personContextRevision: state.personContextRevision, locale: ACTIVE_PRODUCT_LOCALE });
    setInitialWorldRequestId((current) => current + 1);
  }, [initialWorldRequested, state.onboardingComplete, state.personContextRevision, state.userProfile, world.status, world.hasWorld, dispatch]);

  const navigate = (section: ProductSection) => {
    if (section !== 'summary' && !canOpenMap) return;
    dispatch({ type: 'SET_SECTION', section });
  };

  const handleWorldHydration = (snapshot: WorldHydrationSnapshot) => {
    setWorld((current) => current.status === snapshot.status && current.hasWorld === snapshot.hasWorld
      ? current
      : { status: snapshot.status, hasWorld: snapshot.hasWorld });
    setWorldNodeCount((current) => current === snapshot.nodeCount ? current : snapshot.nodeCount);
  };

  const enterProduct = () => {
    const destination = resolveCoverDestination({ onboardingComplete: state.onboardingComplete, profile: state.userProfile, world });
    if (destination === 'pending') return;
    setProfileOpen(false);
    dispatch({ type: 'SET_SECTION', section: destination });
    setCoverEntered(true);
  };

  return <main className="product-shell" lang={ACTIVE_PRODUCT_LOCALE} data-product-locale={ACTIVE_PRODUCT_LOCALE} data-product-section={state.section}
    data-onboarding-complete={state.onboardingComplete ? '1' : '0'} data-cover-visible={coverEntered ? '0' : '1'}
    data-cover-world-status={world.status} data-cover-world-exists={world.hasWorld ? '1' : '0'} data-cover-world-count={worldNodeCount}>
    <div className={`product-map-surface${concealed ? ' is-concealed' : ''}`} aria-hidden={concealed || undefined}>
      <LivingFlowPilot
        productView
        devOffline={devOffline}
        sampleMode={sampleMode}
        worldRepository={sharedWorldRepository.current}
        productSection={mapSection}
        onProductSectionChange={navigate}
        onWorldHydrationChange={handleWorldHydration}
        initialWorldGenerationCommand={initialWorldCommand}
        initialWorldGenerationRequestId={initialWorldRequestId}
        onInitialWorldGenerationChange={(result) => {
          if (result.status === 'success') {
            setInitialWorldStatus('idle');
            setInitialWorldError('');
            dispatch({ type: 'SET_SECTION', section: 'map' });
          } else if (result.status === 'error') {
            setInitialWorldStatus('error');
            setInitialWorldError(result.error ?? t('summary.worldGenerationError'));
          }
        }}
      />
    </div>

    {coverEntered && <header className="product-header">
      <div className="brand"><span className="brand-mark">⛵</span><span>KUROHIGE MAP</span></div>
      <nav className="tabs" aria-label={t('nav.aria')}>
        {!sampleMode && <button type="button" className={state.section === 'summary' ? 'active' : ''} aria-pressed={state.section === 'summary'} onClick={() => navigate('summary')}>▤ {t('nav.summary')}</button>}
        <button type="button" disabled={!canOpenMap} className={state.section === 'map' ? 'active' : ''} aria-pressed={state.section === 'map'} onClick={() => navigate('map')}>▧ {t('nav.map')}</button>
        <button type="button" disabled={!canOpenMap} className={state.section === 'list' ? 'active' : ''} aria-pressed={state.section === 'list'} onClick={() => navigate('list')}>☷ {t('nav.list')}</button>
      </nav>
      {!sampleMode && <button className="product-avatar" type="button" aria-label={t('profile.open')} onClick={() => setProfileOpen(true)}>
        {state.userProfile.avatarRef
          ? <img src={state.userProfile.avatarRef} alt="" />
          : <span>{state.userProfile.nickname?.slice(0, 1) || t('profile.avatarFallback')}</span>}
      </button>}
    </header>}

    {sampleMode && <aside className="sample-mode-badge" role="status">
      <strong>サンプル体験</strong><span className="sample-mode-badge-full">AIリアルタイム生成なし · 本番データ送信なし</span><span className="sample-mode-badge-compact">AI生成なし</span>
    </aside>}

    {coverEntered && !sampleMode && state.section === 'summary' && <SummaryScreen
      onRequestProfile={() => setProfileOpen(true)}
      onConfirmed={() => setInitialWorldRequested(true)}
      generationStatus={initialWorldStatus}
      generationError={initialWorldError}
      onRetry={() => setInitialWorldRequested(true)}
    />}
    {coverEntered && !sampleMode && profileOpen && <ProfileEditor worldRepository={sharedWorldRepository.current} onClose={() => setProfileOpen(false)} />}
    {!coverEntered && <CoverScreen loading={world.status === 'hydrating'} onEnter={enterProduct} />}
  </main>;
}
