export const CANONICAL_BRIDGE_TAGS = [
  'interviewing',
  'qualitative_research',
  'archival_research',
  'community_storytelling',
  'digitization',
  'asset_management',
  'archival_workflow',
  'documentation',
  'taxonomy',
  'cataloging',
  'discoverability',
  'information_architecture',
  'community_facilitation',
  'local_network',
  'collaboration',
  'event_operations',
  'audience_growth',
  'content_planning',
  'publishing',
  'video_production',
  'audio_production',
  'education_facilitation',
  'legal_admin',
  'venue_operations',
  'design',
  'data_analysis',
  'seo_discovery',
  'project_management',
  'storytelling',
  'brand_authority',
  'sponsorship_sales',
  'field_research',
  'observation',
  'experimentation',
  'teaching',
  'mentoring',
  'fundraising',
  'logistics',
  'accessibility',
  'translation',
  'preservation',
  'public_speaking',
  'research_synthesis',
  'prototyping',
] as const;

export type CanonicalBridgeTag = typeof CANONICAL_BRIDGE_TAGS[number];

const canonicalBridgeTagSet = new Set<string>(CANONICAL_BRIDGE_TAGS);

export const normalizeBridgeTag = (value: string) => value.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');

export function canonicalBridgeTags(values: readonly string[] | undefined): CanonicalBridgeTag[] {
  return [...new Set((values ?? []).map(normalizeBridgeTag).filter((tag): tag is CanonicalBridgeTag => canonicalBridgeTagSet.has(tag)))];
}

export function formatCanonicalBridgeVocabulary() {
  return `Canonical bridge tag vocabulary (use only these exact values):\n${CANONICAL_BRIDGE_TAGS.join(', ')}`;
}
