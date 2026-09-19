import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerClient } from "@supabase/ssr";
import { createRecoveryProof, validRecoveryProof } from "./recovery";

// Real Supabase SDK + in-memory cookies, with all HTTP intercepted.
// No email, account, password or external service is touched by these tests.
function fixture() {
  const jar = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const user = { id: "owner", aud: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  const sdk = createServerClient("https://auth.example.test", "test-anon-key", {
    cookies: { getAll: () => Array.from(jar, ([name, value]) => ({ name, value })), setAll: values => values.forEach(v => v.value ? jar.set(v.name, v.value) : jar.delete(v.name)) },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/recover")) return new Response("{}", { status: 200 });
      if (url.pathname.endsWith("/token")) {
        if (body.auth_code !== "valid-code") return new Response(JSON.stringify({ error_code: "otp_expired", msg: "Expired" }), { status: 400 });
        assert.equal(typeof body.code_verifier, "string");
        return new Response(JSON.stringify({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600, token_type: "bearer", user }), { status: 200 });
      }
      if (url.pathname.endsWith("/user")) return new Response(JSON.stringify(user), { status: 200 });
      if (url.pathname.endsWith("/logout")) return new Response(null, { status: 204 });
      throw Error("Unexpected request: " + url.pathname);
    } },
  });
  return { sdk, calls, jar };
}
test("SDK recovery lifecycle: request, PKCE exchange, proof, update and sign-out", async () => {
  const { sdk, calls, jar } = fixture();
  assert.equal((await sdk.auth.resetPasswordForEmail("owner@example.test", { redirectTo: "https://atomivid.example/auth/callback?next=/reset-password" })).error, null);
  assert.ok(calls[0].body.code_challenge);
  const result = await sdk.auth.exchangeCodeForSession("valid-code");
  assert.equal(result.error, null);
  assert.equal("redirectType" in result.data && result.data.redirectType, "recovery");
  const session = result.data.session!;
  const proof = createRecoveryProof(result.data.user!.id, session.access_token, "local-test-key");
  assert.equal(validRecoveryProof(proof, result.data.user!.id, session.access_token, "local-test-key"), true);
  assert.equal((await sdk.auth.updateUser({ password: "a test-only passphrase" })).error, null);
  assert.ok(calls.some(call => call.path.endsWith("/user") && call.body.password === "a test-only passphrase"));
  assert.equal((await sdk.auth.signOut({ scope: "global" })).error, null);
  assert.ok(calls.some(call => call.path.endsWith("/logout")));
  assert.equal(Array.from(jar.keys()).some(key => key.endsWith("auth-token")), false);
});
test("expired code yields no authenticated session or recovery authorization", async () => {
  const { sdk } = fixture();
  await sdk.auth.resetPasswordForEmail("owner@example.test");
  const result = await sdk.auth.exchangeCodeForSession("expired-code");
  assert.ok(result.error);
  assert.equal(result.data.session, null);
});
