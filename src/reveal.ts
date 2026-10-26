import type { Container } from 'pixi.js';
import type { IslandView } from './islands';
import type { PinView } from './pins';

export type RevealState = 'hidden' | 'emerging' | 'revealed';
export type NodeRevealView = { island: IslandView; pin: PinView; localFog: Container; composite?: Container };

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const stage = (elapsed: number, start: number, duration: number) => smooth((elapsed - start) / duration);

export function createNodeReveal(view: NodeRevealView, initial: RevealState = 'revealed') {
  let state = initial;
  let startedAt = 0;

  const apply = (elapsed: number) => {
    const shadow = stage(elapsed, .18, .55);
    const shoreline = stage(elapsed, .42, .65);
    const terrain = stage(elapsed, .65, .7);
    const objects = stage(elapsed, .96, .65);
    const marker = stage(elapsed, 1.34, .42);
    const label = stage(elapsed, 1.58, .46);
    view.island.shadow.alpha = shadow * .98;
    view.island.shoreline.alpha = shoreline;
    view.island.terrain.alpha = terrain;
    view.island.objects.alpha = objects;
    if (view.composite) view.composite.alpha = stage(elapsed, .42, 1.18);
    view.pin.revealAlpha = marker;
    view.pin.halo.alpha *= marker;
    view.pin.marker.alpha = marker;
    view.pin.label.alpha = label;
    view.pin.root.eventMode = marker > .72 ? 'static' : 'none';
    view.pin.root.cursor = marker > .72 ? 'pointer' : 'default';
    view.localFog.alpha = .22 + .78 * (1 - stage(elapsed, .12, 1.9));
  };

  const setHidden = () => {
    state = 'hidden';
    apply(-1);
  };
  const reveal = (seconds: number) => {
    if (state !== 'hidden') return;
    state = 'emerging';
    startedAt = seconds;
  };
  const update = (seconds: number) => {
    if (state !== 'emerging') return;
    const elapsed = seconds - startedAt;
    apply(elapsed);
    if (elapsed >= 2.08) {
      state = 'revealed';
      apply(2.08);
    }
  };
  const show = () => {
    state = 'revealed';
    apply(2.08);
    view.localFog.alpha = 0;
  };
  if (initial === 'hidden') setHidden(); else show();
  return {
    reveal,
    update,
    getState: () => state,
    snapshot: () => ({
      state,
      shadowAlpha: view.island.shadow.alpha,
      shorelineAlpha: view.island.shoreline.alpha,
      terrainAlpha: view.island.terrain.alpha,
      objectAlpha: view.island.objects.alpha,
      pinAlpha: view.pin.marker.alpha,
      labelAlpha: view.pin.label.alpha,
      fogAlpha: view.localFog.alpha,
      interactive: view.pin.root.eventMode === 'static',
    }),
  };
}
