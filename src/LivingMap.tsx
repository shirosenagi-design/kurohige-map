import { createAmbientGulls } from './gulls';
import { useEffect, useRef, useState } from 'react';
import { Application, Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { playerWorldPosition, type PlacedNode, type SemanticNode } from './model';
import { createOcean } from './ocean';
import { createIsland, updateIslandMotion, type IslandMotion } from './islands';
import { createIslandFromRecipe, normalizeVisualRecipe, verifyUnknownRecipeFallback } from './recipeIslands';
import { createPin, placePinPresentation, resolvePinLabelCollisions, setPinState, updatePinBreath, type PinView } from './pins';
import type { NodeFlags } from './model';
import { createShip } from './ship';
import { createTrailSystem } from './trail';
import { createMarineFog } from './marineFog';
import { createNodeReveal, type NodeRevealView } from './reveal';
import { layoutHarnessUpdate, type LayoutTarget } from './layout';
import { createSpatialController, type NodePosition } from './spatial';
import { projectVector, projectWorld } from './projection';
import { createSceneComposition, sceneDepth } from './scene';

export const layerNames = [
  'deepOcean', 'waterSurface', 'shipTrail', 'islandShadows', 'islands',
  'islandObjects', 'ambientActors', 'playerShip', 'pinsLabels', 'marineFog',
] as const;
type LayerName = (typeof layerNames)[number];

type Camera = { x: number; y: number; zoom: number };
type Point = { x: number; y: number };
type ShipRuntimeMovement = {
  to: Point;
  waypoints: Point[];
  targetNodeId: string;
  landingAnchor?: Point;
  ownerTarget?: Point;
  navigationVersion?: number;
  remainingDuration: number;
};
type ShipRuntimeState = { position: Point; movement: ShipRuntimeMovement | null };
type CameraMovementSource = 'initial' | 'user-pan' | 'user-inertia' | 'user-pinch' | 'wheel-zoom' | 'voyage-follow' | 'current-location' | 'resize' | 'bounds';
export type ShipMoveCommand = {
  revision: number;
  targetX: number;
  targetY: number;
  targetNodeId: string;
  waypoints?: Point[];
  landingAnchor?: Point;
  ownerTarget?: Point;
  navigationVersion?: number;
  duration?: number;
};
export type ShipMovementSnapshot = {
  x: number;
  y: number;
  moving: boolean;
  targetNodeId: string | null;
  trailPointCount: number;
  landingAnchor?: Point;
  ownerTarget?: Point;
  navigationVersion?: number;
};
export type ExplorationFrontierSnapshot = Camera & { minY: number; maxY: number; distanceToFrontier: number };
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.2;
const INERTIA_DECAY = 5.8;
const MIN_INERTIA_SPEED = 12;
const MAX_INERTIA_SPEED = 920;
const VELOCITY_SAMPLE_MS = 120;
const RETURN_DURATION = .72;
const WORLD_MARGIN_X = 520;
const WORLD_MARGIN_Y = 430;
const BOUNDS_SLOW_ZONE = 110;
const PREFETCH_VIEWPORTS_AHEAD = 1.8;
const MIN_PREFETCH_DISTANCE = 1100;
const OCEAN_COVERAGE_GUTTER = 256;
const VOYAGE_CAMERA_ACQUIRE_FRACTION = .22;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const pointDistance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const polylineLength = (points: readonly Point[]) => points.slice(1)
  .reduce((total, point, index) => total + pointDistance(points[index], point), 0);
const samplePolyline = (points: readonly Point[], progress: number) => {
  const total = polylineLength(points);
  if (total <= .001 || progress >= 1) return { point: { ...points[points.length - 1] }, segmentIndex: Math.max(0, points.length - 2) };
  const target = total * clamp(progress, 0, 1);
  let traversed = 0;
  for (let index = 1; index < points.length; index++) {
    const segment = pointDistance(points[index - 1], points[index]);
    if (traversed + segment >= target) {
      const ratio = segment <= .001 ? 0 : (target - traversed) / segment;
      return {
        point: {
          x: points[index - 1].x + (points[index].x - points[index - 1].x) * ratio,
          y: points[index - 1].y + (points[index].y - points[index - 1].y) * ratio,
        },
        segmentIndex: index - 1,
      };
    }
    traversed += segment;
  }
  return { point: { ...points[points.length - 1] }, segmentIndex: Math.max(0, points.length - 2) };
};
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

function createLandedMarker() {
  const root = new Container();
  root.name = 'landedIslandMarker';
  const shadow = new Graphics().ellipse(0, -10, 18, 6).fill({ color: 0x103d50, alpha: .18 });
  const flag = new Graphics()
    .moveTo(-8, -15).lineTo(-8, -63).stroke({ color: 0x725442, width: 3 })
    .moveTo(-7, -62).quadraticCurveTo(13, -69, 23, -55).quadraticCurveTo(10, -48, -7, -53).closePath().fill(0xffc85a)
    .circle(-8, -65, 3.5).fill(0xfff4c7);
  root.addChild(shadow, flag);
  root.visible = false;
  return root;
}
const islandSpritePilots: Record<string, {
  url: string;
  name: string;
  anchorX: number;
  anchorY: number;
  baseScale: number;
  pinOffsetY: number;
}> = {
  research: {
    url: '/assets/islands/research-island-pilot.png',
    name: 'researchIslandAssetPilot',
    anchorX: .5,
    anchorY: .57,
    baseScale: .2,
    pinOffsetY: -145,
  },
  film: {
    url: '/assets/islands/creative-island-pilot.png',
    name: 'creativeIslandAssetPilot',
    anchorX: .5,
    anchorY: .555,
    baseScale: .182,
    pinOffsetY: -145,
  },
};

export function LivingMap({
  onSelect,
  selectedId,
  flags,
  activeNodes,
  activePlacement,
  revision,
  layoutUpdate,
  onSpatialSnapshot,
  initialShipPosition = playerWorldPosition,
  shipMove,
  onShipSnapshot,
  onShipMovementComplete,
  revealUpdate,
  landedNodeIds = [],
  canonicalScene = false,
  initialCamera,
  onExplorationFrontier,
}: {
  onSelect: (id: string) => void;
  selectedId: string;
  flags: Record<string, NodeFlags>;
  activeNodes: readonly SemanticNode[];
  activePlacement: readonly PlacedNode[];
  revision: number;
  layoutUpdate?: { revision: number; targets: readonly PlacedNode[] } | null;
  onSpatialSnapshot?: (snapshot: readonly NodePosition[]) => void;
  initialShipPosition?: Point;
  shipMove?: ShipMoveCommand | null;
  onShipSnapshot?: (snapshot: ShipMovementSnapshot) => void;
  onShipMovementComplete?: (snapshot: ShipMovementSnapshot) => void;
  revealUpdate?: { revision: number; nodeIds: readonly string[] } | null;
  landedNodeIds?: readonly string[];
  canonicalScene?: boolean;
  initialCamera?: Camera | null;
  onExplorationFrontier?: (snapshot: ExplorationFrontierSnapshot) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef(selectedId);
  const flagsRef = useRef(flags);
  const pinsRef = useRef<PinView[]>([]);
  const returnToShipRef = useRef<() => void>(() => {});
  const applyLayoutUpdateRef = useRef<(targets: readonly PlacedNode[]) => void>(() => {});
  const startShipMovementRef = useRef<(command: ShipMoveCommand) => void>(() => {});
  const revealNodesRef = useRef<(nodeIds: readonly string[]) => void>(() => {});
  const refreshPinLabelsRef = useRef<() => void>(() => {});
  const landedMarkersRef = useRef(new Map<string, Container>());
  const landedNodeIdsRef = useRef(landedNodeIds);
  const shipRuntimeRef = useRef<ShipRuntimeState>({ position: { ...initialShipPosition }, movement: null });
  const consumedShipMoveRevisionRef = useRef(-1);
  const onSpatialSnapshotRef = useRef(onSpatialSnapshot);
  const onShipSnapshotRef = useRef(onShipSnapshot);
  const onShipMovementCompleteRef = useRef(onShipMovementComplete);
  const onExplorationFrontierRef = useRef(onExplorationFrontier);
  const sceneInstanceRef = useRef<{ canvas: HTMLCanvasElement; cleanup: () => void } | null>(null);
  const sceneBuildGenerationRef = useRef(0);
  const sceneUnmountedRef = useRef(false);
  const [returnVisible, setReturnVisible] = useState(false);
  onSelectRef.current = onSelect;
  selectedRef.current = selectedId;
  flagsRef.current = flags;
  onSpatialSnapshotRef.current = onSpatialSnapshot;
  onShipSnapshotRef.current = onShipSnapshot;
  onShipMovementCompleteRef.current = onShipMovementComplete;
  onExplorationFrontierRef.current = onExplorationFrontier;
  landedNodeIdsRef.current = landedNodeIds;

  useEffect(() => {
    if (!shipRuntimeRef.current.movement) shipRuntimeRef.current.position = { ...initialShipPosition };
  }, [initialShipPosition.x, initialShipPosition.y]);

  useEffect(() => {
    for (const pin of pinsRef.current) setPinState(pin, pin.id === selectedId, flags[pin.id] ?? { kept: false, visited: false });
    refreshPinLabelsRef.current();
  }, [selectedId, flags]);

  useEffect(() => {
    if (layoutUpdate) applyLayoutUpdateRef.current(layoutUpdate.targets);
  }, [layoutUpdate]);

  useEffect(() => {
    if (shipMove) startShipMovementRef.current(shipMove);
    else consumedShipMoveRevisionRef.current = -1;
  }, [shipMove]);

  useEffect(() => {
    if (revealUpdate) revealNodesRef.current(revealUpdate.nodeIds);
  }, [revealUpdate]);

  useEffect(() => {
    const landed = new Set(landedNodeIds);
    for (const [nodeId, marker] of landedMarkersRef.current) marker.visible = landed.has(nodeId);
    if (hostRef.current) hostRef.current.dataset.landedNodeIds = JSON.stringify([...landed]);
  }, [landedNodeIds]);

  useEffect(() => {
    sceneUnmountedRef.current = false;
    return () => {
      sceneUnmountedRef.current = true;
      sceneBuildGenerationRef.current += 1;
      sceneInstanceRef.current?.cleanup();
      sceneInstanceRef.current = null;
      returnToShipRef.current = () => {};
      applyLayoutUpdateRef.current = () => {};
      startShipMovementRef.current = () => {};
      revealNodesRef.current = () => {};
      refreshPinLabelsRef.current = () => {};
      pinsRef.current = [];
      landedMarkersRef.current = new Map();
      delete (window as Window & { __kurohigeSpike?: unknown }).__kurohigeSpike;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    const generation = ++sceneBuildGenerationRef.current;
    let disposed = false;
    let cleanup = () => {};
    const buildIsStale = () => disposed || sceneUnmountedRef.current || generation !== sceneBuildGenerationRef.current;

    async function mount() {
      await app.init({ resizeTo: host!, background: '#78d0eb', antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      if (buildIsStale()) { app.destroy({ removeView: true, releaseGlobalResources: false }); return; }
      const query = new URLSearchParams(window.location.search);
      const recipePilotEnabled = import.meta.env.DEV && query.get('recipePilot') === '1';
      const nemotronPilotEnabled = import.meta.env.DEV && query.get('nemotronPilot') === '1';
      const livingFlowPilotEnabled = import.meta.env.DEV && query.get('livingFlowPilot') === '1';
      const recipeDriven = recipePilotEnabled || nemotronPilotEnabled || livingFlowPilotEnabled;
      const scenePilotEnabled = canonicalScene || (import.meta.env.DEV && query.get('scenePilot') === '1');
      const sceneDebugEnabled = import.meta.env.DEV && query.get('scenePilot') === '1' && query.get('sceneDebug') === '1';
      const assetPilotEnabled = import.meta.env.DEV && !recipeDriven && (query.get('assetPilot') === '1' || scenePilotEnabled);
      const pilotTextures = new Map<string, Texture>();
      if (assetPilotEnabled) {
        await Promise.all(Object.entries(islandSpritePilots).map(async ([nodeId, pilot]) => {
          pilotTextures.set(nodeId, await Assets.load<Texture>(pilot.url));
        }));
      }
      if (buildIsStale()) { app.destroy({ removeView: true, releaseGlobalResources: false }); return; }
      app.canvas.className = 'map-canvas';
      host!.dataset.recipePilot = recipePilotEnabled ? '1' : '0';
      host!.dataset.nemotronPilot = nemotronPilotEnabled ? '1' : '0';
      if (recipeDriven) {
        const fallbackProbe = verifyUnknownRecipeFallback();
        host!.dataset.recipeFallbackProbe = JSON.stringify(fallbackProbe);
        host!.dataset.recipeVisualIdentity = 'visual-recipe-only';
        host!.dataset.recipeNodes = JSON.stringify(activeNodes.map((node) => ({
          id: node.id,
          recipe: node.visualRecipe ? normalizeVisualRecipe(node.visualRecipe) : null,
        })));
      }

      const world = new Container();
      const scene = scenePilotEnabled ? await createSceneComposition(sceneDebugEnabled) : null;
      if (buildIsStale()) { app.destroy({ removeView: true, releaseGlobalResources: false }); return; }
      if (scene) app.stage.addChild(scene.root);
      const layers = Object.fromEntries(layerNames.map((name) => [name, new Container()])) as Record<LayerName, Container>;
      for (const name of layerNames) world.addChild(layers[name]);
      app.stage.addChild(world);
      if (scene) app.stage.addChild(scene.overlay);

      // Each layer is a separate target for future animation, reveal, and redraw work.
      const ocean = await createOcean(layers.deepOcean, layers.waterSurface, activePlacement);
      if (buildIsStale()) { app.destroy({ removeView: true, releaseGlobalResources: false }); return; }
      if (scene) {
        layers.deepOcean.mask = scene.waterMask;
        layers.waterSurface.mask = scene.waterMask;
      }
      const islandMotions: IslandMotion[] = [];
      const pinViews: PinView[] = [];
      const nodeViews = new Map<string, Omit<NodeRevealView, 'localFog'>>();
      const nodeWorldVisuals = new Map<string, Container[]>();
      const nodePilotRoots = new Map<string, Container>();
      const landedMarkers = new Map<string, Container>();
      const spatialHandles = new Map<string, { container: Container; offsetX?: number; offsetY?: number }[]>();

      activePlacement.forEach((placed) => {
        const data = activeNodes.find((node) => node.id === placed.nodeId)!;
        const art = data.visualRecipe
          ? createIslandFromRecipe(data.visualRecipe)
          : createIsland(data.visualTheme);
        islandMotions.push(art.motion);
        for (const part of [art.shadow, art.shoreline, art.terrain, art.objects]) part.position.set(placed.targetX, placed.targetY);
        layers.islandShadows.addChild(art.shadow);
        layers.islands.addChild(art.shoreline);
        layers.islands.addChild(art.terrain);
        layers.islandObjects.addChild(art.objects);

        let pilotRoot: Container | null = null;
        const pilot = data.visualRecipe ? undefined : islandSpritePilots[data.id];
        const pilotTexture = pilotTextures.get(data.id);
        if (pilot && pilotTexture) {
          art.shadow.visible = false;
          art.shoreline.visible = false;
          art.terrain.visible = false;
          art.objects.visible = false;
          pilotRoot = new Container();
          pilotRoot.name = pilot.name;
          const sprite = new Sprite(pilotTexture);
          sprite.anchor.set(pilot.anchorX, pilot.anchorY);
          sprite.scale.set(pilot.baseScale);
          pilotRoot.addChild(sprite);
          layers.islands.addChild(pilotRoot);
          nodePilotRoots.set(data.id, pilotRoot);
        }

        const pin = createPin(data, placed.targetX, placed.targetY - 109, (id) => onSelectRef.current(id));
        setPinState(pin, data.id === selectedRef.current, flagsRef.current[data.id]);
        pinViews.push(pin);
        layers.pinsLabels.addChild(pin.root);
        nodeViews.set(data.id, { island: art, pin });
        const landedMarker = createLandedMarker();
        landedMarker.visible = landedNodeIdsRef.current.includes(data.id);
        layers.islandObjects.addChild(landedMarker);
        landedMarkers.set(data.id, landedMarker);
        const handles = [
          { container: art.shadow }, { container: art.shoreline }, { container: art.terrain }, { container: art.objects },
          { container: landedMarker },
          { container: pin.root, offsetY: pilotRoot && pilot ? pilot.pinOffsetY : -109 },
        ];
        if (pilotRoot) handles.push({ container: pilotRoot });
        spatialHandles.set(data.id, handles);
        nodeWorldVisuals.set(data.id, pilotRoot
          ? [art.shadow, art.shoreline, art.terrain, art.objects, landedMarker, pilotRoot]
          : [art.shadow, art.shoreline, art.terrain, art.objects, landedMarker]);
      });
      pinsRef.current = pinViews;
      landedMarkersRef.current = landedMarkers;
      const currentLandedNodeIds = new Set(landedNodeIdsRef.current);
      for (const [nodeId, marker] of landedMarkers) marker.visible = currentLandedNodeIds.has(nodeId);
      host!.dataset.landedNodeIds = JSON.stringify([...currentLandedNodeIds]);
      const initialLayout: LayoutTarget[] = activePlacement.map((item) => ({
        nodeId: item.nodeId, targetX: item.targetX, targetY: item.targetY,
        visibility: item.visibility, fogDepth: item.fogDepth,
      }));
      const spatial = createSpatialController(initialLayout, spatialHandles);

      // Future trail code must read the controller's World Root, never its idle transform.
      const runtimeShipPosition = shipRuntimeRef.current.position;
      const ship = createShip(runtimeShipPosition.x, runtimeShipPosition.y);
      layers.playerShip.addChild(ship.worldRoot);
      layers.pinsLabels.addChild(ship.label);
      const trail = createTrailSystem((heading) => ship.setHeading(heading));
      layers.shipTrail.addChild(trail.root);

      // Ambient gulls live in the dedicated Ambient Actors layer.
      createAmbientGulls(layers.ambientActors);
      const marineFog = createMarineFog();
      layers.marineFog.addChild(marineFog.root);

      // Frame the northern labels below navigation and the ship above the card.
      const camera: Camera = initialCamera
        ? { x: initialCamera.x, y: initialCamera.y, zoom: clamp(initialCamera.zoom, MIN_ZOOM, MAX_ZOOM) }
        : host!.clientWidth < 700
          ? scenePilotEnabled ? { x: -18, y: 20, zoom: 0.55 } : { x: 32, y: 20, zoom: 0.63 }
          : { x: 0, y: -70, zoom: 0.72 };
      let cameraVelocity: Point = { x: 0, y: 0 };
      let returnAnimation: { from: Point; to: Point; startedAt: number } | null = null;
      let worldBounds = { minX: -850, maxX: 850, minY: -760, maxY: 760 };
      // Keep the current Ship anchor for scene diagnostics. Camera bounds stay
      // tied to the full discovered World so historical regions remain reachable.
      let guardedShipAnchorY = projectWorld(initialShipPosition).y;
      let wasSpatialMoving = false;
      let lastReturnVisible = false;
      const cancelCameraMotion = () => {
        cameraVelocity = { x: 0, y: 0 };
        returnAnimation = null;
      };
      const refreshOceanCoverage = () => {
        const coverage = ocean.setWorldBounds(worldBounds, {
          x: app.screen.width / (2 * MIN_ZOOM) + OCEAN_COVERAGE_GUTTER,
          y: app.screen.height / (2 * MIN_ZOOM) + OCEAN_COVERAGE_GUTTER,
        });
        host!.dataset.oceanRenderer = 'dynamic-tiling-sprites';
        host!.dataset.oceanTextureSizes = JSON.stringify(ocean.textureSizes());
        host!.dataset.oceanCoverage = `${coverage.minX.toFixed(2)},${coverage.maxX.toFixed(2)},${coverage.minY.toFixed(2)},${coverage.maxY.toFixed(2)}`;
      };
      const refreshWorldBounds = () => {
        const positions = spatial.snapshot();
        const projected = positions.map((item) => projectWorld({ x: item.currentWorldX, y: item.currentWorldY }));
        const shipPosition = ship.readTransform();
        const projectedShip = projectWorld({ x: shipPosition.worldX, y: shipPosition.worldY });
        const xs = projected.map((item) => item.x).concat(projectedShip.x);
        const ys = projected.map((item) => item.y).concat(projectedShip.y);
        worldBounds = {
          minX: Math.min(...xs) - WORLD_MARGIN_X,
          maxX: Math.max(...xs) + WORLD_MARGIN_X,
          minY: Math.min(...ys) - WORLD_MARGIN_Y,
          maxY: Math.max(...ys) + WORLD_MARGIN_Y,
        };
        refreshOceanCoverage();
      };
      const refreshGuardedShipAnchor = () => {
        const previous = guardedShipAnchorY;
        const shipPosition = ship.readTransform();
        guardedShipAnchorY = projectWorld({ x: shipPosition.worldX, y: shipPosition.worldY }).y;
        return Math.abs(guardedShipAnchorY - previous) > .001;
      };
      const verticalCameraBounds = () => {
        return { min: worldBounds.minY, max: worldBounds.maxY };
      };
      const constrainCamera = () => {
        const verticalBounds = verticalCameraBounds();
        const nextX = clamp(camera.x, worldBounds.minX, worldBounds.maxX);
        const nextY = clamp(camera.y, verticalBounds.min, verticalBounds.max);
        if (nextX !== camera.x) cameraVelocity.x = 0;
        if (nextY !== camera.y) cameraVelocity.y = 0;
        const changed = nextX !== camera.x || nextY !== camera.y;
        camera.x = nextX;
        camera.y = nextY;
        return changed;
      };
      const dampenVelocityNearBounds = () => {
        const verticalBounds = verticalCameraBounds();
        let factor = 1;
        if (cameraVelocity.x < 0) factor = Math.min(factor, clamp((camera.x - worldBounds.minX) / BOUNDS_SLOW_ZONE, .12, 1));
        if (cameraVelocity.x > 0) factor = Math.min(factor, clamp((worldBounds.maxX - camera.x) / BOUNDS_SLOW_ZONE, .12, 1));
        if (cameraVelocity.y < 0) factor = Math.min(factor, clamp((camera.y - verticalBounds.min) / BOUNDS_SLOW_ZONE, .12, 1));
        if (cameraVelocity.y > 0) factor = Math.min(factor, clamp((verticalBounds.max - camera.y) / BOUNDS_SLOW_ZONE, .12, 1));
        cameraVelocity.x *= factor;
        cameraVelocity.y *= factor;
      };
      refreshWorldBounds();
      refreshGuardedShipAnchor();
      let animationSeconds = 0;
      applyLayoutUpdateRef.current = (targets) => {
        spatial.applyLayoutTargets(targets.map((target) => ({ ...target })), animationSeconds);
        const snapshot = spatial.snapshot();
        host!.dataset.layout = JSON.stringify(snapshot);
        onSpatialSnapshotRef.current?.(snapshot);
      };
      const trailHarnessEnabled = import.meta.env.DEV && query.get('trailTest') === '1';
      const revealHarnessEnabled = import.meta.env.DEV && query.get('revealTest') === '1';
      const layoutHarnessEnabled = import.meta.env.DEV && query.get('layoutTest') === '1';
      const revealTargetId = activeNodes.some((node) => node.id === 'research') ? 'research' : activeNodes[0]?.id ?? '';
      const revealControllers = new Map<string, ReturnType<typeof createNodeReveal>>();
      for (const placed of activePlacement) {
        const localFog = marineFog.createLocalCover(0, 0);
        spatial.addHandle(placed.nodeId, { container: localFog });
        const initialHidden = placed.visibility <= 0 || (revealHarnessEnabled && placed.nodeId === revealTargetId);
        revealControllers.set(placed.nodeId, createNodeReveal({
          ...nodeViews.get(placed.nodeId)!,
          localFog,
          composite: nodePilotRoots.get(placed.nodeId),
        }, initialHidden ? 'hidden' : 'revealed'));
      }
      revealNodesRef.current = (nodeIds) => {
        for (const nodeId of nodeIds) revealControllers.get(nodeId)?.reveal(animationSeconds);
      };
      type ShipMovement = {
        points: Point[];
        to: Point;
        cameraFrom: Point;
        startedAt: number;
        duration: number;
        targetNodeId: string;
        landingAnchor?: Point;
        ownerTarget?: Point;
        navigationVersion?: number;
      };
      let shipMovement: ShipMovement | null = null;
      startShipMovementRef.current = (command) => {
        if (command.revision === consumedShipMoveRevisionRef.current) return;
        consumedShipMoveRevisionRef.current = command.revision;
        const current = ship.readTransform();
        const from = { x: current.worldX, y: current.worldY };
        const to = { x: command.targetX, y: command.targetY };
        const supplied = command.waypoints?.length ? command.waypoints : [to];
        const points = [from, ...supplied.filter((point, index) => (
          index === supplied.length - 1 || pointDistance(point, supplied[index + 1]) > .001
        ))];
        if (pointDistance(points[points.length - 1], to) > .001) points.push(to);
        const displacement = polylineLength(points);
        if (displacement <= .01) return;
        cancelCameraMotion();
        const firstLeg = points[1] ?? to;
        const direction = projectVector({ x: firstLeg.x - from.x, y: firstLeg.y - from.y });
        ship.setHeading(Math.atan2(direction.y, direction.x) + Math.PI / 2);
        const duration = command.duration ?? clamp(displacement / 190, 1.25, 2.45);
        shipMovement = {
          points,
          to,
          cameraFrom: { x: camera.x, y: camera.y },
          startedAt: animationSeconds,
          duration,
          targetNodeId: command.targetNodeId,
          landingAnchor: command.landingAnchor,
          ownerTarget: command.ownerTarget,
          navigationVersion: command.navigationVersion,
        };
        shipRuntimeRef.current = {
          position: from,
          movement: {
            to,
            waypoints: points.slice(1),
            targetNodeId: command.targetNodeId,
            landingAnchor: command.landingAnchor,
            ownerTarget: command.ownerTarget,
            navigationVersion: command.navigationVersion,
            remainingDuration: duration,
          },
        };
        trail.beginMovement(from, animationSeconds);
      };
      const interruptedMovement = shipRuntimeRef.current.movement;
      if (interruptedMovement) {
        const from = { ...shipRuntimeRef.current.position };
        ship.setWorldPosition(from.x, from.y);
        const waypoints = interruptedMovement.waypoints.length ? interruptedMovement.waypoints : [interruptedMovement.to];
        shipMovement = {
          points: [from, ...waypoints],
          to: { ...interruptedMovement.to },
          cameraFrom: { x: camera.x, y: camera.y },
          startedAt: animationSeconds,
          duration: Math.max(.05, interruptedMovement.remainingDuration),
          targetNodeId: interruptedMovement.targetNodeId,
          landingAnchor: interruptedMovement.landingAnchor,
          ownerTarget: interruptedMovement.ownerTarget,
          navigationVersion: interruptedMovement.navigationVersion,
        };
        trail.beginMovement(from, animationSeconds);
      }
      let revealTriggered = false;
      let layoutUpdateStep = 0;
      const updateReturnVisibility = () => {
        const width = app.screen.width;
        const height = app.screen.height;
        const shipPosition = ship.readTransform();
        const projectedShip = projectWorld({ x: shipPosition.worldX, y: shipPosition.worldY });
        const shipX = width / 2 + (projectedShip.x - camera.x) * camera.zoom;
        const shipY = height / 2 + (projectedShip.y - camera.y) * camera.zoom;
        const mobile = width < 700;
        const safeBottom = mobile ? height - 210 : height - 28;
        const behindDesktopCard = !mobile && shipX > width - 465 && shipY > height - 215;
        const visible = shipX < 20 || shipX > width - 20 || shipY < 135 || shipY > safeBottom || behindDesktopCard;
        if (visible !== lastReturnVisible) {
          lastReturnVisible = visible;
          setReturnVisible(visible);
        }
      };
      returnToShipRef.current = () => {
        cancelCameraMotion();
        const width = app.screen.width;
        const height = app.screen.height;
        const mobile = width < 700;
        const targetScreenX = mobile ? width / 2 : width * .43;
        const targetScreenY = scene
          ? height * (mobile ? .68 : .72)
          : mobile ? (135 + height - 210) / 2 : height * .58;
        const shipPosition = ship.readTransform();
        const projectedShip = projectWorld({ x: shipPosition.worldX, y: shipPosition.worldY });
        const verticalBounds = verticalCameraBounds();
        const targetCameraY = projectedShip.y - (targetScreenY - height / 2) / camera.zoom;
        returnAnimation = {
          from: { x: camera.x, y: camera.y },
          to: {
            x: projectedShip.x - (targetScreenX - width / 2) / camera.zoom,
            y: clamp(targetCameraY, verticalBounds.min, verticalBounds.max),
          },
          startedAt: animationSeconds,
        };
      };
      const harnessPath = [
        { x: 0, y: 310 }, { x: 70, y: 280 }, { x: 132, y: 218 },
        { x: 118, y: 142 }, { x: 55, y: 92 }, { x: -25, y: 112 },
      ];
      let harnessStarted = false;
      let harnessEnded = false;
      const updateTrailHarness = (seconds: number) => {
        if (!trailHarnessEnabled || seconds < 1 || harnessEnded) return;
        const elapsed = seconds - 1;
        if (!harnessStarted) {
          harnessStarted = true;
          const worldPosition = ship.readTransform();
          trail.beginMovement({ x: worldPosition.worldX, y: worldPosition.worldY }, seconds);
        }
        const segmentDuration = 1.5;
        const segment = Math.min(harnessPath.length - 2, Math.floor(elapsed / segmentDuration));
        const local = Math.min(1, (elapsed - segment * segmentDuration) / segmentDuration);
        const eased = local * local * (3 - 2 * local);
        const a = harnessPath[segment];
        const b = harnessPath[segment + 1];
        const x = a.x + (b.x - a.x) * eased;
        const y = a.y + (b.y - a.y) * eased;
        ship.setWorldPosition(x, y);
        trail.recordWorldPosition({ x, y }, seconds);
        if (elapsed >= (harnessPath.length - 1) * segmentDuration) {
          ship.setWorldPosition(b.x, b.y);
          trail.recordWorldPosition(b, seconds);
          trail.endMovement(seconds);
          harnessEnded = true;
        }
      };
      const animateWorld = (ticker: { deltaMS: number }) => {
        const delta = Math.min(ticker.deltaMS, 50);
        animationSeconds += delta / 1000;
        ocean.tick(delta);
        marineFog.tick(animationSeconds);
        for (const motion of islandMotions) updateIslandMotion(motion, animationSeconds);
        const nodesMoving = spatial.update(animationSeconds);
        const oceanPlaneAlpha = new Map<string, number>();
        if (scene) {
          const { oceanSafeTopY } = scene.diagnostics();
          spatial.forEachPosition((position) => {
            const projected = projectWorld({ x: position.currentWorldX, y: position.currentWorldY });
            const depth = sceneDepth(projected.y);
            const anchorScreenY = app.screen.height / 2 + (projected.y - camera.y) * camera.zoom;
            oceanPlaneAlpha.set(position.nodeId, smooth((anchorScreenY - oceanSafeTopY) / 48));
            const revealState = revealControllers.get(position.nodeId)?.getState();
            for (const visual of nodeWorldVisuals.get(position.nodeId) ?? []) {
              visual.scale.set(depth.scale);
              if (revealState === 'revealed') {
                visual.alpha = depth.alpha;
              }
            }
            const nodeView = nodeViews.get(position.nodeId);
            if (nodeView) {
              const baseOffset = nodePilotRoots.has(position.nodeId)
                ? islandSpritePilots[position.nodeId].pinOffsetY
                : -109;
              nodeView.pin.root.position.set(projected.x, projected.y + baseOffset * depth.scale);
            }
          });
          const shipState = ship.readTransform();
          const shipDepth = sceneDepth(projectWorld({ x: shipState.worldX, y: shipState.worldY }).y);
          ship.worldRoot.scale.set(shipDepth.scale);
          scene.update(camera, animationSeconds);
        }
        if (layoutHarnessEnabled && layoutUpdateStep === 0 && animationSeconds >= 1) {
          spatial.applyLayoutTargets(layoutHarnessUpdate(1), animationSeconds);
          layoutUpdateStep = 1;
        } else if (layoutHarnessEnabled && layoutUpdateStep === 1 && animationSeconds >= 4.15) {
          spatial.applyLayoutTargets(layoutHarnessUpdate(2), animationSeconds);
          layoutUpdateStep = 2;
        }
        for (const pin of pinViews) updatePinBreath(pin, animationSeconds);
        updateTrailHarness(animationSeconds);
        let voyageFollowFrame: { cameraFrom: Point; current: Point; progress: number } | null = null;
        if (shipMovement && !trailHarnessEnabled) {
          const movement = shipMovement;
          const progress = clamp((animationSeconds - movement.startedAt) / movement.duration, 0, 1);
          const eased = smooth(progress);
          const sampled = samplePolyline(movement.points, eased);
          const { x, y } = sampled.point;
          voyageFollowFrame = { cameraFrom: movement.cameraFrom, current: { x, y }, progress };
          ship.setWorldPosition(x, y);
          shipRuntimeRef.current = {
            position: { x, y },
            movement: {
              to: { ...movement.to },
              waypoints: movement.points.slice(sampled.segmentIndex + 1),
              targetNodeId: movement.targetNodeId,
              landingAnchor: movement.landingAnchor,
              ownerTarget: movement.ownerTarget,
              navigationVersion: movement.navigationVersion,
              remainingDuration: Math.max(.05, movement.duration * (1 - progress)),
            },
          };
          trail.recordWorldPosition({ x, y }, animationSeconds);
          if (progress >= 1) {
            ship.setWorldPosition(movement.to.x, movement.to.y);
            shipRuntimeRef.current = { position: { ...movement.to }, movement: null };
            trail.recordWorldPosition(movement.to, animationSeconds);
            trail.endMovement(animationSeconds);
            shipMovement = null;
            refreshWorldBounds();
            const trailState = trail.snapshot();
            const snapshot = {
              x: movement.to.x,
              y: movement.to.y,
              moving: false,
              targetNodeId: movement.targetNodeId,
              trailPointCount: trailState.pointCount,
              landingAnchor: movement.landingAnchor,
              ownerTarget: movement.ownerTarget,
              navigationVersion: movement.navigationVersion,
            };
            onShipSnapshotRef.current?.(snapshot);
            onShipMovementCompleteRef.current?.(snapshot);
          }
        }
        refreshGuardedShipAnchor();
        if (revealHarnessEnabled && !revealTriggered && animationSeconds >= .85) {
          revealTriggered = true;
          revealControllers.get(revealTargetId)?.reveal(animationSeconds);
        }
        for (const controller of revealControllers.values()) controller.update(animationSeconds);
        if (scene) {
          for (const [nodeId, planeAlpha] of oceanPlaneAlpha) {
            for (const visual of nodeWorldVisuals.get(nodeId) ?? []) visual.alpha *= planeAlpha;
            const nodeView = nodeViews.get(nodeId);
            if (nodeView) nodeView.pin.root.alpha = planeAlpha;
          }
          const { oceanSafeTopY } = scene.diagnostics();
          const shipState = ship.readTransform();
          const projectedShip = projectWorld({ x: shipState.worldX, y: shipState.worldY });
          const shipAnchorScreenY = app.screen.height / 2 + (projectedShip.y - camera.y) * camera.zoom;
          const shipOceanPlaneAlpha = smooth((shipAnchorScreenY - oceanSafeTopY) / 48);
          ship.worldRoot.alpha = shipOceanPlaneAlpha;
          ship.label.alpha = shipOceanPlaneAlpha;
          host!.dataset.shipOceanPlaneAlpha = shipOceanPlaneAlpha.toFixed(3);
        }
        trail.update(animationSeconds);
        ship.updateIdle(animationSeconds, camera.zoom);
        const deltaSeconds = delta / 1000;
        let cameraChanged = false;
        let cameraSource: CameraMovementSource = 'bounds';
        if (voyageFollowFrame) {
          const projectedShip = projectWorld(voyageFollowFrame.current);
          const mobile = app.screen.width < 700;
          const targetScreenX = mobile ? app.screen.width / 2 : app.screen.width * .43;
          const targetScreenY = app.screen.height * (mobile ? .68 : .72);
          const shipCameraX = projectedShip.x - (targetScreenX - app.screen.width / 2) / camera.zoom;
          const shipCameraY = projectedShip.y - (targetScreenY - app.screen.height / 2) / camera.zoom;
          const acquire = smooth(voyageFollowFrame.progress / VOYAGE_CAMERA_ACQUIRE_FRACTION);
          camera.x = voyageFollowFrame.cameraFrom.x + (shipCameraX - voyageFollowFrame.cameraFrom.x) * acquire;
          camera.y = voyageFollowFrame.cameraFrom.y + (shipCameraY - voyageFollowFrame.cameraFrom.y) * acquire;
          cameraChanged = true;
          cameraSource = 'voyage-follow';
          host!.dataset.voyageFollow = '1';
          host!.dataset.voyageFollowTargetScreen = `${targetScreenX.toFixed(2)},${targetScreenY.toFixed(2)}`;
        } else if (returnAnimation) {
          const progress = clamp((animationSeconds - returnAnimation.startedAt) / RETURN_DURATION, 0, 1);
          const eased = progress * progress * (3 - 2 * progress);
          camera.x = returnAnimation.from.x + (returnAnimation.to.x - returnAnimation.from.x) * eased;
          camera.y = returnAnimation.from.y + (returnAnimation.to.y - returnAnimation.from.y) * eased;
          cameraChanged = true;
          cameraSource = 'current-location';
          if (progress >= 1) returnAnimation = null;
        } else if (Math.hypot(cameraVelocity.x, cameraVelocity.y) >= MIN_INERTIA_SPEED) {
          dampenVelocityNearBounds();
          camera.x += cameraVelocity.x * deltaSeconds;
          camera.y += cameraVelocity.y * deltaSeconds;
          const decay = Math.exp(-INERTIA_DECAY * deltaSeconds);
          cameraVelocity.x *= decay;
          cameraVelocity.y *= decay;
          cameraChanged = true;
          cameraSource = 'user-inertia';
        } else if (cameraVelocity.x || cameraVelocity.y) cameraVelocity = { x: 0, y: 0 };
        if (!voyageFollowFrame) {
          if (host!.dataset.voyageFollow === '1') host!.dataset.cameraMovementSource = 'bounds';
          host!.dataset.voyageFollow = '0';
        }
        if (constrainCamera()) cameraChanged = true;
        if (cameraChanged) applyCamera(cameraSource);
        const spatialMoving = spatial.isMoving();
        const spatialJustSettled = wasSpatialMoving && !spatialMoving;
        if (wasSpatialMoving && !spatialMoving) refreshWorldBounds();
        wasSpatialMoving = spatialMoving;
        if (nodesMoving) {
          refreshPinLabelsRef.current();
        }
        if (Math.floor(animationSeconds * 2) !== diagnosticTick) {
          diagnosticTick = Math.floor(animationSeconds * 2);
          const state = ship.readTransform();
          host!.dataset.shipWorld = `${state.worldX},${state.worldY}`;
          host!.dataset.shipIdle = `${state.idleY.toFixed(3)},${state.roll.toFixed(5)}`;
          const trailState = trail.snapshot();
          host!.dataset.trail = `${trailState.pointCount},${trailState.moving ? 1 : 0},${trailState.wakeAlpha.toFixed(3)}`;
          host!.dataset.reveal = JSON.stringify(Object.fromEntries([...revealControllers].map(([id, controller]) => [id, controller.getState()])));
          host!.dataset.layout = JSON.stringify(spatial.snapshot());
          const movingTargetNodeId = shipMovement?.targetNodeId ?? null;
          onShipSnapshotRef.current?.({
            x: state.worldX,
            y: state.worldY,
            moving: Boolean(shipMovement),
            targetNodeId: movingTargetNodeId,
            trailPointCount: trailState.pointCount,
            landingAnchor: shipMovement?.landingAnchor,
            ownerTarget: shipMovement?.ownerTarget,
            navigationVersion: shipMovement?.navigationVersion,
          });
          if (nodesMoving || spatialJustSettled) onSpatialSnapshotRef.current?.(spatial.snapshot());
        }
      };
      let diagnosticTick = -1;
      app.ticker.add(animateWorld);
      const pointers = new Map<number, Point>();
      const velocitySamples: { x: number; y: number; timestamp: number }[] = [];
      let suppressReleaseInertia = false;
      let lastPinchDistance = 0;
      let lastPinchCenter: Point | null = null;
      let sceneWidth = -1;
      let sceneHeight = -1;
      const refreshPinLabels = () => {
        for (const pin of pinViews) placePinPresentation(pin, camera, app.screen.width, app.screen.height);
        const visibleCount = resolvePinLabelCollisions(pinViews, camera, app.screen.width, app.screen.height);
        host!.dataset.visibleLabelCount = String(visibleCount);
        host!.dataset.labelPresentation = 'compact-unselected,full-selected,collision-aware';
      };
      refreshPinLabelsRef.current = refreshPinLabels;
      const applyCamera = (source: CameraMovementSource = 'initial') => {
        if (scene && (sceneWidth !== app.screen.width || sceneHeight !== app.screen.height)) {
          sceneWidth = app.screen.width;
          sceneHeight = app.screen.height;
          scene.resize(sceneWidth, sceneHeight);
          const diagnostics = scene.diagnostics();
          host!.dataset.scenePilot = '1';
          host!.dataset.sceneDebug = diagnostics.debug ? '1' : '0';
          host!.dataset.sceneHorizonY = diagnostics.horizonY.toFixed(2);
          host!.dataset.sceneGuardY = diagnostics.oceanSafeTopY.toFixed(2);
          host!.dataset.sceneStageOrder = 'sceneBackdrop,world,sceneHorizonAtmosphere';
          host!.dataset.sceneOceanMasks = 'deepOcean,waterSurface';
        }
        constrainCamera();
        world.scale.set(camera.zoom);
        world.position.set(app.screen.width / 2 - camera.x * camera.zoom, app.screen.height / 2 - camera.y * camera.zoom);
        refreshPinLabels();
        ship.applyCamera(camera, app.screen.width, app.screen.height);
        host!.dataset.cameraMovementSource = source;
        host!.dataset.camera = `${camera.x.toFixed(2)},${camera.y.toFixed(2)},${camera.zoom.toFixed(3)}`;
        const state = ship.readTransform();
        host!.dataset.shipWorld = `${state.worldX},${state.worldY}`;
        host!.dataset.cameraVelocity = `${cameraVelocity.x.toFixed(2)},${cameraVelocity.y.toFixed(2)}`;
        const frontierDistance = camera.y - worldBounds.minY;
        const prefetchDistance = Math.max(MIN_PREFETCH_DISTANCE, app.screen.height / camera.zoom * PREFETCH_VIEWPORTS_AHEAD);
        host!.dataset.worldBounds = `${worldBounds.minX.toFixed(2)},${worldBounds.maxX.toFixed(2)},${worldBounds.minY.toFixed(2)},${worldBounds.maxY.toFixed(2)}`;
        host!.dataset.frontierDistance = frontierDistance.toFixed(2);
        host!.dataset.frontierPrefetchDistance = prefetchDistance.toFixed(2);
        const notifyExplorationFrontier = source === 'user-pan' || source === 'user-inertia' || source === 'user-pinch';
        if (notifyExplorationFrontier && frontierDistance <= prefetchDistance) {
          host!.dataset.frontierTriggerSource = source;
          onExplorationFrontierRef.current?.({
            x: camera.x,
            y: camera.y,
            zoom: camera.zoom,
            minY: worldBounds.minY,
            maxY: worldBounds.maxY,
            distanceToFrontier: frontierDistance,
          });
        }
        if (scene) {
          const verticalBounds = verticalCameraBounds();
          const anchorScreenY = app.screen.height / 2 + (guardedShipAnchorY - camera.y) * camera.zoom;
          host!.dataset.sceneCameraYRange = `${verticalBounds.min.toFixed(2)},${verticalBounds.max.toFixed(2)}`;
          host!.dataset.sceneUppermostAnchorY = guardedShipAnchorY.toFixed(2);
          host!.dataset.sceneUppermostAnchorScreenY = anchorScreenY.toFixed(2);
          scene.updateDebugCamera({
            cameraY: camera.y,
            minCameraY: verticalBounds.min,
            maxCameraY: verticalBounds.max,
            anchorScreenY,
          });
        }
        updateReturnVisibility();
      };
      const screenPoint = (event: PointerEvent | WheelEvent): Point => {
        const rect = app.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      const zoomAt = (nextZoom: number, anchor: Point, source: CameraMovementSource) => {
        cancelCameraMotion();
        const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
        const wx = camera.x + (anchor.x - app.screen.width / 2) / camera.zoom;
        const wy = camera.y + (anchor.y - app.screen.height / 2) / camera.zoom;
        camera.zoom = zoom;
        camera.x = wx - (anchor.x - app.screen.width / 2) / zoom;
        camera.y = wy - (anchor.y - app.screen.height / 2) / zoom;
        applyCamera(source);
      };
      const onPointerDown = (event: PointerEvent) => {
        cancelCameraMotion();
        app.canvas.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, screenPoint(event));
        lastPinchDistance = 0;
        lastPinchCenter = null;
        velocitySamples.length = 0;
        suppressReleaseInertia = pointers.size > 1;
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!pointers.has(event.pointerId)) return;
        const previous = pointers.get(event.pointerId)!;
        const current = screenPoint(event);
        pointers.set(event.pointerId, current);
        if (pointers.size === 1) {
          const dx = -(current.x - previous.x) / camera.zoom;
          const dy = -(current.y - previous.y) / camera.zoom;
          camera.x += dx;
          camera.y += dy;
          const timestamp = event.timeStamp;
          velocitySamples.push({ x: dx, y: dy, timestamp });
          while (velocitySamples.length && timestamp - velocitySamples[0].timestamp > VELOCITY_SAMPLE_MS) velocitySamples.shift();
          applyCamera('user-pan');
        } else if (pointers.size === 2) {
          suppressReleaseInertia = true;
          velocitySamples.length = 0;
          cameraVelocity = { x: 0, y: 0 };
          const [a, b] = [...pointers.values()];
          const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (lastPinchCenter) {
            camera.x -= (center.x - lastPinchCenter.x) / camera.zoom;
            camera.y -= (center.y - lastPinchCenter.y) / camera.zoom;
          }
          if (lastPinchDistance) zoomAt(camera.zoom * distance / lastPinchDistance, center, 'user-pinch');
          else applyCamera('user-pinch');
          lastPinchCenter = center;
          lastPinchDistance = distance;
        }
      };
      const onPointerUp = (event: PointerEvent) => {
        pointers.delete(event.pointerId);
        if (pointers.size === 0 && !suppressReleaseInertia && velocitySamples.length) {
          const elapsed = Math.max(16, velocitySamples[velocitySamples.length - 1].timestamp - velocitySamples[0].timestamp);
          const total = velocitySamples.reduce((sum, sample) => ({ x: sum.x + sample.x, y: sum.y + sample.y }), { x: 0, y: 0 });
          const speedScale = 1000 / elapsed;
          let vx = total.x * speedScale;
          let vy = total.y * speedScale;
          const speed = Math.hypot(vx, vy);
          if (speed >= MIN_INERTIA_SPEED) {
            const cap = Math.min(1, MAX_INERTIA_SPEED / speed);
            vx *= cap;
            vy *= cap;
            cameraVelocity = { x: vx, y: vy };
          }
        }
        lastPinchDistance = 0;
        lastPinchCenter = null;
        if (pointers.size === 0) velocitySamples.length = 0;
      };
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        zoomAt(camera.zoom * Math.exp(-event.deltaY * 0.001), screenPoint(event), 'wheel-zoom');
      };
      const observer = new ResizeObserver(() => {
        refreshOceanCoverage();
        applyCamera('resize');
      });
      observer.observe(host!);
      app.canvas.addEventListener('pointerdown', onPointerDown);
      app.canvas.addEventListener('pointermove', onPointerMove);
      app.canvas.addEventListener('pointerup', onPointerUp);
      app.canvas.addEventListener('pointercancel', onPointerUp);
      app.canvas.addEventListener('wheel', onWheel, { passive: false });
      applyCamera('initial');
      cleanup = () => {
        app.ticker.remove(animateWorld);
        observer.disconnect();
        app.canvas.removeEventListener('pointerdown', onPointerDown);
        app.canvas.removeEventListener('pointermove', onPointerMove);
        app.canvas.removeEventListener('pointerup', onPointerUp);
        app.canvas.removeEventListener('pointercancel', onPointerUp);
        app.canvas.removeEventListener('wheel', onWheel);
        app.destroy({ removeView: true, releaseGlobalResources: false });
        ocean.destroy();
        marineFog.destroy();
        scene?.destroy();
      };
      const spikeDiagnostic = {
        snapshot: () => ({
          camera: { ...camera },
          ship: ship.readTransform(),
          trail: trail.snapshot(),
          shipMovement: shipMovement ? { ...shipMovement } : null,
          reveal: Object.fromEntries([...revealControllers].map(([id, controller]) => [id, controller.snapshot()])),
          landedNodeIds: [...landedMarkers].filter(([, marker]) => marker.visible).map(([id]) => id),
          layout: spatial.snapshot(),
          layerOrder: [...layerNames],
          recipePilot: recipePilotEnabled,
          nemotronPilot: nemotronPilotEnabled,
          nodeIds: activeNodes.map((node) => node.id),
        }),
      };
      if (buildIsStale()) { cleanup(); return; }

      // Keep the previous fully rendered Scene visible until its replacement is
      // complete. Appending the pre-rendered canvas before destroying the old
      // instance makes World expansion an atomic visual swap.
      app.render();
      const previous = sceneInstanceRef.current;
      host!.appendChild(app.canvas);
      sceneInstanceRef.current = { canvas: app.canvas, cleanup };
      Object.defineProperty(window, '__kurohigeSpike', { configurable: true, value: spikeDiagnostic });
      host!.dataset.sceneSwapState = 'ready';
      host!.dataset.sceneGeneration = String(generation);
      host!.dataset.sceneCanvasCount = String(host!.querySelectorAll('canvas.map-canvas').length);
      previous?.cleanup();
      host!.dataset.sceneCanvasCount = String(host!.querySelectorAll('canvas.map-canvas').length);
    }
    void mount();
    return () => {
      disposed = true;
    };
  }, [revision]);

  return <>
    <div ref={hostRef} className="living-map" aria-label="Possibility Map canvas" />
    <button className={`current-location ${returnVisible ? 'visible' : ''}`} type="button" onClick={() => returnToShipRef.current()} aria-hidden={!returnVisible} tabIndex={returnVisible ? 0 : -1}>
      <span aria-hidden="true">笵ｵ</span><span>迴ｾ蝨ｨ蝨ｰ</span>
    </button>
  </>;
}


