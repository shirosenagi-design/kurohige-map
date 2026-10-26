import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRenderGateway } from '../server/renderGateway.mjs';
import { createLiveAiAccessGate } from '../server/liveAiAccessGate.mjs';
import { createPublicSampleApiGuard } from '../server/publicSampleGuard.mjs';

const servers = [];
after(async () => { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); });

async function listen(server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function request(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const outbound = http.request({ host: '127.0.0.1', port, path, headers, method }, async (response) => {
      let body = '';
      for await (const part of response) body += part;
      resolve({ status: response.statusCode, body });
    });
    outbound.on('error', reject);
    outbound.end();
  });
}

test('Render gateway ignores forged forwarding and proxy-secret headers', async () => {
  const secret = 'internal-secret-of-at-least-thirty-two-characters';
  const upstreamPort = await listen(http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ proto: req.headers['x-forwarded-proto'], secret: req.headers['x-kurohige-proxy-secret'],
      forwarded: req.headers.forwarded ?? null, forwardedFor: req.headers['x-forwarded-for'] ?? null,
      authorization: req.headers.authorization ?? null }));
  }));
  const gatewayPort = await listen(createRenderGateway({ upstreamPort, proxySecret: secret }));
  const response = await request(gatewayPort, '/path', {
    'x-forwarded-proto': 'http', 'x-forwarded-for': 'forged', forwarded: 'for=forged;proto=http',
    'x-kurohige-proxy-secret': 'attacker', authorization: 'Basic opaque-test-value',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { proto: 'https', secret, forwarded: null,
    forwardedFor: null, authorization: 'Basic opaque-test-value' });
});

test('sample remains anonymous and all API paths are blocked before paid routes', async () => {
  const upstreamPort = await listen(http.createServer((req, res) => {
    createPublicSampleApiGuard({ sampleOnly: true })(req, res, () => {
      createLiveAiAccessGate({ enabled: true, username: 'filming-user', password: 'strong-password-with-at-least-24-characters', productionMode: true,
        trustedProxySecret: 'internal-secret-of-at-least-thirty-two-characters' })(req, res, () => res.end('sample map'));
    });
  }));
  const gatewayPort = await listen(createRenderGateway({ upstreamPort, proxySecret: 'internal-secret-of-at-least-thirty-two-characters' }));
  assert.equal((await request(gatewayPort, '/?sample=1')).body, 'sample map');
  const blocked = await request(gatewayPort, '/api/world-expand', {}, 'POST');
  assert.equal(blocked.status, 503);
  assert.equal(JSON.parse(blocked.body).error.code, 'PUBLIC_SAMPLE_SERVER_API_BLOCKED');
});

test('live paid route rejects unauthenticated requests and accepts correct Basic only', async () => {
  const secret = 'internal-secret-of-at-least-thirty-two-characters';
  const upstreamPort = await listen(http.createServer((req, res) => {
    createLiveAiAccessGate({ enabled: true, username: 'filming-user', password: 'strong-password-with-at-least-24-characters',
      productionMode: true, trustedProxySecret: secret })(req, res, () => res.end('authorized'));
  }));
  const gatewayPort = await listen(createRenderGateway({ upstreamPort, proxySecret: secret }));
  assert.equal((await request(gatewayPort, '/api/live-ai-access')).status, 401);
  assert.equal((await request(gatewayPort, '/api/world-expand', {}, 'POST')).status, 401);
  assert.equal((await request(gatewayPort, '/api/live-ai-access', { authorization: `Basic ${Buffer.from('reviewer-user:wrong-password').toString('base64')}` })).status, 401);
  const allowed = await request(gatewayPort, '/api/live-ai-access', {
    authorization: `Basic ${Buffer.from('filming-user:strong-password-with-at-least-24-characters').toString('base64')}`,
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /Live AI access is ready/);
});

test('production Vite preview serves the anonymous sample through the loopback gateway', async () => {
  const keys = ['NEBIUS_API_ENABLED', 'KUROHIGE_PUBLIC_SAMPLE_ONLY', 'KUROHIGE_LIVE_AI_TRUSTED_PROXY_SECRET',
    'REVIEW_STORAGE_BACKEND', 'REVIEW_DATA_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const secret = 'internal-secret-of-at-least-thirty-two-characters';
  Object.assign(process.env, {
    NEBIUS_API_ENABLED: 'false', KUROHIGE_PUBLIC_SAMPLE_ONLY: 'true',
    KUROHIGE_LIVE_AI_TRUSTED_PROXY_SECRET: secret, REVIEW_STORAGE_BACKEND: 'json',
    REVIEW_DATA_PATH: path.join(os.tmpdir(), `kurohige-render-smoke-${randomUUID()}.json`),
  });
  let previewServer;
  let gateway;
  try {
    const { preview } = await import('vite');
    previewServer = await preview({ configFile: path.resolve('vite.config.mjs'),
      preview: { host: '127.0.0.1', port: 42174, strictPort: true } });
    const upstreamPort = previewServer.httpServer.address().port;
    gateway = createRenderGateway({ upstreamPort, proxySecret: secret });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const gatewayPort = gateway.address().port;
    const page = await request(gatewayPort, '/?sample=1');
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/iu);
    const blocked = await request(gatewayPort, '/api/world-expand', {}, 'POST');
    assert.equal(blocked.status, 503);
    assert.equal(JSON.parse(blocked.body).error.code, 'PUBLIC_SAMPLE_SERVER_API_BLOCKED');
  } finally {
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    if (previewServer) await new Promise((resolve) => previewServer.httpServer.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
