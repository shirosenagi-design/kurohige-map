import { useEffect, useMemo, useRef, useState } from 'react';
import { LivingMap, type ShipMoveCommand, type ShipMovementSnapshot } from './LivingMap';
import { planShipVoyage } from './islandNavigation';
import type { PossibilityNode } from './livingFlow';
import type { PlacedNode, SemanticNode } from './model';

const start = { x: 0, y: 500 };

const possibility = (id: string, title: string, terrainProfile: string, visualTheme: string): PossibilityNode => ({
  id, title, shortDescription: '海上航路と安全な着岸を確認するDEV専用Fixture。', category: 'DEV航路検証',
  nodeKind: 'activity', relationToGoal: 'adjacent', curiosityFit: .8, accessibility: .8, novelty: .5, friction: .2,
  portableResourceTags: [], connectionTags: [], helpedByTags: [],
  visualRecipe: {
    visualTheme, dominantMotif: 'campsite_marker', secondaryObjects: ['shelter', 'sign'], terrainProfile,
    accentPalette: 'green_amber', density: 'dense', openness: 'compact', landmarkEmphasis: 'high', energyLevel: 'moderate',
  },
});

const asSemanticNode = (node: PossibilityNode): SemanticNode => ({
  id: node.id, title: node.title, description: node.shortDescription, category: node.category,
  status: 'unseen', visualTheme: 'harbor', visualRecipe: node.visualRecipe,
});

export function ShipNavigationHarness() {
  const autoRun = new URLSearchParams(window.location.search).get('auto') === '1';
  const possibilities = useMemo(() => [
    possibility('navigation-owner', '北の着岸島', 'organic', 'outdoor_recreation'),
    possibility('navigation-blocker', '航路を遮る島', 'raised', 'cultivation'),
    possibility('navigation-return', '南東の帰路島', 'flat', 'community'),
  ], []);
  const placements = useMemo<PlacedNode[]>(() => [
    { nodeId: 'navigation-owner', targetX: 0, targetY: -1500, visibility: 1, fogDepth: 0 },
    { nodeId: 'navigation-blocker', targetX: 0, targetY: -750, visibility: 1, fogDepth: 0 },
    { nodeId: 'navigation-return', targetX: 720, targetY: 450, visibility: 1, fogDepth: 0 },
  ], []);
  const semanticNodes = useMemo(() => possibilities.map(asSemanticNode), [possibilities]);
  const revisionRef = useRef(0);
  const [ship, setShip] = useState<ShipMovementSnapshot>({ ...start, moving: false, targetNodeId: null, trailPointCount: 0 });
  const [move, setMove] = useState<ShipMoveCommand | null>(null);
  const [landed, setLanded] = useState<string[]>([]);
  const [status, setStatus] = useState('待機中');

  const sailTo = (targetNodeId: string) => {
    const target = possibilities.find((node) => node.id === targetNodeId)!;
    const plan = planShipVoyage({ x: ship.x, y: ship.y }, target, placements, placements, possibilities, 3, 3);
    const endpoint = plan.waypoints.at(-1)!;
    revisionRef.current += 1;
    setStatus(targetNodeId === 'navigation-owner' ? '北へ航海中' : '南東へ帰航中');
    setMove({
      revision: revisionRef.current, targetX: endpoint.x, targetY: endpoint.y, targetNodeId,
      waypoints: plan.waypoints, landingAnchor: plan.landingAnchor, ownerTarget: plan.ownerTarget,
      navigationVersion: plan.navigationVersion, duration: 5.5,
    });
    setShip((current) => ({ ...current, moving: true, targetNodeId }));
  };

  useEffect(() => {
    if (!autoRun || ship.moving || landed.includes('navigation-return')) return;
    const targetNodeId = landed.includes('navigation-owner') ? 'navigation-return' : 'navigation-owner';
    const timer = window.setTimeout(() => sailTo(targetNodeId), landed.length ? 900 : 1_800);
    return () => window.clearTimeout(timer);
  }, [autoRun, landed, ship.moving]);

  return <main className="app-shell" data-ship-navigation-harness="1" data-voyage-status={status}
    data-ship-world={`${ship.x.toFixed(2)},${ship.y.toFixed(2)}`} data-trail-points={ship.trailPointCount}
    data-landed-node-ids={JSON.stringify(landed)}>
    <LivingMap
      onSelect={() => {}}
      selectedId="navigation-owner"
      flags={Object.fromEntries(possibilities.map((node) => [node.id, { kept: false, visited: false }]))}
      activeNodes={semanticNodes}
      activePlacement={placements}
      revision={0}
      initialShipPosition={start}
      shipMove={move}
      onShipSnapshot={setShip}
      onShipMovementComplete={(snapshot) => {
        setShip(snapshot);
        if (snapshot.targetNodeId) setLanded((current) => current.includes(snapshot.targetNodeId!) ? current : [...current, snapshot.targetNodeId!]);
        setStatus(snapshot.targetNodeId === 'navigation-owner' ? '北の島へ上陸完了' : '帰路島へ上陸完了');
      }}
      landedNodeIds={landed}
      canonicalScene
    />
    <section style={{ position: 'fixed', zIndex: 50, left: 18, top: 18, padding: '12px 14px', borderRadius: 14,
      background: 'rgba(255,255,255,.92)', color: '#174d61', boxShadow: '0 8px 30px rgba(16,70,90,.18)', minWidth: 250 }}>
      <strong>DEV 船航路・着岸Fixture</strong>
      <div data-testid="voyage-status">{status}</div>
      <div>Ship: {ship.x.toFixed(1)}, {ship.y.toFixed(1)} / Trail: {ship.trailPointCount}</div>
      <div>上陸: {landed.length ? landed.join(', ') : 'なし'}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" disabled={ship.moving || landed.includes('navigation-owner')} onClick={() => sailTo('navigation-owner')}>北へ航海</button>
        <button type="button" disabled={ship.moving || !landed.includes('navigation-owner') || landed.includes('navigation-return')} onClick={() => sailTo('navigation-return')}>南東へ帰航</button>
      </div>
    </section>
  </main>;
}
