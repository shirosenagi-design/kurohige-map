import { Container, Graphics } from 'pixi.js';
import { projectWorld, projectVector } from './projection';

export type TrailPoint = { x: number; y: number; timestamp: number };
type Point = { x: number; y: number };

const SAMPLE_DISTANCE = 16;
const TRAIL_LIFETIME = 10;
const WAKE_FADE_SECONDS = 1.15;
const MAX_POINTS = 96;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function catmullRom(p0: TrailPoint, p1: TrailPoint, p2: TrailPoint, p3: TrailPoint, t: number): TrailPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  const value = (a: number, b: number, c: number, d: number) => .5 * (
    2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3
  );
  return { x: value(p0.x, p1.x, p2.x, p3.x), y: value(p0.y, p1.y, p2.y, p3.y), timestamp: value(p0.timestamp, p1.timestamp, p2.timestamp, p3.timestamp) };
}

function smooth(points: TrailPoint[]) {
  if (points.length < 3) return points;
  const result: TrailPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let step = 0; step < 4; step++) result.push(catmullRom(p0, p1, p2, p3, step / 4));
  }
  result.push(points[points.length - 1]);
  return result;
}

export type TrailSystem = {
  root: Container;
  beginMovement: (position: Point, timestamp: number) => void;
  recordWorldPosition: (position: Point, timestamp: number) => boolean;
  endMovement: (timestamp: number) => void;
  update: (timestamp: number) => void;
  snapshot: () => { pointCount: number; moving: boolean; wakeAlpha: number };
};

export function createTrailSystem(onHeading: (radians: number) => void): TrailSystem {
  const root = new Container();
  root.name = 'pastTrailSystem';
  const trail = new Graphics();
  trail.name = 'pastTrailMesh';
  const wake = new Graphics();
  wake.name = 'localSternWake';
  root.addChild(trail, wake);

  const points: TrailPoint[] = [];
  let moving = false;
  let wakePosition: Point = { x: 0, y: 0 };
  let heading = 0;
  let lastMovementAt = -Infinity;
  let currentWakeAlpha = 0;

  const beginMovement = (position: Point, timestamp: number) => {
    moving = true;
    points.push({ ...position, timestamp });
    wakePosition = { ...position };
    lastMovementAt = timestamp;
  };

  const recordWorldPosition = (position: Point, timestamp: number) => {
    if (!moving) return false;
    const last = points[points.length - 1];
    if (last && distance(last, position) < SAMPLE_DISTANCE) return false;
    if (last) {
      const projectedDirection = projectVector({ x: position.x - last.x, y: position.y - last.y });
      heading = Math.atan2(projectedDirection.y, projectedDirection.x) + Math.PI / 2;
      onHeading(heading);
    }
    points.push({ ...position, timestamp });
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    wakePosition = { ...position };
    lastMovementAt = timestamp;
    return true;
  };

  const endMovement = (timestamp: number) => {
    moving = false;
    lastMovementAt = timestamp;
  };

  const update = (timestamp: number) => {
    while (points.length && timestamp - points[0].timestamp > TRAIL_LIFETIME) points.shift();
    trail.clear();
    const path = smooth(points);
    for (let i = 0; i < path.length - 1; i++) {
      const semanticA = path[i];
      const semanticB = path[i + 1];
      const projectedA = projectWorld(semanticA);
      const projectedB = projectWorld(semanticB);
      const a = { ...projectedA, timestamp: semanticA.timestamp };
      const b = { ...projectedB, timestamp: semanticB.timestamp };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < .01) continue;
      const age = timestamp - (a.timestamp + b.timestamp) / 2;
      const life = clamp01(1 - age / TRAIL_LIFETIME);
      const progress = (i + .5) / Math.max(1, path.length - 1);
      const width = 1.6 + 6.1 * progress;
      const alpha = .07 + .42 * life * (.3 + .7 * progress);
      const nx = -dy / length;
      const ny = dx / length;
      const nextWidth = 1.6 + 6.1 * ((i + 1.5) / Math.max(1, path.length - 1));
      trail.moveTo(a.x + nx * width, a.y + ny * width)
        .lineTo(b.x + nx * nextWidth, b.y + ny * nextWidth)
        .lineTo(b.x - nx * nextWidth, b.y - ny * nextWidth)
        .lineTo(a.x - nx * width, a.y - ny * width)
        .closePath().fill({ color: 0xeafdf8, alpha });
    }

    const wakeAlpha = moving ? .3 : .3 * clamp01(1 - (timestamp - lastMovementAt) / WAKE_FADE_SECONDS);
    currentWakeAlpha = wakeAlpha;
    wake.clear();
    if (wakeAlpha > .002) {
      // Heading zero points upward. Wake arms extend behind the actual movement direction.
      const forward = { x: Math.sin(heading), y: -Math.cos(heading) };
      const side = { x: Math.cos(heading), y: Math.sin(heading) };
      const projectedWake = projectWorld(wakePosition);
      const stern = { x: projectedWake.x - forward.x * 18, y: projectedWake.y - forward.y * 18 };
      for (const sign of [-1, 1]) {
        wake.moveTo(stern.x + side.x * sign * 5, stern.y + side.y * sign * 5)
          .quadraticCurveTo(
            stern.x - forward.x * 14 + side.x * sign * 10,
            stern.y - forward.y * 14 + side.y * sign * 10,
            stern.x - forward.x * 28 + side.x * sign * 18,
            stern.y - forward.y * 28 + side.y * sign * 18,
          ).stroke({ color: 0xf1fffb, width: 2.2, alpha: wakeAlpha });
      }
    }
  };

  return { root, beginMovement, recordWorldPosition, endMovement, update, snapshot: () => ({ pointCount: points.length, moving, wakeAlpha: currentWakeAlpha }) };
}
