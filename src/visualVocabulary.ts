export type VisualRole =
  | 'theme'
  | 'dominantMotif'
  | 'secondaryObject'
  | 'architecture'
  | 'terrain'
  | 'palette';

type VisualConceptDefinition = {
  id: string;
  roles: readonly VisualRole[];
  aliases?: readonly string[];
};

// This is the only handwritten visual vocabulary. Every role-specific view used by
// the normalizer, renderer, DEV prompt, and DEV schema is derived from this registry.
export const VISUAL_CONCEPTS = [
  { id: 'athletics', roles: ['theme'], aliases: ['sport'] },
  { id: 'food_craft', roles: ['theme'], aliases: ['bakery'] },
  { id: 'field_science', roles: ['theme'], aliases: ['nature_study'] },
  { id: 'creative', roles: ['theme'], aliases: ['art'] },
  { id: 'research', roles: ['theme', 'architecture'], aliases: ['science'] },
  { id: 'cultivation', roles: ['theme'], aliases: ['garden'] },
  { id: 'culture', roles: ['theme'], aliases: ['community'] },
  { id: 'outdoor_recreation', roles: ['theme'] },
  { id: 'performance', roles: ['theme'] },
  { id: 'transport', roles: ['theme'] },
  { id: 'guided_experience', roles: ['theme'] },
  { id: 'observation', roles: ['theme'] },
  { id: 'generic', roles: ['theme', 'dominantMotif', 'terrain'] },

  { id: 'running_track', roles: ['dominantMotif'], aliases: ['athletics_marker'] },
  { id: 'bakery_workshop', roles: ['dominantMotif'], aliases: ['oven_sign'] },
  { id: 'insect_observation', roles: ['dominantMotif'], aliases: ['insect_observation_marker'] },
  { id: 'observatory', roles: ['dominantMotif'], aliases: ['antenna'] },
  { id: 'camera', roles: ['dominantMotif'], aliases: ['creative_marker'] },
  { id: 'windmill', roles: ['dominantMotif'] },

  { id: 'tent', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'shelter', roles: ['dominantMotif', 'secondaryObject', 'architecture'] },
  { id: 'firepit', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'campsite_marker', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'stage', roles: ['dominantMotif', 'secondaryObject', 'architecture'] },
  { id: 'speaker_stack', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'amplifier', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'light_rig', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'audience_area', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'road_vehicle', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'road_loop', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'transit_stop', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'route_board', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'package_stack', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'guide_marker', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'tour_map', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'meeting_point', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'passenger_shelter', roles: ['dominantMotif', 'secondaryObject', 'architecture'] },
  { id: 'observation_box', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'binoculars', roles: ['dominantMotif', 'secondaryObject'] },
  { id: 'observation_marker', roles: ['dominantMotif', 'secondaryObject'] },

  { id: 'sign', roles: ['secondaryObject'], aliases: ['podium/sign', 'oven_sign', 'podium'] },
  { id: 'table', roles: ['secondaryObject'], aliases: ['tables'] },
  { id: 'crate', roles: ['secondaryObject'], aliases: ['crates'] },
  { id: 'light', roles: ['secondaryObject'], aliases: ['small_light'] },
  { id: 'dock', roles: ['secondaryObject'] },
  { id: 'path', roles: ['secondaryObject'] },
  { id: 'hurdle', roles: ['secondaryObject'], aliases: ['hurdles'] },
  { id: 'timing_board', roles: ['secondaryObject'] },
  { id: 'cultivation_patch', roles: ['secondaryObject'], aliases: ['plants'] },
  { id: 'utility', roles: ['secondaryObject'] },

  { id: 'workshop', roles: ['architecture'] },
  { id: 'greenhouse', roles: ['architecture'] },
  { id: 'pavilion', roles: ['architecture'] },

  { id: 'flat', roles: ['terrain'], aliases: ['open', 'athletics'] },
  { id: 'organic', roles: ['terrain'], aliases: ['village', 'balanced', 'woodland'] },
  { id: 'raised', roles: ['terrain'], aliases: ['lush', 'rocky'] },

  { id: 'warm_red_white', roles: ['palette'] },
  { id: 'warm_cream_terracotta', roles: ['palette'] },
  { id: 'green_amber', roles: ['palette'] },
  { id: 'ocean_teal', roles: ['palette'], aliases: ['teal'] },
  { id: 'safe', roles: ['palette'] },
] as const satisfies readonly VisualConceptDefinition[];

type VisualConcept = (typeof VISUAL_CONCEPTS)[number];
type ConceptIdForRole<C, R extends VisualRole> = C extends {
  id: infer I extends string;
  roles: readonly (infer CR)[];
} ? R extends CR ? I : never : never;

export type RoleConceptId<R extends VisualRole> = ConceptIdForRole<VisualConcept, R>;
export type ThemeFamily = RoleConceptId<'theme'>;
export type MotifKey = RoleConceptId<'dominantMotif'>;
export type SecondaryKey = RoleConceptId<'secondaryObject'>;
export type ArchitectureKey = RoleConceptId<'architecture'>;
export type FoundationKey = RoleConceptId<'terrain'>;
export type PaletteKey = RoleConceptId<'palette'>;

type VocabularySection = Record<string, readonly string[]>;

export function conceptIdsForRole<R extends VisualRole>(role: R): RoleConceptId<R>[] {
  return VISUAL_CONCEPTS
    .filter((concept) => (concept.roles as readonly VisualRole[]).includes(role))
    .map((concept) => concept.id) as RoleConceptId<R>[];
}

export function registryForRole<R extends VisualRole>(role: R): Record<RoleConceptId<R>, readonly string[]> {
  return Object.fromEntries(
    VISUAL_CONCEPTS
      .filter((concept) => (concept.roles as readonly VisualRole[]).includes(role))
      .map((concept) => [concept.id, 'aliases' in concept ? concept.aliases : []]),
  ) as unknown as Record<RoleConceptId<R>, readonly string[]>;
}

export const VISUAL_VOCABULARY = {
  themes: registryForRole('theme'),
  dominantMotifs: registryForRole('dominantMotif'),
  secondaryObjects: registryForRole('secondaryObject'),
  architectures: registryForRole('architecture'),
  terrainProfiles: registryForRole('terrain'),
  palettes: registryForRole('palette'),
};

export function createVocabularyLookup<T extends VocabularySection>(section: T): Record<string, keyof T & string> {
  const lookup: Record<string, keyof T & string> = {};
  for (const [canonical, aliases] of Object.entries(section)) {
    lookup[canonical] = canonical as keyof T & string;
    for (const alias of aliases) lookup[alias] = canonical as keyof T & string;
  }
  return lookup;
}

export function formatSupportedVisualVocabulary() {
  const line = (label: string, role: VisualRole) => `- ${label}: ${conceptIdsForRole(role).join(', ')}`;
  return [
    line('visualTheme', 'theme'),
    line('dominantMotif', 'dominantMotif'),
    line('secondaryObjects', 'secondaryObject'),
    line('architecture parts', 'architecture'),
    line('terrainProfile', 'terrain'),
    line('accentPalette', 'palette'),
  ].join('\n');
}
