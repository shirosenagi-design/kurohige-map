import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const upstreamHost = '127.0.0.1';
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardedHeaders(headers, proxySecret) {
  const result = {};
  const connectionTokens = String(headers.connection ?? '').toLowerCase().split(',').map((value) => value.trim());
  for (const [name, value] of Object.entries(headers)) {
    if (hopHeaders.has(name) || connectionTokens.includes(name)
      || name === 'forwarded' || name.startsWith('x-forwarded-')
      || name === 'x-kurohige-proxy-secret') continue;
    result[name] = value;
  }
  result['x-forwarded-proto'] = 'https';
  result['x-kurohige-proxy-secret'] = proxySecret;
  return result;
}

export function createRenderGateway({ upstreamPort, proxySecret, ready = () => true, requester = http.request } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid loopback upstream port.');
  if (typeof proxySecret !== 'string' || proxySecret.length < 32) throw new Error('A strong internal proxy secret is required.');
  return http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(ready() ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end(ready() ? 'ready' : 'starting');
      return;
    }
    if (!ready()) {
      response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('Service is starting.');
      return;
    }
    const upstream = requester({
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, proxySecret),
    }, (upstreamResponse) => {
      const headers = Object.fromEntries(Object.entries(upstreamResponse.headers)
        .filter(([name]) => !hopHeaders.has(name)));
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end();
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}

async function main() {
  const publicPort = Number(process.env.PORT);
  const upstreamPort = 4173;
  const proxySecret = process.env.KUROHIGE_LIVE_AI_TRUSTED_PROXY_SECRET;
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535 || publicPort === upstreamPort) throw new Error('Invalid Render public port.');
  if (!['false', 'true'].includes(process.env.NEBIUS_API_ENABLED)) throw new Error('Nebius switch must be explicit.');
  if (process.env.KUROHIGE_PUBLIC_SAMPLE_ONLY !== 'true' && process.env.KUROHIGE_PUBLIC_SAMPLE_ONLY !== 'false') throw new Error('Deployment mode must be explicit.');
  if (process.env.NEBIUS_API_ENABLED === 'true') {
    if (process.env.KUROHIGE_PUBLIC_SAMPLE_ONLY === 'true') throw new Error('Public sample cannot enable Nebius.');
    const session = process.env.KUROHIGE_LIVE_SESSION;
    if (!['filming', 'reviewer'].includes(session)) throw new Error('An approved live session is required.');
    const configPath = process.env.NEBIUS_PRODUCT_GUARD_CONFIG_PATH;
    if (!configPath?.startsWith('/etc/secrets/')) throw new Error('Approved guard configuration must be a Render secret file.');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const ledgerRoot = `/var/data/kurohige/ledgers/${session}/`;
    if (!path.resolve(config.ledgerPath ?? '').startsWith(ledgerRoot)) throw new Error('Live guard ledger must be on the session-specific persistent disk.');
  }
  let upstreamReady = false;
  const server = createRenderGateway({ upstreamPort, proxySecret, ready: () => upstreamReady && child.exitCode === null });
  let child = spawn(process.execPath, [
    '--use-system-ca', './node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native',
    '--host', upstreamHost, '--port', String(upstreamPort), '--strictPort',
  ], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
  const probe = setInterval(() => {
    const ping = http.get({ host: upstreamHost, port: upstreamPort, path: '/' }, (response) => {
      response.resume();
      upstreamReady = true;
      clearInterval(probe);
    });
    ping.on('error', () => {});
    ping.setTimeout(2_000, () => ping.destroy());
  }, 250);
  child.once('exit', (code) => {
    clearInterval(probe);
    upstreamReady = false;
    server.close();
    process.exitCode = code || 1;
  });
  process.once('SIGTERM', () => { child?.kill('SIGTERM'); server.close(); });
  process.once('SIGINT', () => { child?.kill('SIGINT'); server.close(); });
  server.listen(publicPort, '0.0.0.0');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
