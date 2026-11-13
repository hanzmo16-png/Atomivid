import { test } from "node:test";
import assert from "node:assert/strict";
import { fluxImageProvider, fluxEstimatedCostUsd, fluxInput, FLUX_MODEL, FLUX_SIZES } from "./flux";
import { getImageProvider, getFluxImageProvider, getRecraftImageProvider } from "./index";
import { recraftImageProvider } from "./recraft";
import { GenerativeProviderError, type ImageGenerationRequest } from "../types";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import type { StoryboardScene } from "@/lib/video/storyboard/types";

const FAKE_KEY = "fal-flux-test-key-not-real";
const RID = "22222222-3333-4444-8555-666666666666";

/** Minimal JPEG (SOI + APP0 + SOF0 with the given size), padded so it passes the byte-size floor. */
export function jpeg(width: number, height: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([head, sof, Buffer.alloc(4096, 0x11), Buffer.from([0xff, 0xd9])]);
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const orig = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of orig) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };
/** HTTP mock of the fal queue (no network). */
function mockFal(script: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const orig = global.fetch;
  global.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(u), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return script(c, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => { global.fetch = orig; } };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const REQ: ImageGenerationRequest = { prompt: "an ancient fortress at night", aspectRatio: "9:16", maxCostUsd: 0.05 };
const FAST = { FAL_KEY: FAKE_KEY, FLUX_POLL_INTERVAL_MS: "1", FLUX_TIMEOUT_MS: "200" };
const RESULT_URL = `https://queue.fal.run/fal-ai/flux/requests/${RID}`;

function happy(opts: { statuses?: string[]; img?: Buffer; ct?: string; nsfw?: boolean } = {}) {
  const statuses = opts.statuses ?? ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
  let s = 0;
  return (c: Call) => {
    if (c.method === "POST") return json({ request_id: RID, status_url: `${RESULT_URL}/status`, response_url: RESULT_URL });
    if (c.url === `${RESULT_URL}/status`) return json({ status: statuses[Math.min(s++, statuses.length - 1)], request_id: RID });
    if (c.url === RESULT_URL) return json({ images: [{ url: "https://v3b.fal.media/files/flux.jpg", content_type: "image/jpeg", width: 720, height: 1280 }],
      timings: { inference: 2.1 }, seed: 42, has_nsfw_concepts: [opts.nsfw === true], prompt: "x" });
    if (c.url.startsWith("https://v3b.fal.media/")) return new Response(new Uint8Array(opts.img ?? jpeg(720, 1280)), { status: 200, headers: { "content-type": opts.ct ?? "image/jpeg" } });
    return new Response(null, { status: 404 });
  };
}

test("precio publicado: 720×1280 y 1280×720 = 0,92 MP → 1 MP facturado → USD 0,025", () => {
  assert.equal(fluxEstimatedCostUsd({ aspectRatio: "9:16" }), 0.025);
  assert.equal(fluxEstimatedCostUsd({ aspectRatio: "16:9" }), 0.025);
  assert.ok(FLUX_SIZES["9:16"].width * FLUX_SIZES["9:16"].height <= 1_000_000);
  assert.equal(FLUX_SIZES["9:16"].width % 16, 0);
  assert.equal(FLUX_SIZES["9:16"].height % 16, 0);
});

test("payload 9:16: tamaño exacto vertical, una imagen, filtro de seguridad activado, sin campos de estilo", () => {
  const body = fluxInput(REQ);
  assert.deepEqual(body.image_size, { width: 720, height: 1280 });
  assert.equal(body.num_images, 1);
  assert.equal(body.enable_safety_checker, true);
  assert.equal(body.output_format, "jpeg");
  assert.equal(body.num_inference_steps, 28);
  assert.equal(body.guidance_scale, 3.5);
  assert.equal("style_id" in body || "image_urls" in body || "sync_mode" in body, false);
});

test("payload 16:9: tamaño exacto horizontal (Long Form)", () => {
  assert.deepEqual(fluxInput({ ...REQ, aspectRatio: "16:9" }).image_size, { width: 1280, height: 720 });
});

test("validación: prompt vacío, prompt demasiado largo y formato no admitido → invalid_request sin llamar", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      for (const bad of [{ ...REQ, prompt: "   " }, { ...REQ, prompt: "x".repeat(2001) }, { ...REQ, aspectRatio: "1:1" as never }]) {
        await assert.rejects(fluxImageProvider.submitImage!(bad), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
      }
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("sin FAL_KEY: not_configured, cero llamadas, y el selector lo dice claro", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv({ FAL_KEY: undefined }, async () => {
      assert.equal(fluxImageProvider.isAvailable(), false);
      await assert.rejects(fluxImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "not_configured");
      assert.throws(() => getFluxImageProvider(), /FLUX vía fal\.ai: falta FAL_KEY/);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("estimado sobre el máximo: budget_exceeded ANTES de enviar", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(fluxImageProvider.submitImage!({ ...REQ, maxCostUsd: 0.02 }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("envío: endpoint fal-ai/flux/dev, Authorization Key, X-Fal-No-Retry; sondeo y resultado por owner/app", async () => {
  const m = mockFal(happy());
  try {
    await withEnv(FAST, async () => {
      const a = await fluxImageProvider.generateImage(REQ);
      assert.equal(a.model, FLUX_MODEL);
      assert.equal(a.mimeType, "image/jpeg");
      assert.equal(a.extension, "jpg");
      assert.equal(a.width, 720);
      assert.equal(a.height, 1280);
      assert.equal(a.costUsd, 0.025);
      assert.equal(a.costBasis, "estimated");
      assert.equal(a.providerJobId, RID);
      assert.equal(a.styleId, undefined);
    });
    const post = m.calls[0];
    assert.equal(post.url, "https://queue.fal.run/fal-ai/flux/dev");
    assert.equal(post.headers.Authorization, `Key ${FAKE_KEY}`);
    assert.equal(post.headers["X-Fal-No-Retry"], "1");
    assert.deepEqual(post.body?.image_size, { width: 720, height: 1280 });
    assert.equal(m.calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(m.calls.some((c) => c.url === `${RESULT_URL}/status`));
    assert.ok(m.calls.some((c) => c.url === RESULT_URL));
    // The key goes only to fal's queue, never to the media host.
    for (const c of m.calls.filter((x) => x.url.startsWith("https://v3b.fal.media/"))) assert.equal(c.headers.Authorization, undefined);
  } finally { m.restore(); }
});

test("errores HTTP del envío: categoría fija, sin eco del cuerpo ni de la clave", async () => {
  const cases: Array<[number, string, GenerativeProviderError["reason"]]> = [
    [402, "insufficient balance", "quota_exceeded"], [401, "bad key", "authentication_error"], [403, "forbidden", "authentication_error"],
    [429, "slow down", "rate_limited"], [422, "SECRET-PROMPT-ECHO", "invalid_request"], [500, "boom", "upstream_error"],
  ];
  for (const [status, body, reason] of cases) {
    const m = mockFal(() => json({ detail: body }, status));
    try {
      await withEnv(FAST, async () => {
        await assert.rejects(fluxImageProvider.submitImage!(REQ), (e: unknown) => {
          assert.ok(e instanceof GenerativeProviderError);
          assert.equal(e.reason, reason, `HTTP ${status}`);
          assert.equal(e.providerId, "flux");
          assert.ok(!e.message.includes(FAKE_KEY));
          assert.ok(!e.message.includes("SECRET-PROMPT-ECHO"));
          return true;
        });
      });
    } finally { m.restore(); }
  }
});

test("red caída en el envío: upstream_error SIN request_id (incierto: nunca se reenvía)", async () => {
  const m = mockFal(() => { throw new TypeError("fetch failed"); });
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(fluxImageProvider.submitImage!(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "upstream_error" && !e.providerJobId);
    });
  } finally { m.restore(); }
});

test("200 sin request_id válido: invalid_response (puede haberse aceptado: nunca se reenvía)", async () => {
  const m = mockFal(() => json({ request_id: "../x" }));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(fluxImageProvider.submitImage!(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_response");
    });
  } finally { m.restore(); }
});

test("COMPLETED con error y estado desconocido conservan el request_id", async () => {
  for (const st of [{ status: "COMPLETED", error: "x", error_type: "worker_error" }, { status: "WEIRD" }]) {
    const m = mockFal((c) => (c.url.endsWith("/status") ? json(st) : json({})));
    try {
      await withEnv(FAST, async () => {
        await assert.rejects(fluxImageProvider.resumeImage!(RID, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.providerJobId === RID);
      });
    } finally { m.restore(); }
  }
});

test("timeout de sondeo: reason timeout con request_id (reanudable sin volver a cobrar)", async () => {
  const m = mockFal((c) => (c.url.endsWith("/status") ? json({ status: "IN_QUEUE" }) : json({})));
  try {
    await withEnv({ ...FAST, FLUX_TIMEOUT_MS: "5", FLUX_POLL_INTERVAL_MS: "10" }, async () => {
      await assert.rejects(fluxImageProvider.resumeImage!(RID, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "timeout" && e.providerJobId === RID);
    });
    assert.equal(m.calls.filter((c) => c.method === "POST").length, 0);
  } finally { m.restore(); }
});

test("filtro de seguridad de fal marcó la imagen: no se usa y queda como costo incierto (no 'sin cobro')", async () => {
  const m = mockFal(happy({ nsfw: true }));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(fluxImageProvider.resumeImage!(RID, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_response" && e.providerJobId === RID);
    });
  } finally { m.restore(); }
});

test("descarga: imagen diminuta, tipo cruzado o vacía → rechazada con request_id", async () => {
  for (const o of [{ img: jpeg(100, 100) }, { ct: "image/png" }, { img: Buffer.alloc(0) }, { ct: "text/html" }]) {
    const m = mockFal(happy({ statuses: ["COMPLETED"], ...o }));
    try {
      await withEnv(FAST, async () => {
        await assert.rejects(fluxImageProvider.resumeImage!(RID, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.providerJobId === RID);
      });
    } finally { m.restore(); }
  }
});

test("regresión: IMAGE_PROVIDER nunca selecciona flux; Recraft sigue intacto", async () => {
  await withEnv({ IMAGE_PROVIDER: "flux", FAL_KEY: FAKE_KEY, OPENAI_API_KEY: undefined, NODE_ENV: "test", VERCEL: undefined, ATOMIVID_RUNTIME: undefined }, async () => {
    assert.equal(getImageProvider().name, "fixture");
    assert.equal(getRecraftImageProvider(), recraftImageProvider);
    assert.equal(getFluxImageProvider(), fluxImageProvider);
  });
});

// ---- Integración con la puerta de pagos (ledger en memoria + Storage simulado + HTTP mock de fal) ----
function fakeStorage() {
  const objects = new Map<string, number>();
  const sb = { storage: { from() { return {
    async list(dir: string, o?: { search?: string }) { return { data: [...objects.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) })).filter((f) => !o?.search || f.name.startsWith(o.search)), error: null }; },
    async upload(p: string, b: Buffer) { objects.set(p, b.byteLength); return { error: null }; },
    async createSignedUrl(p: string) { return { data: { signedUrl: `https://signed.example.test/${p}` }, error: null }; },
  }; } } } as never;
  return { sb, objects };
}
const scene = { imagePrompt: "an ancient fortress at night", negativePrompt: "text" } as StoryboardScene;

test("integración: request_id en el ledger ANTES del sondeo; reserva = estimado; costo registrado; imagen persistida", async () => {
  const ledger = memoryLedgerStore();
  const { sb, objects } = fakeStorage();
  let seenAtPoll: string | undefined;
  const base = happy();
  const m = mockFal((c) => {
    if (c.url.endsWith("/status") && !seenAtPoll) { const row = [...ledger.ops.values()][0]; seenAtPoll = `${row.status}:${row.providerJobId}`; }
    return base(c);
  });
  try {
    await withEnv(FAST, async () => {
      const out = await resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-f1", sceneIndex: 0, scene,
        imageProvider: fluxImageProvider, remainingBudgetUsd: 0.025, signedUrlTtlSeconds: 60, objectKey: "scene-0-flux" });
      assert.equal(out.status, "generated");
      assert.equal(out.provider, "flux");
      assert.equal(out.path, "req-f1/scene-0-flux.jpg");
      assert.equal(out.costUsd, 0.025);
    });
    assert.equal(seenAtPoll, `PROVIDER_JOB_RECORDED:${RID}`);
    const row = [...ledger.ops.values()][0];
    assert.equal(row.status, "COMMITTED");
    assert.equal(row.provider, "flux");
    assert.equal(row.reservedUsd, 0.025);
    assert.equal(row.committedUsd, 0.025);
    assert.ok(objects.has("req-f1/scene-0-flux.jpg"));
  } finally { m.restore(); }
});

test("integración: interrupción tras el envío → el reintento REANUDA el mismo request_id; un solo envío pagado", async () => {
  const ledger = memoryLedgerStore();
  const { sb } = fakeStorage();
  let crash = true;
  const base = happy({ statuses: ["COMPLETED"] });
  const m = mockFal((c) => {
    if (crash && c.url.endsWith("/status")) throw new TypeError("fetch failed (worker killed)");
    return base(c);
  });
  const run = () => resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-f2", sceneIndex: 1, scene,
    imageProvider: fluxImageProvider, remainingBudgetUsd: 0.025, signedUrlTtlSeconds: 60, objectKey: "scene-1-flux" });
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(run());
      assert.equal([...ledger.ops.values()][0].status, "PROVIDER_JOB_RECORDED");
      crash = false;
      assert.equal((await run()).status, "generated");
      // Third run: the stored object is reused, nothing is called or paid again.
      const calls = m.calls.length;
      assert.equal((await run()).status, "reused");
      assert.equal(m.calls.length, calls);
    });
    assert.equal(m.calls.filter((c) => c.method === "POST").length, 1, "un solo envío pagado");
    assert.equal([...ledger.ops.values()][0].status, "COMMITTED");
  } finally { m.restore(); }
});

test("integración: saldo insuficiente (402) → REFUNDED sin cobro, nada guardado, sin sustituto", async () => {
  const ledger = memoryLedgerStore();
  const { sb, objects } = fakeStorage();
  const m = mockFal(() => json({ detail: "insufficient balance" }, 402));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-f3", sceneIndex: 0, scene,
        imageProvider: fluxImageProvider, remainingBudgetUsd: 0.025, signedUrlTtlSeconds: 60, objectKey: "scene-0-flux" }), /saldo/);
    });
    assert.equal([...ledger.ops.values()][0].status, "REFUNDED");
    assert.equal(objects.size, 0);
  } finally { m.restore(); }
});

test("integración: sin ledger un proveedor real nunca se llama", async () => {
  const { sb } = fakeStorage();
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(resolveGeneratedImageForScene({ supabase: sb, bucket: "videos", requestId: "req-f4", sceneIndex: 0, scene,
        imageProvider: fluxImageProvider, remainingBudgetUsd: 0.025, signedUrlTtlSeconds: 60 }), /sin puerta/);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});
