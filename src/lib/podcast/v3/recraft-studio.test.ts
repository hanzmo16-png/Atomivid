// Podcast Studio · Recraft: el adaptador de recreaciones cobra una vez por clave y nunca vuelve a pedir una imagen
// cuyo resultado es incierto. fal.ai SIMULADO (fetch falso / proveedor falso), USD 0, sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GenerativeProviderError, type ImageGenerationRequest, type ImageProvider } from "@/lib/providers/types";
import { recraftImageProvider, RECRAFT_USD_PER_IMAGE } from "@/lib/providers/image/recraft";
import { MemoryLedger, paidOnce, ProviderRejectedError, UncertainChargeError } from "./cost";
import { recraftRecreate, studioRecraftEnabled } from "./recraft-studio";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 2, 0, 0, 0, 2, 0]), Buffer.alloc(64)]);
type Calls = { submit: number; resume: number; requests: ImageGenerationRequest[] };
function fakeProvider(o: { submit?: () => Promise<{ providerJobId: string }>; resume?: () => Promise<Buffer>; available?: boolean } = {}): ImageProvider & { calls: Calls } {
  const calls: Calls = { submit: 0, resume: 0, requests: [] };
  return {
    name: "recraft", calls, capabilities: { id: "recraft", models: ["m"], formats: ["image/png"], aspectRatios: [], timeoutMs: 1, maxRetries: 0 } as never,
    isAvailable: () => o.available ?? true,
    generateImage: async () => { throw new Error("no se usa"); },
    async submitImage(r) { calls.submit++; calls.requests.push(r); return o.submit ? o.submit() : { providerJobId: "a1b2c3d4-0000-4000-8000-000000000001" }; },
    async resumeImage() { calls.resume++; const buffer = o.resume ? await o.resume() : PNG; return { buffer, mimeType: "image/png", extension: "png", model: "m", costUsd: RECRAFT_USD_PER_IMAGE }; },
  };
}
const dir = () => mkdtemp(path.join(os.tmpdir(), "rcs-"));
const pay = (ledger: MemoryLedger, key: string, call: () => Promise<{ result: string; actualUsd: number }>) =>
  paidOnce(ledger, { key, owner: "u1", episode: "ep", provider: "recraft", op: "recreacion", usd: RECRAFT_USD_PER_IMAGE, budgetUsd: 5, authorized: true }, call);

test("apagado por defecto: requiere PODCAST_STUDIO_RECRAFT=1 y FAL_KEY", () => {
  assert.equal(studioRecraftEnabled({}), false);
  assert.equal(studioRecraftEnabled({ FAL_KEY: "k" }), false);
  assert.equal(studioRecraftEnabled({ PODCAST_STUDIO_RECRAFT: "1" }), false);
  assert.equal(studioRecraftEnabled({ PODCAST_STUDIO_RECRAFT: "1", FAL_KEY: "  " }), false);
  assert.equal(studioRecraftEnabled({ PODCAST_STUDIO_RECRAFT: "1", FAL_KEY: "k" }), true);
});

test("éxito: una sola petición, imagen escrita, costo fijo de Recraft; el reintento reutiliza sin volver a pedir", async () => {
  const p = fakeProvider(), ledger = new MemoryLedger(), d = await dir(), dest = path.join(d, "rec.png");
  const rec = recraftRecreate("16:9", p);
  const r1 = await pay(ledger, "k1", async () => ({ result: dest, ...(await rec("Señal Wow: radiotelescopio Big Ear", dest)) }));
  assert.equal(r1.usd, RECRAFT_USD_PER_IMAGE); assert.equal(r1.reused, false);
  assert.deepEqual(await readFile(dest), PNG);
  assert.equal(p.calls.requests[0].aspectRatio, "16:9"); assert.equal(p.calls.requests[0].maxCostUsd, RECRAFT_USD_PER_IMAGE); assert.equal(p.calls.requests[0].disableRetries, true);
  const r2 = await pay(ledger, "k1", async () => ({ result: dest, ...(await rec("Señal Wow: radiotelescopio Big Ear", dest)) }));
  assert.equal(r2.reused, true); assert.equal(r2.usd, 0);
  assert.equal(p.calls.submit, 1); assert.equal(p.calls.resume, 1);
  assert.equal((await ledger.get("k1"))?.state, "settled");
});

test("rechazos ANTES de aceptar (saldo, credencial, 429, inválida, sin FAL_KEY): sin cargo, reserva liberada, el reintento puede pedirla", async () => {
  for (const reason of ["quota_exceeded", "authentication_error", "rate_limited", "invalid_request", "budget_exceeded"] as const) {
    let first = true;
    const p = fakeProvider({ submit: async () => { if (first) { first = false; throw new GenerativeProviderError(`fal ${reason}`, "recraft", reason); } return { providerJobId: "a1b2c3d4-0000-4000-8000-000000000002" }; } });
    const ledger = new MemoryLedger(), d = await dir(), dest = path.join(d, "rec.png"), rec = recraftRecreate("9:16", p);
    await assert.rejects(pay(ledger, "k", async () => ({ result: dest, ...(await rec("x", dest)) })), (e: Error) => e instanceof ProviderRejectedError, reason);
    assert.equal((await ledger.get("k"))?.state, "released", reason); assert.equal((await ledger.get("k"))?.actual_usd, 0, reason);
    const ok = await pay(ledger, "k", async () => ({ result: dest, ...(await rec("x", dest)) }));
    assert.equal(ok.usd, RECRAFT_USD_PER_IMAGE, reason); assert.equal(p.calls.submit, 2, reason);
  }
  const off = fakeProvider({ available: false }), ledger = new MemoryLedger(), d = await dir();
  await assert.rejects(pay(ledger, "k", async () => ({ result: "x", ...(await recraftRecreate("16:9", off)("x", path.join(d, "a.png"))) })), ProviderRejectedError);
  assert.equal(off.calls.submit, 0);
});

test("fallos DESPUÉS de aceptar (sin request_id, tiempo agotado, resultado vacío): incierto; el reintento NO vuelve a pedir la imagen", async () => {
  const cases: [string, Parameters<typeof fakeProvider>[0]][] = [
    ["200 sin request_id", { submit: async () => { throw new GenerativeProviderError("sin request_id", "recraft", "invalid_response"); } }],
    ["error 5xx del envío", { submit: async () => { throw new GenerativeProviderError("HTTP 503", "recraft", "upstream_error"); } }],
    ["tiempo agotado al sondear", { resume: async () => { throw new GenerativeProviderError("timeout", "recraft", "timeout", undefined, "a1b2c3d4-0000-4000-8000-000000000003"); } }],
    ["imagen vacía", { resume: async () => Buffer.alloc(0) }],
  ];
  for (const [label, o] of cases) {
    const p = fakeProvider(o), ledger = new MemoryLedger(), d = await dir(), dest = path.join(d, "rec.png"), rec = recraftRecreate("16:9", p);
    await assert.rejects(pay(ledger, "k", async () => ({ result: dest, ...(await rec("x", dest)) })), (e: Error) => !(e instanceof ProviderRejectedError), label);
    assert.equal((await ledger.get("k"))?.state, "uncertain", label);
    const before = p.calls.submit;
    await assert.rejects(pay(ledger, "k", async () => ({ result: dest, ...(await rec("x", dest)) })), UncertainChargeError, label);
    assert.equal(p.calls.submit, before, `${label}: no se vuelve a enviar`);
  }
});

test("con el proveedor real de fal.ai y fetch falso: HTTP 402 de saldo antes de aceptar → liberado sin cargo", async () => {
  const orig = global.fetch, prev = process.env.FAL_KEY;
  process.env.FAL_KEY = "fal-test-key";
  global.fetch = (async () => new Response(JSON.stringify({ detail: "Insufficient balance" }), { status: 402 })) as typeof fetch;
  try {
    const ledger = new MemoryLedger(), d = await dir(), dest = path.join(d, "rec.png"), rec = recraftRecreate("16:9", recraftImageProvider);
    await assert.rejects(pay(ledger, "k", async () => ({ result: dest, ...(await rec("x", dest)) })), ProviderRejectedError);
    assert.equal((await ledger.get("k"))?.state, "released");
  } finally { global.fetch = orig; if (prev === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prev; }
});
