import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeLocalStep,
  computeSemanticLayout,
  emptyPersonState,
  type LocalSmallStep,
  type PersonState,
  type PossibilityNode,
  type PossibilityNodeState,
} from '../src/livingFlow.ts';
import { createMemoryWorldRepository } from '../src/worldRepository.ts';
import {
  WORLD_LAYOUT_VERSION,
  WORLD_SCHEMA_VERSION,
  parsePersistedWorld,
  reconcilePersistedWorld,
  type PersistedWorldSnapshotV1,
} from '../src/worldState.ts';
import {
  createInitialProductState,
  createLocalStorageProductStateRepository,
  persistedSnapshot,
  productStateReducer,
  type BrowserStorage,
} from '../src/productState.ts';
import { planShipVoyage } from '../src/islandNavigation.ts';

const recipe = {
  visualTheme: 'field_observation',
  dominantMotif: 'observation_station',
  secondaryObjects: ['notebook', 'scope'],
  terrainProfile: 'gentle_hill',
  accentPalette: 'sea_green',
  density: 'medium' as const,
  openness: 'balanced' as const,
  landmarkEmphasis: 'medium' as const,
  energyLevel: 'calm' as const,
};

const node = (id: string): PossibilityNode => ({
  id,
  title: `島 ${id}`,
  shortDescription: '身近な場所から小さな観察を始める。',
  category: '探究',
  nodeKind: 'activity',
  relationToGoal: 'adjacent',
  curiosityFit: .8,
  accessibility: .7,
  novelty: .6,
  friction: .2,
  portableResourceTags: ['observation'],
  connectionTags: ['field'],
  helpedByTags: ['observation'],
  visualRecipe: recipe,
});

const state = (overrides: Partial<PossibilityNodeState> = {}): PossibilityNodeState => ({
  visible: true,
  visited: false,
  kept: false,
  activePursuit: false,
  landed: false,
  worldTier: 'near',
  completedStepIds: [],
  ...overrides,
});

const stepsFor = (owner: string): LocalSmallStep[] => [1, 2, 3].map((index) => ({
  id: `${owner}-step-${index}`,
  title: `小さな行動 ${index}`,
  shortDescription: '短時間で試して記録する。',
  portableResources: ['knowledge'],
  connectionTags: ['field-note'],
  experienceTag: 'observation',
  resourceBridges: [{ resource: 'knowledge', bridgeTags: ['observation'] }],
  connectionBridgeTags: ['observation'],
  experienceBridgeTags: ['observation'],
}));

function snapshot(overrides: Partial<PersistedWorldSnapshotV1> = {}): PersistedWorldSnapshotV1 {
  const nodes = [node('node-a'), node('node-b')];
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    worldId: 'world-test',
    worldRevision: 3,
    savedAt: '2026-10-05T00:00:00.000Z',
    layoutVersion: WORLD_LAYOUT_VERSION,
    context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
    nodes,
    nodeStates: { 'node-a': state(), 'node-b': state({ worldTier: 'far' }) },
    explorationBands: { 'node-a': 0, 'node-b': 1 },
    generatedBatches: [{ band: 0, nodeIds: ['node-a'] }, { band: 1, nodeIds: ['node-b'] }],
    stepCatalog: {},
    detailCache: {},
    ship: { settledPosition: { x: 0, y: 310 } },
    selectedNodeId: 'node-a',
    ...overrides,
  };
}

test('Persisted World V1 round-trips with a missing Context Seed', () => {
  const original = snapshot({ context: { locale: 'ja', initialPersonContextRevision: 0, integratedPersonContextRevision: 0 } });
  const parsed = parsePersistedWorld(JSON.parse(JSON.stringify(original)));
  assert.equal(parsed.status, 'ready');
  if (parsed.status === 'ready') assert.deepEqual(parsed.snapshot, original);
});

test('duplicate Node IDs are rejected', () => {
  const original = snapshot();
  const parsed = parsePersistedWorld({ ...original, nodes: [original.nodes[0], original.nodes[0]] });
  assert.deepEqual(parsed, { status: 'corrupt', reason: 'Duplicate Node ID.' });
});

test('unknown Node-state references are rejected', () => {
  const original = snapshot();
  const parsed = parsePersistedWorld({ ...original, nodeStates: { ...original.nodeStates, ghost: state() } });
  assert.equal(parsed.status, 'corrupt');
});

test('incoherent exploration band and batch membership is rejected', () => {
  const original = snapshot();
  const parsed = parsePersistedWorld({ ...original, generatedBatches: [{ band: 0, nodeIds: ['node-a', 'node-b'] }] });
  assert.equal(parsed.status, 'corrupt');
});

test('invalid Step ownership and completion relationships are rejected', () => {
  const original = snapshot();
  const parsed = parsePersistedWorld({
    ...original,
    nodeStates: { ...original.nodeStates, 'node-a': state({ completedStepIds: ['foreign-step'] }) },
    stepCatalog: { 'node-a': stepsFor('node-a') },
  });
  assert.equal(parsed.status, 'corrupt');
});

test('historical Landed state cannot be downgraded and repairs its canonical PersonState marker', () => {
  const original = snapshot({ nodeStates: { 'node-a': state({ visited: true, kept: true, landed: true }), 'node-b': state() } });
  const reconciled = reconcilePersistedWorld(original, emptyPersonState());
  assert.equal(reconciled.snapshot.nodeStates['node-a'].landed, true);
  assert.equal(reconciled.personState.experiences.some((experience) => experience.stepId === 'landed:node-a'), true);
});

test('completed Steps reconcile from authoritative Product PersonState', () => {
  const steps = stepsFor('node-a');
  let personState: PersonState = emptyPersonState();
  personState = completeLocalStep(personState, snapshot().nodes[0], steps[0]);
  const original = snapshot({ stepCatalog: { 'node-a': steps } });
  const reconciled = reconcilePersistedWorld(original, personState);
  assert.deepEqual(reconciled.snapshot.nodeStates['node-a'].completedStepIds, [steps[0].id]);
});

test('post-STEP_DONE voyage checkpoint lands once without replaying a tween', () => {
  const original = snapshot();
  const steps = stepsFor('node-a');
  let personState = emptyPersonState();
  for (const step of steps) personState = completeLocalStep(personState, original.nodes[0], step);
  const nodeStates = {
    ...original.nodeStates,
    'node-a': state({ visited: true, kept: true, activePursuit: true, completedStepIds: steps.map((step) => step.id) }),
  };
  const placement = computeSemanticLayout(original.nodes, personState, { 'node-a': 'near', 'node-b': 'far' }, original.explorationBands);
  const target = placement.find((entry) => entry.nodeId === 'node-a')!;
  const checkpoint = snapshot({
    nodeStates,
    stepCatalog: { 'node-a': steps },
    ship: { settledPosition: { x: target.targetX, y: target.targetY } },
  });
  const reconciled = reconcilePersistedWorld(checkpoint, personState);
  assert.equal(reconciled.snapshot.nodeStates['node-a'].landed, true);
  assert.equal(reconciled.snapshot.nodeStates['node-a'].activePursuit, false);
  assert.equal(reconciled.personState.experiences.filter((entry) => entry.stepId === 'landed:node-a').length, 1);
  const repeated = reconcilePersistedWorld(reconciled.snapshot, reconciled.personState);
  assert.equal(repeated.personState.experiences.filter((entry) => entry.stepId === 'landed:node-a').length, 1);
});

test('safe sea-berth checkpoint survives reload and lands without changing history', () => {
  const original = snapshot();
  const steps = stepsFor('node-a');
  let personState = emptyPersonState();
  for (const step of steps) personState = completeLocalStep(personState, original.nodes[0], step);
  const nodeStates = {
    ...original.nodeStates,
    'node-a': state({ visited: true, kept: true, activePursuit: true, completedStepIds: steps.map((step) => step.id) }),
  };
  const placement = computeSemanticLayout(original.nodes, personState, { 'node-a': 'near', 'node-b': 'far' }, original.explorationBands);
  const voyage = planShipVoyage(
    { x: 0, y: 310 },
    original.nodes[0],
    placement,
    placement,
    original.nodes,
    3,
    3,
  );
  const checkpoint = snapshot({
    nodeStates,
    stepCatalog: { 'node-a': steps },
    ship: { settledPosition: voyage.landingAnchor },
  });
  const reconciled = reconcilePersistedWorld(checkpoint, personState);
  assert.equal(reconciled.snapshot.nodeStates['node-a'].landed, true);
  assert.equal(reconciled.snapshot.nodeStates['node-a'].activePursuit, false);
  assert.deepEqual(reconciled.snapshot.ship.settledPosition, voyage.landingAnchor);
  assert.deepEqual(reconciled.snapshot.nodeStates['node-b'], original.nodeStates['node-b']);
  const repeated = reconcilePersistedWorld(reconciled.snapshot, reconciled.personState);
  assert.equal(repeated.personState.experiences.filter((entry) => entry.stepId === 'landed:node-a').length, 1);
});

test('selected Node restores only when it still exists', () => {
  const valid = parsePersistedWorld(snapshot({ selectedNodeId: 'node-b' }));
  assert.equal(valid.status === 'ready' ? valid.snapshot.selectedNodeId : 'corrupt', 'node-b');
  const invalid = parsePersistedWorld(snapshot({ selectedNodeId: 'deleted-node' }));
  assert.equal(invalid.status === 'ready' ? invalid.snapshot.selectedNodeId : 'corrupt', null);
});

test('successful Peek Detail and its Person Context revision persist', () => {
  const original = snapshot({
    detailCache: {
      'node-a': {
        detail: { overview: '観察を続ける活動です。', expectedOutcomes: ['観察記録'], personConnection: '今の関心との接点を探れます。' },
        generatedFromPersonContextRevision: 4,
      },
    },
  });
  const parsed = parsePersistedWorld(original);
  assert.equal(parsed.status, 'ready');
  if (parsed.status === 'ready') assert.deepEqual(parsed.snapshot.detailCache, original.detailCache);
});

test('serialized repository writes cannot let an older revision overwrite a newer one', async () => {
  const repository = createMemoryWorldRepository();
  await Promise.all([repository.save(snapshot({ worldRevision: 8 })), repository.save(snapshot({ worldRevision: 7 }))]);
  const loaded = await repository.loadActive();
  assert.equal(loaded.status === 'ready' ? loaded.snapshot.worldRevision : -1, 8);
});

test('a corrupt World is retained for recovery without damaging ProductState', async () => {
  const values = new Map<string, string>();
  const storage: BrowserStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const productRepository = createLocalStorageProductStateRepository(storage);
  const product = productStateReducer(createInitialProductState(), {
    type: 'CONFIRM_PERSON_CONTEXT',
    context: { interests: ['海辺'], engagementPatterns: [], constraints: [], recentChanges: [] },
  });
  productRepository.save(persistedSnapshot(product));
  const before = productRepository.load();
  const worldRepository = createMemoryWorldRepository({ broken: true });
  assert.equal((await worldRepository.loadActive()).status, 'corrupt');
  assert.deepEqual(productRepository.load(), before);
  assert.deepEqual(worldRepository.readRaw(), { broken: true });
});

test('missing or corrupt World never creates fixture progress', async () => {
  const missing = createMemoryWorldRepository();
  assert.deepEqual(await missing.loadActive(), { status: 'missing' });
  const corrupt = createMemoryWorldRepository('{not-world');
  assert.equal((await corrupt.loadActive()).status, 'corrupt');
  assert.equal(corrupt.readRaw(), '{not-world');
});
