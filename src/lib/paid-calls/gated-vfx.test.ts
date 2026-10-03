/**
 * VFX Provider V1 — economic safety of VFX / Transform Scene (Luma Ray 3.2 video_edit). Mocks only:
 * no network, no provider, no spend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { GenerativeProviderError } from "@/lib/providers/types";
import { createLumaVfxProvider } from "@/lib/providers/vfx/luma";
import type { VfxAsset, VfxProvider, VfxTransformRequest } from "@/lib/providers/vfx/types";
import { VFX_001_CONTROLS } from "@/lib/video/vfx/vfx-001";
import { paidCallKey } from "./gate";
import { gatedVfxTransform, VFX_METHOD, VFX_SHOT_PREFIX, vfxCallSpec, vfxSourceRefPath } from "./gated-vfx";
import { memoryResultStore, paidResultPath } from "./result-store";

const SOURCE_BYTES = Buffer.from("hans-walking-5s-source-bytes");
const SHA = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const REQ: VfxTransformRequest = {
  source: { url: "https://storage.example/signed/hans.mp4?token=a", sha256: SHA, sizeBytes: SOURCE_BYTES.byteLength, mimeType: "video/mp4", durationSeconds: 5, width: 1080, height: 1920, fps: 30 },
  range: { startSeconds: 1, endSeconds: 6 },
  prompt: "Transform the apartment into a cinematic New York street at night.",
  negativePrompt: "face change",
  aspectRatio: "9:16",
  resolution: "720p",
  dynamicRange: "sdr",
  preserveSubject: true,
  strength: "balanced",
  controls: VFX_001_CONTROLS,
  style: "cinematic",
  maxCostUsd: 2,
};
const BUDGET = { hardCapUsd: 5, committedUsd: 0, reservedUsd: 0 };

type Mock = VfxProvider & { calls: number; resumes: number };
function mockProvider(behavior: (r: VfxTransformRequest) => Promise<VfxAsset> = async () => asset(), estimate = 1.08): Mock {
  const p: Mock = {
    name: "mockvfx",
    calls: 0,
    resumes: 0,
    capabilities: { id: "mockvfx", models: ["m1"], formats: ["video/mp4"], aspectRatios: ["9:16"], timeoutMs: 1, maxRetries: 0, requestType: "video_edit", contractVerified: true, resolutions: ["720p"], maxSourceSeconds: 18 },
    isAvailable: () => true,
    resolveModel: () => "m1",
    describeRequest: (r) => ({ strength: r.strength, controls: r.controls ?? null }),
    estimateCostUsd: () => estimate,
    async transformVideo(r) {
      p.calls++;
      return behavior(r);
    },
    async resumeTransform() {
      p.resumes++;
      return asset("resumed");
    },
  };
  return p;
}
const asset = (tag = "out"): VfxAsset => ({ kind: "vfx_transform", buffer: Buffer.from(`vfx-${tag}`), mimeType: "video/mp4", extension: "mp4", model: "m1", costUsd: 1.08, costBasis: "estimated", providerJobId: "job-1", durationSeconds: 5 });
const deps = (provider: VfxProvider, over: Partial<{ ledger: ReturnType<typeof memoryLedgerStore>; results: ReturnType<typeof memoryResultStore>; budget: typeof BUDGET }> = {}) => ({
  ledger: over.ledger ?? memoryLedgerStore(),
  results: over.results ?? memoryResultStore(),
  requestId: "vfx-req-1",
  provider,
  budget: over.budget ?? BUDGET,
});

test("VFX-10: same source + prompt + controls → same identity; signed URL, file_id and render attempts never change it", () => {
  const p = mockProvider();
  const a = vfxCallSpec("vfx-req-1", p, REQ, 0);
  const b = vfxCallSpec("vfx-req-1", p, { ...REQ, source: { ...REQ.source, url: "https://storage.example/other-signed-url", providerFileId: "file-123" } }, 0);
  assert.equal(paidCallKey(a), paidCallKey(b));
  assert.equal(a.shotId, b.shotId);
});

test("VFX-11/12: different source checksum, prompt, resolution, controls, strength, range or request type → different identity", () => {
  const p = mockProvider();
  const base = paidCallKey(vfxCallSpec("r", p, REQ, 0));
  const variants: VfxTransformRequest[] = [
    { ...REQ, source: { ...REQ.source, sha256: "b".repeat(64) } },
    { ...REQ, prompt: REQ.prompt + " Rain." },
    { ...REQ, negativePrompt: "other" },
    { ...REQ, resolution: "1080p" },
    { ...REQ, aspectRatio: "16:9" },
    { ...REQ, controls: { ...REQ.controls, faceIdentity: false } },
    { ...REQ, strength: "subtle" },
    { ...REQ, range: { startSeconds: 2, endSeconds: 7 } },
    { ...REQ, style: "noir" },
  ];
  for (const v of variants) assert.notEqual(paidCallKey(vfxCallSpec("r", p, v, 0)), base);
  const otherType = { ...p, capabilities: { ...p.capabilities, requestType: "video_reframe" } };
  assert.notEqual(paidCallKey(vfxCallSpec("r", otherType, REQ, 0)), base);
});

test("VFX-14: a retry of the same operation never pays twice (1 provider call, stored result reused)", async () => {
  const p = mockProvider();
  const d = deps(p);
  const first = await gatedVfxTransform(d, REQ);
  assert.equal(first.reused, false);
  assert.equal(first.costUsd, 1.08);
  const second = await gatedVfxTransform(d, { ...REQ, source: { ...REQ.source, url: "https://storage.example/new-signed-url" } });
  assert.equal(second.reused, true);
  assert.equal(second.costUsd, 0);
  assert.equal(p.calls, 1);
  assert.equal(second.buffer.toString(), first.buffer.toString());
  const row = d.ledger.ops.get(first.key!)!;
  assert.equal(row.status, "COMMITTED");
  assert.equal(row.method, VFX_METHOD);
});

test("VFX-9: the hard cap blocks before any ledger row or provider call (estimate + committed + reserved)", async () => {
  const p = mockProvider();
  const d = deps(p, { budget: { hardCapUsd: 5, committedUsd: 3.5, reservedUsd: 0.5 } });
  await assert.rejects(gatedVfxTransform(d, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
  const d2 = deps(p);
  await assert.rejects(gatedVfxTransform(d2, { ...REQ, maxCostUsd: 1 }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
  assert.equal(p.calls, 0);
  assert.equal(d.ledger.ops.size + d2.ledger.ops.size, 0);
});

test("VFX-15: an uncertain provider failure fails closed (RECONCILIATION_REQUIRED, never a second call)", async () => {
  const p = mockProvider(async () => {
    throw new Error("socket hang up after submit");
  });
  const d = deps(p);
  await assert.rejects(gatedVfxTransform(d, REQ), /socket hang up/);
  const key = paidCallKey(vfxCallSpec(d.requestId, p, REQ, 1.08));
  assert.equal(d.ledger.ops.get(key)!.status, "RECONCILIATION_REQUIRED");
  await assert.rejects(gatedVfxTransform(d, REQ), ReconciliationRequiredError);
  assert.equal(p.calls, 1);
});

test("VFX-15b: a failure after the provider accepted the job resumes that job; it is never resubmitted", async () => {
  const p = mockProvider(async (r) => {
    await r.onProviderJobAccepted?.("job-77");
    throw new Error("poll timeout");
  });
  const d = deps(p);
  await assert.rejects(gatedVfxTransform(d, REQ), /poll timeout/);
  const key = paidCallKey(vfxCallSpec(d.requestId, p, REQ, 1.08));
  assert.equal(d.ledger.ops.get(key)!.status, "PROVIDER_JOB_RECORDED");
  const resumed = await gatedVfxTransform(d, REQ);
  assert.equal(resumed.buffer.toString(), "vfx-resumed");
  assert.equal(p.calls, 1);
  assert.equal(p.resumes, 1);
});

test("VFX-13: a persisted result is reusable even if the ledger row was lost (crash before commit)", async () => {
  const p = mockProvider();
  const results = memoryResultStore();
  await gatedVfxTransform(deps(p, { results }), REQ);
  const again = await gatedVfxTransform(deps(p, { results, ledger: memoryLedgerStore() }), REQ);
  assert.equal(again.reused, true);
  assert.equal(p.calls, 1);
});

test("VFX-16: vfx_transform stays separate from ai_video", async () => {
  const p = mockProvider();
  const spec = vfxCallSpec("vfx-req-1", p, REQ, 0);
  assert.ok(spec.shotId.startsWith(VFX_SHOT_PREFIX));
  assert.equal(spec.method, VFX_METHOD);
  // An ai_video-style sidecar at the same path is not a VFX result: not reused, the provider is called.
  const results = memoryResultStore();
  const jsonPath = paidResultPath("vfx-req-1", paidCallKey(spec, 0), "json");
  await results.putBytes("vfx-req-1/paid/x.mp4", Buffer.from("ai"), "video/mp4");
  await results.putJson(jsonPath, { videoPath: "vfx-req-1/paid/x.mp4", sha256: "0", bytes: 2 });
  const r = await gatedVfxTransform(deps(p, { results }), REQ);
  assert.equal(r.kind, "vfx_transform");
  assert.equal(r.reused, false);
  assert.equal(p.calls, 1);
  // A provider answering with something that is not vfx_transform is refused (and fails closed).
  const wrong = mockProvider(async () => ({ ...asset(), kind: "ai_video" }) as unknown as VfxAsset);
  await assert.rejects(gatedVfxTransform(deps(wrong), REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_response");
});

/** A scripted Luma Agents API (Files + Generations) behind a mocked fetch. */
function lumaApi(opts: { generationState?: "completed" | "failed" } = {}) {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  const fetchMock = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, auth: headers.Authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url === REQ.source.url) return new Response(SOURCE_BYTES);
    if (url === "https://agents.lumalabs.ai/v1/files" && method === "POST") return json({ id: "file-abc", state: "pending", file: {}, upload: { url: "https://s3.example/put", method: "PUT", headers: { "x-amz-acl": "private" } } });
    if (url === "https://s3.example/put") return new Response(null, { status: 200 });
    if (url === "https://agents.lumalabs.ai/v1/files/file-abc/complete") return json({ id: "file-abc", state: "pending" });
    if (url === "https://agents.lumalabs.ai/v1/files/file-abc") return json({ id: "file-abc", state: "ready", size_bytes: SOURCE_BYTES.byteLength });
    if (url === "https://agents.lumalabs.ai/v1/generations" && method === "POST") return json({ id: "gen-1", state: "queued" }, 201);
    if (url === "https://agents.lumalabs.ai/v1/generations/gen-1") {
      return opts.generationState === "failed" ? json({ id: "gen-1", state: "failed", failure_code: "content_moderated" }) : json({ id: "gen-1", state: "completed", output: [{ type: "video", url: "https://cdn.example/out.mp4" }] });
    }
    if (url === "https://cdn.example/out.mp4") return new Response(Buffer.from("transformed-video"));
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, fetchMock };
}

test("VFX-1..6 (Luma Ray 3.2): Files API → file_id → one video_edit on ray-3.2, 9:16, 720p SDR, face/pose conditioning; retry → 0 calls", async () => {
  const prev = process.env.LUMA_API_KEY;
  process.env.LUMA_API_KEY = "test-key";
  try {
    const api = lumaApi();
    const luma = createLumaVfxProvider({ fetch: api.fetchMock, sleep: async () => {}, now: () => 0 });
    const d = deps(luma);
    const out = await gatedVfxTransform(d, REQ);
    assert.equal(out.kind, "vfx_transform");
    assert.equal(out.buffer.toString(), "transformed-video");
    assert.equal(out.costUsd, 1.08);
    const submits = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/generations"));
    assert.equal(submits.length, 1);
    type Body = { type: string; model: string; source: unknown; aspect_ratio?: string; video: { resolution: string; hdr: boolean; duration?: string; edit: { strength: string; auto_controls?: boolean; controls: Record<string, unknown> } } };
    const body = submits[0].body as Body;
    assert.equal(body.type, "video_edit");
    assert.equal(body.model, "ray-3.2");
    assert.deepEqual(body.source, { file_id: "file-abc" });
    assert.equal(body.aspect_ratio, undefined);
    assert.equal(body.video.resolution, "720p");
    assert.equal(body.video.hdr, false);
    assert.equal(body.video.edit.strength, "flex_1");
    assert.equal(body.video.edit.auto_controls, false);
    assert.deepEqual(body.video.edit.controls.face, { enabled: true });
    assert.deepEqual(body.video.edit.controls.pose, { enabled: true, strength: "precise" });
    assert.equal(body.video.duration, undefined);
    // The upload went through the presigned flow; neither the storage PUT nor the source/CDN reads carry the API key.
    const put = api.calls.find((c) => c.url === "https://s3.example/put")!;
    assert.equal(put.auth, undefined);
    assert.ok(api.calls.filter((c) => !c.url.startsWith("https://agents.lumalabs.ai")).every((c) => c.auth === undefined));
    // Durable file_id cached by sha256; ledger committed at the verified price.
    assert.deepEqual(await d.results.getJson(vfxSourceRefPath(d.requestId, "luma", SHA)), { fileId: "file-abc", sha256: SHA });
    assert.equal(d.ledger.ops.get(out.key!)!.committedUsd, 1.08);
    // Retry: no upload, no submission.
    const before = api.calls.length;
    const again = await gatedVfxTransform(d, REQ);
    assert.equal(again.reused, true);
    assert.equal(api.calls.length, before);
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("VFX-L2 (Luma): a moderated generation after acceptance is never resubmitted (job id kept, resume only)", async () => {
  const prev = process.env.LUMA_API_KEY;
  process.env.LUMA_API_KEY = "test-key";
  try {
    const api = lumaApi({ generationState: "failed" });
    const luma = createLumaVfxProvider({ fetch: api.fetchMock, sleep: async () => {}, now: () => 0 });
    const d = deps(luma);
    await assert.rejects(gatedVfxTransform(d, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "moderation_rejected" && e.providerJobId === "gen-1");
    await assert.rejects(gatedVfxTransform(d, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.providerJobId === "gen-1");
    assert.equal(api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/generations")).length, 1);
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("VFX-L3 (Luma): a source whose bytes do not match its sha256 is refused before any upload or ledger row", async () => {
  const prev = process.env.LUMA_API_KEY;
  process.env.LUMA_API_KEY = "test-key";
  try {
    const api = lumaApi();
    const luma = createLumaVfxProvider({ fetch: api.fetchMock, sleep: async () => {}, now: () => 0 });
    const d = deps(luma);
    await assert.rejects(gatedVfxTransform(d, { ...REQ, source: { ...REQ.source, sha256: "c".repeat(64) } }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
    assert.equal(d.ledger.ops.size, 0);
    assert.equal(api.calls.filter((c) => c.url.startsWith("https://agents.lumalabs.ai")).length, 0);
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});
