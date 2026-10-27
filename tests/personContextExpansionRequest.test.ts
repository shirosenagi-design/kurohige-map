import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestPersonContextExpansion } from '../src/personContextExpansionRequest.ts';

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
