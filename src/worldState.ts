import {
  applyLandingResources,
  computeSemanticLayout,
  type ExplorationBand,
  type LocalSmallStep,
  type PersonState,
  type PossibilityNode,
  type PossibilityNodeState,
  type SemanticLayoutEntry,
  type WorldTier,
} from './livingFlow.ts';
import { CANONICAL_BRIDGE_TAGS } from './semanticBridgeVocabulary.ts';
import { isSafeBerthForOwner, WORLD_LANDING_RADIUS as NAVIGATION_LANDING_RADIUS } from './islandNavigation.ts';

export const WORLD_SCHEMA_VERSION = 1 as const;
export const WORLD_LAYOUT_VERSION = 1 as const;
export const WORLD_LANDING_RADIUS = NAVIGATION_LANDING_RADIUS;

export type NodeDetail = {
  overview: string;
  expectedOutcomes: string[];
  personConnection: string;
};

export type PersistedNodeDetail = {
  detail: NodeDetail;
  generatedFromPersonContextRevision?: number;
};

export type PersistedWorldSnapshotV1 = {
  schemaVersion: typeof WORLD_SCHEMA_VERSION;
  worldId: string;
  worldRevision: number;
  savedAt: string;
  layoutVersion: typeof WORLD_LAYOUT_VERSION;
  context: {
    contextSeed?: string | null;
    locale: 'ja' | 'en';
    initialPersonContextRevision: number;
    integratedPersonContextRevision: number;
  };
  nodes: PossibilityNode[];
  nodeStates: Record<string, PossibilityNodeState>;
  explorationBands: Record<string, ExplorationBand>;
  generatedBatches: Array<{ band: ExplorationBand; nodeIds: string[] }>;
  stepCatalog: Record<string, LocalSmallStep[]>;
  detailCache: Record<string, PersistedNodeDetail>;
  ship: { settledPosition: { x: number; y: number } };
  selectedNodeId?: string | null;
};

export type WorldParseResult =
  | { status: 'ready'; snapshot: PersistedWorldSnapshotV1 }
  | { status: 'corrupt'; reason: string };

export type RehydratedWorld = {
  snapshot: PersistedWorldSnapshotV1;
  personState: PersonState;
  placement: SemanticLayoutEntry[];
};

const bridgeTags = new Set<string>(CANONICAL_BRIDGE_TAGS);
const nodeKinds = new Set(['activity', 'experience', 'information', 'opportunity', 'skill', 'community']);
const goalRelations = new Set(['direct', 'adjacent', 'exploratory']);
const densities = new Set(['sparse', 'medium', 'dense']);
const opennessValues = new Set(['open', 'balanced', 'compact']);
const emphasisValues = new Set(['low', 'medium', 'high']);
const energyValues = new Set(['calm', 'moderate', 'high']);
const worldTiers = new Set(['near', 'far']);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isUnitNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0 && value <= 1;
const isStringArray = (value: unknown, allowEmpty = true): value is string[] => Array.isArray(value)
  && (allowEmpty || value.length > 0)
  && value.every(isNonEmptyString);
const isCanonicalBridgeArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.every((tag) => typeof tag === 'string' && bridgeTags.has(tag));

function validVisualRecipe(value: unknown) {
  return isRecord(value)
    && isNonEmptyString(value.visualTheme)
    && isNonEmptyString(value.dominantMotif)
    && isStringArray(value.secondaryObjects)
    && isNonEmptyString(value.terrainProfile)
    && isNonEmptyString(value.accentPalette)
    && typeof value.density === 'string' && densities.has(value.density)
    && typeof value.openness === 'string' && opennessValues.has(value.openness)
    && typeof value.landmarkEmphasis === 'string' && emphasisValues.has(value.landmarkEmphasis)
    && typeof value.energyLevel === 'string' && energyValues.has(value.energyLevel);
}

function validNode(value: unknown): value is PossibilityNode {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.reviewSubjectId === undefined || isNonEmptyString(value.reviewSubjectId))
    && isNonEmptyString(value.title)
    && isNonEmptyString(value.shortDescription)
    && isNonEmptyString(value.category)
    && typeof value.nodeKind === 'string' && nodeKinds.has(value.nodeKind)
    && typeof value.relationToGoal === 'string' && goalRelations.has(value.relationToGoal)
    && isUnitNumber(value.curiosityFit)
    && isUnitNumber(value.accessibility)
    && isUnitNumber(value.novelty)
    && isUnitNumber(value.friction)
    && isStringArray(value.portableResourceTags, false)
    && isStringArray(value.connectionTags, false)
    && (value.helpedByTags === undefined || isCanonicalBridgeArray(value.helpedByTags))
    && validVisualRecipe(value.visualRecipe);
}

function validNodeState(value: unknown): value is PossibilityNodeState {
  return isRecord(value)
    && typeof value.visible === 'boolean'
    && typeof value.visited === 'boolean'
    && typeof value.kept === 'boolean'
    && typeof value.activePursuit === 'boolean'
    && typeof value.landed === 'boolean'
    && typeof value.worldTier === 'string' && worldTiers.has(value.worldTier)
    && isStringArray(value.completedStepIds)
    && new Set(value.completedStepIds as string[]).size === (value.completedStepIds as string[]).length
    && !(value.landed && value.activePursuit);
}

function validStep(value: unknown): value is LocalSmallStep {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.title)
    || !isNonEmptyString(value.shortDescription)
    || !isStringArray(value.portableResources, false)
    || !isStringArray(value.connectionTags, false)
    || !isNonEmptyString(value.experienceTag)
    || (value.connectionBridgeTags !== undefined && !isCanonicalBridgeArray(value.connectionBridgeTags))
    || (value.experienceBridgeTags !== undefined && !isCanonicalBridgeArray(value.experienceBridgeTags))) return false;
  if (value.resourceBridges === undefined) return true;
  return Array.isArray(value.resourceBridges) && value.resourceBridges.every((bridge) => isRecord(bridge)
    && isNonEmptyString(bridge.resource)
    && isCanonicalBridgeArray(bridge.bridgeTags));
}

function validDetail(value: unknown): value is PersistedNodeDetail {
  if (!isRecord(value) || !isRecord(value.detail)) return false;
  const revision = value.generatedFromPersonContextRevision;
  return isNonEmptyString(value.detail.overview)
    && isStringArray(value.detail.expectedOutcomes, false)
    && isNonEmptyString(value.detail.personConnection)
    && (revision === undefined || isNonNegativeInteger(revision));
}

export function parsePersistedWorld(value: unknown): WorldParseResult {
  if (!isRecord(value)) return { status: 'corrupt', reason: 'World payload is not an object.' };
  if (value.schemaVersion !== WORLD_SCHEMA_VERSION) return { status: 'corrupt', reason: 'Unsupported World schema version.' };
  if (value.layoutVersion !== WORLD_LAYOUT_VERSION) return { status: 'corrupt', reason: 'Unsupported World layout version.' };
  if (!isNonEmptyString(value.worldId) || !isNonNegativeInteger(value.worldRevision) || !isNonEmptyString(value.savedAt)) {
    return { status: 'corrupt', reason: 'Invalid World identity or revision.' };
  }
  if (!isRecord(value.context)
    || (value.context.contextSeed !== undefined && value.context.contextSeed !== null && typeof value.context.contextSeed !== 'string')
    || (value.context.locale !== 'ja' && value.context.locale !== 'en')
    || !isNonNegativeInteger(value.context.initialPersonContextRevision)
    || !isNonNegativeInteger(value.context.integratedPersonContextRevision)) {
    return { status: 'corrupt', reason: 'Invalid World context.' };
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || !value.nodes.every(validNode)) {
    return { status: 'corrupt', reason: 'Invalid or empty Node Catalog.' };
  }
  const nodes = value.nodes as PossibilityNode[];
  const nodeIds = nodes.map((node) => node.id);
  const knownNodes = new Set(nodeIds);
  if (knownNodes.size !== nodeIds.length) return { status: 'corrupt', reason: 'Duplicate Node ID.' };

  if (!isRecord(value.nodeStates) || !isRecord(value.explorationBands)) {
    return { status: 'corrupt', reason: 'Missing Node state or exploration bands.' };
  }
  const rawNodeStates = value.nodeStates;
  const rawExplorationBands = value.explorationBands;
  const stateKeys = Object.keys(rawNodeStates);
  const bandKeys = Object.keys(rawExplorationBands);
  if (stateKeys.length !== nodeIds.length || bandKeys.length !== nodeIds.length
    || stateKeys.some((id) => !knownNodes.has(id)) || bandKeys.some((id) => !knownNodes.has(id))
    || nodeIds.some((id) => !(id in rawNodeStates) || !(id in rawExplorationBands))) {
    return { status: 'corrupt', reason: 'Node state or band membership does not match the Catalog.' };
  }
  if (stateKeys.some((id) => !validNodeState(rawNodeStates[id]))) return { status: 'corrupt', reason: 'Invalid Node state.' };
  if (bandKeys.some((id) => !isNonNegativeInteger(rawExplorationBands[id]))) return { status: 'corrupt', reason: 'Invalid exploration band.' };
  const nodeStates = rawNodeStates as Record<string, PossibilityNodeState>;
  if (Object.values(nodeStates).filter((state) => state.activePursuit).length > 1) {
    return { status: 'corrupt', reason: 'More than one Active Pursuit.' };
  }

  if (!Array.isArray(value.generatedBatches) || value.generatedBatches.length === 0) {
    return { status: 'corrupt', reason: 'Missing generated batch history.' };
  }
  const batchMembership = new Set<string>();
  for (const batch of value.generatedBatches) {
    if (!isRecord(batch) || !isNonNegativeInteger(batch.band) || !isStringArray(batch.nodeIds, false)) {
      return { status: 'corrupt', reason: 'Invalid generated batch.' };
    }
    for (const nodeId of batch.nodeIds) {
      if (!knownNodes.has(nodeId) || rawExplorationBands[nodeId] !== batch.band || batchMembership.has(nodeId)) {
        return { status: 'corrupt', reason: 'Generated batch membership is incoherent.' };
      }
      batchMembership.add(nodeId);
    }
  }
  if (batchMembership.size !== knownNodes.size) return { status: 'corrupt', reason: 'Generated batches do not cover the Catalog.' };

  if (!isRecord(value.stepCatalog)) return { status: 'corrupt', reason: 'Invalid Step Catalog.' };
  const globalStepIds = new Set<string>();
  for (const [nodeId, steps] of Object.entries(value.stepCatalog)) {
    if (!knownNodes.has(nodeId) || !Array.isArray(steps) || steps.length !== 3 || !steps.every(validStep)) {
      return { status: 'corrupt', reason: 'Invalid Step ownership.' };
    }
    for (const step of steps) {
      if (globalStepIds.has(step.id)) return { status: 'corrupt', reason: 'Duplicate Step ID.' };
      globalStepIds.add(step.id);
    }
    const ownedStepIds = new Set(steps.map((step) => step.id));
    if (nodeStates[nodeId].completedStepIds.some((stepId) => !ownedStepIds.has(stepId))) {
      return { status: 'corrupt', reason: 'Completed Step does not belong to its Node.' };
    }
  }
  for (const nodeId of nodeIds) {
    if (nodeStates[nodeId].completedStepIds.length > 0 && !(nodeId in value.stepCatalog)) {
      return { status: 'corrupt', reason: 'Completed Node has no persisted Step Catalog.' };
    }
  }

  if (!isRecord(value.detailCache)) return { status: 'corrupt', reason: 'Invalid Detail cache.' };
  for (const [nodeId, detail] of Object.entries(value.detailCache)) {
    if (!knownNodes.has(nodeId) || !validDetail(detail)) return { status: 'corrupt', reason: 'Invalid persisted Node Detail.' };
  }
  if (!isRecord(value.ship) || !isRecord(value.ship.settledPosition)
    || !isFiniteNumber(value.ship.settledPosition.x) || !isFiniteNumber(value.ship.settledPosition.y)) {
    return { status: 'corrupt', reason: 'Invalid settled Ship position.' };
  }

  const selectedNodeId = typeof value.selectedNodeId === 'string' && knownNodes.has(value.selectedNodeId)
    ? value.selectedNodeId
    : null;
  const snapshot = value as unknown as PersistedWorldSnapshotV1;
  return { status: 'ready', snapshot: { ...snapshot, selectedNodeId } };
}

const tiersFromStates = (states: Record<string, PossibilityNodeState>): Record<string, WorldTier> => Object.fromEntries(
  Object.entries(states).map(([id, state]) => [id, state.worldTier]),
);

const sameStrings = (left: readonly string[], right: readonly string[]) => left.length === right.length
  && left.every((value, index) => value === right[index]);

export function reconcilePersistedWorld(snapshot: PersistedWorldSnapshotV1, canonicalPersonState: PersonState): RehydratedWorld {
  let personState = canonicalPersonState;
  const nextStates = Object.fromEntries(Object.entries(snapshot.nodeStates).map(([nodeId, state]) => {
    const ownedStepIds = new Set((snapshot.stepCatalog[nodeId] ?? []).map((step) => step.id));
    const completedStepIds = [...new Set([
      ...state.completedStepIds,
      ...canonicalPersonState.completedSteps.filter((stepId) => ownedStepIds.has(stepId)),
    ])];
    const landedFromPersonState = canonicalPersonState.experiences.some((experience) => experience.stepId === `landed:${nodeId}`);
    const landed = state.landed || landedFromPersonState;
    return [nodeId, {
      ...state,
      visited: state.visited || landed,
      activePursuit: landed ? false : state.activePursuit,
      landed,
      completedStepIds,
    } satisfies PossibilityNodeState];
  })) as Record<string, PossibilityNodeState>;

  for (const node of snapshot.nodes) {
    if (nextStates[node.id].landed) personState = applyLandingResources(personState, node);
  }

  let placement = computeSemanticLayout(snapshot.nodes, personState, tiersFromStates(nextStates), snapshot.explorationBands);
  const activeNode = snapshot.nodes.find((node) => nextStates[node.id].activePursuit);
  if (activeNode) {
    const state = nextStates[activeNode.id];
    const requiredSteps = snapshot.stepCatalog[activeNode.id] ?? [];
    const allRequiredStepsCompleted = requiredSteps.length === 3 && requiredSteps.every((step) => (
      state.completedStepIds.includes(step.id) && personState.completedSteps.includes(step.id)
    ));
    const target = placement.find((entry) => entry.nodeId === activeNode.id);
    const ship = snapshot.ship.settledPosition;
    const legacyCenterReached = target
      ? Math.hypot(target.targetX - ship.x, target.targetY - ship.y) <= WORLD_LANDING_RADIUS
      : false;
    const navigationBerthReached = target
      ? isSafeBerthForOwner(ship, { x: target.targetX, y: target.targetY }, activeNode.visualRecipe)
      : false;
    if (allRequiredStepsCompleted && target && (legacyCenterReached || navigationBerthReached)) {
      nextStates[activeNode.id] = { ...state, landed: true, activePursuit: false, visited: true };
      personState = applyLandingResources(personState, activeNode);
      placement = computeSemanticLayout(snapshot.nodes, personState, tiersFromStates(nextStates), snapshot.explorationBands);
    }
  }

  const nextSnapshot: PersistedWorldSnapshotV1 = {
    ...snapshot,
    nodeStates: nextStates,
    selectedNodeId: snapshot.selectedNodeId && snapshot.nodes.some((node) => node.id === snapshot.selectedNodeId)
      ? snapshot.selectedNodeId
      : null,
  };
  const personStateChanged = !sameStrings(personState.completedSteps, canonicalPersonState.completedSteps)
    || personState.experiences.length !== canonicalPersonState.experiences.length
    || !sameStrings(personState.portableResources, canonicalPersonState.portableResources);
  return { snapshot: nextSnapshot, personState: personStateChanged ? personState : canonicalPersonState, placement };
}

export function createWorldId() {
  return globalThis.crypto?.randomUUID?.() ?? `world-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
