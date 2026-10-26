import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import distantMountainOverlayUrl from './assets/map/distant-mountain-overlay.png';
import skyCloudOverlayUrl from './assets/map/sky-cloud-overlay.png';
import skySunrayOverlayUrl from './assets/map/sky-sunray-overlay.png';

const OCEAN_ANCHOR_SAFE_MARGIN = 22;
const DISTANT_MOUNTAIN_VISIBLE_BOTTOM_Y = 582;

function gradientTexture(stops: [number, string][]) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return Texture.from(canvas);
}

export function sceneDepth(renderY: number) {
  const normalized = Math.max(0, Math.min(1, (renderY + 230) / 500));
  return {
    scale: .82 + normalized * .26,
    alpha: .86 + normalized * .14,
  };
}

export async function createSceneComposition(debug = false) {
  const root = new Container();
  root.name = 'sceneBackdrop';
  const overlay = new Container();
  overlay.name = 'sceneHorizonAtmosphere';
  const [cloudTexture, sunrayTexture, distantMountainTexture] = await Promise.all([
    Assets.load<Texture>(skyCloudOverlayUrl),
    Assets.load<Texture>(skySunrayOverlayUrl),
    Assets.load<Texture>(distantMountainOverlayUrl),
  ]);
  const skyTexture = gradientTexture([
    [0, '#69c9f3'], [.52, '#a7e5f8'], [.82, '#def6fb'], [1, '#fff4dc'],
  ]);
  const hazeTexture = gradientTexture([
    [0, 'rgba(255,250,231,0)'], [.42, 'rgba(255,251,235,.56)'], [.7, 'rgba(255,255,248,.68)'], [1, 'rgba(255,255,255,0)'],
  ]);
  const sky = new Sprite(skyTexture);
  const sunrayOverlay = new Sprite(sunrayTexture);
  sunrayOverlay.alpha = .18;
  sunrayOverlay.blendMode = 'screen';
  const cloudOverlay = new Sprite(cloudTexture);
  cloudOverlay.alpha = .78;
  const distantMountainOverlay = new Sprite(distantMountainTexture);
  distantMountainOverlay.alpha = .8;

  const horizonHaze = new Sprite(hazeTexture);
  horizonHaze.anchor.set(.5);
  const waterMask = new Graphics();
  waterMask.name = 'sceneOceanHorizonMask';
  root.addChild(sky, sunrayOverlay, cloudOverlay, distantMountainOverlay, waterMask);
  overlay.addChild(horizonHaze);

  const debugLayer = new Container();
  debugLayer.name = 'sceneDebugOverlay';
  const debugBounds = new Graphics();
  const debugLabels = [
    ['SKY REGION', 0x0057ff],
    ['FAR MOUNTAIN BOUNDS', 0xff00d4],
    ['FAR ISLAND BOUNDS', 0xff8a00],
    ['HORIZON / OCEAN MASK BOUNDARY', 0xff1744],
    ['OCEAN-SAFE-TOP / ANCHOR GUARD', 0x00a8ff],
    ['OCEAN MASK REGION', 0x00a650],
    ['CAMERA Y', 0x7d00cc],
  ].map(([text, color]) => new Text({
    text: text as string,
    style: { fontFamily: 'Arial, sans-serif', fontSize: 13, fill: color as number, fontWeight: 'bold' },
  }));
  if (debug) {
    debugLayer.addChild(debugBounds, ...debugLabels);
    overlay.addChild(debugLayer);
  }

  let horizonY = 0;
  let oceanSafeTopY = 0;
  const resize = (width: number, height: number) => {
    horizonY = height * (width < 700 ? .24 : .28);
    oceanSafeTopY = horizonY + OCEAN_ANCHOR_SAFE_MARGIN;
    sky.width = width;
    sky.height = Math.max(horizonY + 130, height * .48);
    sunrayOverlay.scale.set(width / sunrayTexture.width);
    cloudOverlay.scale.set(width / cloudTexture.width);
    const distantMountainScale = width / distantMountainTexture.width;
    distantMountainOverlay.scale.set(distantMountainScale);
    distantMountainOverlay.position.set(0, horizonY - DISTANT_MOUNTAIN_VISIBLE_BOTTOM_Y * distantMountainScale);
    horizonHaze.position.set(width / 2, horizonY + 4);
    horizonHaze.width = width;
    horizonHaze.height = width < 700 ? 118 : 150;
    waterMask.clear().rect(0, horizonY, width, height - horizonY).fill(0xffffff);
    if (debug) {
      debugBounds.clear()
        .rect(1, 1, width - 2, horizonY - 2).stroke({ color: 0x0057ff, width: 3, alpha: .95 })
        .rect(1, horizonY - 78, width - 2, 82).stroke({ color: 0xff00d4, width: 3, alpha: .95 })
        .rect(1, horizonY - 28, width - 2, 62).stroke({ color: 0xff8a00, width: 3, alpha: .95 })
        .moveTo(0, horizonY).lineTo(width, horizonY).stroke({ color: 0xff1744, width: 5, alpha: 1 })
        .moveTo(0, oceanSafeTopY).lineTo(width, oceanSafeTopY).stroke({ color: 0x00a8ff, width: 4, alpha: 1 })
        .rect(1, horizonY + 1, width - 2, height - horizonY - 2).stroke({ color: 0x00a650, width: 3, alpha: .95 });
      const labelX = 12;
      debugLabels[0].position.set(labelX, 142);
      debugLabels[1].position.set(labelX, Math.max(158, horizonY - 74));
      debugLabels[2].position.set(labelX, horizonY + 8);
      debugLabels[3].position.set(labelX, horizonY - 22);
      debugLabels[4].position.set(labelX, oceanSafeTopY + 2);
      debugLabels[5].position.set(labelX, oceanSafeTopY + 22);
      debugLabels[6].position.set(labelX, height - 44);
    }
  };
  const update = (_camera: { x: number; y: number; zoom: number }, _seconds: number) => {};
  const updateDebugCamera = (values: {
    cameraY: number;
    minCameraY: number;
    maxCameraY: number;
    anchorScreenY: number;
  }) => {
    if (!debug) return;
    debugLabels[6].text = `CAMERA Y ${values.cameraY.toFixed(2)}  |  CLAMP ${values.minCameraY.toFixed(2)}…${values.maxCameraY.toFixed(2)}  |  TOP ANCHOR SCREEN Y ${values.anchorScreenY.toFixed(2)}`;
  };
  return {
    root,
    overlay,
    waterMask,
    resize,
    update,
    updateDebugCamera,
    diagnostics: () => ({ horizonY, oceanSafeTopY, debug }),
    destroy: () => { skyTexture.destroy(true); hazeTexture.destroy(true); },
  };
}
