export type WorldPoint = { x: number; y: number };

export const PROJECTION = Object.freeze({
  verticalCompression: .72,
  horizontalShear: .1,
  originX: 0,
  originY: 0,
});

export function projectWorld(point: WorldPoint): WorldPoint {
  const x = point.x - PROJECTION.originX;
  const y = point.y - PROJECTION.originY;
  return {
    x: PROJECTION.originX + x + y * PROJECTION.horizontalShear,
    y: PROJECTION.originY + y * PROJECTION.verticalCompression,
  };
}

export function unprojectWorld(point: WorldPoint): WorldPoint {
  const y = (point.y - PROJECTION.originY) / PROJECTION.verticalCompression;
  const x = point.x - PROJECTION.originX - y * PROJECTION.horizontalShear;
  return {
    x: PROJECTION.originX + x,
    y: PROJECTION.originY + y,
  };
}

export function projectVector(vector: WorldPoint): WorldPoint {
  return {
    x: vector.x + vector.y * PROJECTION.horizontalShear,
    y: vector.y * PROJECTION.verticalCompression,
  };
}
