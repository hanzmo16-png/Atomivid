/** VFX Provider V1 — Luma adapter, cost engine, registry and VFX-001 plan. Mocks only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerativeProviderError } from "../types";
import { getVfxProvider } from "./index";
import { buildLumaModifyPayload, LUMA_VFX_CONTRACT_VERIFIED, lumaCreditsPreflight, lumaModeFor, lumaVfxProvider } from "./luma";
import { assertVfxBudget, costFromRate, estimateVfxCostUsd, VFX_RATES, type VfxRate } from "./pricing";
import { toVfxTransformRequest, type VfxTransformRequest } from "./types";
import { buildVfxSpendPlan, VFX_001 } from "@/lib/video/vfx/vfx-001";

const REQ: VfxTransformRequest = {
  source: { url: "https://storage.example/hans.mp4", sha256: "a".repeat(64), durationSeconds: 8, width: 1080, height: 1920, fps: 30 },
  range: { startSeconds: 0, endSeconds: 5 },
  prompt: "Turn the apartment into New York at night.",
  negativePrompt: "face change",
  aspectRatio: "9:16",
  preserveSubject: true,
  strength: "balanced",
  quality: "standard",
  maxCostUsd: 2,
};

test("LUMA-1: the payload matches the SDK contract (modify_video, ray-2, flex mode, media.url, prompt with Avoid)", () => {
  const body = buildLumaModifyPayload(REQ);
  assert.deepEqual(Object.keys(body).sort(), ["generation_type", "media", "mode", "model", "prompt"]);
  assert.equal(body.generation_type, "modify_video");
  assert.equal(body.model, "ray-2");
  assert.equal(body.mode, "flex_2");
  assert.equal(body.media.url, REQ.source.url);
  assert.match(body.prompt, /Avoid: face change/);
  assert.equal(buildLumaModifyPayload({ ...REQ, quality: "draft" }).model, "ray-flash-2");
  assert.equal(lumaModeFor({ strength: "strong", preserveSubject: true }), "flex_3");
  assert.equal(lumaModeFor({ strength: "strong", preserveSubject: false }), "reimagine_2");
  assert.throws(() => buildLumaModifyPayload({ ...REQ, source: { ...REQ.source, url: "http://insecure" } }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
  assert.throws(() => buildLumaModifyPayload({ ...REQ, range: { startSeconds: 0, endSeconds: 12 } }), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
});

test("LUMA-2: contract and prices are unverified → no estimate and no paid request", async () => {
  assert.equal(LUMA_VFX_CONTRACT_VERIFIED, false);
  assert.equal(lumaVfxProvider.capabilities.contractVerified, false);
  assert.ok(VFX_RATES.every((r) => !r.verified));
  assert.throws(() => lumaVfxProvider.estimateCostUsd(REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
  await assert.rejects(lumaVfxProvider.resumeTransform!("job", REQ), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
});

test("LUMA-3: the cost engine reproduces the published examples and only estimates from verified rates", () => {
  const verified: VfxRate[] = VFX_RATES.map((r) => ({ ...r, verified: true }));
  const shape = { width: 1280, height: 720, fps: 24, durationSeconds: 5 };
  assert.equal(costFromRate(verified[0], shape), 1.75);
  assert.equal(costFromRate(verified[1], shape), 0.61); // 0.6017 rounded up to the cent: never under-reserve.
  assert.equal(estimateVfxCostUsd("luma", "ray-2", shape, verified), 1.75);
  assert.throws(() => estimateVfxCostUsd("luma", "ray-2", shape), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
  assert.throws(() => estimateVfxCostUsd("luma", "unknown-model", shape, verified), /no hay tarifa/);
  assert.throws(() => assertVfxBudget("luma", 1.75, 2, { hardCapUsd: 5, committedUsd: 3.5, reservedUsd: 0 }), /tope absoluto/);
  assert.doesNotThrow(() => assertVfxBudget("luma", 1.75, 2, { hardCapUsd: 5, committedUsd: 3, reservedUsd: 0.25 }));
});

test("LUMA-4: the free preflight is a single GET /credits with Bearer auth (balance in USD cents); 401 → unauthenticated", async () => {
  const prev = process.env.LUMA_API_KEY;
  process.env.LUMA_API_KEY = "test-key";
  try {
    const seen: { url: string; method?: string; auth?: string }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ credit_balance: 1000 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await lumaCreditsPreflight(ok);
    assert.deepEqual(r, { authenticated: true, status: 200, balanceUsd: 10 });
    assert.deepEqual(seen, [{ url: "https://api.lumalabs.ai/dream-machine/v1/credits", method: "GET", auth: "Bearer test-key" }]);
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    assert.deepEqual(await lumaCreditsPreflight(denied), { authenticated: false, status: 401 });
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("LUMA-5: registry picks Luma only when requested and keyed; fixture otherwise (outside production)", () => {
  const prev = process.env.LUMA_API_KEY;
  try {
    delete process.env.LUMA_API_KEY;
    assert.equal(getVfxProvider("luma").name, "fixture");
    process.env.LUMA_API_KEY = "k";
    assert.equal(getVfxProvider("luma").name, "luma");
    assert.equal(getVfxProvider(undefined).name, "fixture");
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("VFX-UX: the Transform Scene contract fills safe defaults and validates prompt and range", () => {
  const r = toVfxTransformRequest({ prompt: "  Nueva York de noche  " }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2 });
  assert.equal(r.prompt, "Nueva York de noche");
  assert.equal(r.preserveSubject, true);
  assert.equal(r.strength, "balanced");
  assert.equal(r.quality, "standard");
  assert.deepEqual(r.range, { startSeconds: 0, endSeconds: 8 });
  assert.throws(() => toVfxTransformRequest({ prompt: " " }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2 }));
  assert.throws(() => toVfxTransformRequest({ prompt: "x" }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2, range: { startSeconds: 2, endSeconds: 9 } }));
});

test("VFX-001: prepared, waiting for the source; the plan is pure, capped and flags every unverified input", () => {
  assert.equal(VFX_001.status, "READY_FOR_SOURCE_VIDEO");
  assert.equal(VFX_001.targetBudgetUsd, 2);
  assert.equal(VFX_001.hardCapUsd, 5);
  const src = { sha256: "c".repeat(64), durationSeconds: 9.5, width: 1080, height: 1920, fps: 30 };
  const plan8 = buildVfxSpendPlan(src);
  assert.equal(plan8.plan, "VFX_001_SPEND_PLAN");
  assert.equal(plan8.requiresHumanAuthorization, true);
  assert.equal(plan8.source.range.endSeconds, 8);
  const ray2at8 = plan8.candidates.find((c) => c.model === "ray-2")!;
  assert.equal(ray2at8.estimatedUsd, 2.8);
  assert.equal(ray2at8.fitsTarget, false);
  assert.equal(plan8.recommended?.model, "ray-flash-2");
  assert.ok(plan8.maximumCostUsd <= VFX_001.hardCapUsd);
  assert.ok(plan8.blockers.some((b) => /no verificado/.test(b)));
  const plan5 = buildVfxSpendPlan(src, { startSeconds: 1, endSeconds: 6 });
  assert.equal(plan5.recommended?.model, "ray-2");
  assert.equal(plan5.recommended?.estimatedUsd, 1.75);
  assert.equal(plan5.maxPaidAttempts, 2);
  assert.equal(plan5.maximumCostUsd, 3.5);
  assert.ok(buildVfxSpendPlan({ ...src, width: 1920, height: 1080 }).blockers.some((b) => /9:16/.test(b)));
});
