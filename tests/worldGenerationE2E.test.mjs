import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLivingFlowApi } from '../server/livingFlowApi.mjs';
import {
  createNebiusProductSpendGuard,
  NEBIUS_PRODUCT_OPERATION_SCOPES,
} from '../server/nebiusProductSpendGuard.mjs';
import {
  appendDistinctPossibilityNodes,
  nearDuplicatePossibilityTitle,
  prepareAdditiveWorldExpansion,
} from '../src/worldExpansion.ts';
import {
  MAX_WORLD_EXPANSION_BATCH,
  TARGET_WORLD_NODE_COUNT,
  WORLD_EXPANSION_BATCH_SIZE,
} from '../src/worldCapacity.ts';

const MODEL_ID = 'nvidia/Nemotron-3-Ultra-550b-a55b';
const WORLD_OPERATIONS = Object.keys(NEBIUS_PRODUCT_OPERATION_SCOPES)
  .filter((operation) => NEBIUS_PRODUCT_OPERATION_SCOPES[operation] === 'world');
const REVIEW_OPERATIONS = Object.keys(NEBIUS_PRODUCT_OPERATION_SCOPES)
  .filter((operation) => NEBIUS_PRODUCT_OPERATION_SCOPES[operation] === 'review');

const domains = [
  '記憶とことば', '生態と環境', '農と食', '移動と案内', '学び合い', '音楽と舞台',
  '修理と制作', '天体と気象', '地域出版', '情報設計', 'ケアと支え合い', '市民参加',
  '観光と解説', '小さな仕事', '空間再生', '交流行事', '循環利用', '屋外運動',
  '文化保存', '防災協働', '物流の工夫', '環境計測', '生物記録', '映像表現',
];
const transformations = [
  '小さな公開実験', '共同道具箱', '定期学習会', '観測ネットワーク',
  '見習い体験', '交換企画', '小規模支援', '公開展示',
  'オープンガイド', '空き場所実験', '協同運営', '現地案内',
];
const nodeKinds = ['activity', 'experience', 'information', 'opportunity', 'skill', 'community'];
const bridgeTags = [
  'interviewing', 'qualitative_research', 'archival_research', 'community_storytelling',
  'digitization', 'documentation', 'cataloging', 'collaboration', 'publishing',
  'field_research', 'observation', 'experimentation', 'teaching', 'logistics',
];
const themes = ['creative', 'field_science', 'cultivation', 'culture', 'research', 'transport'];
const motifs = ['camera', 'insect_observation', 'windmill', 'stage', 'observatory', 'road_loop'];
const terrains = ['flat', 'organic', 'raised', 'generic'];
const palettes = ['warm_red_white', 'warm_cream_terracotta', 'green_amber', 'ocean_teal'];

function semanticNode(index) {
  const domain = domains[index % domains.length];
  const transformation = transformations[Math.floor(index / domains.length) % transformations.length];
  return {
    title: `${domain}を${transformation}として試す`,
    shortDescription: `${domain}に触れながら、${transformation}を具体的な体験として小さく始めます。`,
    category: domain,
    nodeKind: nodeKinds[index % nodeKinds.length],
    relationToGoal: ['direct', 'adjacent', 'exploratory'][index % 3],
    curiosityFit: 0.55 + (index % 4) * 0.1,
    accessibility: 0.5 + (index % 3) * 0.1,
    novelty: 0.6 + (index % 3) * 0.1,
    friction: 0.25 + (index % 4) * 0.1,
    portableResourceTags: [`${domain}の経験`, `${transformation}の型`],
    connectionTags: [`${domain}の仲間`, `${transformation}の参加者`],
    helpedByTags: [bridgeTags[index % bridgeTags.length], bridgeTags[(index + 5) % bridgeTags.length]],
  };
}

function visualRecipe(index) {
  return {
    visualTheme: themes[index % themes.length],
    dominantMotif: motifs[index % motifs.length],
    secondaryObjects: ['sign', 'path'],
    terrainProfile: terrains[index % terrains.length],
    accentPalette: palettes[index % palettes.length],
    density: ['sparse', 'medium', 'dense'][index % 3],
    openness: ['open', 'balanced', 'compact'][index % 3],
    landmarkEmphasis: ['low', 'medium', 'high'][index % 3],
    energyLevel: ['calm', 'moderate', 'high'][index % 3],
  };
}

function invokeMiddleware(middleware, body) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = 'POST';
    const response = {
      statusCode: 200,
      setHeader() {},
      end(value) {
        try { resolve({ status: this.statusCode, body: JSON.parse(value) }); }
        catch (error) { reject(error); }
      },
    };
    Promise.resolve(middleware(request, response)).catch(reject);
  });
}

function createMockNebiusTransport() {
  let semanticIndex = 0;
  let semanticCalls = 0;
  let visualIndex = 0;
  let chatPosts = 0;
  let modelDiscoveryRequests = 0;
  let firstSemanticNode = null;
  let candidateRecoveryInjected = false;
  let stageGInjected = false;
  const driftPrompts = [];

  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/models')) {
      modelDiscoveryRequests += 1;
      return new Response(JSON.stringify({ data: [{ id: MODEL_ID }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    chatPosts += 1;
    const bodyText = String(init.body ?? '');
    const request = JSON.parse(bodyText);
    const schemaName = request.response_format?.json_schema?.name;
    const schema = request.response_format?.json_schema?.schema;
    for (const message of request.messages ?? []) {
      if (typeof message?.content === 'string' && message.content.includes('Semantic drift zone')) {
        driftPrompts.push(message.content);
      }
    }

    let structured;
    if (schemaName?.endsWith('_semantic_batch')) {
      semanticCalls += 1;
      if (!stageGInjected && semanticCalls === 16) {
        stageGInjected = true;
        const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(bodyText, 'utf8') / 4));
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'length', message: { content: '{"nodes":[' } }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: request.max_tokens,
            total_tokens: promptTokens + request.max_tokens,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const count = schema.properties.nodes.minItems;
      const nodes = [];
      if (!candidateRecoveryInjected && semanticCalls === 11 && firstSemanticNode) {
        nodes.push(structuredClone(firstSemanticNode));
        candidateRecoveryInjected = true;
      }
      while (nodes.length < count) {
        const candidate = semanticNode(semanticIndex++);
        firstSemanticNode ??= structuredClone(candidate);
        nodes.push(candidate);
      }
      structured = { nodes };
    } else if (schemaName?.endsWith('_visual_batch')) {
      const nodeIds = schema.properties.recipes.items.properties.nodeId.enum;
      structured = {
        recipes: nodeIds.map((nodeId) => ({ nodeId, visualRecipe: visualRecipe(visualIndex++) })),
      };
    } else {
      throw new Error(`Unexpected mock operation: ${schemaName}`);
    }

    const content = JSON.stringify(structured);
    const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(bodyText, 'utf8') / 4));
    const completionTokens = Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4));
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return {
    fetchImpl,
    stats: () => ({ chatPosts, modelDiscoveryRequests, candidateRecoveryInjected, stageGInjected, driftPrompts }),
  };
}

const summaryOf = (node) => ({
  id: node.id,
  title: node.title,
  shortDescription: node.shortDescription,
  category: node.category,
  nodeKind: node.nodeKind,
  relationToGoal: node.relationToGoal,
  portableResourceTags: node.portableResourceTags,
  connectionTags: node.connectionTags,
  helpedByTags: node.helpedByTags,
});

test('normal Product mock E2E reaches 120 through frontier expansion and appends Person Context changes safely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kurohige-world-120-'));
  const now = Date.now();
  const guard = createNebiusProductSpendGuard({
    schemaVersion: 1,
    runId: `product-world-120-${path.basename(root)}`,
    approvalId: `mock-approval-${path.basename(root)}`,
    ledgerPath: path.join(root, 'product-ledger.jsonl'),
    validFrom: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 60 * 60_000).toISOString(),
    maxTotalChatPosts: 180,
    maxModelDiscoveryRequests: 1,
    maxTotalEstimatedUsd: 100,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 3,
    scopes: {
      world: { maxChatPosts: 179, maxEstimatedUsd: 99, allowedOperations: WORLD_OPERATIONS },
      review: { maxChatPosts: 1, maxEstimatedUsd: 1, allowedOperations: REVIEW_OPERATIONS },
    },
  });
  await guard.initialize();
  const transport = createMockNebiusTransport();
  const api = createLivingFlowApi({
    apiKey: 'mock-key-never-sent',
    apiEnabled: true,
    fetchImpl: transport.fetchImpl,
    diagnosticEnabled: false,
    spendGuard: guard,
  });
  const generationContext = {
    mode: 'person_map',
    locale: 'ja',
    contextSeed: null,
    personState: {
      portableResources: ['観察の記録', '対話の経験'],
      experiences: ['地域の小さな活動に参加した'],
      completedSteps: ['historical-step-1'],
      bridgeTags: ['observation', 'community_facilitation'],
    },
    userProfile: {
      region: { countryCode: 'JP', administrativeArea: '東京都' },
      occupation: '企画職',
      practicalProfile: ['外へ出て試したい', '人と一緒に作りたい', '知らない分野にも触れたい'],
    },
  };

  const initial = await invokeMiddleware(api.possibilityMapMiddleware, { generationContext });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const initialExpansion = await invokeMiddleware(api.worldExpandMiddleware, {
    generationContext,
    explorationBand: 0,
    existingNodes: initial.body.nodes.map(summaryOf),
    keptNodeIds: [],
    landedNodeIds: [],
  });
  assert.equal(initialExpansion.status, 200, JSON.stringify(initialExpansion.body));
  const firstAppend = appendDistinctPossibilityNodes(initial.body.nodes, initialExpansion.body.nodes);
  let nodes = [...initial.body.nodes, ...firstAppend];
  assert.equal(nodes.length, 12);

  let nodeStates = Object.fromEntries(nodes.map((node) => [node.id, {
    visible: true,
    visited: false,
    kept: false,
    activePursuit: false,
    landed: false,
    worldTier: 'far',
    completedStepIds: [],
  }]));
  let explorationBands = Object.fromEntries(nodes.map((node) => [node.id, 0]));
  nodeStates[nodes[0].id] = { ...nodeStates[nodes[0].id], kept: true, completedStepIds: ['historical-step-1'] };
  nodeStates[nodes[1].id] = { ...nodeStates[nodes[1].id], kept: true, landed: true, visited: true, completedStepIds: ['a', 'b', 'c'] };
  nodeStates[nodes[2].id] = { ...nodeStates[nodes[2].id], kept: true, activePursuit: true };
  const preservedState = structuredClone(Object.fromEntries(nodes.slice(0, 3).map((node) => [node.id, nodeStates[node.id]])));
  const personStateBefore = structuredClone(generationContext.personState);
  const shipBefore = { x: 0, y: 310 };
  const trailBefore = [{ x: 0, y: 310, t: 1 }];
  const countAfterEachExpansion = [12];

  for (let band = 1; band <= MAX_WORLD_EXPANSION_BATCH; band += 1) {
    const response = await invokeMiddleware(api.worldExpandMiddleware, {
      generationContext,
      explorationBand: band,
      existingNodes: nodes.map(summaryOf),
      keptNodeIds: nodes.filter((node) => nodeStates[node.id]?.kept).map((node) => node.id),
      landedNodeIds: nodes.filter((node) => nodeStates[node.id]?.landed).map((node) => node.id),
    });
    assert.equal(response.status, 200, `band ${band}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.nodes.length, WORLD_EXPANSION_BATCH_SIZE);
    const prepared = prepareAdditiveWorldExpansion(nodes, response.body.nodes, nodeStates, explorationBands, band);
    assert.equal(prepared.appended.length, WORLD_EXPANSION_BATCH_SIZE, `band ${band} was not atomic`);
    nodes = prepared.nodes;
    nodeStates = prepared.nodeStates;
    explorationBands = prepared.explorationBands;
    countAfterEachExpansion.push(nodes.length);
    for (const [nodeId, expected] of Object.entries(preservedState)) assert.deepEqual(nodeStates[nodeId], expected);
    assert.deepEqual(generationContext.personState, personStateBefore);
    assert.deepEqual(shipBefore, { x: 0, y: 310 });
    assert.deepEqual(trailBefore, [{ x: 0, y: 310, t: 1 }]);
  }

  assert.equal(nodes.length, TARGET_WORLD_NODE_COUNT);
  assert.deepEqual(countAfterEachExpansion, Array.from({ length: 19 }, (_, index) => 12 + index * 6));
  assert.equal(new Set(nodes.map((node) => node.id)).size, TARGET_WORLD_NODE_COUNT);
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      assert.equal(nearDuplicatePossibilityTitle(nodes[left].title, nodes[right].title), false,
        `near duplicate: ${nodes[left].title} / ${nodes[right].title}`);
    }
  }
  assert.ok(new Set(nodes.map((node) => node.category)).size >= 20);
  assert.equal(new Set(nodes.map((node) => node.nodeKind)).size, nodeKinds.length);

  const at120 = await guard.snapshot();
  const statsAt120 = transport.stats();
  assert.equal(statsAt120.modelDiscoveryRequests, 1);
  assert.equal(statsAt120.chatPosts, 162, '160 baseline posts plus candidate and Stage G recovery are expected');
  assert.equal(at120.chatPostsCompleted, 162);
  assert.equal(at120.scopes.world.chatPostsCompleted, 162);
  assert.equal(at120.scopes.review.chatPostsCompleted, 0);
  assert.equal(statsAt120.candidateRecoveryInjected, true);
  assert.equal(statsAt120.stageGInjected, true);
  assert.ok(statsAt120.driftPrompts.some((prompt) => prompt.includes('Semantic drift zone 1')));
  assert.ok(statsAt120.driftPrompts.some((prompt) => prompt.includes('Semantic drift zone 2')));
  assert.ok(statsAt120.driftPrompts.some((prompt) => prompt.includes('Semantic drift zone 3')));

  const nodesAt120 = nodes;
  const statesAt120 = nodeStates;
  const contextChanged = structuredClone(generationContext);
  contextChanged.userProfile.practicalProfile.push('最近、公共空間の活用にも関心が生まれた');
  const contextExpansion = await invokeMiddleware(api.worldExpandMiddleware, {
    generationContext: contextChanged,
    explorationBand: MAX_WORLD_EXPANSION_BATCH,
    expansionReason: 'person_context',
    existingNodes: nodes.map(summaryOf),
    keptNodeIds: nodes.filter((node) => nodeStates[node.id]?.kept).map((node) => node.id),
    landedNodeIds: nodes.filter((node) => nodeStates[node.id]?.landed).map((node) => node.id),
  });
  assert.equal(contextExpansion.status, 200, JSON.stringify(contextExpansion.body));
  const contextPrepared = prepareAdditiveWorldExpansion(
    nodes,
    contextExpansion.body.nodes,
    nodeStates,
    explorationBands,
    MAX_WORLD_EXPANSION_BATCH,
  );
  assert.equal(contextPrepared.appended.length, WORLD_EXPANSION_BATCH_SIZE);
  assert.deepEqual(contextPrepared.nodes.slice(0, TARGET_WORLD_NODE_COUNT), nodesAt120);
  for (const node of nodesAt120) assert.deepEqual(contextPrepared.nodeStates[node.id], statesAt120[node.id]);
  assert.deepEqual(generationContext.personState, personStateBefore);
  assert.deepEqual(shipBefore, { x: 0, y: 310 });
  assert.deepEqual(trailBefore, [{ x: 0, y: 310, t: 1 }]);

  const finalGuard = await guard.snapshot();
  assert.equal(finalGuard.chatPostsCompleted, 170);
  assert.equal(finalGuard.scopes.review.chatPostsCompleted, 0);
  assert.equal(contextPrepared.nodes.length, 126);
  console.log('[world-120-mock-evidence]', JSON.stringify({
    counts: countAfterEachExpansion,
    uniqueAtFrontier: new Set(nodesAt120.map((node) => node.id)).size,
    categoriesAtFrontier: new Set(nodesAt120.map((node) => node.category)).size,
    nodeKindsAtFrontier: new Set(nodesAt120.map((node) => node.nodeKind)).size,
    candidateRejectionsRecovered: statsAt120.candidateRecoveryInjected ? 1 : 0,
    stageGRetriesRecovered: statsAt120.stageGInjected ? 1 : 0,
    chatPostsAt120: at120.chatPostsCompleted,
    baselineChatPostsAt120: 160,
    estimatedInputTokensReservedAt120: at120.estimatedInputTokensReserved,
    estimatedOutputTokensReservedAt120: at120.estimatedOutputTokensReserved,
    estimatedUsdReservedAt120: at120.estimatedUsdReserved,
    mockActualPromptTokensAt120: at120.actualPromptTokens,
    mockActualCompletionTokensAt120: at120.actualCompletionTokens,
    mockActualUsdAt120: at120.actualUsd,
    afterPersonContextNodeCount: contextPrepared.nodes.length,
    finalChatPosts: finalGuard.chatPostsCompleted,
  }));
});
