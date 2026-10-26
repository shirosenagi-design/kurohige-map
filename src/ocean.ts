import { Assets, Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import oceanBaseTileUrl from './assets/map/ocean-base-tile.png';
import waterSplashAUrl from './assets/map/water-splash-a.webm';
import waterSplashBUrl from './assets/map/water-splash-b.webm';
import { placement, type PlacedNode } from './model';

const EXTENT = 8192;
const TAU = Math.PI * 2;
const OCEAN_BASE_TILE_SIZE = 1254;

// Perspective presentation only.
// The source image itself stays untouched.
const PERSPECTIVE_STRIP_COUNT = 48;
const PERSPECTIVE_TOP_SCALE_X = 0.46;
const PERSPECTIVE_TOP_SCALE_Y = 0.28;
const PERSPECTIVE_BOTTOM_SCALE_X = 1.14;
const PERSPECTIVE_BOTTOM_SCALE_Y = 0.98;
const PERSPECTIVE_OVERLAP_PX = 2;

export type OceanWorldBounds = { minX: number; maxX: number; minY: number; maxY: number };
export type OceanCoverage = OceanWorldBounds & { width: number; height: number };

function canvasTexture(size: number, paint: (context: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { alpha: true })!;
  paint(context, size);
  return Texture.from(canvas);
}

function makeBroadLight() {
  return canvasTexture(768, (context, size) => {
    const image = context.createImageData(size, size);
    const pixels = image.data;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const warp = 0.09 * Math.sin(TAU * (2 * v + u)) + 0.035 * Math.cos(TAU * (3 * u - v));
        const band = Math.sin(TAU * (3 * u + v + warp));
        const envelope = 0.5 + 0.5 * Math.cos(TAU * (u - 2 * v));
        const alpha = Math.pow(Math.max(0, band), 4) * envelope * 23;
        const i = (y * size + x) * 4;
        pixels[i] = 240;
        pixels[i + 1] = 253;
        pixels[i + 2] = 255;
        pixels[i + 3] = Math.round(alpha);
      }
    }
    context.putImageData(image, 0, 0);
  });
}

function makeFineLight() {
  return canvasTexture(1024, (context, size) => {
    let seed = 23971;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < 125; i++) {
      const x = random() * size;
      const y = random() * size;
      const length = 14 + random() * 44;
      const bend = (random() - 0.5) * 9;
      context.strokeStyle = `rgba(241, 254, 255, ${0.06 + random() * 0.11})`;
      context.lineWidth = 0.8 + random() * 1.2;
      context.lineCap = 'round';

      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          context.beginPath();
          context.moveTo(x + dx, y + dy);
          context.quadraticCurveTo(
            x + dx + length * 0.48,
            y + dy + bend,
            x + dx + length,
            y + dy - 1,
          );
          context.stroke();
        }
      }
    }
  });
}

function makeShallowGlow() {
  return canvasTexture(256, (context, size) => {
    const gradient = context.createRadialGradient(128, 128, 18, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(179, 244, 225, 0.46)');
    gradient.addColorStop(0.42, 'rgba(166, 239, 226, 0.22)');
    gradient.addColorStop(1, 'rgba(166, 239, 226, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });
}

function fillWorld(texture: Texture) {
  const tile = new TilingSprite({
    texture,
    width: EXTENT * 2,
    height: EXTENT * 2,
  });
  tile.position.set(-EXTENT, -EXTENT);
  return tile;
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

function createPerspectiveOceanBase(texture: Texture, deepOcean: Container) {
  const layer = new Container();

  const strips = Array.from({ length: PERSPECTIVE_STRIP_COUNT }, () => {
    const strip = new TilingSprite({
      texture,
      width: 1,
      height: 1,
    });
    layer.addChild(strip);
    return strip;
  });

  deepOcean.addChild(layer);

  const update = (elapsed: number) => {
    const viewportWidth =
      typeof window === 'undefined' ? 1920 : Math.max(1, window.innerWidth);

    const viewportHeight =
      typeof window === 'undefined' ? 1080 : Math.max(1, window.innerHeight);

    const matrix = deepOcean.worldTransform;

    // LivingMap camera currently uses translation + scale.
    // Guard against a zero-scale transient during mount.
    const scaleX = Math.max(0.0001, Math.abs(matrix.a));
    const scaleY = Math.max(0.0001, Math.abs(matrix.d));

    const mobile = viewportWidth < 768;
    const horizonRatio = mobile ? 0.24 : 0.28;

    // Start slightly above the actual water mask so no gap can appear.
    const screenTop = viewportHeight * horizonRatio - 20;
    const screenBottom = viewportHeight + 10;

    const worldLeft = (-24 - matrix.tx) / scaleX;
    const worldRight = (viewportWidth + 24 - matrix.tx) / scaleX;
    const worldTop = (screenTop - matrix.ty) / scaleY;
    const worldBottom = (screenBottom - matrix.ty) / scaleY;

    const worldWidth = worldRight - worldLeft;
    const worldHeight = worldBottom - worldTop;
    const overlapWorld = PERSPECTIVE_OVERLAP_PX / scaleY;

    let sourceY = worldTop;
    const worldCenterX = (worldLeft + worldRight) * 0.5;
    const localCenterX = worldWidth * 0.5;

    for (let i = 0; i < strips.length; i++) {
      const strip = strips[i];

      const t0 = i / strips.length;
      const t1 = (i + 1) / strips.length;
      const middle = (t0 + t1) * 0.5;

      // Slightly nonlinear progression:
      // compressed far water, gradually opening toward foreground.
      const perspective = smoothstep(middle);

      const textureScaleX =
        PERSPECTIVE_TOP_SCALE_X +
        (PERSPECTIVE_BOTTOM_SCALE_X - PERSPECTIVE_TOP_SCALE_X) * perspective;

      const textureScaleY =
        PERSPECTIVE_TOP_SCALE_Y +
        (PERSPECTIVE_BOTTOM_SCALE_Y - PERSPECTIVE_TOP_SCALE_Y) * perspective;

      const y0 = worldTop + worldHeight * t0;
      const y1 = worldTop + worldHeight * t1;

      strip.position.set(worldLeft, y0);
      strip.width = worldWidth;
      strip.height = y1 - y0 + overlapWorld;

      strip.tileScale.set(textureScaleX, textureScaleY);

      // Keep one continuous virtual ocean surface across all strips.
      // Each strip changes scale, but does not restart its texture phase.
      // Slow, continuous water motion.
      // Adjacent strips use nearly the same phase, so the surface bends
      // instead of looking like independently scrolling bands.
      const waveOffsetX =
        Math.sin(elapsed * 0.78 + middle * 4.4) *
        (4.5 + perspective * 9.5);

      const waveOffsetY =
        Math.cos(elapsed * 0.52 + middle * 5.2) *
        (1.6 + perspective * 3.2);

      const tilePositionX =
        localCenterX - worldCenterX * textureScaleX + waveOffsetX;

      const tilePositionY =
        -sourceY * textureScaleY + waveOffsetY;

      strip.tilePosition.set(tilePositionX, tilePositionY);

      // Advance through the same source surface continuously.
      // Do not use the visual overlap here; it exists only to hide seams.
      sourceY +=
        (y1 - y0) / Math.max(textureScaleY, 0.0001);
    }
  };

  return {
    update,
    destroy: () => {
      layer.destroy({ children: true });
    },
  };
}


async function createAmbientWaterSplashes(waterSurface: Container) {
  // Each ambient splash gets its own irregular point in the 3-second loop.
  // Avoids the whole ocean splashing on the same beat.
  const phases = [
    0.07,
    0.36,
    0.71,
    1.09,
    1.43,
    1.88,
    2.27,
    2.74,
  ];

  const splashUrls = [waterSplashAUrl, waterSplashBUrl];

  const videos: HTMLVideoElement[] = [];
  const videoTextures: Texture[] = [];

  for (const [index, phase] of phases.entries()) {
    const video = document.createElement('video');

    video.src = splashUrls[index % splashUrls.length];
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }

      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener(
        'error',
        () => reject(new Error('water splash video failed to load')),
        { once: true },
      );

      video.load();
    });

    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(
        phase,
        Math.max(0, video.duration - 0.05),
      );
    }

    await video.play().catch(() => {});

    videos.push(video);
    videoTextures.push(Texture.from(video));
  }

  let seed = 918273;

  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const splashes = Array.from({ length: 8 }, (_, index) => {
    const sprite = new Sprite(videoTextures[index % videoTextures.length]);

    sprite.anchor.set(0.5, 0.62);
    sprite.alpha = 0;

    // Source WebM has a dark background.
    // SCREEN keeps the dark pixels from dirtying the ocean
    // while preserving the bright white splash.
    sprite.blendMode = 'screen';

    waterSurface.addChild(sprite);

    return {
      sprite,
      video: videos[index % videos.length],
      wasQuiet: false,
      slotJitterX: 0,
      slotJitterY: 0,
      initialized: false,
      strength: 0.18,
      sizeBias: 1,
      flip: 1,
    };
  });

  // ------------------------------------------------------------------
  // Truly independent ambient splash scheduling
  //
  // Each splash actor has its own random clock.
  // Videos DO NOT loop continuously anymore.
  //
  // When an actor fires:
  //   1. choose a completely new visible-ocean position
  //   2. play one splash
  //   3. hide/pause
  //   4. independently wait a random amount of time
  //
  // This removes both the spatial "fountain grid" and rhythmic looping.
  // ------------------------------------------------------------------

  for (const video of videos) {
    video.loop = false;
    video.autoplay = false;
    video.pause();

    try {
      video.currentTime = 0;
    } catch {
      // Metadata may not be ready on the very first frame.
    }
  }

  type SplashRuntimeState = {
    active: boolean;
    nextBurstAt: number;
    hideAt: number;
  };

  const splashStates: SplashRuntimeState[] = splashes.map(() => ({
    active: false,

    // Spread the first appearances over several seconds,
    // so startup itself does not look choreographed.
    nextBurstAt: 0.8 + random() * 9.0,

    hideAt: 0,
  }));

  const scheduleNextBurst = (
    state: SplashRuntimeState,
    elapsed: number,
  ) => {
    /*
     * Exponential-style random delay.
     *
     * Unlike "every 3-6 sec", this has no obvious rhythm:
     * sometimes two splashes happen fairly close together,
     * sometimes the sea stays quiet noticeably longer.
     */
    const r = Math.max(0.000001, 1 - random());

    const irregularDelay =
      Math.min(
        16.0,
        -Math.log(r) * 5.2,
      );

    state.nextBurstAt =
      elapsed +
      3.2 +
      irregularDelay;
  };

  const placeSplashRandomly = (
    splash: (typeof splashes)[number],
    worldLeft: number,
    worldRight: number,
    worldTop: number,
    worldBottom: number,
  ) => {
    const width = worldRight - worldLeft;
    const height = worldBottom - worldTop;

    // Fully random rather than assigned viewport slots.
    const xRatio =
      0.05 +
      random() * 0.90;

    const yRatio =
      0.34 +
      random() * 0.61;

    splash.sprite.position.set(
      worldLeft + width * xRatio,
      worldTop + height * yRatio,
    );

    // Re-roll appearance every single burst.
    splash.strength =
      0.72 +
      random() * 0.18;

    // Splash size is intentionally uneven:
    // many small splashes, some medium ones, and rare large bursts.
    const sizeRoll = random();

    if (sizeRoll < 0.55) {
      // Small: 55%
      splash.sizeBias =
        0.48 +
        random() * 0.27;
    } else if (sizeRoll < 0.90) {
      // Medium: 35%
      splash.sizeBias =
        0.78 +
        random() * 0.30;
    } else {
      // Large: 10%
      splash.sizeBias =
        1.16 +
        random() * 0.34;
    }

    splash.flip =
      random() > 0.5
        ? -1
        : 1;

    splash.initialized = true;
  };

  const tick = (elapsed: number) => {
    const viewportWidth =
      typeof window === 'undefined'
        ? 1920
        : Math.max(1, window.innerWidth);

    const viewportHeight =
      typeof window === 'undefined'
        ? 1080
        : Math.max(1, window.innerHeight);

    const matrix =
      waterSurface.worldTransform;

    const cameraScaleX =
      Math.max(
        0.0001,
        Math.abs(matrix.a),
      );

    const cameraScaleY =
      Math.max(
        0.0001,
        Math.abs(matrix.d),
      );

    const worldLeft =
      (0 - matrix.tx) /
      cameraScaleX;

    const worldRight =
      (viewportWidth - matrix.tx) /
      cameraScaleX;

    const worldTop =
      (0 - matrix.ty) /
      cameraScaleY;

    const worldBottom =
      (viewportHeight - matrix.ty) /
      cameraScaleY;

    splashes.forEach((splash, index) => {
      const state =
        splashStates[index];

      const sprite =
        splash.sprite;

      const video =
        splash.video;

      // ------------------------------------------------------
      // FIRE
      // ------------------------------------------------------

      if (
        !state.active &&
        elapsed >= state.nextBurstAt
      ) {
        placeSplashRandomly(
          splash,
          worldLeft,
          worldRight,
          worldTop,
          worldBottom,
        );

        state.active = true;

        /*
         * A/B clips contain roughly one second of useful splash motion.
         * Stop after that instead of playing their long transparent pad.
         */
        state.hideAt =
          elapsed +
          1.20 +
          random() * 0.20;

        try {
          video.pause();
          video.currentTime = 0;

          const playPromise =
            video.play();

          if (
            playPromise &&
            typeof playPromise.catch === 'function'
          ) {
            playPromise.catch(
              () => undefined,
            );
          }
        } catch {
          // Keep the ambient system alive even if one playback reset fails.
        }
      }

      // ------------------------------------------------------
      // QUIET
      // ------------------------------------------------------

      if (!state.active) {
        sprite.alpha = 0;
        return;
      }

      if (elapsed >= state.hideAt) {
        state.active = false;

        sprite.alpha = 0;

        video.pause();

        scheduleNextBurst(
          state,
          elapsed,
        );

        return;
      }

      // ------------------------------------------------------
      // ACTIVE SPLASH RENDERING
      // ------------------------------------------------------

      const screenY =
        matrix.ty +
        sprite.y * cameraScaleY;

      const depth =
        Math.min(
          1,
          Math.max(
            0,
            (
              screenY -
              viewportHeight * 0.18
            ) /
            (
              viewportHeight * 0.72
            ),
          ),
        );

      // Preserve the size that already passed visually.
      const baseScale =
        (
          0.058 +
          depth * 0.104
        ) *
        splash.sizeBias;

      const breathe =
        1 +
        Math.sin(
          elapsed * 5.7 +
          index * 1.31,
        ) *
        0.035;

      sprite.scale.set(
        baseScale *
          splash.flip *
          breathe,
        baseScale *
          breathe,
      );

      // Preserve the white / strong splash appearance.
      sprite.alpha =
        splash.strength;
    });
  };

  return {
    tick,

    destroy: () => {
      for (const splash of splashes) {
        splash.sprite.destroy();
      }

      for (const texture of videoTextures) {
        texture.destroy(true);
      }

      for (const video of videos) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    },
  };
}

function createAmbientWhaleCue(waterSurface: Container) {
  const host = new Container();
  host.visible = false;
  waterSurface.addChild(host);

  const shadow = new Graphics();
  const rippleA = new Graphics();
  const rippleB = new Graphics();
  const whaleMark = new Graphics();
  const tailMask = new Graphics();
  const foam = new Graphics();
  const spout = new Graphics();

  host.addChild(
    shadow,
    rippleA,
    rippleB,
    whaleMark,
    tailMask,
    foam,
    spout,
  );

  let seed = 91021;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const clamp01 = (value: number) =>
    Math.min(1, Math.max(0, value));

  const remap01 = (value: number, start: number, end: number) =>
    clamp01((value - start) / Math.max(0.0001, end - start));

  let active = false;
  let mode: 'fin' | 'spout' = 'fin';
  let eventStart = 0;
  let eventDuration = 0;
  let nextEventAt = 2 + random() * 3;

  let anchorX = 0;
  let anchorY = 0;
  let driftX = 0;
  let driftY = 0;
  let direction = 1;
  let isGolden = false;

  const clearVisuals = () => {
    shadow.clear();
    rippleA.clear();
    rippleB.clear();
    whaleMark.clear();
    tailMask.clear();
    foam.clear();
    spout.clear();
  };

  const spawn = (
    elapsed: number,
    worldLeft: number,
    worldRight: number,
    worldTop: number,
    worldBottom: number,
  ) => {
    const width = worldRight - worldLeft;
    const height = worldBottom - worldTop;

    // Slightly favor the head/spout event over the tail event.
    mode = random() < 0.45 ? 'fin' : 'spout';
    direction = random() > 0.5 ? 1 : -1;

    // Rare golden whale variant.
    isGolden = random() < 0.08;

    eventDuration =
      mode === 'fin'
        ? 3.6 + random() * 0.9
        : 4.3 + random() * 1.1;

    eventStart = elapsed;
    active = true;
    host.visible = true;

    const xRatio = 0.14 + random() * 0.72;
    const yRatio = 0.44 + random() * 0.40;

    anchorX = worldLeft + width * xRatio;
    anchorY = worldTop + height * yRatio;

    driftX = (24 + random() * 42) * direction;
    driftY = -6 + random() * 12;
  };

  const tick = (elapsed: number) => {
    const viewportWidth =
      typeof window === 'undefined' ? 1920 : Math.max(1, window.innerWidth);

    const viewportHeight =
      typeof window === 'undefined' ? 1080 : Math.max(1, window.innerHeight);

    const matrix = waterSurface.worldTransform;

    const cameraScaleX = Math.max(0.0001, Math.abs(matrix.a));
    const cameraScaleY = Math.max(0.0001, Math.abs(matrix.d));

    const worldLeft = (0 - matrix.tx) / cameraScaleX;
    const worldRight = (viewportWidth - matrix.tx) / cameraScaleX;
    const worldTop = (0 - matrix.ty) / cameraScaleY;
    const worldBottom = (viewportHeight - matrix.ty) / cameraScaleY;

    if (!active) {
      if (elapsed >= nextEventAt) {
        spawn(
          elapsed,
          worldLeft,
          worldRight,
          worldTop,
          worldBottom,
        );
      } else {
        host.visible = false;
        return;
      }
    }

    const progress = clamp01(
      (elapsed - eventStart) / Math.max(0.0001, eventDuration),
    );

    if (progress >= 1) {
      active = false;
      host.visible = false;
      clearVisuals();
      nextEventAt = elapsed + 5 + random() * 8;
      return;
    }

    const currentX = anchorX + driftX * progress;
    const currentY = anchorY + driftY * progress;

    host.position.set(currentX, currentY);

    const screenY = matrix.ty + currentY * cameraScaleY;
    const depth = clamp01(
      (screenY - viewportHeight * 0.18) / (viewportHeight * 0.72),
    );

    const scale = 0.44 + depth * 0.50;
    host.scale.set(scale);

    const presence = Math.sin(progress * Math.PI);
    const ripplePhase = remap01(progress, 0.14, 0.88);
    const rippleAlpha = 0.22 * (1 - ripplePhase) * presence;

    // shadow
    shadow.clear();
    shadow.ellipse(0, 0, 66, 22);
    shadow.fill({
      color: 0x124c61,
      alpha: (0.08 + depth * 0.08) * (0.45 + presence * 0.55),
    });
    shadow.rotation = 0.08 * direction;

    // ripple A
    rippleA.clear();
    if (rippleAlpha > 0.01) {
      rippleA.circle(0, 5, 16 + ripplePhase * 30);
      rippleA.stroke({
        width: 2,
        color: 0xffffff,
        alpha: rippleAlpha,
      });
    }

    // ripple B
    rippleB.clear();
    if (rippleAlpha > 0.01) {
      rippleB.circle(0, 5, 8 + ripplePhase * 22);
      rippleB.stroke({
        width: 1.5,
        color: 0xffffff,
        alpha: rippleAlpha * 0.78,
      });
    }

    // foam
    const foamPulse =
      mode === 'fin'
        ? Math.sin(remap01(progress, 0.18, 0.54) * Math.PI)
        : Math.sin(remap01(progress, 0.26, 0.52) * Math.PI);

    foam.clear();
    if (foamPulse > 0.01) {
      const spread = 16 + foamPulse * 10;

      foam.circle(-spread * 0.55, 8, 4 + foamPulse * 2.4);
      foam.circle(0, 7, 5 + foamPulse * 3.2);
      foam.circle(spread * 0.55, 8, 4 + foamPulse * 2.4);

      foam.fill({
        color: 0xffffff,
        alpha: 0.40 * foamPulse,
      });
    }

    whaleMark.clear();
    spout.clear();

    if (mode === 'fin') {
      /*
       * WHALE FLUKE
       *
       * Do not shrink or fade the tail when it disappears.
       * The tail keeps its physical size and moves downward through a
       * fixed waterline mask, so it looks like it is sinking into the sea.
       *
       * direction randomly mirrors the perspective:
       * one fluke is large / near, the other is small / far.
       */

      const waterLineY = 12;

      // Only the area ABOVE the waterline may display the tail.
      tailMask.clear();
      tailMask.rect(
        -130,
        -130,
        260,
        130 + waterLineY,
      );
      tailMask.fill({
        color: 0xffffff,
        alpha: 1,
      });

      whaleMark.mask = tailMask;

      const tailT = remap01(
        progress,
        0.10,
        0.82,
      );

      // Rise first, then physically sink through the waterline.
      const peakAt = 0.40;

      let verticalY = waterLineY + 30;

      if (tailT < peakAt) {
        const t = tailT / peakAt;
        const eased = t * t * (3 - 2 * t);

        verticalY =
          waterLineY + 30 -
          eased * 60;
      } else {
        const t =
          (tailT - peakAt) /
          (1 - peakAt);

        const eased = t * t * (3 - 2 * t);

        verticalY =
          waterLineY - 30 +
          eased * 68;
      }

      // At first the silhouette is narrow.
      // The flukes open while the tail rises, then KEEP their size.
      const openT = remap01(
        progress,
        0.13,
        0.33,
      );

      const openEase =
        openT * openT * (3 - 2 * openT);

      const bigSpread =
        14 + openEase * 43;

      const smallSpread =
        10 + openEase * 22;

      const rootLength =
        28;

      // Slightly slanted peduncle reinforces the 3/4-view.
      const rootCenterX = -7;

      whaleMark.clear();

      whaleMark.poly(
        [
          // Central notch between the two flukes.
          0, -5,

          // FAR / SMALL fluke.
          -5, -2,
          -smallSpread * 0.45, -6,
          -smallSpread, -5,
          -smallSpread * 0.74, 2,
          -10, 6,
          -6, 8,

          // Peduncle - left side.
          rootCenterX - 4, rootLength,

          // Rounded-ish bottom of the visible peduncle.
          rootCenterX, rootLength + 3,
          rootCenterX + 5, rootLength,

          // Peduncle - right side.
          6, 8,
          10, 6,

          // NEAR / LARGE fluke.
          bigSpread * 0.42, 9,
          bigSpread * 0.78, 4,
          bigSpread, -4,
          bigSpread * 0.72, -12,
          bigSpread * 0.34, -9,
          6, -2,
        ],
        true,
      );

      whaleMark.fill({
        color: 0x2b5d70,

        // IMPORTANT:
        // no tailLift multiplication.
        // It does NOT fade while sinking.
        alpha: 0.92,
      });

      whaleMark.position.set(
        0,
        verticalY,
      );

      // Mirror the entire perspective randomly.
      // direction was already randomized for every whale event.
      whaleMark.scale.set(
        direction,
        1,
      );

      // Not straight-on:
      // slight roll gives it a 3/4-view rather than a logo silhouette.
      whaleMark.rotation =
        0.10 * direction +
        Math.sin(progress * Math.PI) *
        0.025 *
        direction;

    } else {
      // Spout/head mode keeps the existing behaviour.
      whaleMark.mask = null;
      tailMask.clear();

      whaleMark.position.set(0, 0);
      whaleMark.scale.set(1, 1);
      whaleMark.rotation = 0;
      whaleMark.rotation = 0;
      const backLift = Math.sin(remap01(progress, 0.16, 0.76) * Math.PI);

      if (backLift > 0.01) {
        whaleMark.ellipse(0, 2, 20, 7 + backLift * 3);
        whaleMark.fill({
          color: isGolden ? 0xe0bd4f : 0x2b5d70,
          alpha: 0.72 * backLift,
        });
      }

      const spray = Math.sin(remap01(progress, 0.34, 0.58) * Math.PI);

      if (spray > 0.01) {
        spout.circle(0, -(10 + spray * 26), 3.2);
        spout.circle(-4, -(4 + spray * 18), 2.3);
        spout.circle(4, -(6 + spray * 16), 2.1);
        spout.circle(0, -(1 + spray * 10), 1.7);

        spout.fill({
          color: 0xffffff,
          alpha: 0.72 * spray,
        });
      }
    }
  };

  return {
    tick,
    destroy: () => {
      host.destroy({ children: true });
    },
  };
}
export async function createOcean(
  deepOcean: Container,
  waterSurface: Container,
  activePlacement: readonly PlacedNode[] = placement,
) {
  const baseTexture = await Assets.load<Texture>(oceanBaseTileUrl);
  const textures = [makeBroadLight(), makeFineLight(), makeShallowGlow()];

  // Replace the old flat full-world base with a screen-relative
  // perspective presentation of the exact same source texture.
  const perspectiveBase = createPerspectiveOceanBase(baseTexture, deepOcean);

  const glows: Sprite[] = [];

  for (const placed of activePlacement) {
    const glow = new Sprite(textures[2]);
    glow.anchor.set(0.5);
    glow.position.set(placed.targetX, placed.targetY);
    glow.width = 450;
    glow.height = 310;
    glow.alpha = 0.45;
    glows.push(glow);
    deepOcean.addChild(glow);
  }

  const broad = fillWorld(textures[0]);
  const fine = fillWorld(textures[1]);

  waterSurface.addChild(broad, fine);
  const ambientSplashes = await createAmbientWaterSplashes(waterSurface);
  const ambientWhale = createAmbientWhaleCue(waterSurface);

  // Broad/fine reflection overlays stay on the existing world-space path.
  // Only the photographic/illustrated base receives perspective.
  const tiledPlanes = [broad, fine];

  let coverage: OceanCoverage = {
    minX: -EXTENT,
    maxX: EXTENT,
    minY: -EXTENT,
    maxY: EXTENT,
    width: EXTENT * 2,
    height: EXTENT * 2,
  };

  const setWorldBounds = (
    bounds: OceanWorldBounds,
    padding: { x: number; y: number },
  ) => {
    const minX = Math.floor(bounds.minX - padding.x);
    const maxX = Math.ceil(bounds.maxX + padding.x);
    const minY = Math.floor(bounds.minY - padding.y);
    const maxY = Math.ceil(bounds.maxY + padding.y);

    coverage = {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    };

    for (const plane of tiledPlanes) {
      plane.position.set(minX, minY);
      plane.width = coverage.width;
      plane.height = coverage.height;
    }

    return { ...coverage };
  };

  let elapsed = 0;

  const tick = (deltaMs: number) => {
    elapsed += Math.min(deltaMs, 50) / 1000;

    // Re-evaluate against current camera transform every frame.
    // This is what keeps "far = compressed / near = open"
    // attached to the viewport while Pan / Zoom continue to work.
    perspectiveBase.update(elapsed);

    broad.tilePosition.set(
      elapsed * 1.9,
      Math.sin(elapsed * 0.11) * 2.2,
    );

    fine.tilePosition.set(
      -elapsed * 0.65,
      elapsed * 1.15,
    );

    fine.tileRotation = Math.sin(elapsed * 0.17) * 0.003;
    ambientSplashes.tick(elapsed);
    ambientWhale.tick(elapsed);
  };

  return {
    tick,
    setWorldBounds,
    coverage: () => ({ ...coverage }),
    textureSizes: () => ({
      base: OCEAN_BASE_TILE_SIZE,
      broad: 768,
      fine: 1024,
      shallowGlow: 256,
    }),
    destroy: () => {
      perspectiveBase.destroy();
      ambientSplashes.destroy();
      ambientWhale.destroy();
      textures.forEach((texture) => texture.destroy(true));
    },
  };
}



























