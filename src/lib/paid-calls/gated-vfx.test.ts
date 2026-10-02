/**
 * VFX Provider V1 — economic safety of VFX / Transform Scene. Mocks only: no network, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { GenerativeProviderError } from "@/lib/providers/types";
import { lumaVfxProvider } from "@/lib/providers/vfx/luma";
import type { VfxAsset, VfxProvider, VfxTransformRequest } from "@/lib/providers/vfx/types";
import { paidCallKey } from "./gate";
import { gatedVfxTransform, VFX_METHOD, VFX_SHOT_PREFIX, vfxCallSpec } from "./gated-vfx";
import { memoryResultStore, paidResultPath } from "./result-store";

const REQ: VfxTransformRequest = {
  source: { url: "https://storage.example/signed/hans.mp4?token=a", sha256: "a".repeat(64), durationSeconds: 8, width: 1080, height: 1920, fps: 30 },
  range: { startSeconds: 0, endSeconds: 5 },
  prompt: "Transform the apartment into a cinematic New York street at night.",
  negativePrompt: "face change",
  aspectRatio: "9:16",
  preserveSubject: true,
  strength: "balanced",
  style: "cinematic",
  quality: "standard",
  maxCostUsd: 2,
};
const BUDGET = { hardCapUsd: 5, committedUsd: 0, reservedUsd: 0 };

type Mock = VfxProvider & { calls: number; resumes: number };
function mockProvider(behavior: (r: VfxTransformRequest) => Promise<VfxAsset> = async () => asset(), estimate = 1.75): Mock {
  const p: Mock = {
    name: "mockvfx",
    calls: 0,
    resumes: 0,
    capabilities: { id: "mockvfx", models: ["m1"], formats: ["video/mp4"], aspectRatios: ["9:16"], timeoutMs: 1, maxRetries: 0, contractVerified: true, maxRangeSeconds: { m1: 10 } },
    isAvailable: () => true,
    resolveModel: () => "m1",
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
const asset = (tag = "out"): VfxAsset => ({ kind: "vfx_transform", buffer: Buffer.from(`vfx-${tag}`), mimeType: "video/mp4", extension: "mp4", model: "m1", costUsd: 1.75, costBasis: "estimated", providerJobId: "job-1", durationSeconds: 5 });
const deps = (provider: VfxProvider, over: Partial<{ ledger: ReturnType<typeof memoryLedgerStore>; results: ReturnType<typeof memoryResultStore>; budget: typeof BUDGET }> = {}) => ({
  ledger: over.ledger ?? memoryLedgerStore(),
  results: over.results ?? memoryResultStore(),
  requestId: "vfx-req-1",
  provider,
  budget: over.budget ?? BUDGET,
});

test("VFX-1: same source + prompt + parameters → same identity; signed URL and render attempt never change it", () => {
  const p = mockProvider();
  const a = vfxCallSpec("vfx-req-1", p, REQ, 0);
  const b = vfxCallSpec("vfx-req-1", p, { ...REQ, source: { ...REQ.source, url: "https://storage.example/signed/hans.mp4?token=OTHER" } }, 0);
  assert.equal(paidCallKey(a), paidCallKey(b));
  assert.equal(a.shotId, b.shotId);
});

test("VFX-3/4: different prompt, source checksum, range, aspect, strength or model → different identity", () => {
  const p = mockProvider();
  const base = paidCallKey(vfxCallSpec("r", p, REQ, 0));
  const variants: VfxTransformRequest[] = [
    { ...REQ, prompt: REQ.prompt + " Rain." },
    { ...REQ, source: { ...REQ.source, sha256: "b".repeat(64) } },
    { ...REQ, range: { startSeconds: 0, endSeconds: 6 } },
    { ...REQ, aspectRatio: "16:9" },
    { ...REQ, strength: "strong" },
    { ...REQ, negativePrompt: "other" },
    { ...REQ, style: "noir" },
    { ...REQ, quality: "draft" },
  ];
  for (const v of variants) assert.notEqual(paidCallKey(vfxCallSpec("r", p, v, 0)), base);
  const otherModel = { ...p, resolveModel: () => "m2" };
  assert.notEqual(paidCallKey(vfxCallSpec("r", otherModel, REQ, 0)), base);
});

test("VFX-2: a retry of the same operation never pays twice (stored result reused, 1 provider call)", async () => {
  const p = mockProvider();
  const d = deps(p);
  const first = await gatedVfxTransform(d, REQ);
  assert.equal(first.reused, false);
  assert.equal(first.costUsd, 1.75);
  const second = await gatedVfxTransform(d, { ...REQ, source: { ...REQ.source, url: "https://storage.example/new-signed-url" } });
  assert.equal(second.reused, true);
  assert.equal(second.costUsd, 0);
  assert.equal(p.calls, 1);
  assert.equal(second.buffer.toString(), first.buffer.toString());
  const row = d.ledger.ops.get(first.key!)!;
  assert.equal(row.status, "COMMITTED");
  assert.equal(row.method, VFX_METHOD);
});

test("VFX-5: the hard cap blocks before any ledger row or provider call (estimate + committed + reserved)", async () => {
  const p = mockProvider();
  const d = deps(p, { budget: { hardCapUsd: 5, committedUsd: 3, reservedUsd: 0.5 } });
  await assert.rejects(gatedVfxTransform(d, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
  const d2 = deps(p);
  await assert.rejects(gatedVfxTransform(d2, { ...REQ, maxCostUsd: 1 }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "budget_exceeded");
  assert.equal(p.calls, 0);
  assert.equal(d.ledger.ops.size + d2.ledger.ops.size, 0);
});

test("VFX-6: an uncertain provider failure fails closed (RECONCILIATION_REQUIRED, never a second call)", async () => {
  const p = mockProvider(async () => {
    throw new Error("socket hang up after submit");
  });
  const d = deps(p);
  await assert.rejects(gatedVfxTransform(d, REQ), /socket hang up/);
  const key = paidCallKey(vfxCallSpec(d.requestId, p, REQ, 1.75));
  assert.equal(d.ledger.ops.get(key)!.status, "RECONCILIATION_REQUIRED");
  await assert.rejects(gatedVfxTransform(d, REQ), ReconciliationRequiredError);
  assert.equal(p.calls, 1);
});

test("VFX-6b: a failure after the provider accepted the job resumes that job; it is never resubmitted", async () => {
  const p = mockProvider(async (r) => {
    await r.onProviderJobAccepted?.("job-77");
    throw new Error("poll timeout");
  });
  const d = deps(p);
  await assert.rejects(gatedVfxTransform(d, REQ), /poll timeout/);
  const key = paidCallKey(vfxCallSpec(d.requestId, p, REQ, 1.75));
  assert.equal(d.ledger.ops.get(key)!.status, "PROVIDER_JOB_RECORDED");
  const resumed = await gatedVfxTransform(d, REQ);
  assert.equal(resumed.buffer.toString(), "vfx-resumed");
  assert.equal(p.calls, 1);
  assert.equal(p.resumes, 1);
});

test("VFX-7: a persisted result is reusable even if the ledger row was lost (crash before commit)", async () => {
  const p = mockProvider();
  const results = memoryResultStore();
  await gatedVfxTransform(deps(p, { results }), REQ);
  const again = await gatedVfxTransform(deps(p, { results, ledger: memoryLedgerStore() }), REQ);
  assert.equal(again.reused, true);
  assert.equal(p.calls, 1);
});

test("VFX-8: VFX output is never confused with ai_video", async () => {
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

test("VFX-L1: Luma while its contract is unverified → refused before any ledger row or network", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    const d = deps(lumaVfxProvider);
    await assert.rejects(gatedVfxTransform(d, REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
    assert.equal(d.ledger.ops.size, 0);
    await assert.rejects(lumaVfxProvider.transformVideo(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
