import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRenderGateway } from '../server/renderGateway.mjs';

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('filming Gateway serves Vite and enforces Basic auth without approval JSON or Nebius traffic', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kurohige-filming-boot-'));
  const upstreamPort = await availablePort();
  const gatewayPort = await availablePort();
  const proxySecret = 'isolated-proxy-secret-1234567890';
  const username = 'filming-test-user';
  const password = 'isolated-filming-password-1234567890';
  const childEnv = {
    ...process.env,
    NODE_ENV: 'production', NEBIUS_API_ENABLED: 'true', NEBIUS_API_KEY: 'isolated-dummy-key',
    KUROHIGE_PUBLIC_SAMPLE_ONLY: 'false',
    KUROHIGE_LIVE_SESSION: 'filming', KUROHIGE_LIVE_AI_USERNAME: username,
    KUROHIGE_LIVE_AI_PASSWORD: password, KUROHIGE_LIVE_AI_TRUSTED_PROXY_SECRET: proxySecret,
    REVIEW_STORAGE_BACKEND: 'json', REVIEW_DATA_PATH: path.join(root, 'reviews.json'),
    REVIEW_SESSION_SECRET: 'isolated-review-secret-1234567890',
  };
  delete childEnv.NEBIUS_PRODUCT_GUARD_CONFIG_PATH;
  const child = spawn(process.execPath, [
    './node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native',
    '--host', '127.0.0.1', '--port', String(upstreamPort), '--strictPort',
  ], {
    cwd: path.resolve('.'), stdio: 'ignore', env: childEnv,
  });
  const gateway = createRenderGateway({ upstreamPort, proxySecret });
  await new Promise((resolve) => gateway.listen(gatewayPort, '127.0.0.1', resolve));
  try {
    let home = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/`);
        if (response.status === 200) { home = response; break; }
      } catch { /* Preview may still be starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(home?.status, 200);
    assert.match(await home.text(), /<!doctype html>/iu);
    const accessUrl = `http://127.0.0.1:${gatewayPort}/api/live-ai-access`;
    const anonymous = await fetch(accessUrl);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'LIVE_AI_AUTH_REQUIRED');
    const authorized = await fetch(accessUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    });
    assert.equal(authorized.status, 200);
    const anonymousAi = await fetch(`http://127.0.0.1:${gatewayPort}/api/node-detail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(anonymousAi.status, 401);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await new Promise((resolve) => gateway.close(resolve));
  }
});
