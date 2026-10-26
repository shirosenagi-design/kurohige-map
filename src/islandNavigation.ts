import type { PlacedNode, VisualRecipe } from './model.ts';
import type { PossibilityNode } from './livingFlow.ts';
import { projectWorld, unprojectWorld, type WorldPoint } from './projection.ts';
import { VISUAL_VOCABULARY, createVocabularyLookup, type FoundationKey } from './visualVocabulary.ts';

export const WORLD_LANDING_RADIUS = 92;
export const NAVIGATION_VERSION = 1;

const terrainAliases = createVocabularyLookup(VISUAL_VOCABULARY.terrainProfiles);
const ROUTE_GRID_SIZE = 72;
const ROUTE_PADDING = 250;
const BERTH_GAP = 8;
const COLLISION_EPSILON = .75;

// These conservative envelopes cover the renderer's foundation, cliff faces,
// vegetation/architecture and the whole ship artwork at the same scene depth.
// They are intentionally larger than the shoreline's 119 px horizontal extent.
const FOUNDATION_VISUAL_RADIUS: Record<FoundationKey, number> = {
  flat: 132,
  organic: 136,
  raised: 142,
  generic: 136,
};
const SHIP_VISUAL_RADIUS = 54;
const WATER_CLEARANCE = 12;

export type NavigationPoint = WorldPoint;
export type NavigationObstacle = {
  nodeId: string;
  center: WorldPoint;
  radius: number;
  foundation: FoundationKey;
};
export type ShipVoyagePlan = {
  waypoints: NavigationPoint[];
  landingAnchor: NavigationPoint;
  ownerTarget: NavigationPoint;
  displacement: number;
  remainingDistance: number;
  navigationVersion: typeof NAVIGATION_VERSION;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(b.x - a.x, b.y - a.y);
const sceneDepthScale = (renderY: number) => .82 + clamp((renderY + 230) / 500, 0, 1) * .26;

export function foundationForRecipe(recipe: VisualRecipe | undefined): FoundationKey {
  const key = recipe?.terrainProfile?.trim().toLowerCase() ?? '';
  return terrainAliases[key] ?? 'generic';
}

export function navigationRadiusAt(target: WorldPoint, recipe?: VisualRecipe) {
  const projected = projectWorld(target);
  const foundation = foundationForRecipe(recipe);
  return (FOUNDATION_VISUAL_RADIUS[foundation] + SHIP_VISUAL_RADIUS) * sceneDepthScale(projected.y) + WATER_CLEARANCE;
}

export function navigationObstacle(node: PossibilityNode, placement: Pick<PlacedNode, 'nodeId' | 'targetX' | 'targetY'>): NavigationObstacle {
  const target = { x: placement.targetX, y: placement.targetY };
  return {
    nodeId: node.id,
    center: projectWorld(target),
    radius: navigationRadiusAt(target, node.visualRecipe),
    foundation: foundationForRecipe(node.visualRecipe),
  };
}

function segmentDistanceToPoint(a: WorldPoint, b: WorldPoint, point: WorldPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-9) return { distance: distance(a, point), t: 0 };
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const closest = { x: a.x + dx * t, y: a.y + dy * t };
  return { distance: distance(closest, point), t };
}

export function segmentClearsObstacles(a: WorldPoint, b: WorldPoint, obstacles: readonly NavigationObstacle[]) {
  return obstacles.every((obstacle) => segmentDistanceToPoint(a, b, obstacle.center).distance >= obstacle.radius - COLLISION_EPSILON);
}

export function pointClearsObstacles(point: WorldPoint, obstacles: readonly NavigationObstacle[]) {
  return obstacles.every((obstacle) => distance(point, obstacle.center) >= obstacle.radius - COLLISION_EPSILON);
}

function expandedTransitionObstacles(
  nodes: readonly PossibilityNode[],
  before: readonly PlacedNode[],
  after: readonly PlacedNode[],
) {
  const result: NavigationObstacle[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const beforeById = new Map(before.map((entry) => [entry.nodeId, entry]));
  for (const end of after) {
    const node = nodeById.get(end.nodeId);
    if (!node) continue;
    const start = beforeById.get(end.nodeId) ?? end;
    const requestedShift = Math.hypot(end.targetX - start.targetX, end.targetY - start.targetY);
    const samples = Math.max(1, Math.ceil(requestedShift / 72));
    for (let index = 0; index <= samples; index++) {
      const ratio = index / samples;
      result.push(navigationObstacle(node, {
        nodeId: end.nodeId,
        targetX: start.targetX + (end.targetX - start.targetX) * ratio,
        targetY: start.targetY + (end.targetY - start.targetY) * ratio,
      }));
    }
  }
  return result;
}

function berthCandidates(start: WorldPoint, target: NavigationObstacle, obstacles: readonly NavigationObstacle[]) {
  const base = Math.atan2(start.y - target.center.y, start.x - target.center.x);
  const offsets = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI];
  return offsets.map((offset) => ({
    x: target.center.x + Math.cos(base + offset) * (target.radius + BERTH_GAP),
    y: target.center.y + Math.sin(base + offset) * (target.radius + BERTH_GAP),
  })).filter((candidate) => pointClearsObstacles(candidate, obstacles.filter((obstacle) => obstacle !== target)));
}

type GridCell = { x: number; y: number };
type QueueEntry = GridCell & { priority: number };

class MinQueue {
  private values: QueueEntry[] = [];
  get size() { return this.values.length; }
  push(value: QueueEntry) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].priority <= value.priority) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (!last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right].priority < this.values[left].priority ? right : left;
      if (this.values[child].priority >= last.priority) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function gridRoute(start: WorldPoint, goal: WorldPoint, obstacles: readonly NavigationObstacle[]) {
  if (segmentClearsObstacles(start, goal, obstacles)) return [start, goal];
  const minX = Math.min(start.x, goal.x, ...obstacles.map((item) => item.center.x - item.radius)) - ROUTE_PADDING;
  const maxX = Math.max(start.x, goal.x, ...obstacles.map((item) => item.center.x + item.radius)) + ROUTE_PADDING;
  const minY = Math.min(start.y, goal.y) - ROUTE_PADDING;
  const maxY = Math.max(start.y, goal.y) + ROUTE_PADDING;
  const columns = Math.ceil((maxX - minX) / ROUTE_GRID_SIZE) + 1;
  const rows = Math.ceil((maxY - minY) / ROUTE_GRID_SIZE) + 1;
  if (columns * rows > 120_000) throw new Error('Safe voyage route exceeds the bounded navigation grid.');
  const toCell = (point: WorldPoint): GridCell => ({
    x: clamp(Math.round((point.x - minX) / ROUTE_GRID_SIZE), 0, columns - 1),
    y: clamp(Math.round((point.y - minY) / ROUTE_GRID_SIZE), 0, rows - 1),
  });
  const toPoint = (cell: GridCell): WorldPoint => ({ x: minX + cell.x * ROUTE_GRID_SIZE, y: minY + cell.y * ROUTE_GRID_SIZE });
  const key = (cell: GridCell) => `${cell.x},${cell.y}`;
  const requestedStartCell = toCell(start);
  let startCell = requestedStartCell;
  if (!pointClearsObstacles(toPoint(startCell), obstacles) || !segmentClearsObstacles(start, toPoint(startCell), obstacles)) {
    let replacement: { cell: GridCell; distance: number } | null = null;
    for (let radius = 1; radius <= 5 && !replacement; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const cell = { x: requestedStartCell.x + dx, y: requestedStartCell.y + dy };
          if (cell.x < 0 || cell.y < 0 || cell.x >= columns || cell.y >= rows) continue;
          const point = toPoint(cell);
          if (!pointClearsObstacles(point, obstacles) || !segmentClearsObstacles(start, point, obstacles)) continue;
          const candidateDistance = distance(start, point);
          if (!replacement || candidateDistance < replacement.distance) replacement = { cell, distance: candidateDistance };
        }
      }
    }
    if (!replacement) throw new Error('No safe navigation grid entry is available from the current Ship position.');
    startCell = replacement.cell;
  }
  const frontier = new MinQueue();
  frontier.push({ ...startCell, priority: 0 });
  const cameFrom = new Map<string, GridCell | null>([[key(startCell), null]]);
  const cost = new Map<string, number>([[key(startCell), 0]]);
  const directions = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y }))).filter(({ x, y }) => x || y);
  let reached: GridCell | null = null;
  while (frontier.size) {
    const current = frontier.pop()!;
    const currentPoint = toPoint(current);
    if (segmentClearsObstacles(currentPoint, goal, obstacles)) {
      reached = current;
      break;
    }
    for (const direction of directions) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      if (next.x < 0 || next.y < 0 || next.x >= columns || next.y >= rows) continue;
      const nextPoint = toPoint(next);
      if (!pointClearsObstacles(nextPoint, obstacles) || !segmentClearsObstacles(currentPoint, nextPoint, obstacles)) continue;
      const nextCost = cost.get(key(current))! + Math.hypot(direction.x, direction.y);
      if (nextCost >= (cost.get(key(next)) ?? Infinity)) continue;
      cost.set(key(next), nextCost);
      cameFrom.set(key(next), current);
      frontier.push({ ...next, priority: nextCost + distance(nextPoint, goal) / ROUTE_GRID_SIZE });
    }
  }
  if (!reached) throw new Error('No safe sea route exists between the current Ship position and the landing berth.');
  const cells: GridCell[] = [];
  let cursor: GridCell | null = reached;
  while (cursor) {
    cells.push(cursor);
    cursor = cameFrom.get(key(cursor)) ?? null;
  }
  const raw = [start, ...cells.reverse().map(toPoint), goal];
  const simplified: WorldPoint[] = [raw[0]];
  let index = 0;
  while (index < raw.length - 1) {
    let next = raw.length - 1;
    while (next > index + 1 && !segmentClearsObstacles(raw[index], raw[next], obstacles)) next--;
    simplified.push(raw[next]);
    index = next;
  }
  return simplified;
}

function routeLength(points: readonly WorldPoint[]) {
  let total = 0;
  for (let index = 1; index < points.length; index++) total += distance(points[index - 1], points[index]);
  return total;
}

function partialRoute(points: readonly WorldPoint[], fraction: number) {
  if (fraction >= 1) return [...points];
  const targetDistance = routeLength(points) * fraction;
  const result = [points[0]];
  let traversed = 0;
  for (let index = 1; index < points.length; index++) {
    const segment = distance(points[index - 1], points[index]);
    if (traversed + segment >= targetDistance) {
      const ratio = segment <= 1e-9 ? 0 : (targetDistance - traversed) / segment;
      result.push({
        x: points[index - 1].x + (points[index].x - points[index - 1].x) * ratio,
        y: points[index - 1].y + (points[index].y - points[index - 1].y) * ratio,
      });
      return result;
    }
    result.push(points[index]);
    traversed += segment;
  }
  return result;
}

export function planShipVoyage(
  ship: WorldPoint,
  ownerNode: PossibilityNode,
  beforeLayout: readonly PlacedNode[],
  afterLayout: readonly PlacedNode[],
  nodes: readonly PossibilityNode[],
  completedSteps: number,
  totalSteps: number,
): ShipVoyagePlan {
  const targetPlacement = afterLayout.find((entry) => entry.nodeId === ownerNode.id);
  if (!targetPlacement) throw new Error('Owner Node placement is unavailable.');
  const ownerTarget = { x: targetPlacement.targetX, y: targetPlacement.targetY };
  const obstacles = expandedTransitionObstacles(nodes, beforeLayout, afterLayout);
  const targetObstacle = navigationObstacle(ownerNode, targetPlacement);
  const projectedStart = projectWorld(ship);
  if (!pointClearsObstacles(projectedStart, obstacles)) {
    throw new Error('Ship is not on a safe water position. Repair the persisted position before starting a voyage.');
  }
  const candidates = berthCandidates(projectedStart, targetObstacle, obstacles);
  if (!candidates.length) throw new Error('No safe landing berth is available around the owner Island.');
  let best: { route: WorldPoint[]; berth: WorldPoint; length: number } | null = null;
  const directCandidate = candidates
    .filter((berth) => segmentClearsObstacles(projectedStart, berth, obstacles))
    .map((berth) => ({ berth, length: distance(projectedStart, berth) }))
    .sort((left, right) => left.length - right.length)[0];
  if (directCandidate) {
    const route = [projectedStart, directCandidate.berth];
    best = { route, berth: directCandidate.berth, length: routeLength(route) };
  }
  for (const berth of best ? [] : candidates) {
    try {
      const route = [projectedStart];
      const seaRoute = gridRoute(projectedStart, berth, obstacles);
      route.push(...seaRoute.slice(1));
      best = { route, berth, length: routeLength(route) };
      break;
    } catch {
      // Try the next shoreline candidate. A failed candidate never changes state.
    }
  }
  if (!best) throw new Error('No safe sea route exists to the owner Island.');
  const complete = completedSteps >= totalSteps;
  const fraction = complete ? 1 : completedSteps <= 1 ? .34 : .48;
  const projectedRoute = partialRoute(best.route, fraction);
  const worldRoute = projectedRoute.map(unprojectWorld);
  const landingAnchor = unprojectWorld(best.berth);
  const displacement = routeLength(projectedRoute);
  return {
    waypoints: worldRoute.slice(1),
    landingAnchor,
    ownerTarget,
    displacement,
    remainingDistance: Math.max(0, best.length - displacement),
    navigationVersion: NAVIGATION_VERSION,
  };
}

export function landingReached(ship: WorldPoint, anchor: WorldPoint, landingRadius = WORLD_LANDING_RADIUS) {
  return distance(ship, anchor) <= landingRadius;
}

export function isSafeBerthForOwner(ship: WorldPoint, ownerTarget: WorldPoint, recipe?: VisualRecipe) {
  const projectedShip = projectWorld(ship);
  const projectedTarget = projectWorld(ownerTarget);
  const radius = navigationRadiusAt(ownerTarget, recipe);
  const centerDistance = distance(projectedShip, projectedTarget);
  return centerDistance >= radius - COLLISION_EPSILON
    && centerDistance <= radius + BERTH_GAP + WORLD_LANDING_RADIUS * 1.08;
}

export function resolveUprightShipHeading(heading: number) {
  let normalized = Math.atan2(Math.sin(heading), Math.cos(heading));
  let mirror = 1;
  if (normalized > Math.PI / 2) {
    normalized -= Math.PI;
    mirror = -1;
  } else if (normalized < -Math.PI / 2) {
    normalized += Math.PI;
    mirror = -1;
  }
  return { rotation: normalized, mirror };
}

export function routeIsSeaSafe(route: readonly WorldPoint[], obstacles: readonly NavigationObstacle[]) {
  for (let index = 1; index < route.length; index++) {
    if (!segmentClearsObstacles(projectWorld(route[index - 1]), projectWorld(route[index]), obstacles)) return false;
  }
  return true;
}
