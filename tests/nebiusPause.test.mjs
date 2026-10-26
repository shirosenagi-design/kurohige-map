import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createGuardedNebiusFetch, isNebiusApiEnabled, NEBIUS_API_PAUSED_CODE } from '../server/nebiusTransportGuard.mjs';
import { createVisualRecipeMiddleware, createVisualRecipeService } from '../server/visualRecipeApi.mjs';
import { createLivingFlowApi } from '../server/livingFlowApi.mjs';

function invokeMiddleware(middleware, body) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = 'POST';
    const headers = {};
    const response = {
      statusCode: 200,
      setHeader(name, value) { headers[name] = value; },
      end(value) {
        try { resolve({ status: this.statusCode, headers, body: JSON.parse(value) }); }
        catch (error) { reject(error); }
      },
    };
    Promise.resolve(middleware(request, response)).catch(reject);
  });
}

test('Nebius API is disabled by default and only literal true enables it', () => {
  assert.equal(isNebiusApiEnabled(undefined), false);
  assert.equal(isNebiusApiEnabled(false), false);
  assert.equal(isNebiusApiEnabled('false'), false);
  assert.equal(isNebiusApiEnabled('TRUE'), true);
});

test('common transport guard blocks before the injected fetch function', async () => {
  let externalCalls = 0;
  const guardedFetch = createGuardedNebiusFetch({
    fetchImpl: async () => { externalCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(guardedFetch('https://api.tokenfactory.nebius.com/v1/models'), (error) => error.code === NEBIUS_API_PAUSED_CODE);
  assert.equal(externalCalls, 0);
});

test('visual recipe service and middleware return API_PAUSED with zero external sends', async () => {
  let externalCalls = 0;
  const fetchImpl = async () => { externalCalls += 1; throw new Error('must not run'); };
  const service = createVisualRecipeService({ apiKey: 'mock-key', fetchImpl });
  assert.throws(() => service.discoverModel(), (error) => error.code === NEBIUS_API_PAUSED_CODE);
  const result = await invokeMiddleware(createVisualRecipeMiddleware({ apiKey: 'mock-key', fetchImpl }), { goal: 'test goal' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, NEBIUS_API_PAUSED_CODE);
  assert.equal(externalCalls, 0);
});

test('all Living Flow endpoints return API_PAUSED with zero external sends', async () => {
  let externalCalls = 0;
  const fetchImpl = async () => { externalCalls += 1; throw new Error('must not run'); };
  const api = createLivingFlowApi({ apiKey: 'mock-key', fetchImpl });
  const generationContext = { mode: 'person_map', locale: 'ja', contextSeed: null, personState: {}, userProfile: {} };
  const node = { id: 'node-a', title: '島', shortDescription: '説明', category: '地域', nodeKind: 'activity', relationToGoal: 'direct', portableResourceTags: ['観察'], connectionTags: ['地域'], helpedByTags: [] };
  const calls = [
    [api.possibilityMapMiddleware, { generationContext }],
    [api.nodeStepsMiddleware, { generationContext, keptNode: node, mapContext: [] }],
    [api.nodeDetailMiddleware, { generationContext, node }],
    [api.worldExpandMiddleware, { generationContext, explorationBand: 1, existingNodes: [node], keptNodeIds: [], landedNodeIds: [] }],
  ];
  for (const [middleware, body] of calls) {
    const result = await invokeMiddleware(middleware, body);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, NEBIUS_API_PAUSED_CODE);
  }
  assert.equal(externalCalls, 0);
});

test('explicit true allows the common guard to call only the injected mock transport', async () => {
  let mockCalls = 0;
  const guardedFetch = createGuardedNebiusFetch({ enabled: 'true', fetchImpl: async () => { mockCalls += 1; return { ok: true }; } });
  const response = await guardedFetch('mock://nebius');
  assert.equal(response.ok, true);
  assert.equal(mockCalls, 1);
});

test('Living Flow reports model discovery transport and payload failures without HTTP 500', async () => {
  const generationContext = { mode: 'person_map', locale: 'ja', contextSeed: null, personState: {}, userProfile: {} };
  const transportGuard = {
    async execute() {
      const error = new Error('sanitized guard failure');
      error.code = 'NEBIUS_TRANSPORT_FAILURE';
      throw error;
    },
  };
  const transportApi = createLivingFlowApi({
    apiKey: 'mock-key', apiEnabled: true, spendGuard: transportGuard,
    fetchImpl: async () => { throw new Error('transport should be owned by the mock guard'); },
  });
  const transportResult = await invokeMiddleware(transportApi.possibilityMapMiddleware, { generationContext });
  assert.equal(transportResult.status, 502);
  assert.equal(transportResult.body.error.code, 'nebius_transport_failed');

  const invalidPayloadApi = createLivingFlowApi({
    apiKey: 'mock-key', apiEnabled: true,
    fetchImpl: async () => new Response(JSON.stringify({ data: { unexpected: true } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  });
  const invalidPayloadResult = await invokeMiddleware(invalidPayloadApi.possibilityMapMiddleware, { generationContext });
  assert.equal(invalidPayloadResult.status, 502);
  assert.equal(invalidPayloadResult.body.error.code, 'model_discovery_invalid_response');
});

test('Person Map expansion accepts a discovered 120-node exclusion catalog while Nebius remains paused', async () => {
  let externalCalls = 0;
  const api = createLivingFlowApi({
    apiKey: 'mock-key',
    fetchImpl: async () => { externalCalls += 1; throw new Error('must not run'); },
  });
  const generationContext = { mode: 'person_map', locale: 'ja', contextSeed: null, personState: {}, userProfile: {} };
  const existingNodes = Array.from({ length: 120 }, (_, index) => ({
    id: `node-${index}`, title: `既存の可能性 ${index}`, shortDescription: `既存の説明 ${index}`,
    category: '探索', nodeKind: 'activity', relationToGoal: 'adjacent',
    portableResourceTags: ['観察'], connectionTags: ['地域'], helpedByTags: [],
  }));
  const result = await invokeMiddleware(api.worldExpandMiddleware, {
    generationContext, explorationBand: 18, expansionReason: 'person_context',
    existingNodes, keptNodeIds: [], landedNodeIds: [],
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, NEBIUS_API_PAUSED_CODE);
  assert.equal(externalCalls, 0);
});
