export type VisualRecipe = {
  visualTheme: string;
  dominantMotif: string;
  secondaryObjects: string[];
  terrainProfile: string;
  accentPalette: string;
  density: 'sparse' | 'medium' | 'dense';
  openness: 'open' | 'balanced' | 'compact';
  landmarkEmphasis: 'low' | 'medium' | 'high';
  energyLevel: 'calm' | 'moderate' | 'high';
};

export type SemanticNode = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: 'unseen' | 'peeked';
  kept?: boolean;
  visited?: boolean;
  visualTheme: 'coral' | 'garden' | 'research' | 'harbor';
  visualRecipe?: VisualRecipe;
};

export type PlacedNode = {
  nodeId: string;
  targetX: number;
  targetY: number;
  visibility: number;
  fogDepth: number;
};

// Temporary layout fixture. A future layout engine owns these world coordinates.
export const nodes: SemanticNode[] = [
  { id: 'film', title: '動画制作', description: '伝えることで、世界が少し変わるかも。', category: '表現', status: 'peeked', visualTheme: 'coral' },
  { id: 'research', title: '研究コミュニティ', description: '問いを持ち寄る人たちと出会う。', category: '探究', status: 'unseen', visualTheme: 'research' },
  { id: 'garden', title: '市民科学', description: '身近な自然から、発見を始める。', category: '自然', status: 'unseen', visualTheme: 'garden' },
  { id: 'harbor', title: '小さな船旅', description: 'いつもと違う景色を見に行く。', category: '体験', status: 'unseen', visualTheme: 'harbor' },
];

export type NodeFlags = { kept: boolean; visited: boolean };

export const placement: PlacedNode[] = [
  { nodeId: 'film', targetX: 80, targetY: -65, visibility: 1, fogDepth: 0 },
  { nodeId: 'research', targetX: -245, targetY: -270, visibility: 1, fogDepth: 0 },
  { nodeId: 'garden', targetX: 310, targetY: -310, visibility: 1, fogDepth: 0 },
  { nodeId: 'harbor', targetX: -330, targetY: 175, visibility: 1, fogDepth: 0.2 },
];

// DEV-only fixture data. Runtime activation is gated by import.meta.env.DEV in the UI.
export const recipePilotNodes: SemanticNode[] = [
  {
    id: 'track_and_field',
    title: '陸上競技',
    description: '走るリズムと記録から、新しい挑戦を始める。',
    category: 'スポーツ',
    status: 'unseen',
    visualTheme: 'harbor',
    visualRecipe: {
      visualTheme: 'athletics',
      dominantMotif: 'running_track',
      secondaryObjects: ['hurdles', 'timing_board', 'podium/sign'],
      terrainProfile: 'open',
      accentPalette: 'warm_red_white',
      density: 'medium',
      openness: 'open',
      landmarkEmphasis: 'high',
      energyLevel: 'high',
    },
  },
  {
    id: 'bakery',
    title: '小さなベーカリー',
    description: '香りと手仕事で、まちに温かな居場所をつくる。',
    category: '食とものづくり',
    status: 'unseen',
    visualTheme: 'harbor',
    visualRecipe: {
      visualTheme: 'food_craft',
      dominantMotif: 'bakery_workshop',
      secondaryObjects: ['oven_sign', 'tables', 'crates', 'plants'],
      terrainProfile: 'village',
      accentPalette: 'warm_cream_terracotta',
      density: 'medium',
      openness: 'balanced',
      landmarkEmphasis: 'high',
      energyLevel: 'moderate',
    },
  },
  {
    id: 'insect_observation',
    title: '昆虫観察',
    description: '小さな生きものの変化を、野外でじっくり見つめる。',
    category: 'フィールド科学',
    status: 'unseen',
    visualTheme: 'harbor',
    visualRecipe: {
      visualTheme: 'field_science',
      dominantMotif: 'insect_observation',
      secondaryObjects: ['observation_box', 'plants', 'path', 'small_light'],
      terrainProfile: 'lush',
      accentPalette: 'green_amber',
      density: 'dense',
      openness: 'balanced',
      landmarkEmphasis: 'medium',
      energyLevel: 'calm',
    },
  },
];

export const recipePilotPlacement: PlacedNode[] = [
  { nodeId: 'track_and_field', targetX: -285, targetY: -225, visibility: 1, fogDepth: 0 },
  { nodeId: 'bakery', targetX: 20, targetY: -45, visibility: 1, fogDepth: 0 },
  { nodeId: 'insect_observation', targetX: 315, targetY: -285, visibility: 1, fogDepth: 0 },
];

export function mapFixture(recipePilot: boolean) {
  return recipePilot
    ? { nodes: recipePilotNodes, placement: recipePilotPlacement }
    : { nodes, placement };
}

export const playerWorldPosition = Object.freeze({ x: 0, y: 310 });
