import { Circle, Container, Graphics, Text } from 'pixi.js';
import type { NodeFlags, SemanticNode } from './model';

export type PinView = {
  id: string;
  root: Container;
  halo: Graphics;
  marker: Container;
  selectedRing: Graphics;
  decoration: Graphics;
  label: Text;
  phase: number;
  period: number;
  visualScale: number;
  hit: Circle;
  color: number;
  revealAlpha: number;
  fullTitle: string;
  compactTitle: string;
};

const palette: Record<SemanticNode['visualTheme'], number> = {
  coral: 0xe67879, research: 0x279ba3, garden: 0x6ea77f, harbor: 0x739aaa,
};
const recipePalette: Record<string, number> = {
  warm_red_white: 0xd85e55,
  warm_cream_terracotta: 0xc86f4f,
  green_amber: 0xd79545,
  ocean_teal: 0x4a9eb1,
};
const SAFE_RECIPE_ACCENT = 0x5d9ca8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function identityNumber(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function compactIslandTitle(title: string, maxCharacters = 13) {
  const compact = title.replace(/\s+/g, '').trim();
  const characters = [...compact];
  return characters.length > maxCharacters ? `${characters.slice(0, maxCharacters).join('')}…` : compact;
}

export function createPin(node: SemanticNode, x: number, y: number, onSelect: (id: string) => void): PinView {
  const root = new Container();
  root.position.set(x, y);
  root.eventMode = 'static';
  root.cursor = 'pointer';
  const hit = new Circle(0, 0, 24);
  root.hitArea = hit;
  root.on('pointertap', () => onSelect(node.id));

  const halo = new Graphics().circle(0, 0, 22).fill({ color: 0xffffff, alpha: 0.7 });
  const marker = new Container();
  const color = node.visualRecipe
    ? recipePalette[node.visualRecipe.accentPalette] ?? SAFE_RECIPE_ACCENT
    : palette[node.visualTheme];
  const shape = new Graphics().circle(0, 0, 15).fill(color)
    .circle(0, 0, 7).fill(0xffffff).circle(0, 0, 2.8).fill(color);
  marker.addChild(shape);
  const selectedRing = new Graphics().circle(0, 0, 18.5).stroke({ color: 0xffffff, width: 2.3, alpha: 0.9 });
  marker.addChild(selectedRing);
  const decoration = new Graphics();
  marker.addChild(decoration);

  const compactTitle = compactIslandTitle(node.title);
  const label = new Text({
    text: compactTitle,
    style: {
      fontFamily: 'Arial, "Noto Sans JP", sans-serif', fontSize: 13, fill: 0x153b56, fontWeight: 'bold',
      align: 'center', breakWords: true, wordWrap: true, wordWrapWidth: 150, lineHeight: 17,
    },
  });
  label.anchor.set(0.5, 0);
  label.position.set(0, 25);
  label.eventMode = 'none';
  root.addChild(halo, marker, label);
  const identity = identityNumber(node.id);
  return { id: node.id, root, halo, marker, selectedRing, decoration, label, phase: identity / 4294967296 * Math.PI * 2, period: 2.2 + (identity % 6) * 0.12, visualScale: 1, hit, color, revealAlpha: 1, fullTitle: node.title, compactTitle };
}

export function setPinState(pin: PinView, selected: boolean, flags: NodeFlags) {
  pin.selectedRing.visible = selected;
  pin.label.text = selected ? pin.fullTitle : pin.compactTitle;
  pin.label.style.fontSize = selected ? 15 : 13;
  pin.label.style.wordWrapWidth = selected ? 230 : 150;
  pin.decoration.clear();
  if (flags.kept) {
    pin.decoration.moveTo(10, -13).lineTo(14, -13).lineTo(14, -5).lineTo(12, -7).lineTo(10, -5).closePath()
      .fill(0xf9e0a5);
  }
  if (flags.visited) {
    pin.decoration.circle(0, 20, 2.8).fill({ color: 0x356c76, alpha: 0.7 });
  }
  pin.halo.alpha = selected ? 0.19 : 0.11;
}

export function resolvePinLabelCollisions(pins: readonly PinView[], camera: { x: number; y: number; zoom: number }, width: number, height: number) {
  const candidates = pins.filter((pin) => pin.label.visible).map((pin) => {
    const centerX = width / 2 + (pin.root.x + pin.label.x - camera.x) * camera.zoom;
    const top = height / 2 + (pin.root.y + pin.label.y - camera.y) * camera.zoom;
    const labelWidth = pin.label.width * camera.zoom;
    const labelHeight = pin.label.height * camera.zoom;
    return {
      pin,
      selected: pin.selectedRing.visible,
      screenY: height / 2 + (pin.root.y - camera.y) * camera.zoom,
      rect: { left: centerX - labelWidth / 2, right: centerX + labelWidth / 2, top, bottom: top + labelHeight },
    };
  }).sort((left, right) => Number(right.selected) - Number(left.selected) || right.screenY - left.screenY);
  const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const candidate of candidates) {
    const overlaps = occupied.some((rect) => candidate.rect.left < rect.right + 10
      && candidate.rect.right > rect.left - 10
      && candidate.rect.top < rect.bottom + 7
      && candidate.rect.bottom > rect.top - 7);
    candidate.pin.label.visible = !overlaps;
    if (!overlaps) occupied.push(candidate.rect);
  }
  return occupied.length;
}

export function placePinPresentation(pin: PinView, camera: { x: number; y: number; zoom: number }, width: number, height: number) {
  const zoom = camera.zoom;
  pin.visualScale = clamp(0.88 / zoom, 0.48, 1.4);
  pin.halo.scale.set(pin.visualScale);
  pin.hit.radius = 21 / zoom; // Constant 42 px diameter, independent of the breathing visual.
  pin.label.scale.set(clamp(0.82 / zoom, 0.45, 1.4));

  const screenX = width / 2 + (pin.root.x - camera.x) * zoom;
  const screenY = height / 2 + (pin.root.y - camera.y) * zoom;
  const halfWidth = pin.label.width * zoom / 2;
  const desiredCenter = clamp(screenX, 9 + halfWidth, width - 9 - halfWidth);
  pin.label.x = clamp(desiredCenter - screenX, -56, 56) / zoom;
  // Labels near fixed chrome yield quietly; the marker and its world position remain untouched.
  const safeTop = width < 700 ? 126 : 136;
  const labelBottom = screenY + (25 + pin.label.height) * zoom;
  const bottomLimit = width < 700 || screenX > width - 448 ? height - 194 : height - 20;
  pin.label.visible = screenX >= 0 && screenX <= width && screenY >= safeTop && labelBottom <= bottomLimit;
}

export function updatePinBreath(pin: PinView, seconds: number) {
  const pulse = (1 + Math.sin(seconds * Math.PI * 2 / pin.period + pin.phase)) / 2;
  pin.marker.scale.set(pin.visualScale * (1 + 0.035 * pulse));
  pin.halo.scale.set(pin.visualScale * (1 + 0.012 * pulse));
  pin.halo.alpha = ((pin.selectedRing.visible ? 0.17 : 0.09) + 0.035 * pulse) * pin.revealAlpha;
}
