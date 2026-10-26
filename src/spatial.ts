import type { Container } from 'pixi.js';
import type { LayoutTarget } from './layout';
import { projectWorld } from './projection';

export const MAX_SHIFT_PER_UPDATE = 180;
const BASE_DURATION = 1.48;

export type NodePosition = {
  nodeId: string;
  currentWorldX: number;
  currentWorldY: number;
  startWorldX: number;
  startWorldY: number;
  targetWorldX: number;
  targetWorldY: number;
  rawTargetX: number;
  rawTargetY: number;
  startedAt: number;
  duration: number;
  moving: boolean;
  lastRequestedDistance: number;
  lastEffectiveDistance: number;
};

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

type SpatialHandle = { container: Container; offsetX?: number; offsetY?: number };

export function createSpatialController(initial: LayoutTarget[], handles: Map<string, SpatialHandle[]>) {
  const positions = new Map<string, NodePosition>();
  initial.forEach((entry, index) => positions.set(entry.nodeId, {
    nodeId: entry.nodeId,
    currentWorldX: entry.targetX,
    currentWorldY: entry.targetY,
    startWorldX: entry.targetX,
    startWorldY: entry.targetY,
    targetWorldX: entry.targetX,
    targetWorldY: entry.targetY,
    rawTargetX: entry.targetX,
    rawTargetY: entry.targetY,
    startedAt: 0,
    duration: BASE_DURATION + index * .08,
    moving: false,
    lastRequestedDistance: 0,
    lastEffectiveDistance: 0,
  }));

  const place = (position: NodePosition) => {
    const projected = projectWorld({ x: position.currentWorldX, y: position.currentWorldY });
    for (const handle of handles.get(position.nodeId) ?? []) {
      handle.container.position.set(projected.x + (handle.offsetX ?? 0), projected.y + (handle.offsetY ?? 0));
    }
  };
  positions.forEach(place);

  const addHandle = (nodeId: string, handle: SpatialHandle) => {
    const list = handles.get(nodeId) ?? [];
    list.push(handle);
    handles.set(nodeId, list);
    const position = positions.get(nodeId);
    if (position) {
      const projected = projectWorld({ x: position.currentWorldX, y: position.currentWorldY });
      handle.container.position.set(projected.x + (handle.offsetX ?? 0), projected.y + (handle.offsetY ?? 0));
    }
  };

  const applyLayoutTargets = (targets: LayoutTarget[], seconds: number) => {
    for (const target of targets) {
      const position = positions.get(target.nodeId);
      if (!position) continue;
      const dx = target.targetX - position.currentWorldX;
      const dy = target.targetY - position.currentWorldY;
      const distance = Math.hypot(dx, dy);
      const allowed = Math.min(distance, MAX_SHIFT_PER_UPDATE);
      const ratio = distance > 0 ? allowed / distance : 0;
      position.startWorldX = position.currentWorldX;
      position.startWorldY = position.currentWorldY;
      position.rawTargetX = target.targetX;
      position.rawTargetY = target.targetY;
      position.targetWorldX = position.currentWorldX + dx * ratio;
      position.targetWorldY = position.currentWorldY + dy * ratio;
      position.startedAt = seconds;
      position.moving = allowed > .01;
      position.lastRequestedDistance = distance;
      position.lastEffectiveDistance = allowed;
    }
  };

  const update = (seconds: number) => {
    let didMove = false;
    for (const position of positions.values()) {
      if (!position.moving) continue;
      didMove = true;
      const progress = (seconds - position.startedAt) / position.duration;
      const eased = smooth(progress);
      position.currentWorldX = position.startWorldX + (position.targetWorldX - position.startWorldX) * eased;
      position.currentWorldY = position.startWorldY + (position.targetWorldY - position.startWorldY) * eased;
      if (progress >= 1) {
        position.currentWorldX = position.targetWorldX;
        position.currentWorldY = position.targetWorldY;
        position.moving = false;
      }
      place(position);
    }
    return didMove;
  };

  const snapshot = () => [...positions.values()].map((position) => ({ ...position }));
  const isMoving = () => {
    for (const position of positions.values()) if (position.moving) return true;
    return false;
  };
  const forEachPosition = (visit: (position: Readonly<NodePosition>) => void) => {
    for (const position of positions.values()) visit(position);
  };
  return { addHandle, applyLayoutTargets, update, snapshot, isMoving, forEachPosition };
}
