import { defineConfig, loadEnv } from 'vite';
import { createVisualRecipeMiddleware } from './server/visualRecipeApi.mjs';
import { createLivingFlowApi } from './server/livingFlowApi.mjs';
import { createLocalEmailDelivery, createReviewLabApi } from './server/reviewLabApi.mjs';
import { assertPostgresReviewSchema, createPostgresPool, createPostgresReviewRepository } from './server/postgres/postgresReviewRepository.mjs';
import { createPostgresAccountSyncRepository } from './server/postgres/postgresAccountSyncRepository.mjs';
import { createNebiusProductSpendGuardFromEnv } from './server/nebiusProductSpendGuard.mjs';
import { createPublicSampleApiGuard } from './server/publicSampleGuard.mjs';
import { createLiveAiAccessGate } from './server/liveAiAccessGate.mjs';

const approvedRenderHosts = new Set([
  'kurohige-public-sample.onrender.com',
  'kurohige-live-filming.onrender.com',
  'kurohige-live-reviewer.onrender.com',
]);

function visualRecipeApiPlugin(apiKey, apiEnabled, diagnosticEnabled, reviewLabEnabled, reviewOptions, reviewPool = null, spendGuard = null, publicSampleOnly = false, liveAiAccessGate = null) {
  const livingFlowApi = createLivingFlowApi({ apiKey, apiEnabled, diagnosticEnabled, spendGuard });
  const reviewLabApi = createReviewLabApi({
    enabled: true,
    apiKey,
    apiEnabled,
    developmentAuthEnabled: reviewLabEnabled,
    productionMode: !reviewLabEnabled,
    spendGuard,
    ...reviewOptions,
  });
  const install = (server) => {
    server.middlewares.use(createPublicSampleApiGuard({ sampleOnly: publicSampleOnly }));
    if (liveAiAccessGate) server.middlewares.use(liveAiAccessGate);
    server.middlewares.use('/api/visual-recipe', createVisualRecipeMiddleware({ apiKey, apiEnabled, diagnosticEnabled, spendGuard }));
    server.middlewares.use('/api/possibility-map', livingFlowApi.possibilityMapMiddleware);
    server.middlewares.use('/api/node-steps', livingFlowApi.nodeStepsMiddleware);
    server.middlewares.use('/api/node-detail', livingFlowApi.nodeDetailMiddleware);
    server.middlewares.use('/api/world-expand', livingFlowApi.worldExpandMiddleware);
    server.middlewares.use('/api/reviews', reviewLabApi.middleware);
    if (reviewLabEnabled) server.middlewares.use('/api/review-lab', reviewLabApi.middleware);
    if (!spendGuard || spendGuard.allowsOperation('review_moderation')) reviewLabApi.startJobs();
    server.httpServer?.once('close', () => {
      reviewLabApi.stopJobs();
      if (spendGuard) void spendGuard.stop('server_closed').catch(() => {});
      if (reviewPool) void reviewPool.end();
    });
  };
  return {
    name: 'kurohige-nebius-visual-recipe-api',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export default defineConfig(async ({ command, mode }) => {
  const isBuild = command === 'build';
  const serverEnv = loadEnv(mode, process.cwd(), '');
  const renderHost = serverEnv.RENDER_EXTERNAL_HOSTNAME;
  const allowedHosts = approvedRenderHosts.has(renderHost) ? [renderHost] : [];
  const liveAiAccessGate = createLiveAiAccessGate({
    enabled: serverEnv.NEBIUS_API_ENABLED === 'true',
    username: serverEnv.KUROHIGE_LIVE_AI_USERNAME ?? '',
    password: serverEnv.KUROHIGE_LIVE_AI_PASSWORD ?? '',
    productionMode: mode === 'production',
    trustedProxySecret: serverEnv.KUROHIGE_LIVE_AI_TRUSTED_PROXY_SECRET ?? '',
  });
  const productSpendGuard = isBuild ? null : await createNebiusProductSpendGuardFromEnv(serverEnv);
  const publicSampleOnly = serverEnv.KUROHIGE_PUBLIC_SAMPLE_ONLY === 'true';
  const reviewBackend = serverEnv.REVIEW_STORAGE_BACKEND || 'json';
  let reviewPool = null;
  let reviewRepository;
  let syncRepository = null;
  if (reviewBackend === 'postgres' && !isBuild) {
    reviewPool = await createPostgresPool(serverEnv.REVIEW_DATABASE_URL, {
      ssl: serverEnv.REVIEW_DATABASE_SSL === 'true',
      applicationName: 'kurohige-review-vite',
    });
    await assertPostgresReviewSchema(reviewPool);
    reviewRepository = createPostgresReviewRepository(reviewPool);
    syncRepository = createPostgresAccountSyncRepository(reviewPool);
  } else if (reviewBackend !== 'json' && reviewBackend !== 'postgres') {
    throw new Error(`Unsupported REVIEW_STORAGE_BACKEND: ${reviewBackend}`);
  }
  return {
    server: {
      allowedHosts,
      watch: {
        ignored: ['**/.tmp/**'],
      },
    },
    preview: { allowedHosts },
    plugins: isBuild ? [] : [visualRecipeApiPlugin(
      serverEnv.NEBIUS_API_KEY,
      serverEnv.NEBIUS_API_ENABLED,
      mode !== 'production',
      mode !== 'production',
      {
        storagePath: serverEnv.REVIEW_DATA_PATH || undefined,
        sessionSecret: serverEnv.REVIEW_SESSION_SECRET,
        adminToken: serverEnv.REVIEW_ADMIN_TOKEN,
        repository: reviewRepository,
        syncRepository,
        authPublicBaseUrl: serverEnv.AUTH_PUBLIC_BASE_URL || '',
        emailDelivery: mode !== 'production' && serverEnv.REVIEW_LOCAL_EMAIL_OUTBOX === 'true'
          ? createLocalEmailDelivery()
          : undefined,
        passkey: {
          rpName: 'KUROHIGE MAP',
          rpID: serverEnv.WEBAUTHN_RP_ID || '',
          expectedOrigin: serverEnv.WEBAUTHN_ORIGIN || '',
        },
      },
      reviewPool,
      productSpendGuard,
      publicSampleOnly,
      liveAiAccessGate,
    )],
  };
});
