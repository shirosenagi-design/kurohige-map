import { Container, Sprite, Texture } from 'pixi.js';

type FogPatch = { sprite: Sprite; baseX: number; baseY: number; phase: number; speed: number; sway: number };

function createHazeTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(126, 132, 12, 128, 128, 122);
  gradient.addColorStop(0, 'rgba(244,253,252,.68)');
  gradient.addColorStop(.34, 'rgba(237,250,250,.43)');
  gradient.addColorStop(.68, 'rgba(225,246,248,.17)');
  gradient.addColorStop(1, 'rgba(218,244,248,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.ellipse(128, 128, 122, 86, -.12, 0, Math.PI * 2);
  context.fill();
  return Texture.from(canvas);
}

function patch(texture: Texture, x: number, y: number, width: number, height: number, alpha: number, phase: number): FogPatch {
  const sprite = new Sprite(texture);
  sprite.anchor.set(.5);
  sprite.position.set(x, y);
  sprite.width = width;
  sprite.height = height;
  sprite.alpha = alpha;
  sprite.rotation = Math.sin(phase) * .18;
  return { sprite, baseX: x, baseY: y, phase, speed: .018 + (phase % 1) * .008, sway: 7 + (phase % 3) * 3 };
}

export function createMarineFog() {
  const root = new Container();
  root.name = 'marineFogField';
  const texture = createHazeTexture();
  const patches = [
    patch(texture, -520, -430, 500, 230, .34, .4),
    patch(texture, 540, -570, 590, 260, .29, 1.7),
    patch(texture, -590, 220, 520, 235, .27, 3.1),
    patch(texture, 330, 330, 420, 190, .17, 4.6),
    patch(texture, 30, -690, 500, 210, .15, 5.4),
  ];
  root.addChild(...patches.map((item) => item.sprite));

  const createLocalCover = (x: number, y: number) => {
    const cover = new Container();
    cover.name = 'localRevealFog';
    cover.position.set(x, y);
    const local = [
      patch(texture, -34, -8, 330, 175, .75, .8),
      patch(texture, 48, -26, 290, 150, .67, 2.5),
      patch(texture, 8, 35, 360, 140, .53, 4.1),
    ];
    cover.addChild(...local.map((item) => item.sprite));
    root.addChild(cover);
    return cover;
  };

  const tick = (seconds: number) => {
    for (const item of patches) {
      item.sprite.x = item.baseX + Math.sin(seconds * item.speed + item.phase) * item.sway;
      item.sprite.y = item.baseY + Math.cos(seconds * item.speed * .73 + item.phase) * item.sway * .45;
    }
  };
  return { root, createLocalCover, tick, destroy: () => texture.destroy(true) };
}
