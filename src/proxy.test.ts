/**
 * Proxy (middleware) configuration diagnostics: a missing Supabase variable must not be an opaque
 * 500 on every route. With a complete configuration the session redirect behaviour is unchanged.
 * No external network: the stub Supabase URL points at a closed local port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved = { ...process.env };
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) delete process.env[k];
  Object.assign(process.env, env);
  try { await fn(); } finally { process.env = saved; }
};

test("missing NEXT_PUBLIC_SUPABASE_URL → 503 naming the variable (name only), logged, never an opaque 500", async () => {
  await withEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key-value" }, async () => {
    const logged: string[] = [];
    const orig = console.error; console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      const res = await proxy(new NextRequest("https://preview.example.test/dashboard/command-center"));
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("x-atomivid-config-error"), "NEXT_PUBLIC_SUPABASE_URL");
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.text();
      assert.ok(body.includes('"NEXT_PUBLIC_SUPABASE_URL"') && body.includes("Preview"));
      assert.ok(!body.includes("stub-anon-key-value") && !logged.join("\n").includes("stub-anon-key-value"), "values never leak");
      assert.ok(logged.some((l) => l.includes("[proxy] configuration error") && l.includes("NEXT_PUBLIC_SUPABASE_URL")));
    } finally { console.error = orig; }
  });
});

test("missing NEXT_PUBLIC_SUPABASE_ANON_KEY is named too; the marketing root is affected the same way (it is the proxy, not a page)", async () => {
  await withEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:65530" }, async () => {
    const orig = console.error; console.error = () => {};
    try {
      const res = await proxy(new NextRequest("https://preview.example.test/"));
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("x-atomivid-config-error"), "NEXT_PUBLIC_SUPABASE_ANON_KEY");
    } finally { console.error = orig; }
  });
});

test("complete configuration: behaviour unchanged — anonymous /dashboard/* redirects to /login, public routes pass through", async () => {
  await withEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:65530", NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key" }, async () => {
    const redirected = await proxy(new NextRequest("https://preview.example.test/dashboard/command-center"));
    assert.equal(redirected.status, 307);
    assert.equal(new URL(redirected.headers.get("location")!).pathname, "/login");
    const open = await proxy(new NextRequest("https://preview.example.test/login"));
    assert.equal(open.status, 200);
    assert.equal(open.headers.get("x-atomivid-config-error"), null);
  });
});
