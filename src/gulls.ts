import { Container, Graphics } from 'pixi.js';

type Gull = {
  container: Container;
  body: Graphics;
  wings: Graphics;
  scale: number;
  flapPhase: number;
  driftPhase: number;
  bankPhase: number;
  offsetX: number;
  offsetY: number;
};

type FlockState = {
  container: Container;
  gulls: Gull[];
  active: boolean;
  nextSpawnAt: number;
  startTime: number;
  duration: number;
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
  birdCount: number;
};

const clamp = (
  value: number,
  min: number,
  max: number,
) => Math.max(min, Math.min(max, value));

const clamp01 = (
  value: number,
) => clamp(value, 0, 1);

const smoothstep = (
  t: number,
) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

const cubicBezier = (
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
) => {
  const u = 1 - t;

  return (
    u * u * u * p0 +
    3 * u * u * t * p1 +
    3 * u * t * t * p2 +
    t * t * t * p3
  );
};

export function createAmbientGulls(
  ambientActors: Container,
) {
  const host = new Container();
  host.eventMode = 'none';
  ambientActors.addChild(host);

  let seed = 741927;

  const random = () => {
    seed =
      (seed * 1664525 + 1013904223) >>> 0;

    return seed / 4294967296;
  };

  const drawGull = (
    gull: Gull,
    flap: number,
  ) => {
    const body = gull.body;
    const wings = gull.wings;

    body.clear();
    wings.clear();

    body.ellipse(
      0,
      2,
      5.2,
      2.5,
    );

    body.fill({
      color: 0xf8fbfc,
      alpha: 0.94,
    });

    body.circle(
      4.2,
      0.5,
      1.15,
    );

    body.fill({
      color: 0x667b83,
      alpha: 0.82,
    });

    const lift =
      flap * 6.0;

    const leftOuterY =
      -2.0 - lift;

    const rightOuterY =
      -1.4 - lift * 0.84;

    wings.poly(
      [
        -1, 1,
        -8, -1,
        -17, leftOuterY,
        -12, 4,
        -4, 5,
      ],
      true,
    );

    wings.fill({
      color: 0xffffff,
      alpha: 0.97,
    });

    wings.poly(
      [
        1, 1,
        8, -1,
        17, rightOuterY,
        12, 4,
        4, 5,
      ],
      true,
    );

    wings.fill({
      color: 0xffffff,
      alpha: 0.97,
    });

    wings.poly(
      [
        -2, 4,
        -11, 3,
        -15, leftOuterY + 3,
        -9, 6,
      ],
      true,
    );

    wings.fill({
      color: 0xaac2ca,
      alpha: 0.24,
    });

    wings.poly(
      [
        2, 4,
        11, 3,
        15, rightOuterY + 3,
        9, 6,
      ],
      true,
    );

    wings.fill({
      color: 0xaac2ca,
      alpha: 0.24,
    });
  };

  const createFlock = (
    index: number,
  ): FlockState => {
    const container = new Container();
    host.addChild(container);

    const gulls: Gull[] = [];

    for (let i = 0; i < 4; i += 1) {
      const gullContainer =
        new Container();

      gullContainer.visible = false;

      const body =
        new Graphics();

      const wings =
        new Graphics();

      gullContainer.addChild(
        wings,
        body,
      );

      container.addChild(
        gullContainer,
      );

      gulls.push({
        container: gullContainer,
        body,
        wings,
        scale: 1,
        flapPhase:
          random() *
          Math.PI *
          2,
        driftPhase:
          random() *
          Math.PI *
          2,
        bankPhase:
          random() *
          Math.PI *
          2,
        offsetX: 0,
        offsetY: 0,
      });
    }

    return {
      container,
      gulls,
      active: false,
      nextSpawnAt:
        performance.now() / 1000 +
        index * (0.8 + random() * 0.9) +
        random() * 1.6,
      startTime: 0,
      duration: 0,
      startX: 0,
      startY: 0,
      control1X: 0,
      control1Y: 0,
      control2X: 0,
      control2Y: 0,
      endX: 0,
      endY: 0,
      birdCount: 0,
    };
  };

  // 4 independent flock schedulers.
  // In practice you'll often see 2-4 groups staggered.
  const flocks: FlockState[] = [
    createFlock(0),
    createFlock(1),
    createFlock(2),
    createFlock(3),
  ];

  const beginFlock = (
    flock: FlockState,
    now: number,
  ) => {
    const viewportWidth =
      Math.max(
        1,
        window.innerWidth,
      );

    const viewportHeight =
      Math.max(
        1,
        window.innerHeight,
      );

    const matrix =
      ambientActors.worldTransform;

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

    const worldWidth =
      worldRight - worldLeft;

    const worldHeight =
      worldBottom - worldTop;

    // Three main vertical lanes, matching the rough zones in your sketch.
    const laneRatios = [
      0.14,
      0.44,
      0.79,
    ];

    const laneIndex =
      Math.floor(
        random() * laneRatios.length,
      );

    const laneCenterX =
      worldLeft +
      worldWidth * laneRatios[laneIndex];

    // Small horizontal jitter inside the lane.
    const laneJitter =
      (random() - 0.5) *
      worldWidth * 0.08;

    flock.startX =
      laneCenterX + laneJitter;

    flock.endX =
      flock.startX +
      (random() - 0.5) *
      worldWidth * 0.06;

    // Start around the horizon / mountain band,
    // not from the very top of the screen.
    flock.startY =
      worldTop +
      worldHeight *
        (0.18 + random() * 0.08);

    flock.endY =
      worldBottom +
      worldHeight *
        (0.03 + random() * 0.08);

    // Gentle drifting rather than a straight elevator drop.
    flock.control1X =
      flock.startX +
      (random() - 0.5) *
      worldWidth * 0.08;

    flock.control2X =
      flock.endX +
      (random() - 0.5) *
      worldWidth * 0.10;

    flock.control1Y =
      worldTop +
      worldHeight *
        (0.28 + random() * 0.08);

    flock.control2Y =
      worldTop +
      worldHeight *
        (0.60 + random() * 0.12);

    // Slower drift from the horizon band down across the sea.
    flock.duration =
      22 + random() * 12;

    flock.startTime = now;
    flock.active = true;

    // 2-4 birds per flock.
    flock.birdCount =
      2 + Math.floor(random() * 3);

    const formation = [
      { x: 0,   y: 0  },
      { x: 18,  y: 13 },
      { x: -17, y: 18 },
      { x: 10,  y: 30 },
    ];

    flock.gulls.forEach(
      (
        gull,
        index,
      ) => {
        const active =
          index < flock.birdCount;

        gull.container.visible =
          active;

        if (!active) {
          return;
        }

        gull.offsetX =
          formation[index].x +
          (random() - 0.5) * 14;

        gull.offsetY =
          formation[index].y +
          (random() - 0.5) * 12;

        gull.scale =
          0.70 +
          random() * 0.28;

        gull.flapPhase =
          random() *
          Math.PI *
          2;

        gull.driftPhase =
          random() *
          Math.PI *
          2;

        gull.bankPhase =
          random() *
          Math.PI *
          2;
      },
    );
  };

  let animationFrame = 0;

  const tick = () => {
    if (host.destroyed) {
      return;
    }

    const now =
      performance.now() / 1000;

    flocks.forEach(
      flock => {
        if (
          !flock.active &&
          now >= flock.nextSpawnAt
        ) {
          beginFlock(
            flock,
            now,
          );
        }

        if (!flock.active) {
          return;
        }

        const progress =
          clamp01(
            (
              now -
              flock.startTime
            ) /
            flock.duration,
          );

        const travel =
          smoothstep(progress);

        const leaderX =
          cubicBezier(
            flock.startX,
            flock.control1X,
            flock.control2X,
            flock.endX,
            travel,
          );

        const leaderY =
          cubicBezier(
            flock.startY,
            flock.control1Y,
            flock.control2Y,
            flock.endY,
            travel,
          );

        const aheadT =
          Math.min(
            1,
            travel + 0.01,
          );

        const aheadX =
          cubicBezier(
            flock.startX,
            flock.control1X,
            flock.control2X,
            flock.endX,
            aheadT,
          );

        const aheadY =
          cubicBezier(
            flock.startY,
            flock.control1Y,
            flock.control2Y,
            flock.endY,
            aheadT,
          );

        const pathAngle =
          Math.atan2(
            aheadY - leaderY,
            aheadX - leaderX,
          );

        flock.gulls.forEach(
          (
            gull,
            index,
          ) => {
            if (
              index >=
              flock.birdCount
            ) {
              return;
            }

            const flap =
              Math.sin(
                now * 6.2 +
                gull.flapPhase,
              );

            drawGull(
              gull,
              flap,
            );

            const driftX =
              Math.sin(
                now * 0.90 +
                gull.driftPhase,
              ) * 4;

            const driftY =
              Math.sin(
                now * 1.05 +
                gull.driftPhase * 1.3,
              ) * 3;

            gull.container.position.set(
              leaderX +
                gull.offsetX +
                driftX,
              leaderY +
                gull.offsetY +
                driftY,
            );

            gull.container.rotation =
              pathAngle * 0.08 +
              Math.sin(
                now * 0.70 +
                gull.bankPhase,
              ) * 0.04;

            gull.container.scale.set(
              gull.scale,
              gull.scale,
            );

            // No fade-out. They just drift down and leave the screen.
            gull.container.alpha =
              0.92;
          },
        );

        if (progress >= 1) {
          flock.active = false;

          flock.gulls.forEach(
            gull => {
              gull.container.visible =
                false;
            },
          );

          // Random re-entry time per flock.
          flock.nextSpawnAt =
            now +
            1.5 +
            random() * 6.5;
        }
      },
    );

    animationFrame =
      requestAnimationFrame(
        tick,
      );
  };

  animationFrame =
    requestAnimationFrame(
      tick,
    );

  return {
    destroy: () => {
      cancelAnimationFrame(
        animationFrame,
      );

      host.destroy({
        children: true,
      });
    },
  };
}

