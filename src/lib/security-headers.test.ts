import test from "node:test";
import assert from "node:assert/strict";
import { ENFORCED_CSP, connectOrigins, reportOnlyCsp, securityHeaders } from "./security-headers";
import nextConfig from "../../next.config";

const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co", NEXT_PUBLIC_SENTRY_DSN: "https://k@o1.ingest.us.sentry.io/2", NODE_ENV: "production" };
const byKey = (h: { key: string; value: string }[]) => Object.fromEntries(h.map((x) => [x.key, x.value]));

test("security headers: anti-iframe, nosniff, referrer and an enforced CSP that cannot break the product", () => {
  const h = byKey(securityHeaders(ENV));
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
  const csp = h["Content-Security-Policy"];
  assert.equal(csp, ENFORCED_CSP);
  for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) assert.ok(csp.includes(d), d);
  // The enforced policy must not restrict what Next/Supabase/Sentry/Stripe/media need: no fetch directives at all.
  for (const d of ["default-src", "script-src", "style-src", "img-src", "media-src", "connect-src", "form-action"]) assert.ok(!csp.includes(d), `enforced CSP must not contain ${d}`);
});

test("report-only CSP covers the real origins (Supabase https + wss, Sentry) and never enforces", () => {
  const ro = reportOnlyCsp(ENV);
  assert.match(ro, /connect-src 'self' [^;]*https:\/\/abcd\.supabase\.co/);
  assert.match(ro, /connect-src [^;]*wss:\/\/abcd\.supabase\.co/);
  assert.match(ro, /connect-src [^;]*https:\/\/o1\.ingest\.us\.sentry\.io/);
  assert.match(ro, /media-src 'self' blob: https: https:\/\/abcd\.supabase\.co/, "signed media URLs from storage keep playing");
  assert.match(reportOnlyCsp({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }), /media-src [^;]*http:\/\/127\.0\.0\.1:54321/, "local http storage too (harness)");
  assert.match(ro, /form-action 'self' https:\/\/checkout\.stripe\.com/);
  assert.ok(!ro.includes("unsafe-eval"), "no unsafe-eval in production");
  assert.ok(reportOnlyCsp({ ...ENV, NODE_ENV: "development" }).includes("'unsafe-eval'"), "dev needs unsafe-eval (React)");
  assert.ok(!/report-uri|report-to/.test(ro), "no reporting endpoint: nothing is sent anywhere");
});

test("missing or invalid public URLs never produce a broken policy", () => {
  assert.deepEqual(connectOrigins({}).filter((o) => o.includes("supabase")), []);
  assert.doesNotThrow(() => reportOnlyCsp({ NEXT_PUBLIC_SUPABASE_URL: "not a url" }));
  assert.ok(!reportOnlyCsp({ NEXT_PUBLIC_SUPABASE_URL: "not a url" }).includes("undefined"));
});

test("next.config applies the headers to every route", async () => {
  const rules = await (nextConfig as { headers?: () => Promise<{ source: string; headers: { key: string }[] }[]> }).headers!();
  const all = rules.find((r) => r.source === "/:path*");
  assert.ok(all, "a catch-all rule exists");
  for (const k of ["Content-Security-Policy", "Content-Security-Policy-Report-Only", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy"]) assert.ok(all!.headers.some((h) => h.key === k), k);
});
