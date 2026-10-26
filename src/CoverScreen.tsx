import { t } from './i18n';
import coverBackgroundUrl from './assets/cover/cover-background-no-cta.png';
import coverCtaBaseUrl from './assets/cover/cover-cta-button-base.png';

export function CoverScreen({ loading, onEnter }: { loading: boolean; onEnter: () => void }) {
  return <section className="cover-screen" aria-labelledby="cover-title" data-cover-loading={loading ? '1' : '0'}>
    <img className="cover-background-wash" src={coverBackgroundUrl} alt="" aria-hidden="true" draggable={false} />
    <div className="cover-art">
      <img className="cover-background" src={coverBackgroundUrl} alt="" aria-hidden="true" draggable={false} fetchPriority="high" />
      <div className="cover-entry">
        <h1 id="cover-title">{t('cover.title')}</h1>
        <button className="cover-cta" type="button" disabled={loading} aria-busy={loading || undefined} onClick={onEnter}>
          <img className="cover-cta-base" src={coverCtaBaseUrl} alt="" aria-hidden="true" draggable={false} />
          <span className="cover-cta-content">
            <span className="cover-compass" aria-hidden="true">✦</span>
            <span>{t('cover.open')}</span>
            <span className="cover-chevron" aria-hidden="true">›</span>
          </span>
        </button>
      </div>
    </div>
  </section>;
}
