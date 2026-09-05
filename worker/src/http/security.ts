/**
 * Applied to every Worker response. no-store is the load-bearing one: audio,
 * transcripts and session state must never sit in a shared cache.
 */
export function applySecurityHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
