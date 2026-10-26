import { Container, Graphics, Text } from 'pixi.js';
import { projectWorld } from './projection';
import { resolveUprightShipHeading } from './islandNavigation';

const DEGREE = Math.PI / 180;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export type ShipController = {
  worldRoot: Container;
  label: Text;
  setWorldPosition: (x: number, y: number) => void;
  setHeading: (radians: number) => void;
  applyCamera: (camera: { x: number; y: number; zoom: number }, width: number, height: number) => void;
  updateIdle: (seconds: number, zoom: number) => void;
  readTransform: () => { worldX: number; worldY: number; idleY: number; heading: number; roll: number; artworkScale: number };
};

function createArtwork() {
  const artwork = new Container();

  const hull = new Graphics()
    .moveTo(-24, 8).quadraticCurveTo(0, 14, 25, 5).lineTo(17, 23)
    .quadraticCurveTo(1, 31, -17, 22).closePath().fill(0xf8fbef)
    .moveTo(-17, 22).quadraticCurveTo(1, 31, 17, 23).lineTo(14, 29).quadraticCurveTo(0, 37, -14, 28).closePath().fill(0x2e8195)
    .moveTo(-15, 20).quadraticCurveTo(1, 28, 17, 21).stroke({ color: 0x77c2c8, width: 2.4, alpha: .9 })
    .moveTo(-23, 9).quadraticCurveTo(0, 14, 24, 7).stroke({ color: 0xd0e4df, width: 1.4 });
  hull.name = 'hull';

  const deck = new Graphics().ellipse(0, 8, 22, 6).fill(0xe6d0ad)
    .ellipse(-1, 6, 17, 3.5).fill({ color: 0xffffff, alpha: .8 })
    .roundRect(-5, 2, 12, 8, 2).fill(0xc3e1df);
  deck.name = 'deck';

  const mast = new Graphics().moveTo(0, 8).lineTo(0, -42).stroke({ color: 0x5b8d99, width: 2.1 })
    .circle(0, -42, 1.8).fill(0x6c9ba0);
  mast.name = 'mast';

  const jib = new Graphics().moveTo(-3, -34).quadraticCurveTo(-10, -11, -19, 4)
    .lineTo(-3, 4).closePath().fill(0xfff4d9)
    .moveTo(-3, -34).quadraticCurveTo(-10, -11, -19, 4).stroke({ color: 0xe2d5b5, width: 1 });
  jib.name = 'jib';

  const mainsail = new Graphics().moveTo(3, -40).quadraticCurveTo(17, -16, 22, 5)
    .lineTo(3, 5).closePath().fill(0xffffff)
    .moveTo(3, -40).quadraticCurveTo(17, -16, 22, 5).stroke({ color: 0xb4d9d9, width: 1 })
    .moveTo(5, -30).quadraticCurveTo(14, -9, 16, 0).stroke({ color: 0xe2f3ed, width: 2, alpha: .75 });
  mainsail.name = 'mainSail';

  artwork.addChild(hull, deck, mast, jib, mainsail);
  return artwork;
}

export function createShip(x: number, y: number): ShipController {
  let semanticX = x;
  let semanticY = y;
  const initialRender = projectWorld({ x, y });
  const worldRoot = new Container();
  worldRoot.position.set(initialRender.x, initialRender.y);
  worldRoot.name = 'playerShipWorldRoot';

  // Water contact is stable at the real world position. It is not a wake or trail.
  const contact = new Graphics().ellipse(1, 23, 31, 8).fill({ color: 0x197e9b, alpha: .18 })
    .moveTo(-30, 20).quadraticCurveTo(-17, 27, -5, 25).stroke({ color: 0xe6faf4, width: 1.5, alpha: .48 })
    .moveTo(14, 24).quadraticCurveTo(28, 20, 33, 16).stroke({ color: 0xe6faf4, width: 1.2, alpha: .38 });
  contact.name = 'waterContact';

  const idleRoot = new Container();
  idleRoot.name = 'idleVisualRoot';
  const headingRoot = new Container();
  headingRoot.name = 'headingRoot';
  const rollRoot = new Container();
  rollRoot.name = 'idleRollRoot';
  const visualRoot = new Container();
  visualRoot.name = 'cameraScaleRoot';
  visualRoot.addChild(createArtwork());
  rollRoot.addChild(visualRoot);
  headingRoot.addChild(rollRoot);
  idleRoot.addChild(headingRoot);
  worldRoot.addChild(contact, idleRoot);

  // A sibling in pinsLabels, rather than a child of idleRoot, stays calm as the hull bobs.
  const label = new Text({ text: 'あなた', style: { fontFamily: 'Arial, sans-serif', fontSize: 14, fill: 0x174d61, fontWeight: 'bold' } });
  label.anchor.set(.5, 0);
  label.position.set(initialRender.x, initialRender.y + 38);

  let visualScale = 1;
  let headingMirror = 1;
  let labelOffset = 38;
  let targetHeading = 0;
  let lastUpdateSeconds: number | null = null;
  return {
    worldRoot,
    label,
    setWorldPosition(nextX, nextY) {
      semanticX = nextX;
      semanticY = nextY;
      const render = projectWorld({ x: nextX, y: nextY });
      worldRoot.position.set(render.x, render.y);
      label.position.set(render.x, render.y + labelOffset);
    },
    setHeading(radians) {
      const resolved = resolveUprightShipHeading(radians);
      targetHeading = resolved.rotation;
      headingMirror = resolved.mirror;
    },
    applyCamera(camera, width, height) {
      const { zoom } = camera;
      // Follow world zoom naturally. Clamp only when the projected artwork would
      // leave its readable 30–104 px screen-height envelope (native height ≈64).
      const minimumScale = 30 / (64 * zoom);
      const maximumScale = 104 / (64 * zoom);
      visualScale = clamp(1, minimumScale, maximumScale);
      visualRoot.scale.set(visualScale * headingMirror, visualScale);
      label.scale.set(clamp(.8 / zoom, .45, 1.4));
      const screenX = width / 2 + (worldRoot.x - camera.x) * zoom;
      const screenY = height / 2 + (worldRoot.y - camera.y) * zoom;
      const nearCard = width < 700 || screenX > width - 448;
      const labelWouldMeetCard = screenY + 34 + label.height * zoom > height - 188;
      labelOffset = (nearCard && labelWouldMeetCard ? -70 : 34) / zoom;
      label.position.set(worldRoot.x, worldRoot.y + labelOffset);
      contact.scale.set(visualScale);
    },
    updateIdle(seconds, zoom) {
      const deltaSeconds = lastUpdateSeconds === null ? 0 : Math.max(0, Math.min(.05, seconds - lastUpdateSeconds));
      lastUpdateSeconds = seconds;
      const headingDelta = Math.atan2(Math.sin(targetHeading - headingRoot.rotation), Math.cos(targetHeading - headingRoot.rotation));
      headingRoot.rotation += headingDelta * (1 - Math.exp(-7 * deltaSeconds));
      const verticalWave = Math.sin(seconds * Math.PI * 2 / 5.8 + .55)
        + .08 * Math.sin(seconds * Math.PI * 2 / 9.7 + 1.3);
      idleRoot.y = 4.7 * verticalWave / zoom;
      rollRoot.rotation = DEGREE * .9 * Math.sin(seconds * Math.PI * 2 / 7.3 + 2.1);
    },
    readTransform() {
      return { worldX: semanticX, worldY: semanticY, idleY: idleRoot.y, heading: headingRoot.rotation, roll: rollRoot.rotation, artworkScale: visualScale };
    },
  };
}
