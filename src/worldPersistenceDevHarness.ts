import {
  applyLandingResources,
  completeLocalStep,
  computeSemanticLayout,
  emptyPersonState,
  type LocalSmallStep,
  type PossibilityNode,
  type PossibilityNodeState,
} from './livingFlow';
import { createLocalStorageProductStateRepository, type PersistedProductState } from './productState';
import { createIndexedDbWorldRepository } from './worldRepository';
import { WORLD_LAYOUT_VERSION, WORLD_SCHEMA_VERSION, type PersistedWorldSnapshotV1 } from './worldState';

const PROBE_KEY = 'kurohige-map.persistence-probe';
const blockedPaths = ['/api/possibility-map', '/api/world-expand', '/api/node-steps', '/api/node-detail'];

type PersistenceProbe = { calls: string[]; blocked: boolean; harnessAction: string };

function installFetchProbe(action: string) {
  const scope = window as typeof window & { __kurohigePersistenceProbe?: PersistenceProbe };
  if (scope.__kurohigePersistenceProbe) {
    scope.__kurohigePersistenceProbe.harnessAction = action;
    return;
  }
  const nativeFetch = window.fetch.bind(window);
  const probe: PersistenceProbe = { calls: [], blocked: true, harnessAction: action };
  scope.__kurohigePersistenceProbe = probe;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (blockedPaths.some((path) => new URL(url, window.location.href).pathname === path)) {
      probe.calls.push(new URL(url, window.location.href).pathname);
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Blocked by persistence verification harness.' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;
}

const recipe = (index: number) => ({
  visualTheme: `exploration_${index % 4}`,
  dominantMotif: ['field_station', 'workshop', 'community_table', 'observation_deck'][index % 4],
  secondaryObjects: ['notebook', 'sign', 'small_shelter'],
  terrainProfile: ['gentle_hill', 'terraced', 'open_shore'][index % 3],
  accentPalette: ['sea_green', 'warm_coral', 'sunny_yellow'][index % 3],
  density: (['sparse', 'medium', 'dense'] as const)[index % 3],
  openness: (['open', 'balanced', 'compact'] as const)[index % 3],
  landmarkEmphasis: (['low', 'medium', 'high'] as const)[index % 3],
  energyLevel: (['calm', 'moderate', 'high'] as const)[index % 3],
});

const nodes: PossibilityNode[] = Array.from({ length: 18 }, (_, index) => ({
  id: `persist-node-${String(index + 1).padStart(2, '0')}`,
  title: ['海辺の観察記録', '地域の小さな展示', '音の散歩', '手仕事の交換会', 'まちの聞き書き', '小さな菜園'][index % 6] + ` ${index + 1}`,
  shortDescription: '身近な場所から始め、経験を次の可能性へつなげる小さな活動です。',
  category: ['探究', '表現', '地域', '自然'][index % 4],
  nodeKind: (['activity', 'experience', 'information', 'opportunity', 'skill', 'community'] as const)[index % 6],
  relationToGoal: (['direct', 'adjacent', 'exploratory'] as const)[index % 3],
  curiosityFit: .45 + (index % 5) * .1,
  accessibility: .55 + (index % 4) * .08,
  novelty: .5 + (index % 3) * .12,
  friction: .18 + (index % 4) * .1,
  portableResourceTags: ['observation', 'documentation'],
  connectionTags: ['local', 'field-note'],
  helpedByTags: index % 2 ? ['documentation'] : ['observation'],
  visualRecipe: recipe(index),
}));

const stepsFor = (nodeId: string): LocalSmallStep[] => [1, 2, 3].map((index) => ({
  id: `${nodeId}-step-${index}`,
  title: `小さな一歩 ${index}`,
  shortDescription: '10分だけ試し、気づきを一つ記録する。',
  portableResources: ['knowledge'],
  connectionTags: ['field-note'],
  experienceTag: 'observation',
  resourceBridges: [{ resource: 'knowledge', bridgeTags: ['observation'] }],
  connectionBridgeTags: ['documentation'],
  experienceBridgeTags: ['observation'],
}));

const baseState = (index: number): PossibilityNodeState => ({
  visible: true,
  visited: index < 4,
  kept: index < 4,
  activePursuit: index === 1,
  landed: index === 0,
  worldTier: index < 6 ? 'near' : 'far',
  completedStepIds: [],
});

function persistenceFixture() {
  const landedSteps = stepsFor(nodes[0].id);
  const activeSteps = stepsFor(nodes[1].id);
  const reviewJourneySteps = stepsFor(nodes[2].id);
  let personState = emptyPersonState();
  for (const step of landedSteps) personState = completeLocalStep(personState, nodes[0], step);
  personState = applyLandingResources(personState, nodes[0]);
  personState = completeLocalStep(personState, nodes[1], activeSteps[0]);
  const nodeStates = Object.fromEntries(nodes.map((node, index) => [node.id, baseState(index)])) as Record<string, PossibilityNodeState>;
  nodeStates[nodes[0].id].completedStepIds = landedSteps.map((step) => step.id);
  nodeStates[nodes[1].id].completedStepIds = [activeSteps[0].id];
  const explorationBands = Object.fromEntries(nodes.map((node, index) => [node.id, index < 12 ? 0 : 1]));
  const placement = computeSemanticLayout(nodes, personState, Object.fromEntries(nodes.map((node) => [node.id, nodeStates[node.id].worldTier])), explorationBands);
  const landedTarget = placement.find((entry) => entry.nodeId === nodes[0].id)!;
  const productState: PersistedProductState = {
    version: 2,
    personState,
    userProfile: { nickname: '航海テスト', region: { countryCode: 'JP', administrativeArea: '東京都' }, updatedAt: '2026-10-05T00:00:00.000Z' },
    onboardingComplete: true,
    personContextRevision: 3,
    observedPersonSignals: [],
  };
  const world: PersistedWorldSnapshotV1 = {
    schemaVersion: WORLD_SCHEMA_VERSION,
    worldId: `persistence-fixture-${Date.now()}`,
    worldRevision: 100,
    savedAt: new Date().toISOString(),
    layoutVersion: WORLD_LAYOUT_VERSION,
    context: { contextSeed: null, locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 3 },
    nodes,
    nodeStates,
    explorationBands,
    generatedBatches: [
      { band: 0, nodeIds: nodes.slice(0, 12).map((node) => node.id) },
      { band: 1, nodeIds: nodes.slice(12).map((node) => node.id) },
    ],
    stepCatalog: { [nodes[0].id]: landedSteps, [nodes[1].id]: activeSteps, [nodes[2].id]: reviewJourneySteps },
    detailCache: {
      [nodes[2].id]: {
        detail: {
          overview: 'まちを歩きながら身近な音を記録し、小さな音の地図をつくる活動です。',
          expectedOutcomes: ['観察記録', '短い音声作品'],
          personConnection: '今の観察経験を、表現や地域との接点へ広げられる可能性があります。',
        },
        generatedFromPersonContextRevision: 3,
      },
    },
    ship: { settledPosition: { x: landedTarget.targetX, y: landedTarget.targetY } },
    selectedNodeId: nodes[2].id,
  };
  return { productState, world };
}

export async function prepareWorldPersistenceDevHarness() {
  const query = new URLSearchParams(window.location.search);
  const action = query.get('persistenceHarness');
  if (action === 'seed' || action === 'firstRun' || action === 'corrupt') sessionStorage.setItem(PROBE_KEY, '1');
  if (action === 'stop') sessionStorage.removeItem(PROBE_KEY);
  if (sessionStorage.getItem(PROBE_KEY) === '1') installFetchProbe(action ?? 'reload');
  if (!action) return;

  const repository = createIndexedDbWorldRepository();
  if (action === 'seed') {
    const fixture = persistenceFixture();
    createLocalStorageProductStateRepository(window.localStorage).save(fixture.productState);
    await repository.save(fixture.world);
  } else if (action === 'corrupt') {
    await repository.corruptActiveForTest?.({ schemaVersion: 1, broken: true });
  } else if (action === 'firstRun') {
    await repository.clearActive();
    createLocalStorageProductStateRepository(window.localStorage).clear();
  } else if (action === 'clear' || action === 'stop') {
    await repository.clearActive();
  }
  history.replaceState(null, '', '/');
}
