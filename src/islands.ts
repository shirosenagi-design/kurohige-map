import { Container, Graphics } from 'pixi.js';
import type { SemanticNode } from './model';

type Point = readonly [number, number];
type Theme = SemanticNode['visualTheme'];
export type MotionProfile = {
  kind: 'scan' | 'rotation' | 'light';
  periodSeconds: number;
  amplitude: number;
  phase: number;
  baseAlpha?: number;
};
export type IslandMotion = { target: Container; profile: MotionProfile };
export type IslandView = {
  shadow: Container;
  shoreline: Container;
  terrain: Container;
  objects: Container;
  motion: IslandMotion;
};
type IslandVisual = {
  outline: readonly Point[];
  sand: number;
  earth: number;
  cliff: number;
  grass: number;
  lightGrass: number;
  accent: number;
  depth: number;
  motif: string;
  motion: MotionProfile;
};

const visual: Record<Theme, IslandVisual> = {
  research: {
    outline: [[-1, -.05], [-.82, -.55], [-.46, -.85], [-.12, -.77], [.34, -.95], [.72, -.54], [1, -.06], [.78, .6], [.28, .85], [-.3, .72], [-.76, .48]],
    sand: 0xfff1bc, earth: 0x90a55f, cliff: 0xe7ca83, grass: 0x76df58, lightGrass: 0xe2f57e, accent: 0x52dcef, depth: 46,
    motif: 'observatory', motion: { kind: 'scan', periodSeconds: 8.7, amplitude: 0.12, phase: 0.4 },
  },
  coral: {
    outline: [[-1, -.2], [-.75, -.63], [-.32, -.8], [.14, -.63], [.64, -.72], [1, -.22], [.92, .37], [.5, .82], [-.08, .92], [-.61, .57], [-.92, .28]],
    sand: 0xffeeb3, earth: 0xc07a4f, cliff: 0xeab27a, grass: 0x80de62, lightGrass: 0xe6f57b, accent: 0xff7b55, depth: 43,
    motif: 'studio', motion: { kind: 'light', periodSeconds: 4.9, amplitude: 0.075, baseAlpha: 0.16, phase: 1.7 },
  },
  garden: {
    outline: [[-1, -.05], [-.86, -.48], [-.52, -.79], [-.03, -.92], [.39, -.69], [.8, -.52], [1, -.1], [.82, .55], [.34, .84], [-.17, .72], [-.66, .8], [-.98, .33]],
    sand: 0xfff1bb, earth: 0x91ad57, cliff: 0xe1cd7e, grass: 0x78de58, lightGrass: 0xe3f47b, accent: 0x4fdcc2, depth: 48,
    motif: 'windmill', motion: { kind: 'rotation', periodSeconds: 38, amplitude: Math.PI * 2, phase: 2.1 },
  },
  harbor: {
    outline: [[-1, -.18], [-.78, -.52], [-.35, -.68], [.02, -.94], [.47, -.75], [.88, -.35], [1, .08], [.66, .48], [.25, .61], [-.12, .91], [-.58, .64], [-.97, .31]],
    sand: 0xffeebb, earth: 0xa87f56, cliff: 0xe8c58d, grass: 0x77da74, lightGrass: 0xdcf58a, accent: 0x5dd3f2, depth: 46,
    motif: 'pavilion', motion: { kind: 'light', periodSeconds: 9.3, amplitude: 0.04, baseAlpha: 0.11, phase: 4.2 },
  },
};

const X_RADIUS = 112;
const Y_RADIUS = 57;

function blob(graphics: Graphics, outline: readonly Point[], xScale: number, yScale: number, yOffset: number, color: number, alpha = 1) {
  const points = outline.map(([x, y]) => ({ x: x * X_RADIUS * xScale, y: y * Y_RADIUS * yScale + yOffset }));
  const count = points.length;
  const start = points[0];
  const previous = points[count - 1];
  graphics.moveTo((previous.x + start.x) / 2, (previous.y + start.y) / 2);
  for (let i = 0; i < count; i++) {
    const point = points[i];
    const next = points[(i + 1) % count];
    graphics.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  graphics.closePath().fill({ color, alpha });
}

function tree(x: number, y: number, scale = 1) {
  const group = new Container();
  group.position.set(x, y);
  group.scale.set(scale);
  const shadow = new Graphics().ellipse(5, 3, 12, 4).fill({ color: 0x436f65, alpha: 0.14 });
  const trunk = new Graphics().roundRect(-2, -15, 4, 18, 1).fill(0xaa7a50);
  const crown = new Graphics().circle(-5, -22, 10).fill(0x57d45d)
    .circle(6, -24, 11).fill(0x70e27a).circle(0, -31, 10).fill(0xb0f28c)
    .circle(-5, -34, 4).fill({ color: 0xf2ffb0, alpha: 0.78 });
  group.addChild(shadow, trunk, crown);
  return group;
}

function hut(x: number, y: number, roof: number, width = 37) {
  const group = new Container();
  group.position.set(x, y);
  const building = new Graphics();
  building.ellipse(4, 4, width * .65, 7).fill({ color: 0x547969, alpha: .2 });
  building.rect(-width / 2, -23, width, 25).fill(0xfff8e0);
  building.moveTo(width / 2, -23).lineTo(width / 2 + 8, -29).lineTo(width / 2 + 8, -5).lineTo(width / 2, 2).closePath().fill(0xebc79d);
  building.moveTo(-width / 2 - 5, -23).lineTo(0, -43).lineTo(width / 2 + 8, -23).closePath().fill(roof);
  building.moveTo(0, -43).lineTo(width / 2 + 8, -23).lineTo(width / 2 + 2, -18).lineTo(0, -36).closePath().fill({ color: 0x9f7e70, alpha: .48 });
  building.rect(-5, -13, 10, 15).fill(0x73a6a9);
  building.rect(-width / 2 + 4, -17, 7, 7).fill(0x8fc4c8);
  group.addChild(building);
  return group;
}

function addResearch(objects: Container, accent: number): Container {
  objects.addChild(tree(-72, -12, .8), hut(-12, -15, 0x6baeb9, 47));
  const dome = new Graphics().roundRect(-3, -39, 40, 20, 3).fill(0xc9ded9)
    .moveTo(37, -39).lineTo(44, -44).lineTo(44, -24).lineTo(37, -19).closePath().fill(0x9fbcb8)
    .ellipse(17, -42, 19, 13).fill(0xeaf9f5)
    .ellipse(17, -44, 13, 7).fill(0x91c9d3)
    .rect(14, -57, 5, 13).fill(0x83a8af)
    .circle(16, -59, 4).fill(0xffe9b0);
  const mast = new Graphics().moveTo(66, -8).lineTo(66, -62).stroke({ color: 0x7899a5, width: 2 });
  const sensor = new Graphics().moveTo(-12, 17).lineTo(12, 17).stroke({ color: accent, width: 2 })
    .circle(0, 0, 4).fill(0xffe9af);
  sensor.position.set(66, -63);
  sensor.name = 'antennaSensor';
  objects.addChild(dome, mast, sensor, tree(80, -6, .6));
  return sensor;
}

function addCreative(objects: Container, accent: number): Container {
  objects.addChild(tree(-73, -2, .75), hut(-6, -12, accent, 54));
  const studio = new Graphics().roundRect(-23, -25, 37, 21, 3).fill(0x6a8da5)
    .roundRect(-20, -22, 31, 14, 2).fill(0xdef2ef)
    .moveTo(-7, -20).lineTo(-7, -10).lineTo(3, -15).closePath().fill(accent)
    .moveTo(58, -8).lineTo(58, -53).stroke({ color: 0x8d9e9c, width: 2 })
    .moveTo(47, -53).lineTo(69, -53).lineTo(64, -40).lineTo(52, -40).closePath().fill(0xfff5d8)
    .ellipse(58, -36, 11, 3).fill({ color: 0xffe9ba, alpha: .35 });
  const light = new Graphics().ellipse(58, -34, 17, 8).fill(0xfff3ca)
    .circle(58, -47, 4).fill(0xfff5d6);
  light.alpha = 0.16;
  light.name = 'studioLight';
  objects.addChild(studio, light, tree(81, 4, .55));
  return light;
}

function addGarden(objects: Container, accent: number): Container {
  objects.addChild(tree(-78, -6, .7), tree(81, -4, .72));
  const greenhouse = new Graphics().rect(-51, -22, 43, 23).fill(0xdaf2db)
    .moveTo(-8, -22).lineTo(0, -28).lineTo(0, -5).lineTo(-8, 1).closePath().fill(0x90c4ad)
    .moveTo(-55, -22).lineTo(-30, -44).lineTo(-4, -22).closePath().fill(0xa7d7c2)
    .moveTo(-30, -44).lineTo(-4, -22).lineTo(0, -28).lineTo(-24, -49).closePath().fill({ color: 0xe9fff5, alpha: .72 })
    .moveTo(-30, -44).lineTo(-30, 0).stroke({ color: 0xffffff, width: 2 })
    .moveTo(-51, -22).lineTo(-8, -22).stroke({ color: 0xffffff, width: 2 })
    .rect(-42, -13, 8, 12).fill(0x74ac85);
  const windmillTower = new Graphics().moveTo(36, 0).lineTo(43, -47).lineTo(51, 0).closePath().fill(0xfff4df)
    .moveTo(51, 0).lineTo(57, -5).lineTo(47, -48).lineTo(43, -47).closePath().fill(0xd8c8ae);
  const windmillRotor = new Graphics().moveTo(0, 0).lineTo(0, -25).stroke({ color: 0xf8f5df, width: 5 })
    .moveTo(0, 0).lineTo(25, 0).stroke({ color: 0xf8f5df, width: 5 })
    .moveTo(0, 0).lineTo(-18, 16).stroke({ color: 0xf8f5df, width: 5 })
    .circle(0, 0, 5).fill(accent);
  windmillRotor.position.set(43, -47);
  windmillRotor.name = 'windmillRotor';
  objects.addChild(greenhouse, windmillTower, windmillRotor);
  return windmillRotor;
}

function addCulture(objects: Container, accent: number): Container {
  objects.addChild(tree(-78, -2, .73), tree(75, -5, .65));
  const pavilion = new Graphics().ellipse(0, 2, 40, 9).fill({ color: 0x4a766e, alpha: .17 })
    .rect(-31, -6, 62, 9).fill(0xe6d4b4)
    .rect(-23, -39, 7, 34).fill(0xfff4df)
    .rect(16, -39, 7, 34).fill(0xfff4df)
    .moveTo(-37, -39).lineTo(0, -59).lineTo(37, -39).closePath().fill(accent)
    .moveTo(0, -59).lineTo(37, -39).lineTo(31, -34).lineTo(0, -51).closePath().fill({ color: 0x4e8196, alpha: .58 })
    .rect(-28, -43, 56, 5).fill(0xe4cba9)
    .rect(-8, -31, 16, 23).fill(0x91aeb0)
    .moveTo(-4, -29).lineTo(-4, -13).stroke({ color: 0xfff6e4, width: 2 });
  const path = new Graphics().moveTo(2, 5).quadraticCurveTo(30, 16, 55, 33).stroke({ color: 0xf4e5bc, width: 8, alpha: .85 });
  const lantern = new Graphics().circle(0, -29, 14).fill(0xffe3a6)
    .circle(0, -29, 4).fill(0xfff1cb);
  lantern.alpha = 0.11;
  lantern.name = 'pavilionLantern';
  objects.addChild(path, pavilion, lantern);
  return lantern;
}

export function updateIslandMotion(motion: IslandMotion, seconds: number) {
  const { target, profile } = motion;
  const cycle = seconds * Math.PI * 2 / profile.periodSeconds + profile.phase;
  if (profile.kind === 'scan') target.rotation = Math.sin(cycle) * profile.amplitude;
  if (profile.kind === 'rotation') target.rotation = seconds * profile.amplitude / profile.periodSeconds + profile.phase;
  if (profile.kind === 'light') target.alpha = (profile.baseAlpha ?? 0.1) + Math.sin(cycle) * profile.amplitude;
}

export function createIsland(theme: Theme) {
  const config = visual[theme];
  const shadow = new Container();
  const shoreline = new Container();
  const terrain = new Container();
  const objects = new Container();

  const contact = new Graphics();
  blob(contact, config.outline, 1.2, 1.25, config.depth + 18, 0x248eab, .13);
  blob(contact, config.outline, 1.12, 1.16, config.depth + 12, 0x155f7d, .17);
  shadow.addChild(contact);

  const shore = new Graphics();
  blob(shore, config.outline, 1.11, 1.13, 15, 0xa9e5da, .5);
  blob(shore, config.outline, 1.04, 1.06, config.depth + 10, config.earth);
  blob(shore, config.outline, 1.025, 1.035, config.depth - 2, config.cliff);
  blob(shore, config.outline, 1.01, 1.01, 9, config.sand);
  shoreline.addChild(shore);

  const cliffFaces = new Graphics();
  cliffFaces.moveTo(-92, 35).lineTo(-46, 58).lineTo(-50, config.depth + 61).lineTo(-98, config.depth + 42).closePath()
    .fill({ color: config.earth, alpha: .72 });
  cliffFaces.moveTo(-46, 58).lineTo(12, 68).lineTo(4, config.depth + 66).lineTo(-50, config.depth + 61).closePath()
    .fill({ color: config.earth, alpha: .86 });
  cliffFaces.moveTo(12, 68).lineTo(88, 39).lineTo(89, config.depth + 42).lineTo(4, config.depth + 66).closePath()
    .fill({ color: config.cliff, alpha: .78 });
  cliffFaces.moveTo(-38, config.depth + 44).lineTo(-12, config.depth + 51).stroke({ color: 0xf2dbb6, width: 3, alpha: .3 });
  cliffFaces.moveTo(27, config.depth + 50).lineTo(59, config.depth + 36).stroke({ color: 0xffffff, width: 3, alpha: .2 });
  shoreline.addChild(cliffFaces);

  const land = new Graphics();
  blob(land, config.outline, .87, .78, -11, config.grass);
  land.ellipse(-31, -24, 43, 17).fill({ color: config.lightGrass, alpha: .45 });
  land.ellipse(47, -12, 32, 15).fill({ color: config.lightGrass, alpha: .26 });
  land.moveTo(-51, 22).quadraticCurveTo(-24, 12, 4, 26).stroke({ color: 0xfff3cf, width: 3, alpha: .55 });
  terrain.addChild(land);

  const shoreLight = new Graphics();
  shoreLight.moveTo(-111, 26).quadraticCurveTo(-94, 10, -76, 10)
    .stroke({ color: 0xecfffa, width: 2, alpha: .42 });
  shoreLight.moveTo(82, 32).quadraticCurveTo(109, 26, 118, 41)
    .stroke({ color: 0xecfffa, width: 2, alpha: .35 });
  terrain.addChild(shoreLight);

  const raisedGround = new Graphics();
  if (theme === 'research' || theme === 'garden') {
    raisedGround.ellipse(12, -25, 61, 23).fill(config.cliff);
    raisedGround.ellipse(12, -34, 57, 21).fill(config.lightGrass);
  } else if (theme === 'harbor') {
    raisedGround.ellipse(-8, -27, 59, 20).fill(config.cliff);
    raisedGround.ellipse(-8, -34, 56, 19).fill(config.lightGrass);
  } else {
    raisedGround.ellipse(7, -24, 63, 20).fill(config.cliff);
    raisedGround.ellipse(7, -31, 60, 18).fill(config.lightGrass);
  }
  terrain.addChild(raisedGround);

  let motionTarget: Container;
  if (theme === 'research') motionTarget = addResearch(objects, config.accent);
  else if (theme === 'coral') motionTarget = addCreative(objects, config.accent);
  else if (theme === 'garden') motionTarget = addGarden(objects, config.accent);
  else motionTarget = addCulture(objects, config.accent);
  objects.sortableChildren = true;
  for (const child of objects.children) child.zIndex = Math.round(child.y * 10);

  return { shadow, shoreline, terrain, objects, motion: { target: motionTarget, profile: config.motion } satisfies IslandMotion } satisfies IslandView;
}
