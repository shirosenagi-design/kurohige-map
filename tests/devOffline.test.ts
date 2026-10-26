import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEV_OFFLINE_BLOCK_CODE,
  DEV_OFFLINE_PRODUCT_STATE_KEY,
  DEV_OFFLINE_WORLD_DATABASE_NAME,
  createDevOfflineFetchGuard,
  createDevOfflineProductStateRepository,
  readNormalProductState,
} from '../src/devOffline.ts';
import { PRODUCT_STATE_STORAGE_KEY, createEmptyPersistedProductState } from '../src/productState.ts';
import { WORLD_DATABASE_NAME } from '../src/worldRepository.ts';

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    dump: () => Object.fromEntries(values),
  };
};

test('DEV Product state is isolated from normal Product storage', () => {
  const normal = { ...createEmptyPersistedProductState(), personContextRevision: 4 };
  const browserStorage = storage({ [PRODUCT_STATE_STORAGE_KEY]: JSON.stringify(normal) });
  const beforeNormal = browserStorage.getItem(PRODUCT_STATE_STORAGE_KEY);
  const devRepository = createDevOfflineProductStateRepository(browserStorage);

  assert.equal(devRepository.load().personContextRevision, 0);
  devRepository.save({ ...normal, personContextRevision: 9 });
  assert.equal(devRepository.load().personContextRevision, 9);
  assert.equal(readNormalProductState(browserStorage).personContextRevision, 4);
  assert.equal(browserStorage.getItem(PRODUCT_STATE_STORAGE_KEY), beforeNormal);
  assert.ok(browserStorage.getItem(DEV_OFFLINE_PRODUCT_STATE_KEY));
});

test('DEV storage names cannot collide with normal Product storage', () => {
  assert.notEqual(DEV_OFFLINE_PRODUCT_STATE_KEY, PRODUCT_STATE_STORAGE_KEY);
  assert.notEqual(DEV_OFFLINE_WORLD_DATABASE_NAME, WORLD_DATABASE_NAME);
});

test('DEV fetch guard blocks every same-origin API request without external transmission', async () => {
  let transmissions = 0;
  const diagnostic = { blockedCount: 0, blockedTargets: [] as string[] };
  const underlying = (async () => { transmissions += 1; return new Response('ok'); }) as typeof fetch;
  const guarded = createDevOfflineFetchGuard(underlying, 'http://127.0.0.1:5173/?devOffline=1', diagnostic);

  for (const path of ['/api/possibility-map', '/api/world-expand', '/api/node-detail', '/api/node-steps', '/api/models']) {
    const response = await guarded(path, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, DEV_OFFLINE_BLOCK_CODE);
  }
  const direct = await guarded('https://api.studio.nebius.ai/v1/chat/completions');
  assert.equal(direct.status, 503);
  assert.equal(transmissions, 0);
  assert.equal(diagnostic.blockedCount, 6);
});

test('DEV fetch guard permits non-API static resources', async () => {
  let transmissions = 0;
  const underlying = (async () => { transmissions += 1; return new Response('asset'); }) as typeof fetch;
  const guarded = createDevOfflineFetchGuard(underlying, 'http://127.0.0.1:5173/?devOffline=1');
  const response = await guarded('/assets/map/ocean-base-tile.png');
  assert.equal(await response.text(), 'asset');
  assert.equal(transmissions, 1);
});
