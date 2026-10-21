/**
 * PR169 review R1–R3 (ChatGPT, comment 6309099083): regressions that FAIL on 2d435a0/a425573 and PASS on the fix.
 * USD 0: provider, Storage and ledger are in-memory; global fetch is mocked; FAL_KEY is a fake local value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { resolveGeneratedImageForScene, resolveRecraftReelScene } from "@/lib/video/visual-resource-resolver";
import { recraftImageProvider } from "@/lib/providers/image/recraft";
import type { ImageGenerationRequest, ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "@/lib/video/storyboard/types";
import { RecraftStyleMissingError } from "@/lib/video/recraft-reel";

const SID = "6654d01b-7c9d-4f87-9f99-80e6cb989380";
const references = { referenceImageUrls: ["https://example.test/ref.png?token=a"] };

function webp(): Buffer {
  const b = Buffer.alloc(200); b.write("RIFF"); b.writeUInt32LE(192, 4); b.write("WEBP", 8); b.write("VP8X", 12);
  b.writeUInt32LE(10, 16); b.writeUIntLE(1079, 24, 3); b.writeUIntLE(1919, 27, 3); return b;
}

function harness(opts: { styleIdReturned?: string | undefined } = {}) {
  const objects = new Map<string, Buffer>();
  const ledger = memoryLedgerStore();
  const faults = { sign: false, list: false, upload: false };
  let submits = 0; let resumes = 0; let signCount = 0;
  const returned = "styleIdReturned" in opts ? opts.styleIdReturned : SID;
  const provider: ImageProvider = {
    name: "recraft",
    capabilities: { id: "recraft", models: ["m"], formats: [], aspectRatios: [], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    estimateCostUsd: (r: ImageGenerationRequest) => (r.style?.styleId ? 0.035 : 0.04),
    submitImage: async () => ({ providerJobId: `job-test-${++submits}` }),
    resumeImage: async (id: string, r: ImageGenerationRequest) => { resumes++; return { buffer: webp(), mimeType: "image/webp", extension: "webp", width: 1080, height: 1920, model: "m",
      costUsd: r.style?.styleId ? 0.035 : 0.04, styleId: r.style?.styleId ?? returned, providerJobId: id }; },
    generateImage: async () => { throw new Error("unexpected sync path"); },
  } as unknown as ImageProvider;
  const bucketApi = {
    list: async (dir: string, { search }: { search: string }) => faults.list ? { data: null, error: { message: "injected list failure" } }
      : { data: [...objects.keys()].filter((p) => p.startsWith(dir + "/")).map((p) => ({ name: p.slice(dir.length + 1) })).filter((f) => f.name.startsWith(search)), error: null },
    upload: async (p: string, b: Buffer) => { if (faults.upload) return { error: { message: "injected upload failure" } }; objects.set(p, b); return { error: null }; },
    createSignedUrl: async (p: string) => faults.sign ? { data: null, error: { message: "injected signing failure" } }
      : { data: { signedUrl: `https://example.test/${p}?sig=${++signCount}` }, error: null },
  };
  const sb = { storage: { from: () => bucketApi } } as never;
  const base = (sceneIndex: number) => ({ ledger, supabase: sb, bucket: "videos", requestId: "review-request", sceneIndex,
    scene: { imagePrompt: `scene ${sceneIndex} lighthouse`, negativePrompt: "text" } as StoryboardScene,
    imageProvider: provider, remainingBudgetUsd: 0.04, signedUrlTtlSeconds: 60 });
  const run = (style: typeof references | { styleId: string }, sceneIndex = 0) =>
    resolveGeneratedImageForScene({ ...base(sceneIndex), style, objectKey: `scene-${sceneIndex}-recraft` });
  const persisted: string[] = [];
  let persistFails = false;
  const scene = (style: typeof references | { styleId: string }, sceneIndex: number, onMissingStyleId: "stop" | "same_references" = "stop") => resolveRecraftReelScene({ ...base(sceneIndex), style,
    onMissingStyleId, onStyleId: async (s) => { if (persistFails) throw new Error("injected style persistence failure"); persisted.push(s); } });
  return { run, scene, objects, ledger, faults, persisted, setPersistFail: (v: boolean) => { persistFails = v; },
    get submits() { return submits; }, get resumes() { return resumes; } };
}

test("R1: retry after signing interruption recovers the paid image's style_id (no second submit)", async () => {
  const h = harness(); h.faults.sign = true;
  await assert.rejects(h.run(references), /signing failure/);
  assert.equal([...h.ledger.ops.values()][0].status, "COMMITTED");
  h.faults.sign = false;
  const reused = await h.run(references);
  assert.equal(reused.status, "reused"); assert.equal(h.submits, 1);
  assert.equal(reused.styleId, SID);
});

test("R1: interruption after upload but before persisting the video style → retry persists the same style_id", async () => {
  const h = harness(); h.setPersistFail(true);
  await assert.rejects(h.scene(references, 0), /persistence failure/);
  h.setPersistFail(false);
  const { generated, nextStyle } = await h.scene(references, 0);
  assert.equal(generated.status, "reused"); assert.deepEqual(h.persisted, [SID]); assert.equal(nextStyle.styleId, SID);
  assert.equal(h.submits, 1);
});

test("R2: paid image missing + style now persisted → no second paid submission", async () => {
  const h = harness(); await h.run(references); h.objects.clear();
  await assert.rejects(h.run({ styleId: SID }));
  assert.equal(h.submits, 1); assert.equal(h.ledger.ops.size, 1);
});

test("R2: Storage list failure never becomes permission to pay again", async () => {
  const h = harness(); await h.run(references); h.faults.list = true;
  await assert.rejects(h.run({ styleId: SID }), /no se genera otra|missing|unavailable/i);
  assert.equal(h.submits, 1);
});

test("R2: a changed signed URL of the references does not change the identity of the paid scene", async () => {
  const h = harness(); await h.run(references); h.objects.clear();
  await assert.rejects(h.run({ referenceImageUrls: ["https://example.test/ref.png?token=b"] }));
  assert.equal(h.submits, 1);
});

test("R2: stored image with another style is refused as incompatible (no reuse, no new payment)", async () => {
  const h = harness(); await h.run(references);
  await assert.rejects(h.run({ styleId: "11111111-2222-3333-4444-555555555555" }), /incompatib/);
  assert.equal(h.submits, 1);
});

test("metadata/sidecar objects and other scenes are never mistaken for the paid image", async () => {
  const h = harness();
  h.objects.set("review-request/scene-0-recraft.json", Buffer.from("{}"));
  h.objects.set("review-request/scene-0-recraft.style-meta.txt", Buffer.from("x"));
  h.objects.set("review-request/scene-0-recraftX.webp", webp());
  const r = await h.run(references);
  assert.equal(r.status, "generated"); assert.equal(h.submits, 1);
  assert.match(r.path, /scene-0-recraft\.style-6654d01b-7c9d-4f87-9f99-80e6cb989380\.webp$/);
});

test("≥2-scene sequence with interruptions between stages: one style, one submit per scene, nothing resubmitted", async () => {
  const h = harness();
  // Scene 0 is paid, stored, then the worker dies while signing.
  h.faults.sign = true; await assert.rejects(h.scene(references, 0), /signing/); h.faults.sign = false;
  // Retry from the start of the job (worker reloads with no style persisted yet: references again).
  let style: typeof references | { styleId: string } = references;
  const s0 = await h.scene(style, 0); style = s0.nextStyle as { styleId: string };
  assert.equal(s0.generated.status, "reused"); assert.equal(style.styleId, SID);
  // Scene 1: interrupted after upload (style persistence of the video already done; signing fails).
  h.faults.sign = true; await assert.rejects(h.scene(style, 1)); h.faults.sign = false;
  // Third attempt: worker reloads with the persisted style_id.
  const r0 = await h.scene({ styleId: SID }, 0); const r1 = await h.scene({ styleId: SID }, 1); const s2 = await h.scene({ styleId: SID }, 2);
  assert.deepEqual([r0.generated.status, r1.generated.status, s2.generated.status], ["reused", "reused", "generated"]);
  assert.equal(h.submits, 3, "exactly one paid submit per scene");
  assert.deepEqual(h.persisted, [SID], "style created and persisted exactly once");
  for (const r of [r0, r1, s2]) assert.equal(r.generated.styleId, SID, "same style for the whole video");
  const committed = [...h.ledger.ops.values()].filter((o) => o.status === "COMMITTED");
  assert.equal(committed.length, 3);
  assert.ok(Math.abs(committed.reduce((a, o) => a + Number(o.committedUsd), 0) - 0.11) < 1e-9, "0.04 + 0.035 + 0.035");
});

// fal's official output schema lists style_id as OPTIONAL. Contract change (2026-10-21): a creation without style_id is
// a paid, usable image — it is STORED and its request_id kept; the video's coherence policy decides what happens next.
test("style_id ausente + política «detener»: la imagen pagada se guarda, no se reenvía nada y no se crea otro estilo", async () => {
  const h = harness({ styleIdReturned: undefined });
  await assert.rejects(h.scene(references, 0), RecraftStyleMissingError);
  assert.ok([...h.objects.keys()].some((k) => /scene-0-recraft\.webp$/.test(k)), "the paid image is stored");
  const op = [...h.ledger.ops.values()][0];
  assert.equal(op.status, "COMMITTED", "the paid result is settled, not left ambiguous");
  assert.equal(op.providerJobId, "job-test-1", "request_id kept");
  // Retry: the stored image is reused and the video stops again, still without any new submission.
  await assert.rejects(h.scene(references, 0), RecraftStyleMissingError);
  assert.equal(h.submits, 1);
  assert.deepEqual(h.persisted, []);
});

test("style_id ausente + política «mismas referencias»: cada escena usa las MISMAS referencias; nada se pierde ni se repite", async () => {
  const h = harness({ styleIdReturned: undefined });
  const s0 = await h.scene(references, 0, "same_references");
  assert.deepEqual(s0.nextStyle, references, "next scene keeps the same references");
  const s1 = await h.scene(s0.nextStyle as typeof references, 1, "same_references");
  assert.equal(s1.generated.status, "generated");
  const again = await h.scene(references, 0, "same_references");
  assert.equal(again.generated.status, "reused", "the stored image without style_id is reused on retry");
  assert.equal(h.submits, 2);
  assert.deepEqual(h.persisted, []);
});

test("style_id existente del usuario: nunca crea estilo, aunque fal no devuelva style_id en la respuesta", async () => {
  const h = harness({ styleIdReturned: undefined });
  const r = await h.scene({ styleId: SID }, 0);
  assert.equal(r.generated.styleId, SID, "the requested style_id is kept as the image's style");
  assert.deepEqual(r.nextStyle, { styleId: SID });
  assert.deepEqual(h.persisted, []);
});

async function falMock(styleField: Record<string, unknown>, fn: () => Promise<unknown>) {
  const originalFetch = global.fetch; const oldKey = process.env.FAL_KEY; process.env.FAL_KEY = "fake-local-only";
  const seen: string[] = [];
  global.fetch = (async (u: string | URL, init?: RequestInit) => {
    seen.push(String(u));
    if (init?.method === "POST") return Response.json({ request_id: "job-test-12345" });
    if (String(u).endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (String(u).startsWith("https://image.example.test")) return new Response(new Uint8Array(webp()), { headers: { "content-type": "image/webp" } });
    return Response.json({ images: [{ url: "https://image.example.test/image.webp" }], ...styleField });
  }) as typeof fetch;
  try { return { result: await fn().then((v) => ({ ok: v }), (e: unknown) => ({ err: e as Error })), seen }; }
  finally { global.fetch = originalFetch; if (oldKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = oldKey; }
}

test("adaptador: creación SIN style_id en la respuesta → imagen devuelta (styleId undefined) con su request_id", async () => {
  const { result } = await falMock({}, () => recraftImageProvider.generateImage({ prompt: "x", aspectRatio: "9:16", maxCostUsd: 0.04, style: references }));
  assert.ok("ok" in result);
  const asset = result.ok as { styleId?: string; providerJobId?: string; costUsd: number };
  assert.equal(asset.styleId, undefined); assert.equal(asset.providerJobId, "job-test-12345"); assert.equal(asset.costUsd, 0.04);
});

test("adaptador: style_id inválido (caracteres, eco del request_id, id conocido que no es estilo) nunca se adopta", async () => {
  for (const bad of ["../etc", "", "job-test-12345", "01a15cd6-f79f-77f1-8f4a-06d582611ae4", 42]) {
    const { result } = await falMock({ style_id: bad }, () => recraftImageProvider.generateImage({ prompt: "x", aspectRatio: "9:16", maxCostUsd: 0.04, style: references }));
    assert.ok("ok" in result, `${String(bad)}: the paid image is still returned`);
    assert.equal((result.ok as { styleId?: string }).styleId, undefined, `must not adopt ${String(bad)}`);
  }
  const { result } = await falMock({ style_id: SID }, () => recraftImageProvider.generateImage({ prompt: "x", aspectRatio: "9:16", maxCostUsd: 0.04, style: references }));
  assert.ok("ok" in result); assert.equal((result.ok as { styleId: string }).styleId, SID);
  const existing = await falMock({}, () => recraftImageProvider.generateImage({ prompt: "x", aspectRatio: "9:16", maxCostUsd: 0.04, style: { styleId: SID } }));
  assert.ok("ok" in existing.result); assert.equal((existing.result.ok as { styleId: string }).styleId, SID, "existing style kept when fal omits it");
});

test("no key in errors and only mocked fal URLs are contacted", async () => {
  const { result, seen } = await falMock({ images: [] }, () => recraftImageProvider.generateImage({ prompt: "x", aspectRatio: "9:16", maxCostUsd: 0.04, style: references }));
  assert.ok("err" in result); assert.doesNotMatch(result.err.message, /fake-local-only/);
  for (const u of seen) assert.match(u, /^https:\/\/(queue\.fal\.run|image\.example\.test)\//);
});
