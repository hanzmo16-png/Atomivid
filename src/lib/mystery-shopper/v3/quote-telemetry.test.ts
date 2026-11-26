import test from "node:test";
import assert from "node:assert/strict";
import { isKnownBlockedQuoteTelemetry } from "../../../../scripts/mystery-shopper/quote-telemetry";
test("only the observed Sentry telemetry host and envelope classify harmless; unknown and paid requests stay blocked", () => {
  const observed = { method: "POST", hostname: "o123.ingest.us.sentry.io", pathname: "/api/4512125522083840/envelope/" };
  assert.equal(isKnownBlockedQuoteTelemetry(observed), true);
  assert.equal(isKnownBlockedQuoteTelemetry({ ...observed, hostname: "o123.ingest.sentry.io" }), true);
  for (const hostname of [undefined, "atomivid.vercel.app", "api.openai.com", "evil.sentry.io", "o123.ingest.us.sentry.io.evil.com"]) assert.equal(isKnownBlockedQuoteTelemetry({ ...observed, hostname }), false);
  for (const pathname of ["/api/generate/id/render", "/api/generate/id/confirm-production", "/api/production-check", "/api/m", "/api/other/envelope/"]) assert.equal(isKnownBlockedQuoteTelemetry({ ...observed, pathname }), false);
  assert.equal(isKnownBlockedQuoteTelemetry({ ...observed, method: "GET" }), false);
});
