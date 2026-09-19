import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

let providerError: { status?: number; message: string } | null = null;
let throwNetwork = false;
let cooldown = false;
let calls = 0;
const writes: string[] = [];
class Redirect extends Error { constructor(public path: string) { super(path); } }
mock.module("next/navigation", { namedExports: { redirect: (path: string) => { throw new Redirect(path); } } });
mock.module("next/headers", { namedExports: { cookies: async () => ({
  get: () => cooldown ? { value: "1" } : undefined,
  delete: () => {},
  set: (name: string) => { writes.push(name); },
}) } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => ({ auth: {
  resetPasswordForEmail: async () => {
    calls++;
    if (throwNetwork) throw Error("network unavailable");
    return { error: providerError };
  },
} }) } });
// Keep the real form and alerts; only replace the client pending-state button.
mock.module("@/components/auth/AuthSubmit", { namedExports: { AuthSubmit: () => <button>Enviar enlace de recuperación</button> } });
let requestPasswordReset: typeof import("./actions").requestPasswordReset;
let ForgotPassword: typeof import("./page").default;
before(async () => {
  ({ requestPasswordReset } = await import("./actions"));
  ({ default: ForgotPassword } = await import("./page"));
});

async function submit() {
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  const form = new FormData(); form.set("email", "owner@example.test");
  try { await requestPasswordReset(form); assert.fail("Expected redirect"); }
  catch (error) { if (error instanceof Redirect) return new URL(error.path, "https://example.test"); throw error; }
}
async function render(url: URL) {
  return renderToStaticMarkup(await ForgotPassword({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
}
function reset() { providerError = null; throwNetwork = false; cooldown = false; calls = 0; writes.length = 0; }

test("blocked recovery and provider failures render an error, never success", async () => {
  for (const status of [429, 400, 403, 422, 500, 503, undefined]) {
    reset(); providerError = { status, message: "private provider details" };
    const url = await submit(); const html = await render(url);
    assert.equal(calls, 1);
    assert.equal(url.searchParams.has("sent"), false);
    assert.match(html, /role="alert"/);
    assert.match(html, /No se pudo enviar el enlace/);
    assert.doesNotMatch(html, /bg-success-soft|Solicitud aceptada|private provider details/);
    assert.deepEqual(writes, []);
  }
});
test("network failures render an error, never success", async () => {
  reset(); throwNetwork = true;
  const html = await render(await submit());
  assert.match(html, /No se pudo enviar el enlace/);
  assert.doesNotMatch(html, /bg-success-soft|Solicitud aceptada/);
});
test("local cooldown does not send or pretend that a new email was sent", async () => {
  reset(); cooldown = true;
  const html = await render(await submit());
  assert.equal(calls, 0);
  assert.match(html, /No se ha enviado otro enlace/);
  assert.doesNotMatch(html, /bg-success-soft|Solicitud aceptada/);
});
test("accepted request renders conditional success without claiming delivery", async () => {
  reset(); const url = await submit(); const html = await render(url);
  assert.equal(calls, 1); assert.equal(url.searchParams.get("sent"), "1");
  assert.match(html, /Solicitud aceptada/);
  assert.match(html, /Esto no confirma la entrega/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.deepEqual(writes, ["atomivid-recovery-cooldown"]);
});
test("error takes precedence if the URL contains both error and success", async () => {
  const html = await render(new URL("https://example.test/forgot-password?sent=1&error=No+se+pudo+enviar"));
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /bg-success-soft|Solicitud aceptada/);
});
