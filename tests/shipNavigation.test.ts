import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlacedNode, VisualRecipe } from '../src/model.ts';
import type { PossibilityNode } from '../src/livingFlow.ts';
import {
  foundationForRecipe,
  landingReached,
  navigationObstacle,
  navigationRadiusAt,
  planShipVoyage,
  resolveUprightShipHeading,
  routeIsSeaSafe,
  WORLD_LANDING_RADIUS,
} from '../src/islandNavigation.ts';
import { projectWorld, unprojectWorld } from '../src/projection.ts';

const recipe = (terrainProfile: string): VisualRecipe => ({
  visualTheme: 'outdoor_recreation',
  dominantMotif: 'campsite_marker',
  secondaryObjects: ['shelter', 'sign'],
  terrainProfile,
  accentPalette: 'green_amber',
  density: 'dense',
  openness: 'compact',
  landmarkEmphasis: 'high',
  energyLevel: 'moderate',
});

const node = (id: string, terrainProfile: string): PossibilityNode => ({
  id,
  title: id,
  shortDescription: id,
  category: 'activity',
  nodeKind: 'activity',
  relationToGoal: 'adjacent',
  curiosityFit: .7,
  accessibility: .7,
  novelty: .6,
  friction: .3,
  portableResourceTags: [],
  connectionTags: [],
  helpedByTags: [],
  visualRecipe: recipe(terrainProfile),
});

const placement = (nodeId: string, x: number, y: number): PlacedNode => ({ nodeId, targetX: x, targetY: y, visibility: 1, fogDepth: 0 });
const projectedDirectionStart = (target: { x: number; y: number }, direction: 'up' | 'down' | 'left' | 'right', distance = 900) => {
  const projectedTarget = projectWorld(target);
  return unprojectWorld({
    x: projectedTarget.x + (direction === 'left' ? -distance : direction === 'right' ? distance : 0),
    y: projectedTarget.y + (direction === 'up' ? -distance : direction === 'down' ? distance : 0),
  });
};

test('all renderer foundation families produce safe water berths from all four approach directions', () => {
  for (const terrain of ['flat', 'organic', 'raised', 'generic']) {
    assert.equal(foundationForRecipe(recipe(terrain)), terrain);
    for (const targetY of [250, -700]) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        const owner = node(`owner-${terrain}-${targetY}-${direction}`, terrain);
        const ownerTarget = { x: 0, y: targetY };
        const layout = [placement(owner.id, ownerTarget.x, ownerTarget.y)];
        const start = projectedDirectionStart(ownerTarget, direction);
        const plan = planShipVoyage(start, owner, layout, layout, [owner], 3, 3);
        const route = [start, ...plan.waypoints];
        const obstacle = navigationObstacle(owner, layout[0]);
        assert.equal(routeIsSeaSafe(route, [obstacle]), true, `${terrain}/${targetY}/${direction} route crossed terrain`);
        assert.equal(landingReached(plan.waypoints.at(-1)!, plan.landingAnchor, WORLD_LANDING_RADIUS), true);
        const berthDistance = Math.hypot(
          projectWorld(plan.landingAnchor).x - obstacle.center.x,
          projectWorld(plan.landingAnchor).y - obstacle.center.y,
        );
        assert.ok(berthDistance > WORLD_LANDING_RADIUS, `${terrain}/${targetY}/${direction} still used the old center radius`);
        assert.ok(berthDistance >= obstacle.radius);
      }
    }
  }
});

test('route planner goes around an intervening Island and keeps the full polyline at sea', () => {
  const owner = node('owner', 'organic');
  const blocker = node('blocker', 'raised');
  const layout = [placement(owner.id, 0, -1500), placement(blocker.id, 0, -750)];
  const start = { x: 0, y: 500 };
  const plan = planShipVoyage(start, owner, layout, layout, [owner, blocker], 3, 3);
  const obstacles = [navigationObstacle(owner, layout[0]), navigationObstacle(blocker, layout[1])];
  assert.ok(plan.waypoints.length >= 2, 'the blocker should require a waypoint');
  assert.equal(routeIsSeaSafe([start, ...plan.waypoints], obstacles), true);
});

test('a legacy Ship position already inside terrain is rejected instead of drawing an over-land escape', () => {
  const owner = node('legacy-overlap-owner', 'raised');
  const layout = [placement(owner.id, 0, -300)];
  assert.throws(
    () => planShipVoyage({ x: 0, y: -300 }, owner, layout, layout, [owner], 1, 3),
    /not on a safe water position/,
  );
});

test('layout transition swept area is avoided and partial STEP routes remain at sea', () => {
  const owner = node('owner-moving', 'flat');
  const blocker = node('blocker-moving', 'generic');
  const before = [placement(owner.id, 520, -1400), placement(blocker.id, -90, -650)];
  const after = [placement(owner.id, 400, -1510), placement(blocker.id, 90, -760)];
  const start = { x: -500, y: 400 };
  for (const completed of [1, 2]) {
    const plan = planShipVoyage(start, owner, before, after, [owner, blocker], completed, 3);
    assert.ok(plan.remainingDistance > 0);
    assert.equal(landingReached(plan.waypoints.at(-1)!, plan.landingAnchor), false);
  }
});

test('navigation geometry is independent of Camera zoom and scales only from scene depth', () => {
  const near = navigationRadiusAt({ x: 0, y: 250 }, recipe('organic'));
  const far = navigationRadiusAt({ x: 0, y: -700 }, recipe('organic'));
  assert.ok(near > far);
  const owner = node('zoom-owner', 'organic');
  const layout = [placement(owner.id, 0, -300)];
  const start = { x: 700, y: 300 };
  const plan = planShipVoyage(start, owner, layout, layout, [owner], 3, 3);
  const worldAnchor = plan.landingAnchor;
  const obstacle = navigationObstacle(owner, layout[0]);
  for (const zoom of [.55, 1, 2.2]) {
    const projected = projectWorld(worldAnchor);
    const clearance = (Math.hypot(projected.x - obstacle.center.x, projected.y - obstacle.center.y) - obstacle.radius) * zoom;
    assert.ok(clearance > 0);
  }
});

test('heading resolver keeps artwork upright while preserving travel-side mirroring', () => {
  for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI * 1.75, -Math.PI * 1.75]) {
    const resolved = resolveUprightShipHeading(heading);
    assert.ok(resolved.rotation >= -Math.PI / 2 && resolved.rotation <= Math.PI / 2);
    assert.ok(resolved.mirror === 1 || resolved.mirror === -1);
  }
  assert.deepEqual(resolveUprightShipHeading(0), { rotation: 0, mirror: 1 });
  assert.equal(resolveUprightShipHeading(Math.PI).mirror, -1);
});

test('route planning remains bounded with a 120-island discovered World', () => {
  const nodes = Array.from({ length: 120 }, (_, index) => node(`scale-${index}`, ['flat', 'organic', 'raised', 'generic'][index % 4]));
  const layout = nodes.map((entry, index) => placement(
    entry.id,
    index === 119 ? 0 : (index % 2 ? -720 : 720),
    -index * 350,
  ));
  // Force one meaningful detour without creating an artificial cross-World wall.
  layout[55] = placement(nodes[55].id, 0, -19_250);
  const started = performance.now();
  const plan = planShipVoyage({ x: 0, y: 500 }, nodes[119], layout, layout, nodes, 3, 3);
  const elapsedMs = performance.now() - started;
  assert.equal(routeIsSeaSafe(
    [{ x: 0, y: 500 }, ...plan.waypoints],
    layout.map((entry, index) => navigationObstacle(nodes[index], entry)),
  ), true);
  assert.ok(elapsedMs < 2_000, `120-island route planning took ${elapsedMs.toFixed(1)} ms`);
});
