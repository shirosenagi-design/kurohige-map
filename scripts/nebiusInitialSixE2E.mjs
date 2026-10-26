import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLivingFlowApi } from '../server/livingFlowApi.mjs';
import { createNebiusLiveSpendGuard, isNebiusApiEnabled } from '../server/nebiusTransportGuard.mjs';

const requiredAbsolutePath = (name) => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
};

function invokeMiddleware(middleware, body) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = 'POST';
    const response = {
      statusCode: 200,
      setHeader() {},
      end(value) {
        try { resolve({ status: this.statusCode, body: JSON.parse(value) }); }
        catch (error) { reject(error); }
      },
    };
    Promise.resolve(middleware(request, response)).catch(reject);
  });
}

async function writeNewJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(tempPath, targetPath);
}

async function main() {
  if (!process.execArgv.includes('--use-system-ca')) {
    throw new Error('The initial-six live runner must be launched with Node --use-system-ca.');
  }
  if (!isNebiusApiEnabled(process.env.NEBIUS_API_ENABLED)) throw new Error('NEBIUS_API_ENABLED must be explicitly true for this separately approved live run.');
  if (!process.env.NEBIUS_API_KEY) throw new Error('NEBIUS_API_KEY is required but will not be logged.');
  const contextPath = requiredAbsolutePath('NEBIUS_LIVE_CONTEXT_PATH');
  const ledgerPath = requiredAbsolutePath('NEBIUS_LIVE_LEDGER_PATH');
  const resultPath = requiredAbsolutePath('NEBIUS_LIVE_RESULT_PATH');
  const runId = process.env.NEBIUS_LIVE_RUN_ID ?? '';
  const maxEstimatedUsd = Number(process.env.NEBIUS_LIVE_MAX_ESTIMATED_USD ?? '0.35');
  const contextDocument = JSON.parse(await readFile(contextPath, 'utf8'));
  const generationContext = contextDocument?.generationContext ?? contextDocument;
  if (!generationContext || generationContext.mode !== 'person_map') throw new Error('The context file must contain one person_map generationContext.');

  const spendGuard = createNebiusLiveSpendGuard({ ledgerPath, runId, mode: 'initial-six', maxChatPosts: 8, maxEstimatedUsd });
  await spendGuard.initialize();
  let succeeded = false;
  try {
    const api = createLivingFlowApi({
      apiKey: process.env.NEBIUS_API_KEY,
      apiEnabled: true,
      diagnosticEnabled: true,
      spendGuard,
    });
    const response = await invokeMiddleware(api.possibilityMapMiddleware, { generationContext });
    if (response.status !== 200) throw new Error(`Initial-six endpoint failed safely with HTTP ${response.status} (${response.body?.error?.code ?? 'unknown'}).`);
    if (!Array.isArray(response.body?.nodes) || response.body.nodes.length !== 6) throw new Error('Initial-six endpoint did not return exactly six nodes.');
    if (new Set(response.body.nodes.map((node) => node.id)).size !== 6) throw new Error('Initial-six endpoint returned duplicate node ids.');
    const budget = await spendGuard.complete({ expectedChatPosts: 8 });
    await writeNewJson(resultPath, {
      kind: 'KUROHIGE_MAP_INITIAL_SIX_LIVE_EVIDENCE',
      runId,
      completedAt: new Date().toISOString(),
      model: response.body.model,
      nodeCount: response.body.nodes.length,
      nodes: response.body.nodes,
      diagnostic: response.body.diagnostic ?? null,
      budget,
    });
    succeeded = true;
    process.stdout.write(`${JSON.stringify({ status: 'completed', runId, nodeCount: 6, chatPosts: budget.chatPostsCompleted, actualPromptTokens: budget.actualPromptTokens, actualCompletionTokens: budget.actualCompletionTokens, actualUsd: budget.actualUsd, ledgerPath, resultPath })}\n`);
  } finally {
    process.env.NEBIUS_API_ENABLED = 'false';
    if (!succeeded) await spendGuard.stop('initial_six_runner_failed').catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'stopped', code: error?.code ?? 'INITIAL_SIX_FAILED', message: error instanceof Error ? error.message : 'Initial-six run failed.' })}\n`);
  process.exitCode = 1;
});
