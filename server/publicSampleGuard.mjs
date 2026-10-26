export const PUBLIC_SAMPLE_SERVER_BLOCK_CODE = 'PUBLIC_SAMPLE_SERVER_API_BLOCKED';

const pathnameOf = (requestUrl = '/') => {
  try { return new URL(requestUrl, 'http://127.0.0.1').pathname; } catch { return '/'; }
};

export function createPublicSampleApiGuard({ sampleOnly = false } = {}) {
  return (request, response, next) => {
    if (!sampleOnly || !pathnameOf(request.url).startsWith('/api/')) {
      next();
      return;
    }
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: {
      code: PUBLIC_SAMPLE_SERVER_BLOCK_CODE,
      message: 'This deployment is locked to the public sample. AI and production data APIs are unavailable.',
    } }));
  };
}
