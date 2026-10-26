import { createHash, timingSafeEqual } from 'node:crypto';

const worldAiRoutes = new Set([
  '/api/possibility-map', '/api/world-expand', '/api/node-steps',
  '/api/node-detail', '/api/visual-recipe',
]);

export function isChargeableAiRoute(method, url) {
  const path = new URL(url || '/', 'http://localhost').pathname.toLowerCase().replace(/\/{2,}/gu, '/').replace(/\/+$/u, '');
  if (method === 'GET' && path === '/api/live-ai-access') return true;
  if (!['POST', 'PUT'].includes(method)) return false;
  const pathname = path.replace(/^\/api\/review-lab(?=\/|\.|$)/u, '/api/reviews');
  // Vite's Connect mount also matches /route/child and /route.suffix,
  // case-insensitively. Each mounted World handler accepts those URLs.
  if ([...worldAiRoutes].some((route) => pathname === route
    || (pathname.startsWith(route) && ['/', '.'].includes(pathname[route.length])))) return true;
  if (pathname === '/api/reviews/reviews' && method === 'POST') return true;
  if (/^\/api\/reviews\/reviews\/[^/]+$/u.test(pathname) && method === 'PUT') return true;
  if (pathname === '/api/reviews/admin/moderation/process' && method === 'POST') return true;
  return method === 'POST' && /^\/api\/reviews\/nodes\/[^/]+\/(subject|journey)$/u.test(pathname);
}

const sameSecret = (left, right) => timingSafeEqual(
  createHash('sha256').update(left).digest(),
  createHash('sha256').update(right).digest(),
);

function secureTransport(req, { productionMode, trustedProxySecret }) {
  if (req.socket?.encrypted) return true;
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const host = String(req.headers.host ?? '').split(':')[0];
  const forwarded = req.headers['x-forwarded-proto'] !== undefined
    || req.headers['x-forwarded-host'] !== undefined
    || req.headers.forwarded !== undefined;
  if (!productionMode && !forwarded && ['127.0.0.1', 'localhost'].includes(host)) return true;
  const suppliedProxySecret = req.headers['x-kurohige-proxy-secret'];
  return typeof trustedProxySecret === 'string' && trustedProxySecret.length >= 32
    && typeof suppliedProxySecret === 'string'
    && sameSecret(suppliedProxySecret, trustedProxySecret)
    && req.headers['x-forwarded-proto'] === 'https';
}

export function createLiveAiAccessGate({ enabled = false, username = '', password = '', productionMode = false, trustedProxySecret = '' } = {}) {
  if (enabled && (username.length < 8 || password.length < 24)) {
    throw new Error('Live AI access requires a server-side username and strong password.');
  }
  const failures = new Map();
  return (req, res, next) => {
    if (!enabled || !isChargeableAiRoute(req.method, req.url)) return next();
    const reject = (status, code) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="KUROHIGE MAP live AI", charset="UTF-8"');
      res.end(JSON.stringify({ error: { code } }));
    };
    if (!secureTransport(req, { productionMode, trustedProxySecret })) return reject(403, 'LIVE_AI_HTTPS_REQUIRED');
    const remote = req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const failed = failures.get(remote);
    if (failed && failed.until > now && failed.count >= 5) return reject(429, 'LIVE_AI_ACCESS_RATE_LIMITED');
    const header = req.headers.authorization;
    let user = '';
    let suppliedPassword = '';
    if (typeof header === 'string' && header.startsWith('Basic ') && header.length < 2048) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) {
        user = decoded.slice(0, colon);
        suppliedPassword = decoded.slice(colon + 1);
      }
    }
    if (sameSecret(user, username) && sameSecret(suppliedPassword, password)) {
      failures.delete(remote);
      if (req.method === 'GET' && new URL(req.url || '/', 'http://localhost').pathname.toLowerCase().replace(/\/+$/u, '') === '/api/live-ai-access') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end('Live AI access is ready. Return to KUROHIGE MAP.');
      }
      return next();
    }
    failures.set(remote, failed && failed.until > now
      ? { count: failed.count + 1, until: failed.until }
      : { count: 1, until: now + 60_000 });
    return reject(401, 'LIVE_AI_AUTH_REQUIRED');
  };
}
