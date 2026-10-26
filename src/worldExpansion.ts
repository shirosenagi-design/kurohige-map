import type { ExplorationBand, PossibilityNode, PossibilityNodeState } from './livingFlow.ts';

const normalizedTitle = (value: string) => value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const titleBigrams = (value: string) => {
  const normalized = normalizedTitle(value);
  return new Set([...normalized].slice(0, -1).map((character, index) => character + normalized[index + 1]));
};

export const nearDuplicatePossibilityTitle = (left: string, right: string) => {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter >= 8 && shorter / longer >= .82 && (a.includes(b) || b.includes(a))) return true;
  const aPairs = titleBigrams(a);
  const bPairs = titleBigrams(b);
  const intersection = [...aPairs].filter((pair) => bPairs.has(pair)).length;
  const union = new Set([...aPairs, ...bPairs]).size;
  return union > 0 && intersection / union >= .8;
};

export function appendDistinctPossibilityNodes(
  existing: readonly PossibilityNode[],
  incoming: readonly PossibilityNode[],
) {
  const accepted: PossibilityNode[] = [];
  for (const candidate of incoming) {
    const catalog = [...existing, ...accepted];
    if (catalog.some((node) => node.id === candidate.id || nearDuplicatePossibilityTitle(node.title, candidate.title))) continue;
    accepted.push(candidate);
  }
  return accepted;
}

export function prepareAdditiveWorldExpansion(
  existingNodes: readonly PossibilityNode[],
  incoming: readonly PossibilityNode[],
  existingStates: Readonly<Record<string, PossibilityNodeState>>,
  existingBands: Readonly<Record<string, ExplorationBand>>,
  band: ExplorationBand,
) {
  const appended = appendDistinctPossibilityNodes(existingNodes, incoming);
  const nodeStates = { ...existingStates };
  const explorationBands = { ...existingBands };
  for (const node of appended) {
    nodeStates[node.id] = {
      visible: true,
      visited: false,
      kept: false,
      activePursuit: false,
      landed: false,
      worldTier: 'far',
      completedStepIds: [],
    };
    explorationBands[node.id] = band;
  }
  return {
    appended,
    nodes: [...existingNodes, ...appended],
    nodeStates,
    explorationBands,
  };
}
