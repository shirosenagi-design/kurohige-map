import { useEffect, useMemo, useState } from 'react';
import { ProductShell } from './ProductShell.tsx';
import { ProductStateProvider } from './ProductStateProvider.tsx';
import { isOnboardingProfileComplete } from './productState.ts';
import {
  createDevOfflineProductStateRepository,
  createDevOfflineWorldRepository,
  createReadOnlyNormalWorldRepository,
  readNormalProductState,
} from './devOffline.ts';
import type { PersistedWorldSnapshotV1 } from './worldState.ts';
import './devOffline.css';

type Readiness = 'checking' | 'setup' | 'ready';

const copyForDev = (source: PersistedWorldSnapshotV1): PersistedWorldSnapshotV1 => ({
  ...structuredClone(source),
  worldId: `dev-offline-${crypto.randomUUID()}`,
  worldRevision: 1,
  savedAt: new Date().toISOString(),
});

export function DevOfflineApp() {
  const productRepository = useMemo(() => createDevOfflineProductStateRepository(window.localStorage), []);
  const worldRepository = useMemo(() => createDevOfflineWorldRepository(), []);
  const sourceWorldRepository = useMemo(() => createReadOnlyNormalWorldRepository(), []);
  const [readiness, setReadiness] = useState<Readiness>('checking');
  const [message, setMessage] = useState('DEV保存領域を確認しています…');
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const [world, product] = await Promise.all([worldRepository.loadActive(), Promise.resolve(productRepository.load())]);
      if (disposed) return;
      if (world.status === 'ready' && world.snapshot.nodes.length > 0
        && product.onboardingComplete && isOnboardingProfileComplete(product.userProfile)) {
        setReadiness('ready');
        setMessage('保存済みDEV Worldを読み込みました。');
      } else {
        setReadiness('setup');
        setMessage(world.status === 'corrupt'
          ? 'DEV保存領域を読み込めません。通常Productからもう一度複製できます。'
          : '通常Productの保存済みWorldを明示的に複製してください。');
      }
    })().catch((error) => {
      if (!disposed) { setReadiness('setup'); setMessage(error instanceof Error ? error.message : 'DEV保存領域を確認できませんでした。'); }
    });
    return () => { disposed = true; };
  }, [productRepository, worldRepository]);

  const copyNormalData = async () => {
    if (copying) return;
    setCopying(true);
    try {
      const product = readNormalProductState(window.localStorage);
      if (!product.onboardingComplete || !isOnboardingProfileComplete(product.userProfile)) {
        throw new Error('通常Productに完了済みプロフィールがありません。通常Productのデータは変更していません。');
      }
      const sourceWorld = await sourceWorldRepository.loadActive();
      if (sourceWorld.status !== 'ready' || sourceWorld.snapshot.nodes.length === 0) {
        throw new Error(sourceWorld.status === 'corrupt'
          ? '通常ProductのWorldを安全に読み込めません。データは変更していません。'
          : '通常Productに複製できる保存済みWorldがありません。');
      }
      const saved = await worldRepository.save(copyForDev(sourceWorld.snapshot));
      if (!saved) throw new Error('DEV Worldの保存が拒否されました。通常Productのデータは変更していません。');
      productRepository.save(structuredClone(product));
      setMessage(`${sourceWorld.snapshot.nodes.length}島と保存済みRecipe・詳細をDEV領域へ複製しました。`);
      setReadiness('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'DEV領域への複製に失敗しました。');
    } finally {
      setCopying(false);
    }
  };

  return <div className="dev-offline-root" data-dev-offline="1">
    <aside className="dev-offline-badge" role="status">
      <strong>DEV節約モード</strong><span>API通信停止 · DEV保存領域</span>
    </aside>
    {readiness === 'ready' ? <ProductStateProvider repository={productRepository}>
      <ProductShell devOffline worldRepository={worldRepository} />
    </ProductStateProvider> : <main className="dev-offline-setup">
      <section>
        <p className="dev-offline-eyebrow">KUROHIGE MAP DEVELOPMENT</p>
        <h1>DEV節約モード</h1>
        <p>{message}</p>
        <ul>
          <li>通常Productの保存データは読み取りだけです。</li>
          <li>複製後の変更はDEV専用領域へ保存されます。</li>
          <li>Nebiusを含むAPI通信とfrontier自動拡張は停止します。</li>
        </ul>
        {readiness === 'setup' && <button type="button" onClick={() => void copyNormalData()} disabled={copying}>
          {copying ? 'DEV領域へ複製中…' : '通常Productの保存データをDEV領域へ複製'}
        </button>}
      </section>
    </main>}
  </div>;
}
