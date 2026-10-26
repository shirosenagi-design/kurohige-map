import type { PlacedNode, SemanticNode, VisualRecipe } from './model.ts';
import { PROJECTION } from './projection.ts';
import { canonicalBridgeTags, type CanonicalBridgeTag } from './semanticBridgeVocabulary.ts';

export type PossibilityNodeKind = 'activity' | 'experience' | 'information' | 'opportunity' | 'skill' | 'community';
export type GoalRelation = 'direct' | 'adjacent' | 'exploratory';
export type WorldTier = 'near' | 'far';
export type ExplorationBand = number;

export type PossibilityNode = {
  id: string;
  /** Trusted shared action-experience identity. Never derived from title or place text alone. */
  reviewSubjectId?: string;
  title: string;
  shortDescription: string;
  category: string;
  nodeKind: PossibilityNodeKind;
  relationToGoal: GoalRelation;
  curiosityFit: number;
  accessibility: number;
  novelty: number;
  friction: number;
  portableResourceTags: string[];
  connectionTags: string[];
  helpedByTags?: CanonicalBridgeTag[];
  visualRecipe: VisualRecipe;
};

export type ResourceBridge = {
  resource: string;
  bridgeTags: CanonicalBridgeTag[];
};

export type LocalSmallStep = {
  id: string;
  title: string;
  shortDescription: string;
  portableResources: string[];
  connectionTags: string[];
  experienceTag: string;
  resourceBridges?: ResourceBridge[];
  connectionBridgeTags?: CanonicalBridgeTag[];
  experienceBridgeTags?: CanonicalBridgeTag[];
};

export type CompletedExperience = {
  stepId: string;
  nodeId: string;
  title: string;
  experienceTag: string;
  gainedResources: string[];
  bridgeTags?: CanonicalBridgeTag[];
};

export type PersonState = {
  interests: string[];
  engagementPatterns: string[];
  constraints: string[];
  recentChanges: string[];
  portableResources: string[];
  experiences: CompletedExperience[];
  completedSteps: string[];
  bridgeTags?: CanonicalBridgeTag[];
};

export type SemanticDistanceBreakdown = {
  distance: number;
  baseDistance: number;
  ownerProgressContribution: number;
  bridgeContribution: number;
  helpedByTags: CanonicalBridgeTag[];
  matchedBridgeTags: CanonicalBridgeTag[];
};

export type SemanticTraceEntry = SemanticDistanceBreakdown & {
  nodeId: string;
  nodeTitle: string;
  owner: boolean;
  distanceBefore: number;
  distanceAfter: number;
  delta: number;
  newlyMatchedTags: CanonicalBridgeTag[];
  ownerProgressDelta: number;
  bridgeContributionDelta: number;
};

export type SemanticStepTrace = {
  ownerNodeId: string;
  ownerNodeTitle: string;
  completedStepId: string;
  completedStepTitle: string;
  newlyGainedResources: string[];
  newlyGainedBridgeTags: CanonicalBridgeTag[];
  affectedNodes: SemanticTraceEntry[];
};

export type PossibilityNodeState = {
  visible: boolean;
  visited: boolean;
  kept: boolean;
  activePursuit: boolean;
  landed: boolean;
  worldTier: WorldTier;
  completedStepIds: string[];
};

export type SemanticLayoutEntry = PlacedNode & {
  semanticDistance: number;
};

export const emptyPersonState = (): PersonState => ({
  interests: [],
  engagementPatterns: [],
  constraints: [],
  recentChanges: [],
  portableResources: [],
  experiences: [],
  completedSteps: [],
  bridgeTags: [],
});

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const normalizedTag = (tag: string) => tag.trim().toLowerCase();

export function bridgeTagsForStep(step: LocalSmallStep): CanonicalBridgeTag[] {
  return canonicalBridgeTags([
    ...(step.resourceBridges ?? []).flatMap((bridge) => bridge.bridgeTags),
    ...(step.connectionBridgeTags ?? []),
    ...(step.experienceBridgeTags ?? []),
  ]);
}

export function computeSemanticDistanceBreakdown(node: PossibilityNode, personState: PersonState): SemanticDistanceBreakdown {
  const helpedByTags = canonicalBridgeTags(node.helpedByTags);
  const personBridgeTags = new Set(canonicalBridgeTags(personState.bridgeTags));
  const matchedBridgeTags = helpedByTags.filter((tag) => personBridgeTags.has(tag));
  const bridgeContribution = helpedByTags.length > 0 ? matchedBridgeTags.length / helpedByTags.length * .3 : 0;
  const ownerCompletedSteps = personState.experiences.filter((experience) => (
    experience.nodeId === node.id && !experience.stepId.startsWith('landed:')
  )).length;
  const ownerProgressContribution = Math.min(.3, ownerCompletedSteps * .1);
  const baseDistance = clamp01(
    .14
    + (1 - clamp01(node.curiosityFit)) * .31
    + (1 - clamp01(node.accessibility)) * .22
    + clamp01(node.novelty) * .13
    + clamp01(node.friction) * .25,
  );
  return {
    distance: clamp01(baseDistance - ownerProgressContribution - bridgeContribution),
    baseDistance,
    ownerProgressContribution,
    bridgeContribution,
    helpedByTags,
    matchedBridgeTags,
  };
}

export function computeSemanticDistance(node: PossibilityNode, personState: PersonState) {
  return computeSemanticDistanceBreakdown(node, personState).distance;
}

export function computeSemanticStepTrace(
  nodes: readonly PossibilityNode[],
  beforeState: PersonState,
  afterState: PersonState,
  ownerNode: PossibilityNode,
  step: LocalSmallStep,
): SemanticStepTrace {
  const beforeTags = new Set(canonicalBridgeTags(beforeState.bridgeTags));
  const newlyGainedBridgeTags = bridgeTagsForStep(step).filter((tag) => !beforeTags.has(tag));
  const newlyGainedResources = [...new Set([...step.portableResources, ...step.connectionTags].map(normalizedTag))]
    .filter((resource) => !new Set(beforeState.portableResources.map(normalizedTag)).has(resource));
  const affectedNodes = nodes.map((node) => {
    const before = computeSemanticDistanceBreakdown(node, beforeState);
    const after = computeSemanticDistanceBreakdown(node, afterState);
    return {
      ...after,
      nodeId: node.id,
      nodeTitle: node.title,
      owner: node.id === ownerNode.id,
      distanceBefore: before.distance,
      distanceAfter: after.distance,
      delta: after.distance - before.distance,
      newlyMatchedTags: after.helpedByTags.filter((tag) => newlyGainedBridgeTags.includes(tag)),
      ownerProgressDelta: after.ownerProgressContribution - before.ownerProgressContribution,
      bridgeContributionDelta: after.bridgeContribution - before.bridgeContribution,
    };
  }).filter((entry) => entry.owner || Math.abs(entry.delta) > 1e-9);
  return {
    ownerNodeId: ownerNode.id,
    ownerNodeTitle: ownerNode.title,
    completedStepId: step.id,
    completedStepTitle: step.title,
    newlyGainedResources,
    newlyGainedBridgeTags,
    affectedNodes,
  };
}

function stableHash(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const INITIAL_DEPTHS = [0, 220, 480, 1050, 1500, 1950, 2400, 2850, 3300, 3750, 4200, 4650] as const;
const INITIAL_PROJECTED_X = [-260, 360, -560, 620, -100, 500, -680, 190, 700, -380, 40, 430] as const;
const EXPANSION_DEPTH_OFFSETS = [0, 520, 1080, 1690, 2350, 3060] as const;
const EXPANSION_PROJECTED_X = [-620, 310, -150, 670, -410, 80] as const;

const centeredJitter = (seed: number, span: number) => (seed % (span * 2 + 1)) - span;
const semanticXForProjectedLane = (projectedX: number, targetY: number) => (
  Math.round(projectedX - targetY * PROJECTION.horizontalShear)
);

export function computeSemanticLayout(
  nodes: readonly PossibilityNode[],
  personState: PersonState,
  worldTiers: Readonly<Record<string, WorldTier>> = {},
  explorationBands: Readonly<Record<string, ExplorationBand>> = {},
): SemanticLayoutEntry[] {
  const initialNodes = nodes.filter((node) => (explorationBands[node.id] ?? 0) === 0);
  return nodes.map((node) => {
    const semanticDistance = computeSemanticDistance(node, personState);
    const explorationBand = explorationBands[node.id] ?? 0;
    const tier = worldTiers[node.id] ?? 'near';
    const identity = stableHash(`${node.id}|${node.category}|${node.nodeKind}|${node.connectionTags.join('|')}`);
    if (explorationBand > 0) {
      const bandNodes = nodes.filter((candidate) => (explorationBands[candidate.id] ?? 0) === explorationBand);
      const bandIndex = bandNodes.findIndex((candidate) => candidate.id === node.id);
      const depth = 4700 + (explorationBand - 1) * 3050
        + (EXPANSION_DEPTH_OFFSETS[bandIndex] ?? bandIndex * 560)
        + semanticDistance * 140
        + centeredJitter(identity >>> 9, 90);
      const targetY = -Math.round(depth);
      const laneIndex = (bandIndex + explorationBand * 2) % EXPANSION_PROJECTED_X.length;
      const projectedX = EXPANSION_PROJECTED_X[laneIndex] + centeredJitter(identity, 90);
      return {
        nodeId: node.id,
        targetX: semanticXForProjectedLane(projectedX, targetY),
        targetY,
        visibility: 1,
        fogDepth: .42,
        semanticDistance,
      };
    }
    const index = initialNodes.findIndex((candidate) => candidate.id === node.id);
    const depth = (INITIAL_DEPTHS[index] ?? index * 440) + semanticDistance * 80 + centeredJitter(identity >>> 8, 35);
    const targetY = Math.round(200 - depth);
    const projectedX = (INITIAL_PROJECTED_X[index] ?? EXPANSION_PROJECTED_X[index % EXPANSION_PROJECTED_X.length])
      + centeredJitter(identity, 70);
    return {
      nodeId: node.id,
      targetX: semanticXForProjectedLane(projectedX, targetY),
      targetY,
      visibility: 1,
      fogDepth: tier === 'far' ? .36 : Math.max(0, semanticDistance - .58) * .8,
      semanticDistance,
    };
  });
}

export function initialWorldTiers(nodes: readonly PossibilityNode[]): Record<string, WorldTier> {
  return Object.fromEntries(nodes.map((node, index) => [
    node.id,
    index < 6 ? 'near' : 'far',
  ]));
}

export function computeShipAdvance(
  ship: { x: number; y: number },
  target: { targetX: number; targetY: number },
  completedSteps: number,
  totalSteps: number,
  landingRadius = 92,
) {
  const dx = target.targetX - ship.x;
  const dy = target.targetY - ship.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= .001) return { x: ship.x, y: ship.y, displacement: 0, remainingDistance: 0 };
  const complete = completedSteps >= totalSteps;
  const moveDistance = complete
    ? Math.max(0, distance - landingRadius * .72)
    : distance * (completedSteps <= 1 ? .34 : .48);
  const ratio = Math.min(1, moveDistance / distance);
  const x = ship.x + dx * ratio;
  const y = ship.y + dy * ratio;
  return { x, y, displacement: moveDistance, remainingDistance: Math.hypot(target.targetX - x, target.targetY - y) };
}

export function applyLandingResources(personState: PersonState, node: PossibilityNode): PersonState {
  const landingId = `landed:${node.id}`;
  if (personState.experiences.some((experience) => experience.stepId === landingId)) return personState;
  const gainedResources = ['skill', 'knowledge', 'experience', 'artifact', 'confidence', 'connection'];
  return {
    ...personState,
    portableResources: [...new Set([...personState.portableResources, ...gainedResources])],
    experiences: [...personState.experiences, {
      stepId: landingId,
      nodeId: node.id,
      title: `${node.title}へ到達`,
      experienceTag: 'local_island_landing',
      gainedResources,
    }],
  };
}

export function asSemanticNode(node: PossibilityNode): SemanticNode {
  return {
    id: node.id,
    title: node.title,
    description: node.shortDescription,
    category: `${node.category} · ${node.nodeKind}`,
    status: 'unseen',
    visualTheme: 'harbor',
    visualRecipe: node.visualRecipe,
  };
}

export function completeLocalStep(
  personState: PersonState,
  node: PossibilityNode,
  step: LocalSmallStep,
): PersonState {
  if (personState.completedSteps.includes(step.id)) return personState;
  const portableResources = [...new Set([
    ...personState.portableResources,
    ...step.portableResources,
    ...step.connectionTags,
  ].map(normalizedTag))];
  const gainedBridgeTags = bridgeTagsForStep(step);
  return {
    ...personState,
    portableResources,
    completedSteps: [...personState.completedSteps, step.id],
    bridgeTags: canonicalBridgeTags([...(personState.bridgeTags ?? []), ...gainedBridgeTags]),
    experiences: [...personState.experiences, {
      stepId: step.id,
      nodeId: node.id,
      title: step.title,
      experienceTag: step.experienceTag,
      gainedResources: [...step.portableResources, ...step.connectionTags],
      bridgeTags: gainedBridgeTags,
    }],
  };
}
