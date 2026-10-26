import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PUBLIC_SAMPLE_NODES,
  SAMPLE_API_BLOCK_CODE,
  SAMPLE_PRODUCT_STATE_KEY,
  SAMPLE_WORLD_DATABASE_NAME,
  createInitialSampleWorld,
  createSampleFetchGuard,
  createSampleProductStateRepository,
  sampleNodesForBand,
} from '../src/sampleMode.ts';
import { PRODUCT_STATE_STORAGE_KEY } from '../src/productState.ts';
import { TARGET_WORLD_NODE_COUNT, MAX_WORLD_EXPANSION_BATCH } from '../src/worldCapacity.ts';
import { prepareAdditiveWorldExpansion, nearDuplicatePossibilityTitle } from '../src/worldExpansion.ts';
import { parsePersistedWorld } from '../src/worldState.ts';
import { PUBLIC_SAMPLE_SERVER_BLOCK_CODE, createPublicSampleApiGuard } from '../server/publicSampleGuard.mjs';

test('public sample catalog contains 120 semantically varied, unique fixed Nodes', () => {
  assert.equal(PUBLIC_SAMPLE_NODES.length, TARGET_WORLD_NODE_COUNT);
  assert.equal(new Set(PUBLIC_SAMPLE_NODES.map((node) => node.id)).size, TARGET_WORLD_NODE_COUNT);
  assert.equal(new Set(PUBLIC_SAMPLE_NODES.map((node) => node.title)).size, TARGET_WORLD_NODE_COUNT);
  assert.equal(new Set(PUBLIC_SAMPLE_NODES.map((node) => node.category)).size, 20);
  for (let left = 0; left < PUBLIC_SAMPLE_NODES.length; left += 1) {
    for (let right = left + 1; right < PUBLIC_SAMPLE_NODES.length; right += 1) {
      assert.equal(nearDuplicatePossibilityTitle(PUBLIC_SAMPLE_NODES[left].title, PUBLIC_SAMPLE_NODES[right].title), false,
        `${PUBLIC_SAMPLE_NODES[left].title} must differ from ${PUBLIC_SAMPLE_NODES[right].title}`);
    }
  }
});

test('sample starts with 12 Nodes and expands in six-Node frontier batches to 120', () => {
  const initial = createInitialSampleWorld();
  assert.equal(initial.nodes.length, 12);
  assert.equal(parsePersistedWorld(initial).status, 'ready');
  let nodes = initial.nodes;
  let states = initial.nodeStates;
  let bands = initial.explorationBands;
  for (let band = 1; band <= MAX_WORLD_EXPANSION_BATCH; band += 1) {
    const prepared = prepareAdditiveWorldExpansion(nodes, sampleNodesForBand(band), states, bands, band);
    assert.equal(prepared.appended.length, 6);
    nodes = prepared.nodes;
    states = prepared.nodeStates;
    bands = prepared.explorationBands;
  }
  assert.equal(nodes.length, TARGET_WORLD_NODE_COUNT);
  assert.equal(new Set(nodes.map((node) => node.id)).size, TARGET_WORLD_NODE_COUNT);
});

test('sample Product storage is isolated from normal Product keys and World database', () => {
  assert.notEqual(SAMPLE_PRODUCT_STATE_KEY, PRODUCT_STATE_STORAGE_KEY);
  assert.notEqual(SAMPLE_WORLD_DATABASE_NAME, 'kurohige-map-world');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const repository = createSampleProductStateRepository(storage);
  const sample = repository.load();
  assert.equal(sample.userProfile.nickname, 'サンプル航海者');
  repository.save(sample);
  assert.equal(values.has(SAMPLE_PRODUCT_STATE_KEY), true);
  assert.equal(values.has(PRODUCT_STATE_STORAGE_KEY), false);
});

test('sample client guard blocks same-origin APIs and Nebius while allowing static assets', async () => {
  const forwarded: string[] = [];
  const transport = (async (input: RequestInfo | URL) => {
    forwarded.push(String(input));
    return new Response('asset', { status: 200 });
  }) as typeof fetch;
  const diagnostic = { blockedCount: 0, blockedTargets: [] as string[] };
  const guarded = createSampleFetchGuard(transport, 'http://127.0.0.1:5191/?sample=1', diagnostic);
  const api = await guarded('/api/world-expand', { method: 'POST' });
  const nebius = await guarded('https://api.studio.nebius.ai/v1/chat/completions', { method: 'POST' });
  const asset = await guarded('/assets/map/ocean-base-tile.png');
  assert.equal(api.status, 503);
  assert.equal((await api.json()).error.code, SAMPLE_API_BLOCK_CODE);
  assert.equal(nebius.status, 503);
  assert.equal(asset.status, 200);
  assert.equal(diagnostic.blockedCount, 2);
  assert.deepEqual(forwarded, ['/assets/map/ocean-base-tile.png']);
});

test('public sample server lock rejects all API paths before route handling', () => {
  let nextCalls = 0;
  const guard = createPublicSampleApiGuard({ sampleOnly: true });
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(body: string) { this.body = body; },
  };
  guard({ url: '/api/reviews/session' }, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, PUBLIC_SAMPLE_SERVER_BLOCK_CODE);
  guard({ url: '/assets/index.js' }, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});

test('sample route owns its Provider and uses local sample expansion without API fetch', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/SampleApp.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf8');
  assert.match(main, /get\('sample'\) === '1'/u);
  assert.match(main, /installSampleFetchGuard/u);
  assert.match(app, /ProductStateProvider repository=\{productRepository\}/u);
  assert.match(app, /ProductShell sampleMode worldRepository=\{worldRepository\}/u);
  assert.match(flow, /incomingNodes = sampleNodesForBand\(band\)/u);
  assert.match(flow, /offline=\{devOffline \|\| sampleMode\}/u);
  assert.match(vite, /KUROHIGE_PUBLIC_SAMPLE_ONLY/u);
  assert.match(vite, /createPublicSampleApiGuard/u);
});
