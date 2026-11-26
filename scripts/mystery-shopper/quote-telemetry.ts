/** Classification only. The physical browser route still aborts every one of these requests. */
export function isKnownBlockedQuoteTelemetry(request: { method: string; hostname?: string; pathname: string }): boolean {
  // Observed project envelope; instrumentation-client.ts enables Sentry browser errors, whose SDK uses this route.
  return request.method === "POST" && /^o\d+\.ingest(?:\.[a-z]+)?\.sentry\.io$/.test(request.hostname ?? "")
    && request.pathname === "/api/4512125522083840/envelope/";
}
