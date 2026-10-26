export const INITIAL_WORLD_NODE_COUNT = 12;
export const WORLD_EXPANSION_BATCH_SIZE = 6;
export const TARGET_WORLD_NODE_COUNT = 120;
// Frontier exploration stops at TARGET_WORLD_NODE_COUNT. Confirmed Person Map
// changes may append bounded batches without deleting the discovered World.
export const MAX_WORLD_NODE_SUMMARIES = 240;
export const MAX_WORLD_EXPANSION_BATCH = (TARGET_WORLD_NODE_COUNT - INITIAL_WORLD_NODE_COUNT) / WORLD_EXPANSION_BATCH_SIZE;
export const FRONTIER_AHEAD_BATCHES = 2;

export type SemanticDriftZone = 0 | 1 | 2 | 3;

export function semanticDriftZoneForBatch(batch: number): SemanticDriftZone {
  if (batch <= 0) return 0;
  if (batch <= 3) return 1;
  if (batch <= 9) return 2;
  return 3;
}

export function semanticDriftGuidance(batch: number) {
  const zone = semanticDriftZoneForBatch(batch);
  const lens = [
    'people, community, and collaboration',
    'making, craft, and tangible artifacts',
    'field observation, research, and experimentation',
    'places, experiences, and local access',
    'communication, publishing, and audience connection',
    'systems, operations, and sustainable practice',
  ][Math.max(0, batch - 1) % 6];
  const zoneGuidance = {
    0: 'Initial: stay strongly and directly connected to the Context Seed and current Person State.',
    1: 'Adjacent: expand into neighboring domains and natural extensions while keeping an explicit semantic connection to the person.',
    2: 'Bridge: use portable resources, interests, and experiences as bridges into cross-domain possibilities. Depend less on the Context Seed.',
    3: 'Serendipity: allow surprising domains and indirect connections. Depend much less on the Context Seed, but retain a plausible bridge to the Current Person State or capabilities a person could carry forward.',
  }[zone];
  return `Semantic drift zone ${zone}, internal batch ${batch}: ${zoneGuidance} For diversity in this batch, especially consider ${lens}; use it only where semantically plausible and do not repeat existing concepts.`;
}
