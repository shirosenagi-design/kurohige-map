import type { ExplorationBand, PossibilityNode, PossibilityNodeState, SemanticLayoutEntry } from './livingFlow.ts';
import { projectWorld } from './projection.ts';
import { prepareAdditiveWorldExpansion } from './worldExpansion.ts';
import { WORLD_EXPANSION_BATCH_SIZE } from './worldCapacity.ts';
import type { PersistedWorldSnapshotV1 } from './worldState.ts';
import type { WorldRepository } from './worldRepository.ts';

export const PERSON_CONTEXT_EXPANSION_TIMEOUT_MS = 9 * 60 * 1000;

export function cameraForPersonContextExpansion(
  placement: readonly SemanticLayoutEntry[],
  appendedNodeIds: readonly string[],
): { x: number; y: number; zoom: number } {
  const firstTwo = appendedNodeIds.slice(0, 2).map((id) => placement.find((entry) => entry.nodeId === id));
  if (firstTwo.some((entry) => !entry)) throw new Error('New island placement is incomplete.');
  const projected = firstTwo.map((entry) => projectWorld({ x: entry!.targetX, y: entry!.targetY }));
  return {
    x: (projected[0].x + projected[1].x) / 2,
    y: (projected[0].y + projected[1].y) / 2,
    zoom: 0.55,
  };
}

export async function savePersonContextExpansion(
  repository: WorldRepository,
  currentWorld: { worldId: string; worldRevision: number; nodeIds: readonly string[] },
  incoming: readonly PossibilityNode[],
  band: ExplorationBand,
  personContextRevision: number,
): Promise<{ snapshot: PersistedWorldSnapshotV1; appended: PossibilityNode[] }> {
  if (incoming.length !== WORLD_EXPANSION_BATCH_SIZE) throw new Error('World expansion returned an incomplete batch.');
  const loaded = await repository.loadActive();
  if (loaded.status !== 'ready') throw new Error('The saved World is unavailable; the new islands were not applied.');
  const existing = loaded.snapshot;
  if (existing.worldId !== currentWorld.worldId || existing.worldRevision !== currentWorld.worldRevision
    || existing.nodes.length !== currentWorld.nodeIds.length
    || existing.nodes.some((node, index) => node.id !== currentWorld.nodeIds[index])) {
    throw new Error('The saved World changed during expansion; reload before retrying.');
  }
  const prepared = prepareAdditiveWorldExpansion(
    existing.nodes, incoming, existing.nodeStates, existing.explorationBands, band,
  );
  if (prepared.appended.length !== WORLD_EXPANSION_BATCH_SIZE) throw new Error('World expansion returned duplicate islands.');
  const snapshot: PersistedWorldSnapshotV1 = {
    ...existing,
    worldRevision: existing.worldRevision + 1,
    savedAt: new Date().toISOString(),
    context: { ...existing.context, integratedPersonContextRevision: personContextRevision },
    nodes: prepared.nodes,
    nodeStates: prepared.nodeStates as Record<string, PossibilityNodeState>,
    explorationBands: prepared.explorationBands,
    generatedBatches: [...existing.generatedBatches, { band, nodeIds: prepared.appended.map((node) => node.id) }],
  };
  if (!await repository.save(snapshot)) throw new Error('World persistence rejected the new islands.');
  return { snapshot, appended: prepared.appended };
}

export async function requestPersonContextExpansion<T>(
  body: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PERSON_CONTEXT_EXPANSION_TIMEOUT_MS,
): Promise<{ response: Response; payload: T }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new DOMException('Person Context expansion timed out.', 'TimeoutError'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl('/api/world-expand', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
        return { response, payload: await response.json() as T };
      })(),
      deadline,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
