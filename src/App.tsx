import { useState, type FormEvent } from 'react';
import { LivingMap } from './LivingMap';
import { LivingFlowPilot } from './LivingFlowPilot';
import { ProductShell } from './ProductShell';
import { mapFixture, type NodeFlags, type PlacedNode, type SemanticNode, type VisualRecipe } from './model';
import { diagnoseVisualRecipe } from './recipeIslands';
import { ShipNavigationHarness } from './ShipNavigationHarness';

type GeneratedIsland = {
  revision: number;
  goal: string;
  recipe: VisualRecipe;
  model: string;
  structuredOutputMethod: string;
  semanticIntent?: SemanticIntent;
};

type SemanticIntent = {
  themeConcept: string;
  dominantVisualIdea: string;
  supportingVisualConcepts: string[];
  terrainCharacter: string;
  moodEnergy: string;
  importantSemanticDistinctions: string[];
};

type VisualRecipeResponse = {
  recipe?: VisualRecipe;
  model?: string;
  structuredOutputMethod?: string;
  error?: { message?: string };
  diagnostic?: Record<string, unknown>;
  semanticIntent?: SemanticIntent;
};

export function App() {
  const query = new URLSearchParams(window.location.search);
  if (import.meta.env.DEV && query.get('shipNavigationTest') === '1') return <ShipNavigationHarness />;
  const livingFlowPilot = import.meta.env.DEV && query.get('livingFlowPilot') === '1';
  const classicDevHarness = import.meta.env.DEV && [
    'recipePilot', 'nemotronPilot', 'scenePilot', 'assetPilot', 'trailTest', 'revealTest', 'layoutTest',
  ].some((key) => query.get(key) === '1');
  if (livingFlowPilot) return <LivingFlowPilot />;
  if (classicDevHarness) return <ClassicMapApp />;
  return <ProductShell />;
}

function ClassicMapApp() {
  const query = new URLSearchParams(window.location.search);
  const recipePilotEnabled = import.meta.env.DEV && query.get('recipePilot') === '1';
  const nemotronPilotEnabled = import.meta.env.DEV && query.get('nemotronPilot') === '1';
  const recipeDebugEnabled = nemotronPilotEnabled && query.get('recipeDebug') === '1';
  const twoStagePilotEnabled = nemotronPilotEnabled && query.get('twoStagePilot') === '1';
  const vocabPilotEnabled = nemotronPilotEnabled && query.get('vocabPilot') === '1';
  const baseFixture = mapFixture(recipePilotEnabled);
  const [generated, setGenerated] = useState<GeneratedIsland | null>(null);
  const [goal, setGoal] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [serverDiagnostic, setServerDiagnostic] = useState<Record<string, unknown> | null>(null);

  const generatedNode: SemanticNode | null = generated ? {
    id: `nemotron-live-${generated.revision}`,
    title: generated.goal,
    description: 'Nemotronが作成したVisual Recipeから生成した可能性の島。',
    category: 'LIVE VISUAL RECIPE',
    status: 'unseen',
    visualTheme: 'harbor',
    visualRecipe: generated.recipe,
  } : null;
  const generatedPlacement: PlacedNode | null = generatedNode ? {
    nodeId: generatedNode.id,
    targetX: 0,
    targetY: -70,
    visibility: 1,
    fogDepth: 0,
  } : null;
  const activeNodes = generatedNode ? [generatedNode] : baseFixture.nodes;
  const activePlacement = generatedPlacement ? [generatedPlacement] : baseFixture.placement;
  const recipeDiagnostics = generated ? diagnoseVisualRecipe(generated.recipe) : null;

  const [selectedId, setSelectedId] = useState(baseFixture.nodes[0].id);
  const [flags, setFlags] = useState<Record<string, NodeFlags>>(() => Object.fromEntries(
    baseFixture.nodes.map((node) => [node.id, { kept: !!node.kept, visited: !!node.visited }]),
  ));
  const selected = activeNodes.find((node) => node.id === selectedId) ?? activeNodes[0];
  const selectedFlags = flags[selected.id] ?? { kept: false, visited: false };
  const toggle = (field: keyof NodeFlags) => setFlags((current) => ({
    ...current,
    [selected.id]: { ...(current[selected.id] ?? { kept: false, visited: false }), [field]: !selectedFlags[field] },
  }));

  const generateIsland = async (event: FormEvent) => {
    event.preventDefault();
    const requestedGoal = goal.trim();
    if (!requestedGoal || generating) return;
    setGenerating(true);
    setGenerationError('');
    setServerDiagnostic(null);
    try {
      const response = await fetch('/api/visual-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: requestedGoal,
          ...(twoStagePilotEnabled ? { devTwoStagePilot: true } : {}),
          ...(vocabPilotEnabled ? { devVocabPilot: true } : {}),
        }),
      });
      const payload = await response.json() as VisualRecipeResponse;
      setServerDiagnostic(payload.diagnostic ?? null);
      if (!response.ok || !payload.recipe || !payload.model || !payload.structuredOutputMethod) {
        throw new Error(payload.error?.message ?? `Visual Recipe request failed (${response.status}).`);
      }
      const revision = (generated?.revision ?? 0) + 1;
      const next: GeneratedIsland = {
        revision,
        goal: requestedGoal,
        recipe: payload.recipe,
        model: payload.model,
        structuredOutputMethod: payload.structuredOutputMethod,
        semanticIntent: payload.semanticIntent,
      };
      setGenerated(next);
      const nodeId = `nemotron-live-${revision}`;
      setSelectedId(nodeId);
      setFlags((current) => ({ ...current, [nodeId]: { kept: false, visited: false } }));
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : 'Visual Recipe generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="app-shell">
      <LivingMap
        onSelect={setSelectedId}
        selectedId={selected.id}
        flags={flags}
        activeNodes={activeNodes}
        activePlacement={activePlacement}
        revision={generated?.revision ?? 0}
      />
      <div className="ui-overlay">
        <header className="top-ui">
          <div className="brand"><span className="brand-mark">⛵</span><span>KUROHIGE MAP</span></div>
          <nav className="tabs" aria-label="Screen sections">
            <button className="active" type="button">▧ マップ</button>
            <button type="button" disabled>☷ リスト</button>
            <button type="button" disabled>▤ ノート</button>
          </nav>
        </header>
        {nemotronPilotEnabled && <form className="nemotron-panel" onSubmit={generateIsland} aria-label="Nemotron Visual Recipe Pilot">
          <label htmlFor="nemotron-goal">可能性を入力</label>
          <div className="nemotron-controls">
            <input
              id="nemotron-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={600}
              placeholder="例：宇宙について学びたい"
              disabled={generating}
            />
            <button type="submit" disabled={generating || !goal.trim()}>{generating ? '生成中…' : 'Generate Island'}</button>
          </div>
          {generationError && <p className="nemotron-error" role="alert">{generationError}</p>}
          {(recipeDebugEnabled || twoStagePilotEnabled || vocabPilotEnabled) && serverDiagnostic && <details className="nemotron-result server-diagnostic" open>
            <summary>Server Reliability Diagnostic</summary>
            <pre>{JSON.stringify(serverDiagnostic, null, 2)}</pre>
          </details>}
          {generated && <details className="nemotron-result">
            <summary>Returned Visual Recipe</summary>
            <div className="nemotron-meta">Model: {generated.model}<br />Output: {generated.structuredOutputMethod}</div>
            <pre>{JSON.stringify(generated.recipe, null, 2)}</pre>
          </details>}
        </form>}
        {vocabPilotEnabled && generated && recipeDiagnostics && serverDiagnostic && <aside className="recipe-debug-panel vocab-pilot-panel" aria-label="Role-Aware Visual Vocabulary Contract Pilot" aria-live="polite">
          <header>
            <span>DEV · SINGLE-STAGE ROLE-AWARE VOCABULARY</span>
            <strong>{generated.goal}</strong>
          </header>
          <section>
            <h2>RAW VISUALRECIPE</h2>
            <pre>{JSON.stringify(generated.recipe, null, 2)}</pre>
          </section>
          <section>
            <h2>NORMALIZED RECIPE</h2>
            <pre>{JSON.stringify(recipeDiagnostics.normalized, null, 2)}</pre>
          </section>
          <section>
            <h2>SELECTED REUSABLE PARTS</h2>
            <pre>{JSON.stringify(recipeDiagnostics.selectedParts, null, 2)}</pre>
          </section>
          <section>
            <h2>GENERIC FALLBACKS</h2>
            <pre>{JSON.stringify({
              genericFallbacks: recipeDiagnostics.fallbacks.filter((fallback) => fallback.reason === 'generic'),
              unsupportedOrDropped: recipeDiagnostics.dropped,
            }, null, 2)}</pre>
          </section>
          <section>
            <h2>TOKENS · LATENCY · RETRY · STAGE G</h2>
            <pre>{JSON.stringify({
              totalUsage: serverDiagnostic.totalUsage,
              totalLatencyMs: serverDiagnostic.totalLatencyMs,
              totalRetryCount: serverDiagnostic.totalRetryCount,
              stageG: serverDiagnostic.stageG,
              attempts: serverDiagnostic.attempts,
            }, null, 2)}</pre>
          </section>
        </aside>}
        {twoStagePilotEnabled && generated && recipeDiagnostics && serverDiagnostic && <aside className="recipe-debug-panel two-stage-panel" aria-label="Two-Stage Semantic Intent Pilot" aria-live="polite">
          <header>
            <span>DEV · TWO-STAGE ON → OFF</span>
            <strong>{generated.goal}</strong>
          </header>
          <section>
            <h2>GOAL</h2>
            <pre>{generated.goal}</pre>
          </section>
          <section className="two-stage-intent">
            <h2>STAGE A · SEMANTIC INTENT</h2>
            <pre>{JSON.stringify(generated.semanticIntent, null, 2)}</pre>
          </section>
          <section className="two-stage-raw-recipe">
            <h2>STAGE B · RAW VISUALRECIPE</h2>
            <pre>{JSON.stringify(generated.recipe, null, 2)}</pre>
          </section>
          <section className="two-stage-normalized">
            <h2>NORMALIZED RECIPE</h2>
            <pre>{JSON.stringify(recipeDiagnostics.normalized, null, 2)}</pre>
          </section>
          <section className="two-stage-metrics">
            <h2>TOKENS · LATENCY · RETRY · STAGE G</h2>
            <pre>{JSON.stringify({
              totalUsage: serverDiagnostic.totalUsage,
              totalLatencyMs: serverDiagnostic.totalLatencyMs,
              totalRetryCount: serverDiagnostic.totalRetryCount,
              stageG: serverDiagnostic.stageG,
              stages: serverDiagnostic.stages,
            }, null, 2)}</pre>
          </section>
        </aside>}
        {recipeDebugEnabled && recipeDiagnostics && <aside className="recipe-debug-panel" aria-label="Live Recipe Fallback Diagnostics" aria-live="polite">
          <header>
            <span>DEV · LIVE RECIPE</span>
            <strong>{generated?.goal}</strong>
          </header>
          <section className="recipe-debug-raw">
            <h2>RAW RECIPE</h2>
            <pre>{JSON.stringify(generated?.recipe, null, 2)}</pre>
          </section>
          <section className="recipe-debug-normalized">
            <h2>NORMALIZED RECIPE</h2>
            <pre>{JSON.stringify(recipeDiagnostics.normalized, null, 2)}</pre>
          </section>
          <section className="recipe-debug-fallbacks">
            <h2>FALLBACKS</h2>
            <pre>{JSON.stringify({ fallbacks: recipeDiagnostics.fallbacks, resolution: recipeDiagnostics.resolution }, null, 2)}</pre>
          </section>
          <section className="recipe-debug-unsupported">
            <h2>DROPPED / UNSUPPORTED PARTS</h2>
            <pre>{JSON.stringify({ dropped: recipeDiagnostics.dropped, unsupported: recipeDiagnostics.unsupported }, null, 2)}</pre>
          </section>
        </aside>}
        <section className="bottom-ui" aria-label="Selected node preview">
          <div className="card-heading"><span className="category">{selected.category}</span><span className="preview-caption">可能性のプレビュー</span></div>
          <h1>{selected.title}</h1>
          <p>{selected.description}</p>
          <div className="actions">
            <button type="button" disabled>のぞく</button>
            <button type="button" aria-pressed={selectedFlags.kept} onClick={() => toggle('kept')}>{selectedFlags.kept ? 'キープ中' : 'キープ'}</button>
            <button type="button" aria-pressed={selectedFlags.visited} onClick={() => toggle('visited')}>{selectedFlags.visited ? '訪れた · 記録済' : '訪れた'}</button>
          </div>
        </section>
      </div>
    </main>
  );
}
