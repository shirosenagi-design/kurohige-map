import { useEffect, useMemo, useState } from 'react';
import { ProductShell } from './ProductShell.tsx';
import { ProductStateProvider } from './ProductStateProvider.tsx';
import {
  SAMPLE_WORLD_ID,
  createInitialSampleWorld,
  createSampleProductStateRepository,
  createSampleWorldRepository,
} from './sampleMode.ts';
import './sampleMode.css';

type SampleReadiness = 'preparing' | 'ready' | 'error';

export function SampleApp() {
  const productRepository = useMemo(() => createSampleProductStateRepository(window.localStorage), []);
  const worldRepository = useMemo(() => createSampleWorldRepository(), []);
  const [readiness, setReadiness] = useState<SampleReadiness>('preparing');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const current = await worldRepository.loadActive();
      if (disposed) return;
      if (current.status === 'corrupt') {
        setError('サンプル専用Worldを安全に読み込めませんでした。通常Productの保存領域は使用していません。');
        setReadiness('error');
        return;
      }
      if (current.status === 'missing') {
        const saved = await worldRepository.save(createInitialSampleWorld());
        if (!saved) {
          const afterRace = await worldRepository.loadActive();
          if (afterRace.status !== 'ready' || afterRace.snapshot.worldId !== SAMPLE_WORLD_ID) {
            throw new Error('サンプル専用Worldを準備できませんでした。');
          }
        }
      } else if (current.snapshot.worldId !== SAMPLE_WORLD_ID) {
        setError('サンプル専用保存領域に別のWorldがあるため、自動上書きを停止しました。');
        setReadiness('error');
        return;
      }
      if (!disposed) setReadiness('ready');
    })().catch((cause) => {
      if (!disposed) {
        setError(cause instanceof Error ? cause.message : 'サンプルを準備できませんでした。');
        setReadiness('error');
      }
    });
    return () => { disposed = true; };
  }, [worldRepository]);

  if (readiness !== 'ready') return <main className="sample-mode-setup" data-sample-mode="1">
    <section>
      <p>KUROHIGE MAP PUBLIC SAMPLE</p>
      <h1>サンプル体験を準備しています</h1>
      {readiness === 'error' && <div role="alert">{error}</div>}
    </section>
  </main>;

  return <div className="sample-mode-root" data-sample-mode="1">
    <ProductStateProvider repository={productRepository}>
      <ProductShell sampleMode worldRepository={worldRepository} />
    </ProductStateProvider>
  </div>;
}
