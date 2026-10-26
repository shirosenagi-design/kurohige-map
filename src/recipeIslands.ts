import { Container, Graphics } from 'pixi.js';
import type { VisualRecipe } from './model';
import type { IslandMotion, IslandView, MotionProfile } from './islands';
import {
  VISUAL_VOCABULARY,
  createVocabularyLookup,
  type ArchitectureKey,
  type FoundationKey,
  type MotifKey,
  type PaletteKey,
  type SecondaryKey,
  type ThemeFamily,
} from './visualVocabulary';

type Point = readonly [number, number];

type Palette = {
  sand: number;
  earth: number;
  cliff: number;
  grass: number;
  lightGrass: number;
  accent: number;
  accentLight: number;
  structure: number;
};

export type NormalizedVisualRecipe = {
  themeFamily: ThemeFamily;
  dominantMotif: MotifKey;
  secondaryObjects: SecondaryKey[];
  foundation: FoundationKey;
  paletteKey: PaletteKey;
  density: VisualRecipe['density'];
  openness: VisualRecipe['openness'];
  landmarkEmphasis: VisualRecipe['landmarkEmphasis'];
  energyLevel: VisualRecipe['energyLevel'];
};

export type RecipeFallback = {
  field: string;
  input: unknown;
  output: unknown;
  reason: 'unsupported' | 'invalid' | 'duplicate' | 'generic';
};

export type VisualRecipeDiagnostics = {
  normalized: NormalizedVisualRecipe;
  fallbacks: RecipeFallback[];
  dropped: {
    secondaryObjects: string[];
    duplicateSecondaryObjects: string[];
  };
  unsupported: {
    dominantMotif: string | null;
    secondaryObjects: string[];
  };
  resolution: {
    visualTheme: { input: string; output: ThemeFamily; usedFallback: boolean };
    terrain: { input: string; output: FoundationKey; usedFallback: boolean };
    palette: { input: string; output: PaletteKey; usedFallback: boolean };
    architecture: { output: ArchitectureKey; source: 'dominantMotif' | 'visualTheme' | 'generic'; usedFallback: boolean };
    landmark: { output: MotifKey; usedFallback: boolean };
  };
  selectedParts: {
    foundation: FoundationKey;
    architecture: ArchitectureKey;
    landmark: MotifKey;
    secondaryObjects: SecondaryKey[];
  };
};

const foundations: Record<FoundationKey, { outline: readonly Point[]; depth: number }> = {
  flat: {
    outline: [[-1, -.08], [-.79, -.5], [-.35, -.69], [.12, -.64], [.62, -.58], [1, -.14], [.89, .38], [.5, .68], [-.05, .72], [-.57, .59], [-.94, .3]],
    depth: 38,
  },
  organic: {
    outline: [[-1, -.16], [-.76, -.63], [-.31, -.79], [.16, -.65], [.7, -.78], [1, -.2], [.87, .42], [.46, .84], [-.13, .91], [-.66, .58], [-.94, .2]],
    depth: 44,
  },
  raised: {
    outline: [[-1, -.03], [-.82, -.53], [-.45, -.88], [-.03, -.79], [.36, -.98], [.76, -.57], [1, -.08], [.77, .62], [.23, .87], [-.31, .74], [-.79, .45]],
    depth: 51,
  },
  generic: {
    outline: [[-1, -.12], [-.8, -.56], [-.37, -.78], [.08, -.72], [.57, -.69], [1, -.16], [.84, .48], [.4, .79], [-.12, .84], [-.62, .61], [-.96, .25]],
    depth: 45,
  },
};

const palettes: Record<PaletteKey, Palette> = {
  warm_red_white: { sand: 0xffedb1, earth: 0xc0754b, cliff: 0xebaa71, grass: 0x78df5b, lightGrass: 0xe3f47a, accent: 0xff5848, accentLight: 0xffd98f, structure: 0xfff8df },
  warm_cream_terracotta: { sand: 0xffefba, earth: 0xc07f53, cliff: 0xeaab6d, grass: 0x79dc5e, lightGrass: 0xe0f37b, accent: 0xf66c43, accentLight: 0xffd783, structure: 0xfff7dd },
  green_amber: { sand: 0xfff0b9, earth: 0x879f52, cliff: 0xcdd36d, grass: 0x6edf5f, lightGrass: 0xdcf475, accent: 0xf6b33a, accentLight: 0xffdf84, structure: 0xf8f6d8 },
  ocean_teal: { sand: 0xfff0bb, earth: 0x5f9f82, cliff: 0xbcd996, grass: 0x68dd84, lightGrass: 0xd6f585, accent: 0x35d2ea, accentLight: 0xd8fdff, structure: 0xf9f9df },
  safe: { sand: 0xffefb9, earth: 0x90a55d, cliff: 0xd4cf79, grass: 0x78d86c, lightGrass: 0xdff47f, accent: 0x4ecedf, accentLight: 0xd9faf2, structure: 0xfcf7df },
};

const themeAliases = createVocabularyLookup(VISUAL_VOCABULARY.themes);
const motifAliases = createVocabularyLookup(VISUAL_VOCABULARY.dominantMotifs);
const terrainAliases = createVocabularyLookup(VISUAL_VOCABULARY.terrainProfiles);
const paletteAliases = createVocabularyLookup(VISUAL_VOCABULARY.palettes);
const secondaryAliases = createVocabularyLookup(VISUAL_VOCABULARY.secondaryObjects);

const architectureByMotif: Record<MotifKey, ArchitectureKey> = {
  running_track: 'pavilion',
  bakery_workshop: 'workshop',
  insect_observation: 'research',
  observatory: 'research',
  camera: 'workshop',
  windmill: 'greenhouse',
  tent: 'shelter',
  shelter: 'shelter',
  firepit: 'shelter',
  campsite_marker: 'shelter',
  stage: 'stage',
  speaker_stack: 'stage',
  amplifier: 'stage',
  light_rig: 'stage',
  audience_area: 'stage',
  road_vehicle: 'passenger_shelter',
  road_loop: 'passenger_shelter',
  transit_stop: 'passenger_shelter',
  route_board: 'passenger_shelter',
  package_stack: 'workshop',
  guide_marker: 'passenger_shelter',
  tour_map: 'passenger_shelter',
  meeting_point: 'pavilion',
  passenger_shelter: 'passenger_shelter',
  observation_box: 'research',
  binoculars: 'research',
  observation_marker: 'research',
  generic: 'pavilion',
};

const architectureByTheme: Record<ThemeFamily, ArchitectureKey> = {
  athletics: 'pavilion', food_craft: 'workshop', field_science: 'research', creative: 'workshop',
  research: 'research', cultivation: 'greenhouse', culture: 'pavilion', outdoor_recreation: 'shelter',
  performance: 'stage', transport: 'passenger_shelter', guided_experience: 'passenger_shelter',
  observation: 'research', generic: 'pavilion',
};

const safeEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
const lookupKey = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function normalizeVisualRecipe(recipe: VisualRecipe): NormalizedVisualRecipe {
  const themeFamily = themeAliases[lookupKey(recipe.visualTheme)] ?? 'generic';
  const dominantMotif = motifAliases[lookupKey(recipe.dominantMotif)] ?? 'generic';
  const rawSecondaryObjects: unknown[] = Array.isArray(recipe.secondaryObjects) ? recipe.secondaryObjects : [];
  const secondaryObjects = [...new Set(rawSecondaryObjects
    .map((item) => secondaryAliases[lookupKey(item)])
    .filter((item): item is SecondaryKey => item !== undefined))];
  return {
    themeFamily,
    dominantMotif,
    secondaryObjects,
    foundation: terrainAliases[lookupKey(recipe.terrainProfile)] ?? 'generic',
    paletteKey: paletteAliases[lookupKey(recipe.accentPalette)] ?? 'safe',
    density: safeEnum(recipe.density, ['sparse', 'medium', 'dense'], 'medium'),
    openness: safeEnum(recipe.openness, ['open', 'balanced', 'compact'], 'balanced'),
    landmarkEmphasis: safeEnum(recipe.landmarkEmphasis, ['low', 'medium', 'high'], 'medium'),
    energyLevel: safeEnum(recipe.energyLevel, ['calm', 'moderate', 'high'], 'moderate'),
  };
}

export function diagnoseVisualRecipe(recipe: VisualRecipe): VisualRecipeDiagnostics {
  const normalized = normalizeVisualRecipe(recipe);
  const fallbacks: RecipeFallback[] = [];
  const rawTheme = lookupKey(recipe.visualTheme);
  const rawMotif = lookupKey(recipe.dominantMotif);
  const rawTerrain = lookupKey(recipe.terrainProfile);
  const rawPalette = lookupKey(recipe.accentPalette);
  const themeSupported = themeAliases[rawTheme] !== undefined || rawTheme === 'generic';
  const motifSupported = motifAliases[rawMotif] !== undefined || rawMotif === 'generic';
  const terrainSupported = terrainAliases[rawTerrain] !== undefined;
  const paletteSupported = paletteAliases[rawPalette] !== undefined || rawPalette === 'safe';

  if (!themeSupported) fallbacks.push({ field: 'visualTheme', input: recipe.visualTheme, output: 'generic', reason: 'unsupported' });
  if (!motifSupported) fallbacks.push({ field: 'dominantMotif', input: recipe.dominantMotif, output: 'generic', reason: 'unsupported' });
  if (!terrainSupported) fallbacks.push({ field: 'terrainProfile', input: recipe.terrainProfile, output: 'generic', reason: 'unsupported' });
  if (!paletteSupported) fallbacks.push({ field: 'accentPalette', input: recipe.accentPalette, output: 'safe', reason: 'unsupported' });

  const unsupportedSecondaryObjects: string[] = [];
  const duplicateSecondaryObjects: string[] = [];
  const seenSecondaryObjects = new Set<SecondaryKey>();
  const rawSecondaryObjects: unknown[] = Array.isArray(recipe.secondaryObjects) ? recipe.secondaryObjects : [];
  for (const item of rawSecondaryObjects) {
    const resolved = secondaryAliases[lookupKey(item)];
    if (!resolved) {
      const value = typeof item === 'string' ? item : String(item);
      unsupportedSecondaryObjects.push(value);
      fallbacks.push({ field: 'secondaryObjects', input: value, output: null, reason: 'unsupported' });
    } else if (seenSecondaryObjects.has(resolved)) {
      const value = typeof item === 'string' ? item : String(item);
      duplicateSecondaryObjects.push(value);
      fallbacks.push({ field: 'secondaryObjects', input: value, output: resolved, reason: 'duplicate' });
    } else {
      seenSecondaryObjects.add(resolved);
    }
  }

  const enumFields = [
    ['density', recipe.density, normalized.density, ['sparse', 'medium', 'dense']],
    ['openness', recipe.openness, normalized.openness, ['open', 'balanced', 'compact']],
    ['landmarkEmphasis', recipe.landmarkEmphasis, normalized.landmarkEmphasis, ['low', 'medium', 'high']],
    ['energyLevel', recipe.energyLevel, normalized.energyLevel, ['calm', 'moderate', 'high']],
  ] as const;
  for (const [field, input, output, allowed] of enumFields) {
    if (!(allowed as readonly string[]).includes(input)) fallbacks.push({ field, input, output, reason: 'invalid' });
  }

  const architectureSource = normalized.dominantMotif !== 'generic'
    ? 'dominantMotif'
    : normalized.themeFamily !== 'generic' ? 'visualTheme' : 'generic';
  const architecture = normalized.dominantMotif === 'generic'
    ? architectureByTheme[normalized.themeFamily]
    : architectureByMotif[normalized.dominantMotif];
  if (normalized.dominantMotif === 'generic') {
    fallbacks.push({ field: 'architecture', input: recipe.dominantMotif, output: architecture, reason: 'generic' });
    fallbacks.push({ field: 'landmark', input: recipe.dominantMotif, output: 'generic', reason: 'generic' });
  }

  return {
    normalized,
    fallbacks,
    dropped: {
      secondaryObjects: [...unsupportedSecondaryObjects, ...duplicateSecondaryObjects],
      duplicateSecondaryObjects,
    },
    unsupported: {
      dominantMotif: motifSupported ? null : recipe.dominantMotif,
      secondaryObjects: unsupportedSecondaryObjects,
    },
    resolution: {
      visualTheme: { input: recipe.visualTheme, output: normalized.themeFamily, usedFallback: !themeSupported },
      terrain: { input: recipe.terrainProfile, output: normalized.foundation, usedFallback: !terrainSupported },
      palette: { input: recipe.accentPalette, output: normalized.paletteKey, usedFallback: !paletteSupported },
      architecture: { output: architecture, source: architectureSource, usedFallback: normalized.dominantMotif === 'generic' },
      landmark: { output: normalized.dominantMotif, usedFallback: normalized.dominantMotif === 'generic' },
    },
    selectedParts: {
      foundation: normalized.foundation,
      architecture,
      landmark: normalized.dominantMotif,
      secondaryObjects: normalized.secondaryObjects,
    },
  };
}

const X_RADIUS = 116;
const Y_RADIUS = 58;

function blob(graphics: Graphics, outline: readonly Point[], xScale: number, yScale: number, yOffset: number, color: number, alpha = 1) {
  const points = outline.map(([x, y]) => ({ x: x * X_RADIUS * xScale, y: y * Y_RADIUS * yScale + yOffset }));
  const start = points[0];
  const previous = points[points.length - 1];
  graphics.moveTo((previous.x + start.x) / 2, (previous.y + start.y) / 2);
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    graphics.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  graphics.closePath().fill({ color, alpha });
}

function makeTree(x: number, y: number, scale: number, palette: Palette) {
  const root = new Container();
  root.position.set(x, y);
  root.scale.set(scale);
  root.label = 'vegetation-tree';
  root.addChild(
    new Graphics().ellipse(4, 3, 11, 4).fill({ color: 0x345f55, alpha: .15 }),
    new Graphics().roundRect(-2, -14, 4, 17, 1).fill(0x95745a),
    new Graphics().circle(-5, -21, 9).fill(palette.grass)
      .circle(5, -23, 10).fill(palette.lightGrass)
      .circle(0, -30, 9).fill(palette.grass)
      .circle(-4, -32, 3).fill({ color: 0xe4f1bb, alpha: .55 }),
  );
  return root;
}

function buildFoundation(normalized: NormalizedVisualRecipe, palette: Palette) {
  const shadow = new Container();
  const shoreline = new Container();
  const terrain = new Container();
  const { outline, depth } = foundations[normalized.foundation];

  const contact = new Graphics();
  blob(contact, outline, 1.2, 1.25, depth + 18, 0x248eab, .13);
  blob(contact, outline, 1.12, 1.16, depth + 12, 0x155f7d, .17);
  shadow.addChild(contact);

  const shore = new Graphics();
  blob(shore, outline, 1.11, 1.13, 15, 0xa9e5da, .5);
  blob(shore, outline, 1.04, 1.06, depth + 10, palette.earth);
  blob(shore, outline, 1.025, 1.035, depth - 2, palette.cliff);
  blob(shore, outline, 1.01, 1.01, 9, palette.sand);
  shoreline.addChild(shore);

  const faces = new Graphics()
    .moveTo(-94, 35).lineTo(-47, 59).lineTo(-51, depth + 61).lineTo(-99, depth + 42).closePath().fill({ color: palette.earth, alpha: .73 })
    .moveTo(-47, 59).lineTo(13, 69).lineTo(5, depth + 66).lineTo(-51, depth + 61).closePath().fill({ color: palette.earth, alpha: .86 })
    .moveTo(13, 69).lineTo(91, 39).lineTo(91, depth + 42).lineTo(5, depth + 66).closePath().fill({ color: palette.cliff, alpha: .78 });
  shoreline.addChild(faces);

  const land = new Graphics();
  blob(land, outline, .87, .78, -11, palette.grass);
  const opennessScale = normalized.openness === 'open' ? 1.25 : normalized.openness === 'compact' ? .78 : 1;
  land.ellipse(-34 * opennessScale, -23, 40, 16).fill({ color: palette.lightGrass, alpha: .42 });
  land.ellipse(43 * opennessScale, -10, 31, 14).fill({ color: palette.lightGrass, alpha: .25 });
  terrain.addChild(land);

  const raised = new Graphics();
  const raisedScale = normalized.foundation === 'raised' ? 1 : normalized.foundation === 'flat' ? .72 : .86;
  raised.ellipse(7, -26, 61 * raisedScale, 22 * raisedScale).fill(palette.cliff);
  raised.ellipse(7, -33, 57 * raisedScale, 19 * raisedScale).fill(palette.lightGrass);
  terrain.addChild(raised);

  const foam = new Graphics()
    .moveTo(-113, 25).quadraticCurveTo(-94, 8, -75, 10).stroke({ color: 0xecfffa, width: 2, alpha: .43 })
    .moveTo(82, 31).quadraticCurveTo(110, 25, 119, 41).stroke({ color: 0xecfffa, width: 2, alpha: .36 });
  terrain.addChild(foam);
  return { shadow, shoreline, terrain };
}

function addVegetation(objects: Container, normalized: NormalizedVisualRecipe, palette: Palette) {
  const count = normalized.density === 'dense' ? 6 : normalized.density === 'medium' ? 4 : 2;
  const spread = normalized.openness === 'open' ? 1.12 : normalized.openness === 'compact' ? .76 : .94;
  const positions: readonly Point[] = [[-78, -4], [79, -2], [-59, -31], [65, -29], [-91, 18], [92, 18]];
  for (let index = 0; index < count; index++) {
    const [x, y] = positions[index];
    objects.addChild(makeTree(x * spread, y, .5 + (index % 3) * .08, palette));
  }
}

function workshop(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-workshop';
  group.addChild(new Graphics()
    .ellipse(3, 3, 30, 7).fill({ color: 0x4b7065, alpha: .18 })
    .rect(-25, -27, 50, 29).fill(palette.structure)
    .moveTo(-31, -27).lineTo(0, -49).lineTo(32, -27).closePath().fill(palette.accent)
    .moveTo(0, -49).lineTo(32, -27).lineTo(26, -21).lineTo(0, -40).closePath().fill({ color: palette.earth, alpha: .48 })
    .rect(-6, -15, 12, 17).fill(0x78a3a3)
    .rect(12, -18, 8, 8).fill(palette.accentLight));
  return group;
}

function researchStructure(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-research';
  group.addChild(new Graphics()
    .ellipse(0, 3, 31, 7).fill({ color: 0x416e65, alpha: .18 })
    .roundRect(-28, -25, 56, 27, 4).fill(palette.structure)
    .ellipse(0, -29, 24, 16).fill(0xdff3eb)
    .ellipse(0, -31, 17, 9).fill(palette.accentLight)
    .rect(-4, -44, 8, 13).fill(0x7e9fa0)
    .circle(0, -46, 4).fill(palette.accent));
  return group;
}

function greenhouse(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-greenhouse';
  group.addChild(new Graphics()
    .rect(-28, -24, 56, 25).fill({ color: 0xdff4df, alpha: .9 })
    .moveTo(-32, -24).lineTo(0, -49).lineTo(32, -24).closePath().fill({ color: palette.accentLight, alpha: .75 })
    .moveTo(0, -48).lineTo(0, 0).stroke({ color: 0xffffff, width: 2 })
    .rect(-20, -15, 9, 15).fill(palette.grass));
  return group;
}

function pavilion(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-pavilion';
  group.addChild(new Graphics()
    .rect(-24, -31, 6, 31).fill(palette.structure)
    .rect(18, -31, 6, 31).fill(palette.structure)
    .moveTo(-33, -31).lineTo(0, -48).lineTo(33, -31).closePath().fill(palette.accent)
    .rect(-29, -34, 58, 5).fill(palette.accentLight));
  return group;
}

function campShelter(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-shelter';
  group.addChild(new Graphics()
    .ellipse(0, 4, 34, 8).fill({ color: 0x426c60, alpha: .16 })
    .moveTo(-31, -3).lineTo(-19, -34).lineTo(19, -34).lineTo(31, -3).closePath().fill(palette.accentLight)
    .moveTo(-19, -34).lineTo(0, -48).lineTo(19, -34).closePath().fill(palette.accent)
    .rect(-23, -5, 5, 10).fill(0x7e6854)
    .rect(18, -5, 5, 10).fill(0x7e6854));
  return group;
}

function performanceStage(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-stage';
  group.addChild(new Graphics()
    .ellipse(0, 4, 37, 8).fill({ color: 0x426c60, alpha: .17 })
    .rect(-31, -23, 62, 25).fill(0x4d5b64)
    .rect(-35, -28, 70, 6).fill(palette.accent)
    .rect(-25, -18, 50, 15).fill({ color: palette.accentLight, alpha: .52 })
    .rect(-28, -43, 4, 20).fill(0x718487)
    .rect(24, -43, 4, 20).fill(0x718487)
    .moveTo(-28, -42).lineTo(28, -42).stroke({ color: 0xe9f2e6, width: 3 }));
  return group;
}

function passengerShelter(palette: Palette) {
  const group = new Container();
  group.label = 'architecture-passenger-shelter';
  group.addChild(new Graphics()
    .ellipse(0, 4, 34, 7).fill({ color: 0x426c60, alpha: .16 })
    .roundRect(-29, -30, 58, 31, 4).fill({ color: palette.structure, alpha: .9 })
    .rect(-24, -25, 48, 20).fill({ color: palette.accentLight, alpha: .42 })
    .rect(-34, -34, 68, 7).fill(palette.accent)
    .rect(-22, -3, 44, 5).fill(0x8d6d55));
  return group;
}

function addArchitecture(objects: Container, normalized: NormalizedVisualRecipe, palette: Palette) {
  const key = normalized.dominantMotif === 'generic'
    ? architectureByTheme[normalized.themeFamily]
    : architectureByMotif[normalized.dominantMotif];
  const factories: Record<ArchitectureKey, (colors: Palette) => Container> = {
    workshop,
    research: researchStructure,
    greenhouse,
    pavilion,
    shelter: campShelter,
    stage: performanceStage,
    passenger_shelter: passengerShelter,
  };
  const part = factories[key](palette);
  const x = normalized.openness === 'open' ? 63 : normalized.openness === 'compact' ? -25 : -45;
  part.position.set(x, -8);
  part.scale.set(normalized.openness === 'compact' ? .82 : .74);
  objects.addChild(part);
}

function addLandmark(objects: Container, normalized: NormalizedVisualRecipe, palette: Palette) {
  const group = new Container();
  group.label = `landmark-${normalized.dominantMotif}`;
  const emphasis = normalized.landmarkEmphasis === 'high' ? 1.16 : normalized.landmarkEmphasis === 'low' ? .82 : 1;
  group.scale.set(emphasis);
  group.position.set(normalized.openness === 'compact' ? 14 : -4, normalized.openness === 'open' ? -8 : -15);
  let target: Container = group;
  let kind: MotionProfile['kind'] = 'light';
  const motifIs = (...keys: MotifKey[]) => keys.includes(normalized.dominantMotif);

  if (normalized.dominantMotif === 'running_track') {
    group.addChild(new Graphics()
      .ellipse(0, 2, 54, 24).fill({ color: palette.accentLight, alpha: .46 })
      .ellipse(0, 2, 50, 21).stroke({ color: palette.accent, width: 5 })
      .ellipse(0, 2, 39, 14).stroke({ color: 0xffffff, width: 2, alpha: .9 })
      .moveTo(-5, -19).lineTo(-5, 23).stroke({ color: 0xffffff, width: 2 }));
    const flag = new Graphics().moveTo(0, 0).lineTo(0, -28).stroke({ color: 0x795f55, width: 2 })
      .moveTo(0, -28).lineTo(17, -23).lineTo(0, -17).closePath().fill(palette.accent);
    flag.position.set(9, -8);
    group.addChild(flag);
    target = flag;
  } else if (normalized.dominantMotif === 'bakery_workshop') {
    const sign = new Graphics().circle(0, -20, 17).fill(palette.accentLight)
      .circle(0, -20, 14).stroke({ color: palette.accent, width: 3 })
      .moveTo(-8, -20).quadraticCurveTo(0, -31, 8, -20).quadraticCurveTo(0, -11, -8, -20).fill(palette.accent)
      .rect(-2, -4, 4, 22).fill(0x896c55);
    group.position.x = 22;
    group.addChild(sign);
    target = sign;
  } else if (normalized.dominantMotif === 'insect_observation') {
    group.addChild(new Graphics()
      .roundRect(-22, -22, 44, 28, 5).fill(palette.structure)
      .rect(-15, -15, 30, 15).fill({ color: palette.accentLight, alpha: .7 })
      .circle(-5, -9, 4).fill(palette.accent)
      .circle(6, -7, 3).fill(0x5a745b));
    const lens = new Graphics().circle(0, 0, 13).stroke({ color: palette.accent, width: 5 })
      .moveTo(10, 10).lineTo(24, 24).stroke({ color: 0x755f50, width: 5 });
    lens.position.set(21, -31);
    group.addChild(lens);
    target = lens;
    kind = 'scan';
  } else if (normalized.dominantMotif === 'observatory') {
    group.addChild(new Graphics().moveTo(0, 8).lineTo(0, -47).stroke({ color: 0x7899a5, width: 3 }));
    const antenna = new Graphics().moveTo(-13, 12).lineTo(13, 12).stroke({ color: palette.accent, width: 3 }).circle(0, 0, 5).fill(palette.accentLight);
    antenna.position.set(0, -49);
    group.addChild(antenna);
    target = antenna;
    kind = 'scan';
  } else if (normalized.dominantMotif === 'camera') {
    const camera = new Graphics().roundRect(-24, -22, 48, 31, 5).fill(0x56788b)
      .circle(0, -7, 11).fill(palette.accentLight).circle(0, -7, 6).fill(palette.accent)
      .rect(-10, -29, 20, 8).fill(palette.accent);
    group.addChild(camera);
    target = camera;
  } else if (normalized.dominantMotif === 'windmill') {
    group.addChild(new Graphics().moveTo(-8, 10).lineTo(-2, -37).lineTo(7, 10).closePath().fill(palette.structure));
    const rotor = new Graphics().moveTo(0, 0).lineTo(0, -24).stroke({ color: 0xfff7e4, width: 5 })
      .moveTo(0, 0).lineTo(24, 0).stroke({ color: 0xfff7e4, width: 5 })
      .moveTo(0, 0).lineTo(-17, 16).stroke({ color: 0xfff7e4, width: 5 }).circle(0, 0, 5).fill(palette.accent);
    rotor.position.set(-2, -36);
    group.addChild(rotor);
    target = rotor;
    kind = 'rotation';
  } else if (motifIs('tent', 'shelter', 'firepit', 'campsite_marker')) {
    const camp = new Graphics()
      .moveTo(-32, 5).lineTo(-12, -31).lineTo(11, 5).closePath().fill(palette.accent)
      .moveTo(-12, -31).lineTo(29, 5).lineTo(11, 5).closePath().fill(palette.accentLight)
      .moveTo(-12, -31).lineTo(-12, 5).stroke({ color: 0xfff1d7, width: 2 });
    if (normalized.dominantMotif === 'firepit') {
      camp.circle(31, 2, 13).fill(0x8b705b)
        .moveTo(24, 2).quadraticCurveTo(30, -20, 36, 2).quadraticCurveTo(31, 12, 24, 2).fill(0xf59b55)
        .moveTo(28, 2).quadraticCurveTo(32, -11, 35, 2).quadraticCurveTo(32, 7, 28, 2).fill(0xffe49a);
    } else if (normalized.dominantMotif === 'campsite_marker') {
      camp.rect(24, -26, 25, 17).fill(palette.structure).rect(34, -9, 4, 19).fill(0x80664e)
        .moveTo(28, -18).lineTo(43, -18).stroke({ color: palette.accent, width: 3 });
    }
    group.addChild(camp);
    target = camp;
  } else if (motifIs('stage', 'speaker_stack', 'amplifier', 'light_rig', 'audience_area')) {
    const performance = new Graphics()
      .rect(-37, -25, 74, 31).fill(0x53616b)
      .rect(-42, -30, 84, 7).fill(palette.accent)
      .rect(-31, -17, 15, 25).fill(0x334953).circle(-23, -10, 5).fill(palette.accentLight).circle(-23, 1, 6).fill(palette.accent)
      .rect(16, -17, 15, 25).fill(0x334953).circle(23, -10, 5).fill(palette.accentLight).circle(23, 1, 6).fill(palette.accent)
      .moveTo(0, -18).lineTo(0, 4).stroke({ color: 0xe8efe6, width: 2 }).circle(0, -20, 4).fill(palette.accentLight);
    if (normalized.dominantMotif === 'light_rig') {
      performance.moveTo(-31, -43).lineTo(31, -43).stroke({ color: 0x849a9c, width: 3 })
        .circle(-22, -39, 6).fill(0xffd98b).circle(0, -39, 6).fill(0xffb6a5).circle(22, -39, 6).fill(0xaeeaf0);
    }
    group.addChild(performance);
    target = performance;
  } else if (motifIs('road_vehicle', 'road_loop', 'transit_stop', 'route_board', 'package_stack')) {
    const transport = new Graphics()
      .ellipse(0, 8, 48, 21).stroke({ color: 0x81958a, width: 8, alpha: .8 })
      .roundRect(-30, -20, 59, 25, 6).fill(palette.accent)
      .moveTo(-19, -20).lineTo(-8, -34).lineTo(13, -34).lineTo(24, -20).closePath().fill(palette.accentLight)
      .circle(-18, 6, 8).fill(0x3f5960).circle(18, 6, 8).fill(0x3f5960)
      .rect(-3, -18, 14, 12).fill({ color: 0xdff4ef, alpha: .85 });
    if (normalized.dominantMotif === 'package_stack') {
      transport.rect(32, -16, 18, 18).fill(0xb8895f).rect(39, -32, 18, 18).fill(0xd2a574)
        .moveTo(34, -14).lineTo(48, 0).stroke({ color: 0xf0c992, width: 2 });
    } else if (motifIs('transit_stop', 'route_board')) {
      transport.rect(37, -39, 4, 43).fill(0x718583).roundRect(29, -45, 20, 16, 3).fill(palette.structure)
        .moveTo(33, -39).lineTo(45, -39).stroke({ color: palette.accent, width: 3 });
    }
    group.addChild(transport);
    target = transport;
  } else if (motifIs('guide_marker', 'tour_map', 'meeting_point', 'passenger_shelter')) {
    const guide = new Graphics()
      .roundRect(-29, -36, 58, 38, 5).fill(palette.structure)
      .rect(-22, -29, 44, 25).fill(palette.accentLight)
      .moveTo(-17, -10).quadraticCurveTo(-7, -29, 4, -14).quadraticCurveTo(14, -2, 20, -22).stroke({ color: palette.accent, width: 4 })
      .circle(-17, -10, 4).fill(palette.accent).circle(20, -22, 4).fill(palette.accent)
      .rect(-3, 1, 6, 15).fill(0x806852);
    if (normalized.dominantMotif === 'meeting_point') {
      guide.circle(0, -49, 11).fill(palette.accent).circle(0, -49, 4).fill(palette.accentLight);
    }
    group.addChild(guide);
    target = guide;
    kind = 'scan';
  } else if (motifIs('observation_box', 'binoculars', 'observation_marker')) {
    const observation = new Graphics()
      .roundRect(-31, -24, 62, 30, 5).fill(palette.structure)
      .rect(-22, -17, 44, 17).fill({ color: palette.accentLight, alpha: .72 })
      .circle(-10, -31, 12).stroke({ color: palette.accent, width: 5 })
      .circle(12, -31, 12).stroke({ color: palette.accent, width: 5 })
      .moveTo(0, -31).lineTo(2, -31).stroke({ color: palette.accent, width: 5 })
      .moveTo(-19, -22).lineTo(-25, -4).stroke({ color: 0x785f50, width: 4 })
      .moveTo(21, -22).lineTo(27, -4).stroke({ color: 0x785f50, width: 4 });
    if (normalized.dominantMotif === 'observation_marker') {
      observation.rect(35, -39, 4, 44).fill(0x7c6953).circle(37, -43, 9).fill(palette.accentLight)
        .circle(37, -43, 4).fill(palette.accent);
    }
    group.addChild(observation);
    target = observation;
    kind = 'scan';
  } else {
    const beacon = new Graphics().rect(-4, -35, 8, 42).fill(0x7c948e)
      .circle(0, -38, 11).fill({ color: palette.accentLight, alpha: .7 })
      .circle(0, -38, 5).fill(palette.accent);
    group.addChild(beacon);
    target = beacon;
  }
  objects.addChild(group);
  return { target, kind };
}

function secondaryPart(key: SecondaryKey, palette: Palette) {
  const group = new Container();
  group.label = `secondary-${key}`;
  const g = new Graphics();
  if (key === 'sign') g.rect(-9, -17, 18, 12).fill(palette.accentLight).rect(-2, -5, 4, 12).fill(0x846c55);
  else if (key === 'table') g.rect(-13, -8, 26, 6).fill(0xb98761).rect(-9, -2, 4, 10).fill(0x85644d).rect(6, -2, 4, 10).fill(0x85644d);
  else if (key === 'crate') g.rect(-10, -12, 20, 19).fill(0xba8960).moveTo(-8, -9).lineTo(8, 4).stroke({ color: 0xe1bb83, width: 2 });
  else if (key === 'light') g.rect(-2, -22, 4, 28).fill(0x758b82).circle(0, -23, 7).fill(palette.accentLight).circle(0, -23, 3).fill(0xfff1bb);
  else if (key === 'dock') g.rect(-17, -4, 34, 8).fill(0xb78d68).rect(-14, 3, 4, 12).fill(0x826c57).rect(10, 3, 4, 12).fill(0x826c57);
  else if (key === 'path') g.moveTo(-19, 8).quadraticCurveTo(0, -8, 19, 5).stroke({ color: palette.sand, width: 8, alpha: .9 });
  else if (key === 'observation_box') g.roundRect(-12, -17, 24, 24, 3).fill(palette.structure).rect(-7, -11, 14, 9).fill(palette.accentLight);
  else if (key === 'hurdle') g.moveTo(-12, 7).lineTo(-12, -10).lineTo(12, -10).lineTo(12, 7).stroke({ color: 0xffffff, width: 3 }).moveTo(-10, -7).lineTo(10, -7).stroke({ color: palette.accent, width: 3 });
  else if (key === 'timing_board') g.rect(-13, -20, 26, 19).fill(0x395d65).rect(-10, -17, 20, 12).fill(palette.accentLight).rect(-2, -1, 4, 9).fill(0x806952);
  else if (key === 'cultivation_patch') g.ellipse(0, 2, 17, 8).fill(0x8b7759).circle(-9, -5, 6).fill(palette.lightGrass).circle(1, -7, 7).fill(palette.grass).circle(10, -4, 5).fill(palette.lightGrass);
  else if (key === 'tent' || key === 'shelter') g.moveTo(-17, 7).lineTo(0, -22).lineTo(18, 7).closePath().fill(palette.accent).moveTo(0, -22).lineTo(0, 7).stroke({ color: palette.accentLight, width: 2 });
  else if (key === 'firepit') g.circle(0, 2, 11).fill(0x876b55).moveTo(-7, 2).quadraticCurveTo(0, -21, 7, 2).quadraticCurveTo(0, 12, -7, 2).fill(0xf69b54).moveTo(-3, 2).quadraticCurveTo(0, -11, 4, 2).fill(0xffdf87);
  else if (key === 'campsite_marker') g.rect(-11, -18, 22, 14).fill(palette.structure).rect(-2, -4, 4, 13).fill(0x7c654e).moveTo(-7, -11).lineTo(7, -11).stroke({ color: palette.accent, width: 3 });
  else if (key === 'stage' || key === 'audience_area') g.rect(-18, -12, 36, 17).fill(0x53616b).rect(-21, -16, 42, 5).fill(palette.accent).circle(-10, 10, 3).fill(palette.accentLight).circle(0, 11, 3).fill(palette.accentLight).circle(10, 10, 3).fill(palette.accentLight);
  else if (key === 'speaker_stack' || key === 'amplifier') g.rect(-11, -23, 22, 30).fill(0x344954).circle(0, -14, 5).fill(palette.accentLight).circle(0, -2, 7).fill(palette.accent);
  else if (key === 'light_rig') g.moveTo(-16, -20).lineTo(16, -20).stroke({ color: 0x788c8d, width: 3 }).rect(-15, -18, 5, 25).fill(0x788c8d).rect(10, -18, 5, 25).fill(0x788c8d).circle(-8, -17, 5).fill(0xffd98b).circle(8, -17, 5).fill(0xaeeaf0);
  else if (key === 'road_vehicle') g.roundRect(-18, -14, 36, 19, 5).fill(palette.accent).moveTo(-10, -14).lineTo(-3, -23).lineTo(9, -23).lineTo(15, -14).fill(palette.accentLight).circle(-10, 6, 5).fill(0x3d535c).circle(10, 6, 5).fill(0x3d535c);
  else if (key === 'road_loop') g.ellipse(0, -3, 19, 11).stroke({ color: 0x84958b, width: 6 }).ellipse(0, -3, 10, 4).stroke({ color: palette.sand, width: 2 });
  else if (key === 'transit_stop' || key === 'route_board') g.rect(-2, -27, 4, 35).fill(0x718583).roundRect(-11, -31, 22, 16, 3).fill(palette.structure).moveTo(-7, -25).lineTo(7, -25).stroke({ color: palette.accent, width: 3 });
  else if (key === 'package_stack') g.rect(-15, -12, 17, 18).fill(0xba8960).rect(2, -18, 16, 24).fill(0xd2a574).moveTo(-13, -10).lineTo(0, 3).stroke({ color: 0xf0c992, width: 2 });
  else if (key === 'guide_marker' || key === 'meeting_point') g.rect(-2, -22, 4, 29).fill(0x7c6953).circle(0, -25, 9).fill(palette.accent).circle(0, -25, 3).fill(palette.accentLight);
  else if (key === 'tour_map') g.roundRect(-15, -20, 30, 25, 3).fill(palette.structure).moveTo(-10, -6).quadraticCurveTo(0, -20, 10, -9).stroke({ color: palette.accent, width: 3 }).circle(-10, -6, 3).fill(palette.accent).circle(10, -9, 3).fill(palette.accent);
  else if (key === 'passenger_shelter') g.roundRect(-18, -21, 36, 25, 3).fill({ color: palette.structure, alpha: .88 }).rect(-14, -17, 28, 13).fill({ color: palette.accentLight, alpha: .45 }).rect(-21, -25, 42, 5).fill(palette.accent);
  else if (key === 'binoculars') g.circle(-7, -10, 8).stroke({ color: palette.accent, width: 4 }).circle(7, -10, 8).stroke({ color: palette.accent, width: 4 }).moveTo(-1, -10).lineTo(1, -10).stroke({ color: palette.accent, width: 4 }).moveTo(-11, -3).lineTo(-15, 7).stroke({ color: 0x765f50, width: 3 }).moveTo(11, -3).lineTo(15, 7).stroke({ color: 0x765f50, width: 3 });
  else if (key === 'observation_marker') g.rect(-2, -22, 4, 29).fill(0x7c6953).circle(0, -25, 8).fill(palette.accentLight).circle(0, -25, 3).fill(palette.accent);
  else g.circle(0, -4, 8).fill(palette.accentLight).rect(-2, 3, 4, 7).fill(0x7c7562);
  group.addChild(g);
  return group;
}

function addSecondaryObjects(objects: Container, normalized: NormalizedVisualRecipe, palette: Palette) {
  const capacity = normalized.density === 'dense' ? 6 : normalized.density === 'medium' ? 4 : 2;
  const spread = normalized.openness === 'open' ? 1.18 : normalized.openness === 'compact' ? .78 : 1;
  const slots: readonly Point[] = [[-62, 17], [62, 18], [-46, -21], [49, -24], [-82, 31], [82, 32]];
  normalized.secondaryObjects.slice(0, capacity).forEach((key, index) => {
    const part = secondaryPart(key, palette);
    const [x, y] = slots[index];
    part.position.set(x * spread, y);
    part.scale.set(.78 + (index % 2) * .08);
    objects.addChild(part);
  });
}

function motionProfile(kind: MotionProfile['kind'], normalized: NormalizedVisualRecipe): MotionProfile {
  const activity = normalized.energyLevel === 'high' ? 1 : normalized.energyLevel === 'calm' ? .42 : .68;
  if (kind === 'rotation') return { kind, periodSeconds: 26 / activity, amplitude: Math.PI * 2, phase: .7 };
  if (kind === 'scan') return { kind, periodSeconds: 7.8 / activity, amplitude: .12 * activity, phase: .4 };
  return { kind, periodSeconds: 6.6 / activity, amplitude: .045 * activity, baseAlpha: .74, phase: 1.3 };
}

export function createIslandFromRecipe(recipe: VisualRecipe): IslandView {
  const normalized = normalizeVisualRecipe(recipe);
  const palette = palettes[normalized.paletteKey];
  const { shadow, shoreline, terrain } = buildFoundation(normalized, palette);
  const objects = new Container();
  objects.sortableChildren = true;
  addVegetation(objects, normalized, palette);
  addArchitecture(objects, normalized, palette);
  const landmark = addLandmark(objects, normalized, palette);
  addSecondaryObjects(objects, normalized, palette);
  for (const child of objects.children) child.zIndex = Math.round(child.y * 10);
  const motion = { target: landmark.target, profile: motionProfile(landmark.kind, normalized) } satisfies IslandMotion;
  return { shadow, shoreline, terrain, objects, motion };
}

export function verifyUnknownRecipeFallback() {
  const recipe: VisualRecipe = {
    visualTheme: 'totally_unknown_world',
    dominantMotif: 'unknown_machine',
    secondaryObjects: ['thing_that_does_not_exist'],
    terrainProfile: '???',
    accentPalette: 'unknown_palette',
    density: 'medium',
    openness: 'balanced',
    landmarkEmphasis: 'medium',
    energyLevel: 'moderate',
  };
  const normalized = normalizeVisualRecipe(recipe);
  const island = createIslandFromRecipe(recipe);
  const parts = [island.shadow, island.shoreline, island.terrain, island.objects];
  const result = {
    ok: parts.every((part) => part.children.length > 0),
    themeFamily: normalized.themeFamily,
    motif: normalized.dominantMotif,
    foundation: normalized.foundation,
    palette: normalized.paletteKey,
    supportedSecondaryCount: normalized.secondaryObjects.length,
  };
  for (const part of parts) part.destroy({ children: true });
  return result;
}
