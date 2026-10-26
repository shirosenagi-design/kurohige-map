import {
  LEGACY_PRODUCT_STATE_STORAGE_KEY,
  PRODUCT_STATE_STORAGE_KEY,
  createEmptyPersistedProductState,
  parsePersistedProductState,
  type BrowserStorage,
  type PersistedProductState,
  type ProductStateRepository,
} from './productState.ts';
import { createIndexedDbWorldRepository, type WorldRepository } from './worldRepository.ts';

export const DEV_OFFLINE_PRODUCT_STATE_KEY = 'kurohige-map.dev-offline.product-state.v1';
export const DEV_OFFLINE_WORLD_DATABASE_NAME = 'kurohige-map-world-dev-offline';
export const DEV_OFFLINE_BLOCK_CODE = 'DEV_OFFLINE_API_BLOCKED';

export type DevOfflineNetworkDiagnostic = {
  blockedCount: number;
  blockedTargets: string[];
};

declare global {
  interface Window {
    __kurohigeDevOffline?: DevOfflineNetworkDiagnostic;
  }
}

export function createDevOfflineProductStateRepository(storage: BrowserStorage): ProductStateRepository {
  return {
    load: () => {
      try {
        return parsePersistedProductState(storage.getItem(DEV_OFFLINE_PRODUCT_STATE_KEY));
      } catch {
        return createEmptyPersistedProductState();
      }
    },
    save: (state) => storage.setItem(DEV_OFFLINE_PRODUCT_STATE_KEY, JSON.stringify(state)),
    clear: () => storage.removeItem(DEV_OFFLINE_PRODUCT_STATE_KEY),
  };
}

export function readNormalProductState(storage: BrowserStorage): PersistedProductState {
  return parsePersistedProductState(
    storage.getItem(PRODUCT_STATE_STORAGE_KEY) ?? storage.getItem(LEGACY_PRODUCT_STATE_STORAGE_KEY),
  );
}

export function createDevOfflineWorldRepository(factory: IDBFactory = globalThis.indexedDB): WorldRepository {
  return createIndexedDbWorldRepository(factory, { databaseName: DEV_OFFLINE_WORLD_DATABASE_NAME });
}

export function createReadOnlyNormalWorldRepository(factory: IDBFactory = globalThis.indexedDB): WorldRepository {
  return createIndexedDbWorldRepository(factory, { quarantineCorrupt: false });
}

const targetOf = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);
const shouldBlock = (target: string, baseUrl: string) => {
  try {
    const url = new URL(target, baseUrl);
    return (url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/api/'))
      || /(^|\.)api\.studio\.nebius\.ai$/iu.test(url.hostname)
      || /(^|\.)nebius\.ai$/iu.test(url.hostname);
  } catch {
    return true;
  }
};

export function createDevOfflineFetchGuard(
  fetchImplementation: typeof fetch,
  baseUrl = 'http://127.0.0.1/',
  diagnostic: DevOfflineNetworkDiagnostic = { blockedCount: 0, blockedTargets: [] },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = targetOf(input);
    if (!shouldBlock(target, baseUrl)) return fetchImplementation(input, init);
    diagnostic.blockedCount += 1;
    diagnostic.blockedTargets.push(target);
    return new Response(JSON.stringify({
      error: {
        code: DEV_OFFLINE_BLOCK_CODE,
        message: 'DEV節約モードではAPI通信を停止しています。保存済みデータだけを利用できます。',
      },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export function installDevOfflineFetchGuard() {
  if (!import.meta.env.DEV) return;
  const diagnostic: DevOfflineNetworkDiagnostic = { blockedCount: 0, blockedTargets: [] };
  window.__kurohigeDevOffline = diagnostic;
  window.fetch = createDevOfflineFetchGuard(window.fetch.bind(window), window.location.href, diagnostic);
}
