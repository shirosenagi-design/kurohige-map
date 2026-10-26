export type LayoutTarget = {
  nodeId: string;
  targetX: number;
  targetY: number;
  visibility?: number;
  fogDepth?: number;
};

// Deterministic stand-in for the future Person Map + World Map layout engine.
export function layoutHarnessUpdate(step: 1 | 2): LayoutTarget[] {
  if (step === 1) return [
    { nodeId: 'film', targetX: 90, targetY: 100 },
    { nodeId: 'research', targetX: -130, targetY: -145 },
    { nodeId: 'garden', targetX: 190, targetY: -270 },
    { nodeId: 'harbor', targetX: -700, targetY: 500 },
  ];
  return [
    { nodeId: 'film', targetX: 80, targetY: 120 },
    { nodeId: 'research', targetX: -95, targetY: -120 },
    { nodeId: 'garden', targetX: 145, targetY: -235 },
    { nodeId: 'harbor', targetX: -700, targetY: 500 },
  ];
}
