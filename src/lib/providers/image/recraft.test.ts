import { test } from "node:test";
import assert from "node:assert/strict";
import { recraftImageProvider, recraftEstimatedCostUsd, imageDimensions, RECRAFT_MODEL } from "./recraft";
import { getImageProvider, getRecraftImageProvider } from "./index";
import { GenerativeProviderError } from "../types";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import type { StoryboardScene } from "@/lib/video/storyboard/types";

const FAKE_KEY = "fal-test-key-not-real";
const RID = "11111111-2222-4333-8444-555555555555";

export function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(200, 0);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(192, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const orig = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of orig) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
/** HTTP mock of the fal queue (no network). `script` decides each response. */
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
const REQ = { prompt: "a lighthouse at dawn", aspectRatio: "9:16" as const, maxCostUsd: 1, style: { referenceImageUrls: ["https://signed.example.test/ref-0.png?token=x"] } };
const FAST = { FAL_KEY: FAKE_KEY, RECRAFT_POLL_INTERVAL_MS: "1", RECRAFT_TIMEOUT_MS: "200" };

function happy(statuses: string[] = ["IN_PROGRESS", "COMPLETED"], img = webp(1080, 1920), ct = "image/webp") {
  let s = 0;
  return (c: Call) => {
    if (c.method === "POST") return json({ request_id: RID, status_url: "x", response_url: "y" });
    if (c.url.endsWith("/status")) return json({ status: statuses[Math.min(s++, statuses.length - 1)], request_id: RID });
    if (c.url === `https://queue.fal.run/recraft/v4/requests/${RID}`) return json({ images: [{ url: "https://v3b.fal.media/files/x.webp", content_type: "image/webp" }], style_id: "6654d01b-7c9d-4f87-9f99-80e6cb989380" });
    if (c.url.startsWith("https://v3b.fal.media/")) return new Response(new Uint8Array(img), { status: 200, headers: { "content-type": ct } });
    return new Response(null, { status: 404 });
  };
}

test("precio publicado: 0.035 con style_id, 0.040 creando el estilo desde referencias", () => {
  assert.equal(recraftEstimatedCostUsd({ style: { styleId: "6654d01b-7c9d" } }), 0.035);
  assert.equal(Math.round(recraftEstimatedCostUsd({ style: { referenceImageUrls: ["u"] } }) * 1000) / 1000, 0.04);
});

test("sin FAL_KEY: not_configured y cero llamadas HTTP", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv({ FAL_KEY: undefined }, async () => {
      await assert.rejects(recraftImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "not_configured" && /FAL_KEY/.test(e.message));
      assert.throws(() => getRecraftImageProvider(), /FAL_KEY/);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("estimado sobre el máximo: budget_exceeded ANTES de enviar", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(recraftImageProvider.generateImage({ ...REQ, maxCostUsd: 0.01 }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("envío: endpoint, Authorization Key, X-Fal-No-Retry y payload del esquema oficial (referencias → sin style_id)", async () => {
  const m = mockFal(happy());
  try {
    await withEnv(FAST, async () => {
      const a = await recraftImageProvider.generateImage(REQ);
      assert.equal(a.styleId, "6654d01b-7c9d-4f87-9f99-80e6cb989380");
      assert.equal(a.mimeType, "image/webp");
      assert.equal(a.width, 1080); assert.equal(a.height, 1920);
      assert.equal(a.providerJobId, RID);
      assert.equal(a.model, RECRAFT_MODEL);
    });
    const post = m.calls[0];
    assert.equal(post.url, "https://queue.fal.run/recraft/v4/style/text-to-image");
    assert.equal(post.headers.Authorization, `Key ${FAKE_KEY}`);
    assert.equal(post.headers["X-Fal-No-Retry"], "1");
    assert.deepEqual(post.body, { prompt: REQ.prompt, image_size: "portrait_16_9", enable_safety_checker: true, image_urls: REQ.style.referenceImageUrls });
    // status/result use only owner/app (recraft/v4), per the queue docs
    assert.ok(m.calls.some((c) => c.url === `https://queue.fal.run/recraft/v4/requests/${RID}/status`));
  } finally { m.restore(); }
});

test("con style_id se reutiliza el estilo (sin image_urls) y 16:9 usa landscape_16_9", async () => {
  const m = mockFal(happy());
  try {
    await withEnv(FAST, async () => {
      await recraftImageProvider.generateImage({ ...REQ, aspectRatio: "16:9", style: { styleId: "6654d01b-7c9d-4f87-9f99-80e6cb989380", match: "flexible" } });
    });
    const b = m.calls[0].body as Record<string, unknown>;
    assert.equal(b.style_id, "6654d01b-7c9d-4f87-9f99-80e6cb989380");
    assert.equal(b.image_urls, undefined);
    assert.equal(b.style_match, "flexible");
    assert.equal(b.image_size, "landscape_16_9");
  } finally { m.restore(); }
});

test("sin style_id ni referencias: invalid_request sin llamar", async () => {
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(recraftImageProvider.generateImage({ ...REQ, style: {} }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

for (const [status, body, reason] of [
  [402, { detail: "payment required" }, "quota_exceeded"],
  [403, { detail: "User is locked. Reason: Exhausted balance." }, "quota_exceeded"],
  [401, { detail: "unauthorized" }, "authentication_error"],
  [429, {}, "rate_limited"],
  [422, { detail: "bad" }, "invalid_request"],
  [500, {}, "upstream_error"],
] as const) {
  test(`envío HTTP ${status} → ${reason}, mensaje sin la clave`, async () => {
    const m = mockFal(() => json(body, status));
    try {
      await withEnv(FAST, async () => {
        await assert.rejects(recraftImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === reason && !e.message.includes(FAKE_KEY) && !e.providerJobId);
      });
      assert.equal(m.calls.length, 1);
    } finally { m.restore(); }
  });
}

test("COMPLETED con error: upstream_error conservando el request_id", async () => {
  const m = mockFal((c) => c.method === "POST" ? json({ request_id: RID }) : json({ status: "COMPLETED", error: "boom", error_type: "runner_error" }));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(recraftImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "upstream_error" && e.providerJobId === RID);
    });
  } finally { m.restore(); }
});

test("timeout de sondeo: reason timeout con request_id (reanudable, nunca reenvía)", async () => {
  const m = mockFal((c) => c.method === "POST" ? json({ request_id: RID }) : json({ status: "IN_QUEUE" }));
  try {
    await withEnv({ ...FAST, RECRAFT_TIMEOUT_MS: "20", RECRAFT_POLL_INTERVAL_MS: "5" }, async () => {
      await assert.rejects(recraftImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "timeout" && e.providerJobId === RID);
    });
    assert.equal(m.calls.filter((c) => c.method === "POST").length, 1);
  } finally { m.restore(); }
});

for (const [name, img, ct, reason] of [
  ["vacía", Buffer.alloc(0), "image/webp", "download_failed"],
  ["HTML", Buffer.from("<html>expired</html>"), "text/html", "invalid_response"],
  ["demasiado pequeña", webp(100, 100), "image/webp", "invalid_response"],
  ["tipo declarado ≠ contenido", webp(1080, 1920), "image/png", "invalid_response"],
] as const) {
  test(`descarga ${name} → ${reason}`, async () => {
    const m = mockFal(happy(["COMPLETED"], img as Buffer, ct));
    try {
      await withEnv(FAST, async () => {
        await assert.rejects(recraftImageProvider.generateImage(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === reason && e.providerJobId === RID);
      });
    } finally { m.restore(); }
  });
}

test("imageDimensions lee PNG, WEBP VP8X y JPEG", () => {
  const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  assert.deepEqual(imageDimensions(png), { type: "image/png", width: 800, height: 600 });
  assert.deepEqual(imageDimensions(webp(1080, 1920)), { type: "image/webp", width: 1080, height: 1920 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageDimensions(jpg), { type: "image/jpeg", width: 1080, height: 1920 });
});

test("regresión: IMAGE_PROVIDER nunca selecciona recraft (solo la elección por video)", async () => {
  await withEnv({ IMAGE_PROVIDER: "recraft", FAL_KEY: FAKE_KEY, OPENAI_API_KEY: undefined, NODE_ENV: "test", VERCEL: undefined, ATOMIVID_RUNTIME: undefined }, async () => {
    assert.equal(getImageProvider().name, "fixture");
  });
});

// ---- Integración con la puerta de pagos (ledger en memoria + HTTP mock de fal) ----
function fakeStorage() {
  const objects = new Map<string, number>();
  const sb = { storage: { from() { return {
    async list(dir: string, o?: { search?: string }) { return { data: [...objects.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) })).filter((f) => !o?.search || f.name.startsWith(o.search)), error: null }; },
    async upload(p: string, b: Buffer) { objects.set(p, b.byteLength); return { error: null }; },
    async createSignedUrl(p: string) { return { data: { signedUrl: `https://signed.example.test/${p}` }, error: null }; },
  }; } } } as never;
  return { sb, objects };
}
const scene = { imagePrompt: "a lighthouse at dawn", negativePrompt: "text" } as StoryboardScene;

test("integración: request_id queda en el ledger ANTES del sondeo; reserva = estimado; costo real registrado", async () => {
  const ledger = memoryLedgerStore();
  const { sb, objects } = fakeStorage();
  let seenAtPoll: string | undefined;
  const base = happy();
  const m = mockFal((c) => {
    if (c.url.endsWith("/status")) { const row = [...ledger.ops.values()][0]; seenAtPoll = `${row.status}:${row.providerJobId}`; }
    return base(c);
  });
  try {
    await withEnv(FAST, async () => {
      const out = await resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-1", sceneIndex: 0, scene,
        imageProvider: recraftImageProvider, remainingBudgetUsd: 0.04, signedUrlTtlSeconds: 60, style: REQ.style, objectKey: "scene-0-recraft" });
      assert.equal(out.status, "generated");
      assert.equal(out.styleId, "6654d01b-7c9d-4f87-9f99-80e6cb989380");
      assert.equal(out.path, "req-1/scene-0-recraft.style-6654d01b-7c9d-4f87-9f99-80e6cb989380.webp");
    });
    assert.equal(seenAtPoll, `PROVIDER_JOB_RECORDED:${RID}`);
    const row = [...ledger.ops.values()][0];
    assert.equal(row.status, "COMMITTED");
    assert.equal(row.reservedUsd, 0.04);
    assert.equal(row.committedUsd, 0.04);
    assert.equal(row.provider, "recraft");
    assert.ok(objects.has("req-1/scene-0-recraft.style-6654d01b-7c9d-4f87-9f99-80e6cb989380.webp"));
  } finally { m.restore(); }
});

test("integración: interrupción tras el envío → el siguiente intento REANUDA el mismo request_id sin reenviar", async () => {
  const ledger = memoryLedgerStore();
  const { sb } = fakeStorage();
  let crash = true;
  const base = happy(["COMPLETED"]);
  const m = mockFal((c) => {
    if (crash && c.url.endsWith("/status")) throw new TypeError("fetch failed (worker killed)");
    return base(c);
  });
  const run = () => resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-2", sceneIndex: 1, scene,
    imageProvider: recraftImageProvider, remainingBudgetUsd: 0.04, signedUrlTtlSeconds: 60, style: REQ.style, objectKey: "scene-1-recraft" });
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(run());
      assert.equal([...ledger.ops.values()][0].status, "PROVIDER_JOB_RECORDED");
      crash = false;
      const out = await run();
      assert.equal(out.status, "generated");
    });
    assert.equal(m.calls.filter((c) => c.method === "POST").length, 1, "un solo envío pagado");
    assert.equal([...ledger.ops.values()][0].status, "COMMITTED");
  } finally { m.restore(); }
});

test("integración: saldo insuficiente (402) → REFUNDED sin cobro, error claro, sin sustituto", async () => {
  const ledger = memoryLedgerStore();
  const { sb, objects } = fakeStorage();
  const m = mockFal(() => json({ detail: "insufficient balance" }, 402));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(resolveGeneratedImageForScene({ ledger, supabase: sb, bucket: "videos", requestId: "req-3", sceneIndex: 0, scene,
        imageProvider: recraftImageProvider, remainingBudgetUsd: 0.04, signedUrlTtlSeconds: 60, style: REQ.style, objectKey: "scene-0-recraft" }), /saldo/);
    });
    const row = [...ledger.ops.values()][0];
    assert.equal(row.status, "REFUNDED");
    assert.equal(objects.size, 0);
  } finally { m.restore(); }
});

test("integración: sin ledger un proveedor real nunca se llama", async () => {
  const { sb } = fakeStorage();
  const m = mockFal(() => json({}));
  try {
    await withEnv(FAST, async () => {
      await assert.rejects(resolveGeneratedImageForScene({ supabase: sb, bucket: "videos", requestId: "req-4", sceneIndex: 0, scene,
        imageProvider: recraftImageProvider, remainingBudgetUsd: 0.04, signedUrlTtlSeconds: 60, style: REQ.style }), /sin puerta/);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});
