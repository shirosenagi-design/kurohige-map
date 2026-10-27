import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LivingMap, type ExplorationFrontierSnapshot, type ShipMoveCommand, type ShipMovementSnapshot } from './LivingMap';
import type { NodeFlags, PlacedNode } from './model';
import type { NodePosition } from './spatial';
import { useProductState } from './ProductStateProvider';
import { ACTIVE_PRODUCT_LOCALE, t } from './i18n';
import { canStartInitialWorldGeneration, createProductGenerationContext } from './generationContext';
import { isOnboardingProfileComplete, type WorldGenerationCommand } from './productState';
import { SailingLoader } from './SailingLoader';
import { ReviewSection } from './ReviewSection';
import { VoyageLogList } from './VoyageLogList';
import { voyageLogTitle } from './voyageLog';
import {
  applyLandingResources, asSemanticNode, completeLocalStep, computeSemanticLayout, computeSemanticStepTrace,
  initialWorldTiers, type ExplorationBand, type LocalSmallStep, type PersonState,
  type PossibilityNode, type PossibilityNodeState, type SemanticLayoutEntry, type SemanticStepTrace, type WorldTier,
} from './livingFlow';
import { landingReached, planShipVoyage, WORLD_LANDING_RADIUS } from './islandNavigation';
import {
  FRONTIER_AHEAD_BATCHES,
  INITIAL_WORLD_NODE_COUNT,
  MAX_WORLD_NODE_SUMMARIES,
  MAX_WORLD_EXPANSION_BATCH,
  TARGET_WORLD_NODE_COUNT,
  WORLD_EXPANSION_BATCH_SIZE,
} from './worldCapacity';
import { appendDistinctPossibilityNodes, prepareAdditiveWorldExpansion } from './worldExpansion';
import { createIndexedDbWorldRepository, type WorldRepository } from './worldRepository';
import { cameraForPersonContextExpansion, requestPersonContextExpansion, savePersonContextExpansion } from './personContextExpansionRequest';
import { createSampleNodeDetail, createSampleSmallSteps, sampleNodesForBand } from './sampleMode';
import { notifyWorldPersisted } from './localPersistenceSignals';
import {
  WORLD_LAYOUT_VERSION,
  WORLD_SCHEMA_VERSION,
  createWorldId,
  reconcilePersistedWorld,
  type NodeDetail,
  type PersistedWorldSnapshotV1,
} from './worldState';

type ApiDiagnostic = Record<string, unknown>;
type PossibilityMapResponse = { parentGoal?: string; nodes?: PossibilityNode[]; model?: string; diagnostic?: ApiDiagnostic; error?: { message?: string } };
type NodeStepsResponse = { steps?: LocalSmallStep[]; model?: string; diagnostic?: ApiDiagnostic; error?: { message?: string } };
type NodeDetailResponse = Partial<NodeDetail> & { model?: string; diagnostic?: ApiDiagnostic; error?: { message?: string } };
type DistanceAudit = { before: number; after: number; requestedDisplacement: number; effectiveDisplacement: number };
type ReactionMetrics = { shipDisplacement: number; medianIslandDisplacement: number; maxIslandDisplacement: number };
type ProductMapSection = 'map' | 'list';
type ListFilter = 'kept' | 'voyageLog';
export type WorldHydrationStatus = 'hydrating' | 'ready' | 'missing' | 'corrupt';
export type WorldHydrationSnapshot = { status: WorldHydrationStatus; hasWorld: boolean; nodeCount: number };
type ExplorationBatch = {
  band: ExplorationBand;
  camera: ExplorationFrontierSnapshot | null;
  nodes: { id: string; title: string; category: string; nodeKind: string; relationToGoal: string }[];
};

const INITIAL_SHIP_POSITION = { x: 0, y: 310 };
const LANDING_RADIUS = WORLD_LANDING_RADIUS;
const legacyParentGoalForRequest = (contextSeed: string) => contextSeed.trim() || '現在のPerson Contextから広がる可能性';
const emptyReaction: ReactionMetrics = { shipDisplacement: 0, medianIslandDisplacement: 0, maxIslandDisplacement: 0 };
const flagsFromStates = (states: Record<string, PossibilityNodeState>): Record<string, NodeFlags> => Object.fromEntries(
  Object.entries(states).map(([id, state]) => [id, { kept: state.kept, visited: state.visited }]),
);
const tiersFromStates = (states: Record<string, PossibilityNodeState>): Record<string, WorldTier> => Object.fromEntries(
  Object.entries(states).map(([id, state]) => [id, state.worldTier]),
);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const kindLabel: Record<PossibilityNode['nodeKind'], string> = {
  activity: t('map.kind.activity'), experience: t('map.kind.experience'), information: t('map.kind.information'), opportunity: t('map.kind.opportunity'), skill: t('map.kind.skill'), community: t('map.kind.community'),
};
const relationLabel: Record<PossibilityNode['relationToGoal'], string> = {
  direct: t('map.relation.direct'), adjacent: t('map.relation.adjacent'), exploratory: t('map.relation.exploratory'),
};

export function LivingFlowPilot({
  productView = false,
  productSection = 'map',
  onProductSectionChange,
  onWorldHydrationChange,
  initialWorldGenerationCommand,
  initialWorldGenerationRequestId = 0,
  onInitialWorldGenerationChange,
  devOffline = false,
  sampleMode = false,
  worldRepository,
}: {
  productView?: boolean;
  productSection?: ProductMapSection;
  onProductSectionChange?: (section: ProductMapSection) => void;
  onWorldHydrationChange?: (snapshot: WorldHydrationSnapshot) => void;
  initialWorldGenerationCommand?: WorldGenerationCommand | null;
  initialWorldGenerationRequestId?: number;
  onInitialWorldGenerationChange?: (result: { status: 'loading' | 'success' | 'error'; error?: string }) => void;
  devOffline?: boolean;
  sampleMode?: boolean;
  worldRepository?: WorldRepository;
}) {
  const { state: canonicalProductState, dispatch: productDispatch } = useProductState();
  const personState = canonicalProductState.personState;
  const [parentGoalInput, setParentGoalInput] = useState('');
  const [parentGoal, setParentGoal] = useState('');
  const [nodes, setNodes] = useState<PossibilityNode[]>([]);
  const [placement, setPlacement] = useState<SemanticLayoutEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [nodeStates, setNodeStates] = useState<Record<string, PossibilityNodeState>>({});
  const [explorationBands, setExplorationBands] = useState<Record<string, ExplorationBand>>({});
  const [explorationBand, setExplorationBand] = useState<ExplorationBand>(0);
  const [batchHistory, setBatchHistory] = useState<ExplorationBatch[]>([]);
  const [stepCatalog, setStepCatalog] = useState<Record<string, LocalSmallStep[]>>({});
  const [dismissedStepsNodeId, setDismissedStepsNodeId] = useState('');
  const [detailCache, setDetailCache] = useState<Record<string, NodeDetail>>({});
  const [detailNodeId, setDetailNodeId] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [completedStep, setCompletedStep] = useState<LocalSmallStep | null>(null);
  const [shipPosition, setShipPosition] = useState(INITIAL_SHIP_POSITION);
  const [shipSnapshot, setShipSnapshot] = useState<ShipMovementSnapshot>({ ...INITIAL_SHIP_POSITION, moving: false, targetNodeId: null, trailPointCount: 0 });
  const [shipMove, setShipMove] = useState<ShipMoveCommand | null>(null);
  const [reaction, setReaction] = useState<ReactionMetrics>(emptyReaction);
  const [mapRevision, setMapRevision] = useState(0);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutUpdate, setLayoutUpdate] = useState<{ revision: number; targets: readonly PlacedNode[] } | null>(null);
  const [spatialSnapshot, setSpatialSnapshot] = useState<readonly NodePosition[]>([]);
  const [distanceAudit, setDistanceAudit] = useState<Record<string, DistanceAudit>>({});
  const [semanticTrace, setSemanticTrace] = useState<SemanticStepTrace | null>(null);
  const [mapDiagnostic, setMapDiagnostic] = useState<{ initial: ApiDiagnostic | null; expansion: ApiDiagnostic | null } | null>(null);
  const [stepsDiagnostic, setStepsDiagnostic] = useState<Record<string, ApiDiagnostic>>({});
  const [loadingMap, setLoadingMap] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [loadingExpansion, setLoadingExpansion] = useState(false);
  const [expansionError, setExpansionError] = useState('');
  const [cameraRestore, setCameraRestore] = useState<{ x: number; y: number; zoom: number } | null>(null);
  const [error, setError] = useState('');
  const [listFilter, setListFilter] = useState<ListFilter>('kept');
  const [worldHydrationStatus, setWorldHydrationStatus] = useState<WorldHydrationStatus>('hydrating');
  const [worldPersistenceError, setWorldPersistenceError] = useState('');
  const [reviewEligibilityRevision, setReviewEligibilityRevision] = useState(0);
  const [voyageLogRevision, setVoyageLogRevision] = useState(0);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const nodeStatesRef = useRef(nodeStates); nodeStatesRef.current = nodeStates;
  const personStateRef = useRef(personState); personStateRef.current = personState;
  const stepCatalogRef = useRef(stepCatalog); stepCatalogRef.current = stepCatalog;
  const placementRef = useRef(placement); placementRef.current = placement;
  const explorationBandsRef = useRef(explorationBands); explorationBandsRef.current = explorationBands;
  const explorationBandRef = useRef(explorationBand); explorationBandRef.current = explorationBand;
  const loadingExpansionRef = useRef(false);
  const requestedBandsRef = useRef(new Set<ExplorationBand>());
  const blockedBandsRef = useRef(new Set<ExplorationBand>());
  const lastFrontierCameraRef = useRef<ExplorationFrontierSnapshot | null>(null);
  const claimedStepCompletionsRef = useRef(new Set<string>());
  const detailContextRevisionRef = useRef<Record<string, number | undefined>>({});
  const worldRepositoryRef = useRef<WorldRepository | null>(null);
  if (!worldRepositoryRef.current) worldRepositoryRef.current = worldRepository ?? createIndexedDbWorldRepository();
  const worldIdRef = useRef('');
  const worldRevisionRef = useRef(0);
  const worldInitialContextRevisionRef = useRef(0);
  const worldIntegratedContextRevisionRef = useRef(0);
  const hydrationRunRef = useRef(0);
  const skipNextHydratedPersistenceRef = useRef(false);
  const onWorldHydrationChangeRef = useRef(onWorldHydrationChange);
  onWorldHydrationChangeRef.current = onWorldHydrationChange;
  const onInitialWorldGenerationChangeRef = useRef(onInitialWorldGenerationChange);
  onInitialWorldGenerationChangeRef.current = onInitialWorldGenerationChange;
  const handledInitialWorldRequestRef = useRef(0);
  const handledContextExpansionRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const reviewEligibilityQueueRef = useRef<Promise<void>>(Promise.resolve());
  const reviewSessionReadyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const commitNodeStates = (updater: Record<string, PossibilityNodeState> | ((current: Record<string, PossibilityNodeState>) => Record<string, PossibilityNodeState>)) => {
    const next = typeof updater === 'function' ? updater(nodeStatesRef.current) : updater;
    nodeStatesRef.current = next;
    setNodeStates(next);
    return next;
  };
  const commitPersonState = (next: PersonState) => {
    personStateRef.current = next;
    productDispatch({ type: 'REPLACE_PERSON_STATE', personState: next });
  };
  const queueReviewEligibilityEvent = (path: string, body: unknown, onSuccess?: () => void) => {
    if (devOffline || sampleMode || !productView) return;
    reviewEligibilityQueueRef.current = reviewEligibilityQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!reviewSessionReadyRef.current) {
          const session = await fetch('/api/reviews/session', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          if (!session.ok) return;
          reviewSessionReadyRef.current = true;
        }
        const response = await fetch(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (response.ok) onSuccess?.();
      });
  };
  const recordLandingJourney = (node: PossibilityNode, steps: readonly LocalSmallStep[]) => {
    if (steps.length !== 3) return;
    queueReviewEligibilityEvent(`/api/reviews/nodes/${encodeURIComponent(node.id)}/journey`, {
      requiredStepIds: steps.map((step) => step.id),
      subjectCandidate: {
        name: node.title, summary: node.shortDescription, category: node.category, nodeKind: node.nodeKind,
        portableResourceTags: node.portableResourceTags, connectionTags: node.connectionTags, helpedByTags: node.helpedByTags ?? [],
      },
    });
  };

  const semanticNodes = useMemo(() => nodes.map(asSemanticNode), [nodes]);
  const flags = useMemo(() => flagsFromStates(nodeStates), [nodeStates]);
  const visibleNodes = nodes.filter((node) => nodeStates[node.id]?.visible);
  const nearNodes = nodes.filter((node) => nodeStates[node.id]?.worldTier === 'near');
  const farNodes = nodes.filter((node) => nodeStates[node.id]?.worldTier === 'far');
  const selected = nodes.find((node) => node.id === selectedId) ?? (productView ? null : visibleNodes[0] ?? null);
  const selectedState = selected ? nodeStates[selected.id] : undefined;
  const selectedSteps = selected ? stepCatalog[selected.id] ?? [] : [];
  const detailNode = nodes.find((node) => node.id === detailNodeId) ?? null;
  const openDetail = detailNode ? detailCache[detailNode.id] : undefined;
  const activePursuit = nodes.find((node) => nodeStates[node.id]?.activePursuit) ?? null;
  const landedNodeIds = nodes.filter((node) => nodeStates[node.id]?.landed).map((node) => node.id);
  const listNodes = nodes.filter((node) => listFilter === 'kept'
    ? nodeStates[node.id]?.kept && !nodeStates[node.id]?.landed
    : nodeStates[node.id]?.landed);

  useEffect(() => {
    const run = ++hydrationRunRef.current;
    let disposed = false;
    const hydrate = async () => {
      try {
        const loaded = await worldRepositoryRef.current!.loadActive();
        if (disposed || run !== hydrationRunRef.current) return;
        if (loaded.status === 'missing') {
          setWorldHydrationStatus('missing');
          return;
        }
        if (loaded.status === 'corrupt') {
          setWorldPersistenceError(loaded.reason);
          setWorldHydrationStatus('corrupt');
          return;
        }

        const reconciled = reconcilePersistedWorld(loaded.snapshot, personStateRef.current);
        const snapshot = reconciled.snapshot;
        const restoredDetails = Object.fromEntries(Object.entries(snapshot.detailCache).map(([nodeId, stored]) => [nodeId, stored.detail]));
        detailContextRevisionRef.current = Object.fromEntries(Object.entries(snapshot.detailCache)
          .map(([nodeId, stored]) => [nodeId, stored.generatedFromPersonContextRevision]));
        worldIdRef.current = snapshot.worldId;
        worldRevisionRef.current = snapshot.worldRevision;
        worldInitialContextRevisionRef.current = snapshot.context.initialPersonContextRevision;
        worldIntegratedContextRevisionRef.current = snapshot.context.integratedPersonContextRevision;
        nodesRef.current = snapshot.nodes;
        nodeStatesRef.current = snapshot.nodeStates;
        stepCatalogRef.current = snapshot.stepCatalog;
        placementRef.current = reconciled.placement;
        explorationBandsRef.current = snapshot.explorationBands;
        const restoredBand = Math.max(0, ...Object.values(snapshot.explorationBands)) as ExplorationBand;
        explorationBandRef.current = restoredBand;
        requestedBandsRef.current.clear();
        blockedBandsRef.current.clear();
        loadingExpansionRef.current = false;
        claimedStepCompletionsRef.current = new Set(Object.entries(snapshot.nodeStates)
          .flatMap(([nodeId, state]) => state.completedStepIds.map((stepId) => `${nodeId}::${stepId}`)));
        // Restoring an existing Snapshot is not a user mutation. Persisting the
        // hydrated values immediately would manufacture a new World revision and
        // make a just-restored Server Bundle diverge before the user changes it.
        skipNextHydratedPersistenceRef.current = true;

        setParentGoal(snapshot.context.contextSeed ?? '');
        setNodes(snapshot.nodes);
        setPlacement(reconciled.placement);
        setSelectedId(snapshot.selectedNodeId ?? '');
        setNodeStates(snapshot.nodeStates);
        setExplorationBands(snapshot.explorationBands);
        setExplorationBand(restoredBand);
        setBatchHistory(snapshot.generatedBatches.map((batch) => ({
          band: batch.band,
          camera: null,
          nodes: batch.nodeIds.map((nodeId) => snapshot.nodes.find((node) => node.id === nodeId)!)
            .map(({ id, title, category, nodeKind, relationToGoal }) => ({ id, title, category, nodeKind, relationToGoal })),
        })));
        setStepCatalog(snapshot.stepCatalog);
        setDetailCache(restoredDetails);
        setDetailNodeId('');
        setLoadingDetail(false);
        setDetailError('');
        setCompletedStep(null);
        setShipPosition(snapshot.ship.settledPosition);
        setShipSnapshot({ ...snapshot.ship.settledPosition, moving: false, targetNodeId: null, trailPointCount: 0 });
        setShipMove(null);
        setReaction(emptyReaction);
        setLayoutUpdate(null);
        setSpatialSnapshot([]);
        setCameraRestore(null);
        setLoadingExpansion(false);
        setExpansionError('');
        setSemanticTrace(null);
        if (reconciled.personState !== personStateRef.current) commitPersonState(reconciled.personState);
        setMapRevision((current) => current + 1);
        setWorldHydrationStatus('ready');
      } catch (caught) {
        if (disposed || run !== hydrationRunRef.current) return;
        setWorldPersistenceError(caught instanceof Error ? caught.message : 'World persistence could not be loaded.');
        setWorldHydrationStatus('corrupt');
      }
    };
    void hydrate();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    onWorldHydrationChangeRef.current?.({
      status: worldHydrationStatus,
      hasWorld: worldHydrationStatus === 'ready' && nodes.length > 0,
      nodeCount: nodes.length,
    });
  }, [worldHydrationStatus, nodes.length]);

  useEffect(() => {
    if (devOffline || sampleMode) return;
    if (!productView || initialWorldGenerationRequestId <= 0
      || handledInitialWorldRequestRef.current === initialWorldGenerationRequestId
      || initialWorldGenerationCommand?.type !== 'INITIAL_WORLD_GENERATION_REQUESTED'
      || worldHydrationStatus === 'hydrating'
      || !canonicalProductState.onboardingComplete
      || !isOnboardingProfileComplete(canonicalProductState.userProfile)) return;
    handledInitialWorldRequestRef.current = initialWorldGenerationRequestId;
    if (!canStartInitialWorldGeneration({
      status: worldHydrationStatus,
      nodeCount: nodesRef.current.length,
      onboardingComplete: canonicalProductState.onboardingComplete,
      profile: canonicalProductState.userProfile,
    })) {
      onInitialWorldGenerationChangeRef.current?.({ status: 'error', error: worldHydrationStatus === 'corrupt' ? t('summary.worldCorrupt') : t('summary.worldUnavailable') });
      return;
    }

    let disposed = false;
    const generateInitialWorld = async () => {
      setLoadingMap(true); setError(''); setExpansionError('');
      onInitialWorldGenerationChangeRef.current?.({ status: 'loading' });
      try {
        const generationContext = createProductGenerationContext(
          personStateRef.current,
          canonicalProductState.userProfile,
          initialWorldGenerationCommand.locale,
        );
        const initialResponse = await fetch('/api/possibility-map', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ generationContext }),
        });
        const initialPayload = await initialResponse.json() as PossibilityMapResponse;
        if (!initialResponse.ok || !initialPayload.nodes || initialPayload.nodes.length !== 6) {
          throw new Error(initialPayload.error?.message ?? `Possibility Map request failed (${initialResponse.status}).`);
        }
        const expansionResponse = await fetch('/api/world-expand', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            generationContext,
            explorationBand: 0,
            existingNodes: initialPayload.nodes.map(({ id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags }) => ({
              id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags,
            })),
            keptNodeIds: [], landedNodeIds: [],
          }),
        });
        const expansionPayload = await expansionResponse.json() as PossibilityMapResponse;
        if (!expansionResponse.ok || !expansionPayload.nodes || expansionPayload.nodes.length !== WORLD_EXPANSION_BATCH_SIZE) {
          throw new Error(expansionPayload.error?.message ?? `World expansion request failed (${expansionResponse.status}).`);
        }
        const initialExpansion = appendDistinctPossibilityNodes(initialPayload.nodes, expansionPayload.nodes);
        const allNodes = [...initialPayload.nodes, ...initialExpansion];
        if (allNodes.length !== INITIAL_WORLD_NODE_COUNT) throw new Error('最初の探索海域には12の異なる島が必要です。');
        const initialPersonState = personStateRef.current;
        const tiers = initialWorldTiers(allNodes);
        const bands = Object.fromEntries(allNodes.map((node) => [node.id, 0])) as Record<string, ExplorationBand>;
        const nextStates = Object.fromEntries(allNodes.map((node) => [node.id, {
          visible: true, visited: false, kept: false, activePursuit: false,
          landed: false, worldTier: tiers[node.id], completedStepIds: [],
        } satisfies PossibilityNodeState]));
        const nextPlacement = computeSemanticLayout(allNodes, initialPersonState, tiers, bands);
        const worldId = createWorldId();
        const generatedBatch = { band: 0 as ExplorationBand, nodeIds: allNodes.map((node) => node.id) };
        const snapshot: PersistedWorldSnapshotV1 = {
          schemaVersion: WORLD_SCHEMA_VERSION,
          worldId,
          worldRevision: 1,
          savedAt: new Date().toISOString(),
          layoutVersion: WORLD_LAYOUT_VERSION,
          context: {
            contextSeed: generationContext.contextSeed,
            locale: initialWorldGenerationCommand.locale,
            initialPersonContextRevision: canonicalProductState.personContextRevision,
            integratedPersonContextRevision: canonicalProductState.personContextRevision,
          },
          nodes: allNodes,
          nodeStates: nextStates,
          explorationBands: bands,
          generatedBatches: [generatedBatch],
          stepCatalog: {}, detailCache: {},
          ship: { settledPosition: INITIAL_SHIP_POSITION },
          selectedNodeId: null,
        };
        const latestWorld = await worldRepositoryRef.current!.loadActive();
        if (latestWorld.status === 'ready') throw new Error('A World was created while generation was in progress. Reload to use the saved World.');
        if (latestWorld.status === 'corrupt') throw new Error(t('summary.worldCorrupt'));
        const saved = await worldRepositoryRef.current!.save(snapshot);
        if (!saved) throw new Error('World persistence rejected the initial snapshot.');
        notifyWorldPersisted(snapshot);
        if (disposed) return;

        worldIdRef.current = worldId; worldRevisionRef.current = 1;
        worldInitialContextRevisionRef.current = canonicalProductState.personContextRevision;
        worldIntegratedContextRevisionRef.current = canonicalProductState.personContextRevision;
        nodesRef.current = allNodes; placementRef.current = nextPlacement; nodeStatesRef.current = nextStates;
        explorationBandsRef.current = bands; explorationBandRef.current = 0; stepCatalogRef.current = {};
        requestedBandsRef.current.clear(); blockedBandsRef.current.clear(); claimedStepCompletionsRef.current.clear();
        detailContextRevisionRef.current = {};
        setParentGoal(''); setNodes(allNodes); setPlacement(nextPlacement); setSelectedId(''); setNodeStates(nextStates);
        setExplorationBands(bands); setExplorationBand(0);
        setBatchHistory([{ band: 0, camera: null, nodes: allNodes.map(({ id, title, category, nodeKind, relationToGoal }) => ({ id, title, category, nodeKind, relationToGoal })) }]);
        setStepCatalog({}); setDetailCache({}); setDetailNodeId(''); setCompletedStep(null); setSemanticTrace(null);
        setShipPosition(INITIAL_SHIP_POSITION); setShipSnapshot({ ...INITIAL_SHIP_POSITION, moving: false, targetNodeId: null, trailPointCount: 0 }); setShipMove(null);
        setMapDiagnostic({ initial: initialPayload.diagnostic ?? null, expansion: expansionPayload.diagnostic ?? null });
        setMapRevision((current) => current + 1); setWorldPersistenceError(''); setWorldHydrationStatus('ready');
        onInitialWorldGenerationChangeRef.current?.({ status: 'success' });
      } catch (caught) {
        if (disposed) return;
        const message = caught instanceof Error ? caught.message : t('summary.worldGenerationError');
        setError(message);
        onInitialWorldGenerationChangeRef.current?.({ status: 'error', error: message });
      } finally {
        if (!disposed) setLoadingMap(false);
      }
    };
    void generateInitialWorld();
    return () => { disposed = true; };
  }, [productView, sampleMode, initialWorldGenerationRequestId, initialWorldGenerationCommand, worldHydrationStatus, canonicalProductState.onboardingComplete, canonicalProductState.personContextRevision, canonicalProductState.userProfile]);

  useEffect(() => {
    if (devOffline || sampleMode || !productView || initialWorldGenerationRequestId <= 0
      || handledContextExpansionRequestRef.current === initialWorldGenerationRequestId
      || initialWorldGenerationCommand?.type !== 'PERSON_CONTEXT_EXPANSION_REQUESTED'
      || worldHydrationStatus !== 'ready' || nodesRef.current.length === 0) return;
    if (loadingExpansionRef.current) return;
    handledContextExpansionRequestRef.current = initialWorldGenerationRequestId;

    const requestedRevision = initialWorldGenerationCommand.personContextRevision;
    if (requestedRevision <= worldIntegratedContextRevisionRef.current) {
      onInitialWorldGenerationChangeRef.current?.({ status: 'success' });
      return;
    }
    if (nodesRef.current.length + WORLD_EXPANSION_BATCH_SIZE > MAX_WORLD_NODE_SUMMARIES) {
      onInitialWorldGenerationChangeRef.current?.({ status: 'error', error: 'このWorldへ安全に追加できる島の上限に達しました。' });
      return;
    }

    const requestId = initialWorldGenerationRequestId;
    const integratePersonContext = async () => {
      loadingExpansionRef.current = true;
      setLoadingExpansion(true);
      setExpansionError('');
      onInitialWorldGenerationChangeRef.current?.({ status: 'loading' });
      try {
        const currentNodes = nodesRef.current;
        const currentStates = nodeStatesRef.current;
        const band = Math.max(1, explorationBandRef.current) as ExplorationBand;
        const generationContext = createProductGenerationContext(
          personStateRef.current,
          canonicalProductState.userProfile,
          initialWorldGenerationCommand.locale,
          parentGoal || null,
        );
        const { response, payload } = await requestPersonContextExpansion<PossibilityMapResponse>({
          generationContext,
          explorationBand: band,
          expansionReason: 'person_context',
          existingNodes: currentNodes.map(({ id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags }) => ({
            id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags,
          })),
          keptNodeIds: currentNodes.filter((node) => currentStates[node.id]?.kept).map((node) => node.id),
          landedNodeIds: currentNodes.filter((node) => currentStates[node.id]?.landed).map((node) => node.id),
        });
        if (!response.ok || !payload.nodes || payload.nodes.length !== WORLD_EXPANSION_BATCH_SIZE) {
          throw new Error(payload.error?.message ?? `${t('error.worldExpansion')} (${response.status})`);
        }

        const latestNodes = nodesRef.current;
        if (!mountedRef.current || handledContextExpansionRequestRef.current !== requestId) return;
        const { snapshot, appended } = await savePersonContextExpansion(
          worldRepositoryRef.current!,
          { worldId: worldIdRef.current, worldRevision: worldRevisionRef.current, nodeIds: latestNodes.map((node) => node.id) },
          payload.nodes,
          band,
          requestedRevision,
        );
        const allNodes = snapshot.nodes;
        const nextStates = snapshot.nodeStates;
        const bands = snapshot.explorationBands;
        const nextPlacement = computeSemanticLayout(allNodes, personStateRef.current, tiersFromStates(nextStates), bands);
        const focus = cameraForPersonContextExpansion(nextPlacement, appended.map((node) => node.id));
        if (!mountedRef.current || handledContextExpansionRequestRef.current !== requestId) return;

        worldRevisionRef.current = snapshot.worldRevision;
        worldIntegratedContextRevisionRef.current = requestedRevision;
        nodesRef.current = allNodes;
        nodeStatesRef.current = nextStates;
        explorationBandsRef.current = bands;
        if (band > explorationBandRef.current) explorationBandRef.current = band;
        requestedBandsRef.current.add(band);
        placementRef.current = nextPlacement;
        skipNextHydratedPersistenceRef.current = true;
        notifyWorldPersisted(snapshot);
        setNodes(allNodes);
        commitNodeStates(nextStates);
        setExplorationBands(bands);
        setExplorationBand(explorationBandRef.current);
        setPlacement(nextPlacement);
        setCameraRestore(focus);
        setLayoutUpdate(null);
        setSpatialSnapshot([]);
        setBatchHistory((current) => [...current, {
          band,
          camera: null,
          nodes: appended.map(({ id, title, category, nodeKind, relationToGoal }) => ({ id, title, category, nodeKind, relationToGoal })),
        }]);
        setMapDiagnostic((current) => current ? { ...current, expansion: payload.diagnostic ?? null } : current);
        setMapRevision((current) => current + 1);
        onInitialWorldGenerationChangeRef.current?.({ status: 'success' });
      } catch (caught) {
        if (!mountedRef.current || handledContextExpansionRequestRef.current !== requestId) return;
        const message = caught instanceof DOMException && caught.name === 'TimeoutError'
          ? t('error.worldExpansionTimeout')
          : caught instanceof Error ? caught.message : t('error.worldExpansion');
        setExpansionError(message);
        onInitialWorldGenerationChangeRef.current?.({ status: 'error', error: message });
      } finally {
        loadingExpansionRef.current = false;
        if (mountedRef.current) setLoadingExpansion(false);
      }
    };
    void integratePersonContext();
  }, [productView, devOffline, sampleMode, initialWorldGenerationRequestId, initialWorldGenerationCommand, worldHydrationStatus, loadingExpansion, canonicalProductState.userProfile, parentGoal]);

  useEffect(() => {
    if (worldHydrationStatus === 'hydrating' || nodes.length === 0 || batchHistory.length === 0) return;
    if (skipNextHydratedPersistenceRef.current) {
      skipNextHydratedPersistenceRef.current = false;
      return;
    }
    if (!worldIdRef.current) {
      worldIdRef.current = createWorldId();
      worldRevisionRef.current = 0;
      worldInitialContextRevisionRef.current = canonicalProductState.personContextRevision;
      worldIntegratedContextRevisionRef.current = canonicalProductState.personContextRevision;
    }
    const worldRevision = worldRevisionRef.current + 1;
    worldRevisionRef.current = worldRevision;
    const settledPosition = shipMove
      ? { x: shipMove.targetX, y: shipMove.targetY }
      : { ...shipPosition };
    const persistedDetails = Object.fromEntries(Object.entries(detailCache).map(([nodeId, detail]) => [nodeId, {
      detail,
      generatedFromPersonContextRevision: detailContextRevisionRef.current[nodeId],
    }]));
    const snapshot: PersistedWorldSnapshotV1 = {
      schemaVersion: WORLD_SCHEMA_VERSION,
      worldId: worldIdRef.current,
      worldRevision,
      savedAt: new Date().toISOString(),
      layoutVersion: WORLD_LAYOUT_VERSION,
      context: {
        contextSeed: parentGoal.trim() || null,
        locale: ACTIVE_PRODUCT_LOCALE,
        initialPersonContextRevision: worldInitialContextRevisionRef.current,
        integratedPersonContextRevision: worldIntegratedContextRevisionRef.current,
      },
      nodes,
      nodeStates,
      explorationBands,
      generatedBatches: batchHistory.map((batch) => ({ band: batch.band, nodeIds: batch.nodes.map((node) => node.id) })),
      stepCatalog,
      detailCache: persistedDetails,
      ship: { settledPosition },
      selectedNodeId: selectedId && nodes.some((node) => node.id === selectedId) ? selectedId : null,
    };
    void worldRepositoryRef.current!.save(snapshot).then((saved) => {
      if (saved) notifyWorldPersisted(snapshot);
      setWorldPersistenceError('');
    }).catch((caught) => {
      setWorldPersistenceError(caught instanceof Error ? caught.message : 'World persistence could not be saved.');
    });
  }, [worldHydrationStatus, parentGoal, nodes, nodeStates, explorationBands, batchHistory, stepCatalog, detailCache, shipPosition, shipMove, selectedId]);

  const showProductTab = (tab: ProductMapSection) => {
    onProductSectionChange?.(tab);
    if (tab === 'list') setDetailNodeId('');
  };

  const reopenNodeFromList = (nodeId: string, openDetail = false) => {
    setSelectedId(nodeId);
    if (openDetail) setDetailNodeId(nodeId);
    onProductSectionChange?.('map');
  };

  const generateMap = async (event: FormEvent) => {
    event.preventDefault();
    if (devOffline) { setError('DEV節約モードでは新しいWorldを生成できません。'); return; }
    const requestedGoal = parentGoalInput.trim();
    if (!requestedGoal || loadingMap || worldHydrationStatus === 'hydrating') return;
    setLoadingMap(true); setError(''); setExpansionError('');
    requestedBandsRef.current.clear(); blockedBandsRef.current.clear();
    claimedStepCompletionsRef.current.clear();
    loadingExpansionRef.current = false;
    try {
      const initialPersonState = personStateRef.current;
      const initialResponse = await fetch('/api/possibility-map', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentGoal: requestedGoal, personState: initialPersonState }),
      });
      const initialPayload = await initialResponse.json() as PossibilityMapResponse;
      if (!initialResponse.ok || !initialPayload.nodes || initialPayload.nodes.length < 5) {
        throw new Error(initialPayload.error?.message ?? `Possibility Map request failed (${initialResponse.status}).`);
      }
      const expansionResponse = await fetch('/api/world-expand', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentGoal: requestedGoal, personState: initialPersonState,
          explorationBand: 0,
          existingNodes: initialPayload.nodes.map(({ id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags }) => ({
            id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags,
          })),
          keptNodeIds: [], landedNodeIds: [],
        }),
      });
      const expansionPayload = await expansionResponse.json() as PossibilityMapResponse;
      if (!expansionResponse.ok || !expansionPayload.nodes || expansionPayload.nodes.length < 5) {
        throw new Error(expansionPayload.error?.message ?? `World expansion request failed (${expansionResponse.status}).`);
      }
      const initialExpansion = appendDistinctPossibilityNodes(initialPayload.nodes, expansionPayload.nodes);
      const allNodes = [...initialPayload.nodes, ...initialExpansion];
      if (allNodes.length !== INITIAL_WORLD_NODE_COUNT) throw new Error('最初の探索海域には12の異なる島が必要です。');
      const tiers = initialWorldTiers(allNodes);
      const bands = Object.fromEntries(allNodes.map((node) => [node.id, 0])) as Record<string, ExplorationBand>;
      const nextStates = Object.fromEntries(allNodes.map((node) => [node.id, {
        visible: true, visited: false, kept: false, activePursuit: false,
        landed: false, worldTier: tiers[node.id], completedStepIds: [],
      } satisfies PossibilityNodeState]));
      const nextPlacement = computeSemanticLayout(allNodes, initialPersonState, tiers, bands);
      worldIdRef.current = createWorldId();
      worldRevisionRef.current = 0;
      worldInitialContextRevisionRef.current = canonicalProductState.personContextRevision;
      worldIntegratedContextRevisionRef.current = canonicalProductState.personContextRevision;
      detailContextRevisionRef.current = {};
      nodesRef.current = allNodes; placementRef.current = nextPlacement;
      setParentGoal(requestedGoal); setNodes(allNodes); setPlacement(nextPlacement); setSelectedId(productView ? '' : allNodes[0].id);
      onProductSectionChange?.('map');
      commitNodeStates(nextStates); setExplorationBands(bands); setExplorationBand(0);
      setBatchHistory([{ band: 0, camera: null, nodes: allNodes.map(({ id, title, category, nodeKind, relationToGoal }) => ({ id, title, category, nodeKind, relationToGoal })) }]);
      stepCatalogRef.current = {}; setStepCatalog({}); setDetailCache({}); setDetailNodeId(''); setDetailError(''); setLoadingDetail(false); setCompletedStep(null); setSemanticTrace(null);
      setShipPosition(INITIAL_SHIP_POSITION); setShipSnapshot({ ...INITIAL_SHIP_POSITION, moving: false, targetNodeId: null, trailPointCount: 0 });
      setShipMove(null); setReaction(emptyReaction);
      setLayoutUpdate(null); setSpatialSnapshot([]); setCameraRestore(null); setLoadingExpansion(false);
      setDistanceAudit(Object.fromEntries(nextPlacement.map((entry) => [entry.nodeId, {
        before: entry.semanticDistance, after: entry.semanticDistance, requestedDisplacement: 0, effectiveDisplacement: 0,
      }])));
      setMapDiagnostic({ initial: initialPayload.diagnostic ?? null, expansion: expansionPayload.diagnostic ?? null });
      setStepsDiagnostic({}); setMapRevision((current) => current + 1);
      setWorldHydrationStatus('ready');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Possibility Map generation failed.'); }
    finally { setLoadingMap(false); }
  };

  const requestFrontierExpansion = async (camera: ExplorationFrontierSnapshot, requestedBand?: ExplorationBand) => {
    if (devOffline) return;
    const firstBand = requestedBand ?? explorationBandRef.current + 1;
    if (worldHydrationStatus === 'hydrating' || nodesRef.current.length < INITIAL_WORLD_NODE_COUNT || nodesRef.current.length >= TARGET_WORLD_NODE_COUNT
      || firstBand < 1 || firstBand > MAX_WORLD_EXPANSION_BATCH
      || loadingExpansionRef.current || requestedBandsRef.current.has(firstBand) || blockedBandsRef.current.has(firstBand)) return;
    lastFrontierCameraRef.current = camera;
    loadingExpansionRef.current = true;
    setLoadingExpansion(true); setExpansionError('');
    let currentNodes = nodesRef.current;
    let currentStates = nodeStatesRef.current;
    let currentBands = explorationBandsRef.current;
    let finalError = '';
    try {
      for (let offset = 0; offset < FRONTIER_AHEAD_BATCHES; offset++) {
        const band = firstBand + offset;
        if (band > MAX_WORLD_EXPANSION_BATCH || currentNodes.length >= TARGET_WORLD_NODE_COUNT) break;
        if (requestedBandsRef.current.has(band) || blockedBandsRef.current.has(band)) break;
        requestedBandsRef.current.add(band);
        try {
          let incomingNodes: PossibilityNode[];
          let expansionDiagnostic: ApiDiagnostic | null = null;
          if (sampleMode) {
            incomingNodes = sampleNodesForBand(band);
          } else {
            const response = await fetch('/api/world-expand', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(productView ? { generationContext: createProductGenerationContext(personStateRef.current, canonicalProductState.userProfile, ACTIVE_PRODUCT_LOCALE, parentGoal || null) } : { parentGoal: legacyParentGoalForRequest(parentGoal), personState: personStateRef.current }),
                explorationBand: band,
                existingNodes: currentNodes.map(({ id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags }) => ({
                  id, title, shortDescription, category, nodeKind, relationToGoal, portableResourceTags, connectionTags, helpedByTags,
                })),
                keptNodeIds: currentNodes.filter((node) => currentStates[node.id]?.kept).map((node) => node.id),
                landedNodeIds: currentNodes.filter((node) => currentStates[node.id]?.landed).map((node) => node.id),
              }),
            });
            const payload = await response.json() as PossibilityMapResponse;
            if (!response.ok || !payload.nodes || payload.nodes.length !== WORLD_EXPANSION_BATCH_SIZE) {
              throw new Error(payload.error?.message ?? `${t('error.worldExpansion')} (${response.status})`);
            }
            incomingNodes = payload.nodes;
            expansionDiagnostic = payload.diagnostic ?? null;
          }
          if (incomingNodes.length !== WORLD_EXPANSION_BATCH_SIZE) throw new Error('サンプルWorldの探索Batchが不足しています。');
          const prepared = prepareAdditiveWorldExpansion(currentNodes, incomingNodes, nodeStatesRef.current, currentBands, band);
          const { appended, nodes: allNodes, nodeStates: nextStates, explorationBands: bands } = prepared;
          if (appended.length !== WORLD_EXPANSION_BATCH_SIZE) throw new Error(t('error.duplicateWorld'));
          const latestPersonState = personStateRef.current;
          const tiers = tiersFromStates(nextStates);
          const nextPlacement = computeSemanticLayout(allNodes, latestPersonState, tiers, bands);
          currentNodes = allNodes; currentStates = nextStates; currentBands = bands;
          nodesRef.current = allNodes; nodeStatesRef.current = nextStates; explorationBandsRef.current = bands; explorationBandRef.current = band;
          setNodes(allNodes); commitNodeStates(nextStates); setExplorationBands(bands); setExplorationBand(band);
          placementRef.current = nextPlacement; setPlacement(nextPlacement); setLayoutUpdate(null); setSpatialSnapshot([]); setCameraRestore(camera);
          setBatchHistory((current) => [...current, {
            band, camera,
            nodes: appended.map(({ id, title, category, nodeKind, relationToGoal }) => ({ id, title, category, nodeKind, relationToGoal })),
          }]);
          if (!sampleMode) setMapDiagnostic((current) => current ? { ...current, expansion: expansionDiagnostic } : current);
          setMapRevision((current) => current + 1);
        } catch (caught) {
          requestedBandsRef.current.delete(band);
          blockedBandsRef.current.add(band);
          finalError = caught instanceof Error ? caught.message : t('error.worldExpansion');
          break;
        }
      }
      if (finalError) setExpansionError(finalError);
    } finally {
      loadingExpansionRef.current = false;
      setLoadingExpansion(false);
    }
  };

  const handleExplorationFrontier = (camera: ExplorationFrontierSnapshot) => {
    if (worldHydrationStatus === 'hydrating') return;
    lastFrontierCameraRef.current = camera;
    void requestFrontierExpansion(camera);
  };
  const retryExpansion = () => {
    const camera = lastFrontierCameraRef.current;
    const band = explorationBandRef.current + 1;
    if (!camera || band > MAX_WORLD_EXPANSION_BATCH) return;
    blockedBandsRef.current.delete(band);
    requestedBandsRef.current.delete(band);
    void requestFrontierExpansion(camera, band);
  };

  const toggleKeep = () => {
    if (!selected || !selectedState) return;
    commitNodeStates((current) => ({ ...current, [selected.id]: { ...current[selected.id], kept: !current[selected.id].kept } }));
  };
  const loadNodeDetail = async (node: PossibilityNode) => {
    if (detailCache[node.id] || loadingDetail) return;
    if (sampleMode) {
      detailContextRevisionRef.current[node.id] = canonicalProductState.personContextRevision;
      setDetailCache((current) => ({ ...current, [node.id]: createSampleNodeDetail(node) }));
      return;
    }
    if (devOffline) {
      setDetailError('この島の保存済み詳細はありません。DEV節約モードでは新しい詳細を生成できません。');
      return;
    }
    setLoadingDetail(true); setDetailError('');
    try {
      const response = await fetch('/api/node-detail', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productView
          ? { generationContext: createProductGenerationContext(personState, canonicalProductState.userProfile, ACTIVE_PRODUCT_LOCALE, parentGoal || null), node }
          : { parentGoal: legacyParentGoalForRequest(parentGoal), node, personState }),
      });
      const payload = await response.json() as NodeDetailResponse;
      if (!response.ok || !payload.overview || !Array.isArray(payload.expectedOutcomes) || !payload.personConnection) {
        throw new Error(payload.error?.message ?? `${t('error.detail')} (${response.status})`);
      }
      detailContextRevisionRef.current[node.id] = canonicalProductState.personContextRevision;
      setDetailCache((current) => ({ ...current, [node.id]: {
        overview: payload.overview!, expectedOutcomes: payload.expectedOutcomes!, personConnection: payload.personConnection!,
      } }));
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : t('error.detail'));
    } finally { setLoadingDetail(false); }
  };
  const peekSelected = () => {
    if (!selected || !selectedState) return;
    commitNodeStates((current) => ({ ...current, [selected.id]: { ...current[selected.id], visited: true } }));
    setDetailNodeId(selected.id); setDetailError('');
    void loadNodeDetail(selected);
  };

  const generateSteps = async () => {
    if (!selected || !selectedState || loadingSteps) return;
    setDismissedStepsNodeId('');
    if (devOffline && stepCatalog[selected.id]?.length !== 3) {
      setError('この島の保存済みSmall Stepsはありません。DEV節約モードでは新しいStepsを生成できません。');
      return;
    }
    commitNodeStates((current) => Object.fromEntries(Object.entries(current).map(([id, state]) => [id, {
      ...state,
      kept: id === selected.id ? true : state.kept,
      activePursuit: id === selected.id,
    }])));
    if (stepCatalog[selected.id]?.length === 3) {
      recordLandingJourney(selected, stepCatalog[selected.id]);
      return;
    }
    if (sampleMode) {
      const sampleSteps = createSampleSmallSteps(selected);
      const nextCatalog = { ...stepCatalogRef.current, [selected.id]: sampleSteps };
      stepCatalogRef.current = nextCatalog;
      setStepCatalog(nextCatalog);
      return;
    }
    setLoadingSteps(true); setError('');
    try {
      const response = await fetch('/api/node-steps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(productView ? { generationContext: createProductGenerationContext(personState, canonicalProductState.userProfile, ACTIVE_PRODUCT_LOCALE, parentGoal || null) } : { parentGoal: legacyParentGoalForRequest(parentGoal), personState }), keptNode: selected,
          mapContext: nodes.map(({ id, title, portableResourceTags, connectionTags, helpedByTags }) => ({ id, title, portableResourceTags, connectionTags, helpedByTags })),
        }),
      });
      const payload = await response.json() as NodeStepsResponse;
      if (!response.ok || !payload.steps || payload.steps.length !== 3) throw new Error(payload.error?.message ?? `Local Small Steps request failed (${response.status}).`);
      const nextCatalog = { ...stepCatalogRef.current, [selected.id]: payload.steps! };
      stepCatalogRef.current = nextCatalog;
      setStepCatalog(nextCatalog);
      recordLandingJourney(selected, payload.steps);
      if (payload.diagnostic) setStepsDiagnostic((current) => ({ ...current, [selected.id]: payload.diagnostic! }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('error.steps')); }
    finally { setLoadingSteps(false); }
  };

  const markDone = (step: LocalSmallStep) => {
    if (!selected || shipSnapshot.moving) return;
    const node = selected;
    const completionKey = `${node.id}::${step.id}`;
    const canonicalStates = nodeStatesRef.current;
    const canonicalPersonState = personStateRef.current;
    const state = canonicalStates[node.id];
    const steps = stepCatalogRef.current[node.id] ?? [];
    if (!state || !steps.some((candidate) => candidate.id === step.id)
      || state.completedStepIds.includes(step.id) || canonicalPersonState.completedSteps.includes(step.id)
      || claimedStepCompletionsRef.current.has(completionKey)) return;
    claimedStepCompletionsRef.current.add(completionKey);
    const canonicalNodes = nodesRef.current;
    const tiers = tiersFromStates(canonicalStates);
    const beforeLayout = computeSemanticLayout(canonicalNodes, canonicalPersonState, tiers, explorationBandsRef.current);
    const nextPersonState = completeLocalStep(canonicalPersonState, node, step);
    const afterLayout = computeSemanticLayout(canonicalNodes, nextPersonState, tiers, explorationBandsRef.current);
    const nextSemanticTrace = computeSemanticStepTrace(canonicalNodes, canonicalPersonState, nextPersonState, node, step);
    const nextCompleted = [...state.completedStepIds, step.id];
    const nextStates = Object.fromEntries(Object.entries(canonicalStates).map(([id, current]) => [id, {
      ...current, activePursuit: id === node.id, visited: id === node.id ? true : current.visited,
      completedStepIds: id === node.id ? nextCompleted : current.completedStepIds,
    }])) as Record<string, PossibilityNodeState>;
    let voyage;
    try {
      voyage = planShipVoyage(
        shipPosition,
        node,
        beforeLayout,
        afterLayout,
        canonicalNodes,
        nextCompleted.length,
        steps.length,
      );
    } catch (caught) {
      claimedStepCompletionsRef.current.delete(completionKey);
      setWorldPersistenceError(caught instanceof Error ? caught.message : '安全な航路を計算できませんでした。');
      return;
    }
    const finalWaypoint = voyage.waypoints[voyage.waypoints.length - 1] ?? shipPosition;
    const displacements = afterLayout.map((after) => {
      const before = beforeLayout.find((entry) => entry.nodeId === after.nodeId)!;
      return Math.hypot(after.targetX - before.targetX, after.targetY - before.targetY);
    });
    const nextLayoutRevision = layoutRevision + 1; const nextShipRevision = (shipMove?.revision ?? 0) + 1;
    commitPersonState(nextPersonState); commitNodeStates(nextStates); placementRef.current = afterLayout; setPlacement(afterLayout); setLayoutRevision(nextLayoutRevision); setSemanticTrace(nextSemanticTrace);
    setLayoutUpdate({ revision: nextLayoutRevision, targets: afterLayout });
    setShipMove({
      revision: nextShipRevision,
      targetX: finalWaypoint.x,
      targetY: finalWaypoint.y,
      targetNodeId: node.id,
      waypoints: voyage.waypoints,
      landingAnchor: voyage.landingAnchor,
      ownerTarget: voyage.ownerTarget,
      navigationVersion: voyage.navigationVersion,
    });
    setShipSnapshot((current) => ({ ...current, moving: true, targetNodeId: node.id })); setCompletedStep(step);
    setReaction({ shipDisplacement: voyage.displacement, medianIslandDisplacement: median(displacements), maxIslandDisplacement: Math.max(0, ...displacements) });
    setDistanceAudit(Object.fromEntries(afterLayout.map((after) => {
      const before = beforeLayout.find((entry) => entry.nodeId === after.nodeId)!;
      return [after.nodeId, { before: before.semanticDistance, after: after.semanticDistance,
        requestedDisplacement: Math.hypot(after.targetX - before.targetX, after.targetY - before.targetY), effectiveDisplacement: 0 }];
    })));
    queueReviewEligibilityEvent(`/api/reviews/nodes/${encodeURIComponent(node.id)}/journey/steps/${encodeURIComponent(step.id)}`, {});
  };

  const handleShipSnapshot = (snapshot: ShipMovementSnapshot) => {
    setShipSnapshot(snapshot);
    if (!snapshot.moving) setShipPosition((current) => (
      Math.abs(current.x - snapshot.x) <= .001 && Math.abs(current.y - snapshot.y) <= .001
        ? current
        : { x: snapshot.x, y: snapshot.y }
    ));
  };
  const handleShipMovementComplete = (snapshot: ShipMovementSnapshot) => {
    setShipPosition({ x: snapshot.x, y: snapshot.y }); setShipSnapshot(snapshot);
    const node = nodesRef.current.find((candidate) => candidate.id === snapshot.targetNodeId); if (!node) return;
    const state = nodeStatesRef.current[node.id]; const requiredSteps = stepCatalogRef.current[node.id] ?? [];
    const requiredStepIds = requiredSteps.map((step) => step.id);
    const target = placementRef.current.find((entry) => entry.nodeId === node.id);
    const allRequiredStepsCompleted = requiredStepIds.length === 3
      && requiredStepIds.every((stepId) => state?.completedStepIds.includes(stepId) && personStateRef.current.completedSteps.includes(stepId));
    if (!state || state.landed || !state.activePursuit || !allRequiredStepsCompleted || !target) return;
    const landingAnchor = snapshot.landingAnchor ?? { x: target.targetX, y: target.targetY };
    const ownerTarget = snapshot.ownerTarget ?? { x: target.targetX, y: target.targetY };
    if (!landingReached(snapshot, landingAnchor, LANDING_RADIUS)) return;
    commitNodeStates((current) => ({ ...current, [node.id]: { ...current[node.id], landed: true, activePursuit: false, visited: true } }));
    commitPersonState(applyLandingResources(personStateRef.current, node));
    queueReviewEligibilityEvent(`/api/reviews/nodes/${encodeURIComponent(node.id)}/landing`, {
      ownerNodeId: node.id,
      ship: { x: snapshot.x, y: snapshot.y },
      ownerTarget,
      ...(snapshot.landingAnchor ? { landingAnchor, navigationVersion: snapshot.navigationVersion } : {}),
    }, () => setReviewEligibilityRevision((current) => current + 1));
  };

  const effectiveByNode = Object.fromEntries(spatialSnapshot.map((entry) => [entry.nodeId, entry.lastEffectiveDistance]));
  const isStepCompleted = (nodeId: string, stepId: string) => (
    Boolean(nodeStates[nodeId]?.completedStepIds.includes(stepId)) || personState.completedSteps.includes(stepId)
  );

  return <main className="app-shell living-flow-shell" data-world-count={nodes.length} data-visible-count={visibleNodes.length}
    data-dev-offline={devOffline ? '1' : '0'}
    data-sample-mode={sampleMode ? '1' : '0'}
    data-world-hydration={worldHydrationStatus} data-world-persistence-error={worldPersistenceError}
    data-initial-world-loading={loadingMap ? '1' : '0'}
    data-active-pursuit={activePursuit?.id ?? ''} data-landed-count={landedNodeIds.length}
    data-person-state={JSON.stringify(personState)} data-exploration-band={explorationBand}
    data-expansion-loading={loadingExpansion ? '1' : '0'} data-batch-history={JSON.stringify(batchHistory)}
    data-peek-open={detailNodeId} data-detail-cache-count={Object.keys(detailCache).length}
    data-product-tab={productSection} data-list-filter={listFilter} data-list-count={listNodes.length}
    data-selected-id={selected?.id ?? ''} data-selected-node-state={selectedState ? JSON.stringify(selectedState) : ''}>
    {(nodes.length > 0 || productView) ? <LivingMap
      onSelect={setSelectedId} selectedId={selected?.id ?? ''} flags={flags}
      activeNodes={semanticNodes} activePlacement={placement} revision={mapRevision}
      layoutUpdate={layoutUpdate} onSpatialSnapshot={setSpatialSnapshot}
      initialShipPosition={shipPosition} shipMove={shipMove} onShipSnapshot={handleShipSnapshot}
      onShipMovementComplete={handleShipMovementComplete} landedNodeIds={landedNodeIds} canonicalScene={productView}
      initialCamera={cameraRestore} onExplorationFrontier={!devOffline && productView && worldHydrationStatus !== 'hydrating' ? handleExplorationFrontier : undefined}
    /> : <div className="living-flow-empty-map" aria-label="Empty possibility ocean"><span>Parent GoalからPossibility Mapを生成してください</span></div>}

    <div className="ui-overlay living-flow-overlay"><header className={`top-ui${productView ? ' living-product-map-controls' : ''}`}>
      {!productView && <div className="brand"><span className="brand-mark">⛵</span><span>KUROHIGE MAP</span></div>}
      {!productView && <form className="living-goal-form" onSubmit={generateMap}>
        <label htmlFor="parent-goal">Parent Goal · Context Seed</label>
        <div><input id="parent-goal" value={parentGoalInput} onChange={(event) => setParentGoalInput(event.target.value)} maxLength={600} placeholder="例：地域の古い映画館を学びの場として再生したい" disabled={loadingMap || worldHydrationStatus === 'hydrating'} />
          <button type="submit" disabled={loadingMap || worldHydrationStatus === 'hydrating' || !parentGoalInput.trim()}>{loadingMap ? '世界を描いています…' : 'Generate Map'}</button></div>
        {parentGoal && <p><strong>Parent Goal:</strong> {parentGoal} · {nodes.length}の島</p>}
        {error && <p className="living-flow-error" role="alert">{error}</p>}
      </form>}
      {productView && (loadingExpansion || expansionError) && <div className="living-product-status">
        {loadingExpansion && <SailingLoader compact label={t('map.frontierLoading')} />}
        {expansionError && <p className="living-flow-error" role="alert">{expansionError} <button type="button" className="living-retry-button" onClick={retryExpansion}>{t('map.retry')}</button></p>}
      </div>}
    </header>
      {productSection === 'map' && selected && selectedState && <section className="bottom-ui living-selected-card" aria-label="Selected possibility node">
        {productView && <button className="living-steps-close" type="button" aria-label={t('map.closeSelected')} onClick={() => setSelectedId('')}>×</button>}
        <div className="card-heading"><span className="category">{selected.category}</span><span className="preview-caption">{productView ? `${kindLabel[selected.nodeKind]} · ${relationLabel[selected.relationToGoal]}${selectedState.activePursuit ? ` · ${t('map.active')}` : ''}${selectedState.landed ? ` · ${t('map.landed')}` : ''}` : `${selected.nodeKind} · ${selected.relationToGoal}${selectedState.activePursuit ? ' · ACTIVE' : ''}${selectedState.landed ? ' · LANDED' : ''}`}</span></div>
        <h1>{selected.title}</h1><p>{selected.shortDescription}</p><div className="actions">
          <button type="button" onClick={peekSelected}>{t('map.peek')}</button>
          <button type="button" aria-pressed={selectedState.kept} onClick={toggleKeep}>{selectedState.kept ? t('map.kept') : t('map.keep')}</button>
          <button type="button" disabled={loadingSteps} onClick={generateSteps}>{loadingSteps ? t('map.routeLoading') : productView ? t('map.pursue') : selectedSteps.length ? t('map.pursue') : 'Small Steps'}</button>
        </div>
        {(devOffline || sampleMode) && error && <p className="living-flow-error" role="alert">{error}</p>}
      </section>}
    </div>

    {productView && productSection === 'list' && <section className="living-list-view" aria-label={t('list.aria')}>
      <header>
        <div><p>{t('list.eyebrow')}</p><h1>{listFilter === 'voyageLog' ? voyageLogTitle(canonicalProductState.userProfile.nickname) : t('list.title')}</h1></div>
        <div className="living-list-filters" role="group" aria-label={t('list.filtersAria')}>
          <button type="button" className={listFilter === 'kept' ? 'active' : ''} aria-pressed={listFilter === 'kept'} onClick={() => setListFilter('kept')}>{t('list.kept')}</button>
          <button type="button" className={listFilter === 'voyageLog' ? 'active' : ''} aria-pressed={listFilter === 'voyageLog'} onClick={() => setListFilter('voyageLog')}>{t('list.voyageLog')}</button>
        </div>
      </header>
      {listFilter === 'kept' && (listNodes.length > 0 ? <div className="living-list-items">
        {listNodes.map((node) => { const state = nodeStates[node.id]; return <article key={node.id} data-node-id={node.id}>
          <div className="living-list-item-heading"><span className="category">{node.category}</span><span>{kindLabel[node.nodeKind]} · {relationLabel[node.relationToGoal]}</span></div>
          <h2>{node.title}</h2><p>{node.shortDescription}</p>
          <div className="living-list-item-footer"><span>{state.landed ? `⚑ ${t('map.landed')}` : state.activePursuit ? t('map.active') : t('list.keptStatus')}</span>
            <button type="button" onClick={() => reopenNodeFromList(node.id)}>{t('list.viewMap')}</button></div>
        </article>; })}
      </div> : <div className="living-list-empty">
        <p>{t('list.emptyKept')}</p>
        <button type="button" onClick={() => showProductTab('map')}>{t('list.backToMap')}</button>
      </div>)}
      {listFilter === 'voyageLog' && <VoyageLogList
        nodes={nodes}
        nodeStates={nodeStates}
        nickname={canonicalProductState.userProfile.nickname}
        onOpenNode={(nodeId) => reopenNodeFromList(nodeId, true)}
        refreshRevision={voyageLogRevision}
        offline={devOffline || sampleMode}
      />}
    </section>}

    {nodes.length > 0 && !productView && <aside className="living-node-panel" aria-label="Visible Possibility Nodes"><h2>Possibility Nodes</h2>
      <p>{nodes.length} in world · {nearNodes.length} near · {farNodes.length} far · 上方向へPanして探索</p>
      <div className="living-node-list">{visibleNodes.map((node) => { const state = nodeStates[node.id]; return <button key={node.id} type="button" className={node.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(node.id)}>
        <span>{node.title}</span><small>{state.worldTier.toUpperCase()} · {node.nodeKind}{state.kept ? ' · KEPT' : ''}{state.activePursuit ? ' · ACTIVE' : ''}{state.landed ? ' · LANDED' : ''}</small>
      </button>; })}</div>
    </aside>}

    {nodes.length > 0 && productView && productSection === 'map' && selectedSteps.length > 0 && selected && dismissedStepsNodeId !== selected.id && <aside className="living-product-steps-panel" aria-label={t('steps.aria')}>
      <button className="living-steps-close" type="button" aria-label={t('steps.close')} onClick={() => setDismissedStepsNodeId(selected.id)}>×</button>
      <h2>{t('steps.title')}</h2>
      <div className="living-step-list">{selectedSteps.map((step) => <article key={step.id}>
        <strong>{isStepCompleted(selected.id, step.id) ? '✓ ' : ''}{step.title}</strong>
        <p>{step.shortDescription}</p><small>{t('steps.resources', { resources: step.portableResources.join(t('common.listSeparator')) })}</small>
        <button type="button" disabled={isStepCompleted(selected.id, step.id) || shipSnapshot.moving} onClick={() => markDone(step)}>{isStepCompleted(selected.id, step.id) ? t('steps.complete') : shipSnapshot.moving ? t('steps.voyaging') : t('steps.try')}</button>
      </article>)}</div>
      {selectedState?.landed && <p className="living-landed-note">⚑ {t('map.landed')}</p>}
    </aside>}

    {productView && productSection === 'map' && detailNode && <div className="living-peek-backdrop">
      <section className="living-peek-panel" role="dialog" aria-modal="true" aria-labelledby="living-peek-title">
        <button className="living-peek-close" type="button" aria-label={t('peek.close')} onClick={() => setDetailNodeId('')}>×</button>
        <p className="living-peek-eyebrow">{t('peek.eyebrow')}</p>
        <h1 id="living-peek-title">{detailNode.title}</h1>
        {loadingDetail && !openDetail && <SailingLoader label={t('peek.loading')} />}
        {detailError && !openDetail && <div className="living-peek-error" role="alert"><p>{detailError}</p>
          <button type="button" onClick={() => void loadNodeDetail(detailNode)}>{t('map.retry')}</button></div>}
        {openDetail && <>
          <section><h2>{t('peek.activity')}</h2><p>{openDetail.overview}</p></section>
          <section><h2>{t('peek.outcomes')}</h2><ul>{openDetail.expectedOutcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
          <section><h2>{t('peek.connection')}</h2><p>{openDetail.personConnection}</p></section>
        </>}
        <ReviewSection
          nodeId={detailNode.id}
          nodeTitle={detailNode.title}
          nodeDescription={detailNode.shortDescription}
          nodeCategory={detailNode.category}
          nodeKind={detailNode.nodeKind}
          portableResourceTags={detailNode.portableResourceTags}
          connectionTags={detailNode.connectionTags}
          helpedByTags={detailNode.helpedByTags ?? []}
          profile={canonicalProductState.userProfile}
          localLanded={Boolean(nodeStates[detailNode.id]?.landed)}
          eligibilityRevision={reviewEligibilityRevision}
          onOwnReviewsChanged={() => setVoyageLogRevision((current) => current + 1)}
          offline={devOffline || sampleMode}
        />
      </section>
    </div>}

    {nodes.length > 0 && !productView && <aside className="living-debug-panel" aria-label="Ship Forward Living World state and diagnostics">
      <section><h2>Voyage State</h2><pre>{JSON.stringify({ parentGoal,
        ship: { x: Number(shipSnapshot.x.toFixed(2)), y: Number(shipSnapshot.y.toFixed(2)), moving: shipSnapshot.moving, trailPoints: shipSnapshot.trailPointCount },
        activePursuit: activePursuit?.id ?? null, worldNodeCount: nodes.length, nearCount: nearNodes.length, farCount: farNodes.length,
        initialWorldPopulation: 'all generated nodes exist before any STEP_DONE', landedNodeIds,
        manualExploration: 'free pan / zoom; camera never mutates Ship semantic position',
      }, null, 2)}</pre></section>
      {selectedSteps.length > 0 && selected && <section><h2>Local Small Steps · choose any</h2><div className="living-step-list">{selectedSteps.map((step) => <article key={step.id}>
        <strong>{isStepCompleted(selected.id, step.id) ? '✓ ' : ''}{step.title}</strong><p>{step.shortDescription}</p><small>Resources: {step.portableResources.join(', ')}</small>
        <button type="button" disabled={isStepCompleted(selected.id, step.id) || shipSnapshot.moving} onClick={() => markDone(step)}>{isStepCompleted(selected.id, step.id) ? 'Done ✓' : shipSnapshot.moving ? '航海中…' : 'やってみた / Done'}</button>
      </article>)}</div></section>}
      <section><h2>Last Step / Reaction</h2><pre>{JSON.stringify({ completedStep, ...reaction, shipIsPrimary: reaction.shipDisplacement > reaction.maxIslandDisplacement }, null, 2)}</pre></section>
      <section><h2>Person State / Portable Resources</h2><pre>{JSON.stringify(personState, null, 2)}</pre></section>
      <section><h2>Canonical Semantic Bridge Trace</h2><pre>{JSON.stringify(semanticTrace, null, 2)}</pre></section>
      <section><h2>Semantic Distance / Island Displacement</h2><div className="living-distance-table">{visibleNodes.map((node) => { const audit = distanceAudit[node.id]; return <div key={node.id}>
        <strong>{node.title}</strong><span>{audit?.before.toFixed(3)} → {audit?.after.toFixed(3)}</span>
        <small>requested {(audit?.requestedDisplacement ?? 0).toFixed(1)} · effective {(effectiveByNode[node.id] ?? audit?.effectiveDisplacement ?? 0).toFixed(1)}</small>
      </div>; })}</div></section>
      <details><summary>Server diagnostics</summary><pre>{JSON.stringify({ map: mapDiagnostic, steps: stepsDiagnostic }, null, 2)}</pre></details>
    </aside>}
  </main>;
}
