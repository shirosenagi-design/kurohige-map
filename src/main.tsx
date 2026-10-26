import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function bootstrap() {
  const sampleMode = new URLSearchParams(window.location.search).get('sample') === '1';
  if (sampleMode) {
    const [{ SampleApp }, { installSampleFetchGuard }] = await Promise.all([
      import('./SampleApp'),
      import('./sampleMode'),
    ]);
    installSampleFetchGuard();
    createRoot(document.getElementById('root')!).render(<React.StrictMode><SampleApp /></React.StrictMode>);
    return;
  }
  const devOffline = import.meta.env.DEV && new URLSearchParams(window.location.search).get('devOffline') === '1';
  if (devOffline) {
    const [{ DevOfflineApp }, { installDevOfflineFetchGuard }] = await Promise.all([
      import('./DevOfflineApp'),
      import('./devOffline'),
    ]);
    installDevOfflineFetchGuard();
    createRoot(document.getElementById('root')!).render(<React.StrictMode><DevOfflineApp /></React.StrictMode>);
    return;
  }
  const reviewLab = import.meta.env.DEV && new URLSearchParams(window.location.search).get('reviewLab') === '1';
  if (reviewLab) {
    const { ReviewLab } = await import('./ReviewLab');
    createRoot(document.getElementById('root')!).render(<React.StrictMode><ReviewLab /></React.StrictMode>);
    return;
  }
  if (import.meta.env.DEV) {
    const { prepareWorldPersistenceDevHarness } = await import('./worldPersistenceDevHarness');
    await prepareWorldPersistenceDevHarness();
  }
  const [{ App }, { ProductStateProvider }] = await Promise.all([
    import('./App'),
    import('./ProductStateProvider'),
  ]);
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ProductStateProvider><App /></ProductStateProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
