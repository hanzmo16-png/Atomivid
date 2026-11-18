/** Gates of the one-image FLUX test (USD 0: fetch mocked, no network, no key). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Hit = { url: string; method: string };
function mock(opts: { balance?: number; unitPrice?: number; authStatus?: number } = {}) {
  const hits: Hit[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u); const method = init?.method ?? "GET"; hits.push({ url, method });
    if (url.startsWith("https://api.fal.ai/v1/models?")) return Response.json({ models: [{ endpoint_id: "fal-ai/flux/dev", metadata: { status: "active" } }] });
    if (url.startsWith("https://api.fal.ai/v1/models/pricing?")) return opts.authStatus ? new Response("{}", { status: opts.authStatus })
      : Response.json({ prices: [{ endpoint_id: "fal-ai/flux/dev", unit_price: opts.unitPrice ?? 0.025, unit: "image", currency: "USD" }] });
    if (url === "https://api.fal.ai/v1/models/pricing/estimate") return Response.json({ estimate_type: "unit_price", total_cost: 0.025, currency: "USD" });
    if (url.startsWith("https://api.fal.ai/v1/account/billing")) return Response.json({ credits: { current_balance: opts.balance ?? 24.05, currency: "USD" } });
    if (url.startsWith("https://queue.fal.run/")) throw new Error("PAID CALL ATTEMPTED");
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { hits, restore: () => { globalThis.fetch = orig; } };
}
async function run(env: Record<string, string | undefined>, m = mock()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flux-test-"));
  const saved = { ...process.env };
  Object.assign(process.env, { FAL_KEY: "fake-key-aaaaaaaa", FAL_ADMIN_KEY: "fake-admin-bbbbbbbb", OUT_DIR: dir, FLUX_TEST_MODE: undefined, FLUX_TEST_AUTHORIZED_USD: undefined, FLUX_TEST_CONFIRM: undefined, GITHUB_STEP_SUMMARY: undefined });
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const k of ["FLUX_TEST_MODE", "FLUX_TEST_AUTHORIZED_USD", "FLUX_TEST_CONFIRM", "GITHUB_STEP_SUMMARY"]) if (!(k in env)) delete process.env[k];
  try {
    const { main } = await import("./flux-real-test");
    const report = await main();
    const file = fs.readFileSync(path.join(dir, "flux-real-test-report.json"), "utf8");
    return { report, file, hits: m.hits };
  } finally { m.restore(); process.env = saved; process.exitCode = 0; }
}
const paid = (hits: Hit[]) => hits.filter((h) => h.url.startsWith("https://queue.fal.run/")).length;

test("preflight completo: modelo activo, clave autenticada, precio, estimación y saldo; ninguna llamada pagada; sin secretos en el informe", async () => {
  const { report, file, hits } = await run({});
  assert.equal(report.verdict, "OK", JSON.stringify(report.checks));
  assert.equal(paid(hits), 0);
  assert.ok(!file.includes("fake-key-aaaaaaaa") && !file.includes("fake-admin-bbbbbbbb"));
});

test("generate sin frase de confirmación o sin autorización suficiente: NO genera (USD 0)", async () => {
  for (const env of [{ FLUX_TEST_MODE: "generate", FLUX_TEST_AUTHORIZED_USD: "0.50" },
    { FLUX_TEST_MODE: "generate", FLUX_TEST_AUTHORIZED_USD: "0.01", FLUX_TEST_CONFIRM: "GENERAR-UNA-IMAGEN-FLUX" },
    { FLUX_TEST_MODE: "generate", FLUX_TEST_AUTHORIZED_USD: "0.75", FLUX_TEST_CONFIRM: "GENERAR-UNA-IMAGEN-FLUX" }]) {
    const { report, hits } = await run(env);
    assert.equal(paid(hits), 0, JSON.stringify(env));
    assert.equal(report.verdict, "NO-OK");
  }
});

test("generate con clave rechazada o saldo insuficiente: el preflight falla y NO genera", async () => {
  for (const m of [mock({ authStatus: 401 }), mock({ balance: 0.01 })]) {
    const { report, hits } = await run({ FLUX_TEST_MODE: "generate", FLUX_TEST_AUTHORIZED_USD: "0.50", FLUX_TEST_CONFIRM: "GENERAR-UNA-IMAGEN-FLUX" }, m);
    assert.equal(paid(hits), 0);
    assert.equal(report.verdict, "NO-OK");
  }
});

test("generate autorizado (fal simulado): UN solo envío, request_id guardado, imagen 720×1280 validada y costo real leído de billing-events", async () => {
  const jpeg = (() => {
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(1280, 5); sof.writeUInt16BE(720, 7); sof[9] = 3;
    return Buffer.concat([head, sof, Buffer.alloc(4096, 7), Buffer.from([0xff, 0xd9])]);
  })();
  const base = mock();
  const inner = globalThis.fetch;
  const RID = "33333333-4444-4555-8666-777777777777";
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url === "https://queue.fal.run/fal-ai/flux/dev") { base.hits.push({ url, method: "POST" }); return Response.json({ request_id: RID }); }
    if (url === `https://queue.fal.run/fal-ai/flux/requests/${RID}/status`) return Response.json({ status: "COMPLETED" });
    if (url === `https://queue.fal.run/fal-ai/flux/requests/${RID}`) return Response.json({ images: [{ url: "https://v3b.fal.media/files/x.jpg" }], has_nsfw_concepts: [false], seed: 1, timings: {}, prompt: "p" });
    if (url === "https://v3b.fal.media/files/x.jpg") return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } });
    if (url.startsWith("https://api.fal.ai/v1/models/billing-events")) return Response.json({ billing_events: [{ request_id: RID, cost_total: 0.023, output_units: 0.92, unit: "image", unit_price: 0.025 }] });
    return inner(u, init);
  }) as typeof fetch;
  const { report, hits } = await run({ FLUX_TEST_MODE: "generate", FLUX_TEST_AUTHORIZED_USD: "0.50", FLUX_TEST_CONFIRM: "GENERAR-UNA-IMAGEN-FLUX", FLUX_POLL_INTERVAL_MS: "1" }, { hits: base.hits, restore: () => { globalThis.fetch = inner; base.restore(); } });
  assert.equal(hits.filter((h) => h.url === "https://queue.fal.run/fal-ai/flux/dev").length, 1, "exactly one paid submission");
  const g = report.generation as Record<string, unknown>;
  assert.equal(g.requestId, RID);
  assert.equal(g.width, 720); assert.equal(g.height, 1280);
  assert.equal(g.billedCostUsd, 0.023);
  assert.ok(report.checks.some((c) => c.check === "costo real registrado" && c.ok === true));
});
