export const PERSON_CONTEXT_EXPANSION_TIMEOUT_MS = 9 * 60 * 1000;

export async function requestPersonContextExpansion<T>(
  body: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PERSON_CONTEXT_EXPANSION_TIMEOUT_MS,
): Promise<{ response: Response; payload: T }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new DOMException('Person Context expansion timed out.', 'TimeoutError'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl('/api/world-expand', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
        return { response, payload: await response.json() as T };
      })(),
      deadline,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
