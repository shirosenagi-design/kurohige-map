import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cameraForPersonContextExpansion, requestPersonContextExpansion, savePersonContextExpansion } from '../src/personContextExpansionRequest.ts';
import { createInitialSampleWorld, sampleNodesForBand } from '../src/sampleMode.ts';
import { createMemoryWorldRepository } from '../src/worldRepository.ts';
import { computeSemanticLayout, emptyPersonState } from '../src/livingFlow.ts';

test('existing World context change uses one additive request and preserves its context', async () => {
  const body = {
    generationContext: { personState: { constraints: ['ビジネス'] } },
    expansionReason: 'person_context',
    existingNodes: [{ id: 'kept-island' }],
    keptNodeIds: ['kept-island'],
    landedNodeIds: [],
  };
  let calls = 0;
  const result = await requestPersonContextExpansion<{ nodes: { id: string }[] }>(body, async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/world-expand');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return new Response(JSON.stringify({ nodes: [{ id: 'new-island' }] }), { status: 200 });
  }, 100);
  assert.equal(calls, 1);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.nodes, [{ id: 'new-island' }]);
});

test('a stalled expansion aborts and rejects even when the transport ignores its signal', async () => {
  let signal: AbortSignal | undefined;
  const stalledFetch: typeof fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  await assert.rejects(requestPersonContextExpansion({}, stalledFetch, 10), { name: 'TimeoutError' });
  assert.equal(signal?.aborted, true);
  const retried = await requestPersonContextExpansion({}, async () =>
    new Response(JSON.stringify({ nodes: [] }), { status: 200 }), 100);
  assert.equal(retried.response.status, 200);
});

test('the context expansion effect keeps its result handler through its own loading-state update', () => {
  const source = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  const contextEffect = source.slice(source.indexOf('const integratePersonContext = async () =>'), source.indexOf('void integratePersonContext();'));
  assert.match(contextEffect, /setLoadingExpansion\(true\)/u);
  assert.match(contextEffect, /onInitialWorldGenerationChangeRef\.current\?\.\(\{ status: 'error'/u);
  assert.doesNotMatch(contextEffect, /if \(disposed\) return/u);
  assert.match(contextEffect, /setLoadingExpansion\(false\)/u);
});

test('successful context expansion saves exactly six additions before it can report success', async () => {
  const original = createInitialSampleWorld();
  original.nodeStates[original.nodes[0].id].kept = true;
  original.nodeStates[original.nodes[1].id].landed = true;
  const repository = createMemoryWorldRepository(original);
  let calls = 0;
  const api = await requestPersonContextExpansion<{ nodes: typeof original.nodes }>(
    { expansionReason: 'person_context', existingNodes: original.nodes },
    async () => { calls += 1; return new Response(JSON.stringify({ nodes: sampleNodesForBand(1) }), { status: 200 }); },
    100,
  );
  assert.equal(calls, 1);
  assert.equal(api.response.ok, true);
  const { snapshot, appended } = await savePersonContextExpansion(repository, {
    worldId: original.worldId, worldRevision: original.worldRevision, nodeIds: original.nodes.map((node) => node.id),
  }, api.payload.nodes, 1, 2);
  assert.equal(appended.length, 6);
  assert.equal(snapshot.nodes.length, original.nodes.length + 6);
  assert.equal(snapshot.worldRevision, original.worldRevision + 1);
  assert.equal(snapshot.context.integratedPersonContextRevision, 2);
  assert.deepEqual(snapshot.nodeStates[original.nodes[0].id], original.nodeStates[original.nodes[0].id]);
  assert.deepEqual(snapshot.nodeStates[original.nodes[1].id], original.nodeStates[original.nodes[1].id]);
  const loaded = await repository.loadActive();
  assert.equal(loaded.status, 'ready');
  if (loaded.status === 'ready') assert.deepEqual(loaded.snapshot, snapshot);
  const placement = computeSemanticLayout(snapshot.nodes, emptyPersonState(), {}, snapshot.explorationBands);
  const camera = cameraForPersonContextExpansion(placement, appended.map((node) => node.id));
  assert.ok(camera.y < -2000, 'the newly appended frontier is outside the initial camera view');
});

test('failed or incomplete context expansion preserves the existing World', async () => {
  const original = createInitialSampleWorld();
  const repository = createMemoryWorldRepository(original);
  const currentWorld = {
    worldId: original.worldId, worldRevision: original.worldRevision, nodeIds: original.nodes.map((node) => node.id),
  };
  await assert.rejects(savePersonContextExpansion(repository, currentWorld, sampleNodesForBand(1).slice(0, 5), 1, 2));
  await assert.rejects(savePersonContextExpansion(repository, { ...currentWorld, worldRevision: 0 }, sampleNodesForBand(1), 1, 2));
  const loaded = await repository.loadActive();
  assert.equal(loaded.status, 'ready');
  if (loaded.status === 'ready') assert.deepEqual(loaded.snapshot, original);
});

test('API refusal and local save refusal cannot be reported as a completed expansion', async () => {
  const original = createInitialSampleWorld();
  const repository = createMemoryWorldRepository(original);
  const api = await requestPersonContextExpansion<{ error: { message: string } }>({}, async () =>
    new Response(JSON.stringify({ error: { message: 'API paused' } }), { status: 503 }), 100);
  assert.equal(api.response.ok, false);
  const refusingRepository = { ...repository, save: async () => false };
  await assert.rejects(savePersonContextExpansion(refusingRepository, {
    worldId: original.worldId, worldRevision: original.worldRevision, nodeIds: original.nodes.map((node) => node.id),
  }, sampleNodesForBand(1), 1, 2), /persistence rejected/u);
  const loaded = await repository.loadActive();
  assert.equal(loaded.status, 'ready');
  if (loaded.status === 'ready') assert.deepEqual(loaded.snapshot, original);
});
