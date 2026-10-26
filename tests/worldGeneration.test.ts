import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PossibilityNode } from '../src/livingFlow.ts';
import { appendDistinctPossibilityNodes, prepareAdditiveWorldExpansion } from '../src/worldExpansion.ts';
import {
  INITIAL_WORLD_NODE_COUNT,
  MAX_WORLD_EXPANSION_BATCH,
  TARGET_WORLD_NODE_COUNT,
  WORLD_EXPANSION_BATCH_SIZE,
} from '../src/worldCapacity.ts';

const node = (id: string, title = `可能性 ${id}`) => ({ id, title }) as PossibilityNode;

test('camera exploration capacity remains 12 + eighteen six-node batches = 120 unique Nodes', () => {
  const distinctTitle = (index: number) => `体験${String.fromCodePoint(0x4e00 + index)}`;
  let sequence = 0;
  let world = Array.from({ length: INITIAL_WORLD_NODE_COUNT }, (_, index) => node(`initial-${index}`, distinctTitle(sequence++)));
  for (let band = 1; band <= MAX_WORLD_EXPANSION_BATCH; band++) {
    const incoming = Array.from({ length: WORLD_EXPANSION_BATCH_SIZE }, (_, index) => node(`band-${band}-${index}`, distinctTitle(sequence++)));
    const appended = appendDistinctPossibilityNodes(world, incoming);
    assert.equal(appended.length, WORLD_EXPANSION_BATCH_SIZE);
    world = [...world, ...appended];
  }
  assert.equal(world.length, TARGET_WORLD_NODE_COUNT);
  assert.equal(new Set(world.map((entry) => entry.id)).size, TARGET_WORLD_NODE_COUNT);
});

test('client duplicate guard rejects ID collisions and close paraphrase titles without diluting the World', () => {
  const existing = [node('existing', 'AIで作った楽曲をYouTubeに公開する')];
  const incoming = [
    node('existing', '別のタイトル'),
    node('paraphrase', 'AIで作った楽曲を YouTube に公開する'),
    node('unique', '地域の古い写真をデジタル展示にまとめる'),
  ];
  assert.deepEqual(appendDistinctPossibilityNodes(existing, incoming).map((entry) => entry.id), ['unique']);
});

test('an incomplete failed expansion leaves the existing World and history untouched', () => {
  const existing = [node('kept', '写真を展示する'), node('landed', '畑を見学する')];
  const states = {
    kept: { visible: true, visited: true, kept: true, activePursuit: false, landed: false, worldTier: 'near', completedStepIds: ['s1'] },
    landed: { visible: true, visited: true, kept: true, activePursuit: false, landed: true, worldTier: 'far', completedStepIds: ['s2', 's3', 's4'] },
  } as const;
  const bands = { kept: 0, landed: 2 } as const;
  const before = structuredClone({ existing, states, bands });
  const candidate = prepareAdditiveWorldExpansion(existing, [node('new', '音楽を公開する')], states, bands, 3);
  assert.notEqual(candidate.appended.length, WORLD_EXPANSION_BATCH_SIZE);
  assert.deepEqual({ existing, states, bands }, before);
});

test('normal Product connects confirmed Person Map revisions to additive expansion and preserves DEV fixture isolation', () => {
  const shell = readFileSync(new URL('../src/ProductShell.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../src/LivingFlowPilot.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(shell, /PERSON_CONTEXT_EXPANSION_REQUESTED/u);
  assert.match(flow, /expansionReason: 'person_context'/u);
  assert.match(flow, /worldIntegratedContextRevisionRef\.current = requestedRevision/u);
  assert.match(flow, /prepareAdditiveWorldExpansion\(/u);
  assert.match(flow, /nodes: allNodes/u);
  assert.doesNotMatch(flow, /setNodes\(appended\)/u);
  assert.match(app, /if \(livingFlowPilot\) return <LivingFlowPilot \/>/u);
  assert.match(app, /return <ProductShell \/>/u);
});

test('Person Map expansion preserves every existing Keep, Landed, pursuit, and completed-Step state', () => {
  const existing = [node('kept'), node('landed')];
  const states = {
    kept: { visible: true, visited: true, kept: true, activePursuit: true, landed: false, worldTier: 'near', completedStepIds: ['step-a'] },
    landed: { visible: true, visited: true, kept: true, activePursuit: false, landed: true, worldTier: 'far', completedStepIds: ['step-b', 'step-c', 'step-d'] },
  } as const;
  const bands = { kept: 0, landed: 4 } as const;
  const prepared = prepareAdditiveWorldExpansion(existing, [node('new', '新しい領域を試す')], states, bands, 4);
  assert.deepEqual(prepared.nodeStates.kept, states.kept);
  assert.deepEqual(prepared.nodeStates.landed, states.landed);
  assert.deepEqual(prepared.explorationBands.kept, 0);
  assert.deepEqual(prepared.explorationBands.landed, 4);
  assert.equal(prepared.nodes.length, 3);
  assert.deepEqual(prepared.nodeStates.new.completedStepIds, []);
});
