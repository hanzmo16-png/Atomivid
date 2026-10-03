/** VFX Provider V1 — Luma Ray 3.2 video_edit adapter, cost engine, registry, UX contract and VFX-001 plan. Mocks only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerativeProviderError } from "../types";
import { getVfxProvider } from "./index";
import { buildLumaVideoEditPayload, LUMA_API_BASE, lumaControlsFor, lumaErrorDetail, lumaFilesPreflight, lumaStrengthFor, lumaVfxProvider } from "./luma";
import { assertVfxBudget, estimateVfxCostUsd, VFX_PRICES, type VfxPriceQuery } from "./pricing";
import { toVfxTransformRequest, type VfxTransformRequest } from "./types";
import { buildVfxSpendPlan, VFX_001, VFX_001_CONTROLS } from "@/lib/video/vfx/vfx-001";

const REQ: VfxTransformRequest = {
  source: { url: "https://storage.example/hans.mp4", sha256: "a".repeat(64), sizeBytes: 1000, mimeType: "video/mp4", durationSeconds: 5, width: 1080, height: 1920, fps: 30 },
  range: { startSeconds: 0, endSeconds: 5 },
  prompt: "Turn the apartment into New York at night.",
  negativePrompt: "face change",
  aspectRatio: "9:16",
  resolution: "720p",
  dynamicRange: "sdr",
  preserveSubject: true,
  strength: "balanced",
  controls: VFX_001_CONTROLS,
  maxCostUsd: 2,
};
const q = (resolution: VfxPriceQuery["resolution"], durationSeconds: number): VfxPriceQuery => ({ provider: "luma", model: "ray-3.2", requestType: "video_edit", resolution, dynamicRange: "sdr", durationSeconds });

test("LUMA-1/2/3/4/5: payload = Agents API video_edit on ray-3.2 with source.file_id, 9:16, 720p, SDR (hdr false), no duration", () => {
  const body = buildLumaVideoEditPayload(REQ, "file-1");
  assert.equal(LUMA_API_BASE, "https://agents.lumalabs.ai/v1");
  assert.equal(body.type, "video_edit");
  assert.equal(body.model, "ray-3.2");
  assert.deepEqual(body.source, { file_id: "file-1" });
  assert.equal(body.aspect_ratio, "9:16");
  assert.equal(body.video.resolution, "720p");
  assert.equal(body.video.hdr, false);
  assert.ok(!("duration" in body.video));
  assert.match(body.prompt, /Avoid: face change/);
  assert.throws(() => buildLumaVideoEditPayload(REQ, ""), /file_id/);
});

test("LUMA-6: subject preservation uses only documented controls (face, pose, depth blur, normals, trajectory) and stays conservative", () => {
  const body = buildLumaVideoEditPayload(REQ, "file-1");
  assert.equal(body.video.edit.strength, "flex_1");
  assert.equal(body.video.edit.auto_controls, false);
  assert.deepEqual(body.video.edit.controls, {
    face: { enabled: true },
    pose: { enabled: true, strength: "precise" },
    depth: { enabled: true, blur: 0.7 },
    normals: { enabled: false },
    trajectory: { enabled: true },
  });
  assert.equal(lumaStrengthFor({ strength: "subtle", preserveSubject: true }), "adhere_2");
  assert.equal(lumaStrengthFor({ strength: "strong", preserveSubject: true }), "flex_3");
  assert.equal(lumaStrengthFor({ strength: "strong", preserveSubject: false }), "reimagine_1");
  assert.equal(lumaControlsFor(undefined), undefined);
  assert.throws(() => lumaControlsFor({ depth: { enabled: true, freedom: 1.5 } }), /entre 0 y 1/);
  // Undocumented parameters are refused, never silently dropped.
  assert.throws(() => buildLumaVideoEditPayload({ ...REQ, seed: "42" }, "file-1"), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "invalid_request");
  assert.throws(() => buildLumaVideoEditPayload({ ...REQ, source: { ...REQ.source, durationSeconds: 19 } }, "file-1"), /18 s/);
});

test("LUMA-7/8: Ray 3.2 video_edit standard/SDR prices — 720p/5s = 1.08, 1080p/5s = 2.16, full table, no interpolation", () => {
  assert.equal(estimateVfxCostUsd(q("720p", 5)), 1.08);
  assert.equal(estimateVfxCostUsd(q("1080p", 5)), 2.16);
  const table: Record<string, [number, number]> = { "360p": [0.54, 1.08], "540p": [0.72, 1.44], "720p": [1.08, 2.16], "1080p": [2.16, 4.32] };
  for (const [res, [five, ten]] of Object.entries(table)) {
    assert.equal(estimateVfxCostUsd(q(res as VfxPriceQuery["resolution"], 5)), five);
    assert.equal(estimateVfxCostUsd(q(res as VfxPriceQuery["resolution"], 10)), ten);
  }
  assert.equal(VFX_PRICES.length, 8);
  assert.ok(VFX_PRICES.every((p) => p.verified && p.dynamicRange === "sdr" && p.model === "ray-3.2" && p.requestType === "video_edit"));
  assert.equal(estimateVfxCostUsd(q("720p", 5.03)), 1.08);
  assert.throws(() => estimateVfxCostUsd(q("720p", 7)), (e: unknown) => e instanceof GenerativeProviderError && e.reason === "contract_unverified");
  assert.throws(() => estimateVfxCostUsd({ ...q("720p", 5), model: "ray-2" }), /no hay precio verificado/);
  assert.equal(lumaVfxProvider.estimateCostUsd(REQ), 1.08);
  assert.throws(() => assertVfxBudget("luma", 1.08, 2, { hardCapUsd: 5, committedUsd: 4, reservedUsd: 0 }), /tope absoluto/);
  assert.doesNotThrow(() => assertVfxBudget("luma", 1.08, 2, { hardCapUsd: 5, committedUsd: 2.16, reservedUsd: 1.08 }));
});

test("LUMA-PF: the free preflight is a single read-only GET /files?limit=1 with Bearer auth; 401 → unauthenticated", async () => {
  const prev = process.env.LUMA_API_KEY;
  process.env.LUMA_API_KEY = "test-key";
  try {
    const seen: { url: string; method?: string; auth?: string }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await lumaFilesPreflight(ok), { authenticated: true, status: 200, filesListed: 0 });
    assert.deepEqual(seen, [{ url: "https://agents.lumalabs.ai/v1/files?limit=1", method: "GET", auth: "Bearer test-key" }]);
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    assert.deepEqual(await lumaFilesPreflight(denied), { authenticated: false, status: 401 });
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("LUMA-REG: registry picks Luma only when requested and keyed; fixture otherwise (outside production)", () => {
  const prev = process.env.LUMA_API_KEY;
  try {
    delete process.env.LUMA_API_KEY;
    assert.equal(getVfxProvider("luma").name, "fixture");
    process.env.LUMA_API_KEY = "k";
    assert.equal(getVfxProvider("luma").name, "luma");
    assert.equal(getVfxProvider("luma").capabilities.requestType, "video_edit");
    assert.equal(getVfxProvider(undefined).name, "fixture");
  } finally {
    if (prev === undefined) delete process.env.LUMA_API_KEY;
    else process.env.LUMA_API_KEY = prev;
  }
});

test("VFX-UX: the Transform Scene contract fills conservative defaults and validates prompt and range", () => {
  const r = toVfxTransformRequest({ prompt: "  Nueva York de noche  " }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2 });
  assert.equal(r.prompt, "Nueva York de noche");
  assert.equal(r.preserveSubject, true);
  assert.equal(r.strength, "subtle");
  assert.equal(r.resolution, "720p");
  assert.equal(r.dynamicRange, "sdr");
  assert.equal(r.controls?.faceIdentity, true);
  assert.deepEqual(r.range, { startSeconds: 0, endSeconds: 5 });
  assert.throws(() => toVfxTransformRequest({ prompt: " " }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2 }));
  assert.throws(() => toVfxTransformRequest({ prompt: "x" }, REQ.source, { aspectRatio: "9:16", maxCostUsd: 2, range: { startSeconds: 0, endSeconds: 8 } }), /recortado/);
});

test("VFX-001: waits for Hans' source; the spend plan is pure, 720p/5 s = 1.08, within target and cap, and needs human authorization", () => {
  assert.equal(VFX_001.status, "WAITING_FOR_HANS_SOURCE_VIDEO");
  assert.equal(VFX_001.model, "ray-3.2");
  assert.equal(VFX_001.requestType, "video_edit");
  assert.equal(VFX_001.resolution, "720p");
  assert.equal(VFX_001.expectedCostUsd, 1.08);
  const src = { sha256: "c".repeat(64), sizeBytes: 12_000_000, mimeType: "video/mp4", durationSeconds: 5.0, width: 1080, height: 1920, fps: 30 };
  const plan = buildVfxSpendPlan(src);
  assert.equal(plan.plan, "VFX_001_SPEND_PLAN");
  assert.equal(plan.requiresHumanAuthorization, true);
  assert.equal(plan.estimatedCostUsd, 1.08);
  assert.equal(plan.request.strength, "flex_1");
  assert.equal(plan.maxPaidAttemptsWithinTarget, 1);
  assert.equal(plan.maxPaidAttempts, 2);
  assert.equal(plan.maximumCostUsd, 2.16);
  assert.ok(plan.maximumCostUsd <= VFX_001.hardCapUsd);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.options.map((o) => [o.resolution, o.usd, o.withinTarget]), [["720p", 1.08, true], ["540p", 0.72, true], ["1080p", 2.16, false]]);
  assert.ok(buildVfxSpendPlan({ ...src, durationSeconds: 7.2 }).blockers.some((b) => /recortarse/.test(b)));
  assert.ok(buildVfxSpendPlan({ ...src, width: 1920, height: 1080 }).blockers.some((b) => /9:16/.test(b)));
});

test("LUMA-ERR: a provider validation error keeps its message for diagnosis, without URLs", async () => {
  const res = new Response(JSON.stringify({ detail: [{ loc: ["body", "aspect_ratio"], msg: "not allowed for video_edit; see https://docs.example/x?sig=secret" }] }), { status: 422 });
  const d = await lumaErrorDetail(res);
  assert.match(d, /aspect_ratio/);
  assert.doesNotMatch(d, /https?:/);
  assert.equal(await lumaErrorDetail(new Response("not json", { status: 422 })), "");
});
