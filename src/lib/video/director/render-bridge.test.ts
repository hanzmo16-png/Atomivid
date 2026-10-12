/**
 * chatgpt-26: Director plan → existing VerticalReel props. Synthetic fixtures only (no provider, network, Supabase,
 * Hans media). A passing bridge is not a permission to buy or generate anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { GeneratedScript } from "@/lib/providers/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { inputFromReel } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog } from "./recipes";
import { planToVerticalReel, type BridgeInput, type ExistingMedia } from "./render-bridge";

const SCRIPT: GeneratedScript = {
  title: "Sintético",
  segments: [
    { text: "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo?", visualQuery: "tired creator laptop", visualConcepts: ["tired creator at laptop", "person checking clock"], energy: "high" },
    { text: "Escribe tu idea y la aplicación prepara guion, voz e imágenes.", visualQuery: "app screen typing", visualConcepts: ["hands typing on phone app", "app pantalla"] },
    { text: "Mira algunos resultados de nuestras pruebas.", visualQuery: "video results montage", visualConcepts: ["videos resultado montage", "phone showing videos"] },
    { text: "Síguenos para enterarte del lanzamiento.", visualQuery: "person smiling at camera", visualConcepts: ["woman smiling at camera", "creator waving"], energy: "low" },
  ],
};
const catalog = bundledRecipeCatalog();

function fixture(mutate?: (sb: ReturnType<typeof simulateStoryboard>) => void, avatar = false) {
  const sb = simulateStoryboard(SCRIPT);
  mutate?.(sb);
  const input = inputFromReel(sb, avatar ? { avatarScenes: [{ sceneId: "scene-0", assetId: "avatar-sintetico" }] } : {});
  const plan = proposePlan(input, catalog);
  const media: Record<string, ExistingMedia> = {};
  for (const a of input.inventory ?? []) media[a.id] = { url: `http://127.0.0.1/sintetico/${a.id}`, mediaType: a.motion === "real" ? "video" : "image", license: "CLEARED" };
  // "Measured" narration timings: deliberately not equal to the estimates (real voice is faster).
  let t = 0;
  const segmentTimes: BridgeInput["segmentTimes"] = {};
  for (const s of input.segments) { const len = (s.end - s.start) * 0.9; segmentTimes[s.id] = { start: t, end: t + len }; t += len; }
  const b: BridgeInput = { plan, input, catalog, media, segmentTimes, audioUrl: "http://127.0.0.1/sintetico/voz.wav",
    captions: [{ text: "subtítulo sintético", startSeconds: 0, endSeconds: 1 }], durationSeconds: t + 0.5 };
  return { b, plan, input };
}

test("valid plan + existing cleared media → VerticalReel props: continuous timeline on the measured narration, real clips stay video", () => {
  const { b, plan } = fixture();
  const r = planToVerticalReel(b);
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.blockers));
  if (!r.ok) return;
  assert.equal(r.paidCalls, 0);
  assert.equal(r.props.scenes.length, plan.shots.length);
  assert.equal(r.props.scenes[0].startSeconds, 0);
  for (let i = 1; i < r.props.scenes.length; i++) assert.ok(Math.abs(r.props.scenes[i].startSeconds - r.props.scenes[i - 1].endSeconds) < 0.05);
  for (const s of plan.shots) if (s.movement.realMotion) assert.equal(r.shots.find(x => x.shotId === s.id)!.mediaType, "video", s.id);
  // Phrase → shot correspondence is carried by order: scene i covers the measured window of its segment.
  assert.deepEqual(planToVerticalReel(b), r, "pure: same input, same output, no side effects");
});

test("blocks instead of filling gaps: pending licence, missing media, still for real motion, unrenderable AI label", () => {
  const pending = fixture();
  for (const k of Object.keys(pending.b.media)) pending.b.media[k] = { ...pending.b.media[k], license: "NEEDS_REVIEW" };
  const r1 = planToVerticalReel(pending.b);
  assert.equal(r1.ok, false);
  assert.ok(!r1.ok && r1.blockers.some(x => x.code === "LICENSE_NOT_CLEARED_FOR_RENDER" || x.code === "AUDIT_LICENSE_PENDING"));

  const missing = fixture();
  delete missing.b.media["scene-2:planned"];
  const r2 = planToVerticalReel(missing.b);
  assert.ok(!r2.ok && r2.blockers.some(x => x.code === "MEDIA_MISSING"));

  const still = fixture();
  const realShot = still.plan.shots.find(s => s.movement.realMotion)!;
  still.b.media[realShot.asset.assetId!] = { ...still.b.media[realShot.asset.assetId!], mediaType: "image" };
  const r3 = planToVerticalReel(still.b);
  assert.ok(!r3.ok && r3.blockers.some(x => x.code === "REAL_MOTION_WITHOUT_CLIP"));

  const ai = fixture(sb => { sb.scenes[1].resourceType = "generated_image"; });
  const r4 = planToVerticalReel(ai.b);
  assert.ok(!r4.ok && r4.blockers.some(x => x.code === "LABEL_NOT_RENDERABLE"));
});

test("material that would have to be created is never authorised here; missing timings block; tampered plans block", () => {
  const nm = fixture();
  nm.b.input = { ...nm.b.input, inventory: (nm.b.input.inventory ?? []).filter(a => a.id !== "scene-3:planned") };
  nm.b.plan = proposePlan(nm.b.input, catalog);
  const r1 = planToVerticalReel(nm.b);
  assert.ok(!r1.ok && r1.blockers.some(x => x.code === "MATERIAL_NOT_AUTHORISED" || x.code === "AUDIT_BUDGET_EXCEEDED" || x.code === "AUDIT_NO_MATERIAL"), !r1.ok ? JSON.stringify(r1.blockers.map(b => b.code)) : "");

  const nt = fixture();
  delete nt.b.segmentTimes["scene-1"];
  const r2 = planToVerticalReel(nt.b);
  assert.ok(!r2.ok && r2.blockers.some(x => x.code === "TIMING_MISSING"));

  for (const tamper of [{ paidCalls: 1 }, { executable: true }]) {
    const t = fixture();
    t.b.plan = { ...(t.plan as object), ...tamper };
    const r = planToVerticalReel(t.b);
    assert.ok(!r.ok && r.blockers.some(x => x.code === "CONTRACT_INVALID"), JSON.stringify(tamper));
  }
});

test("an approved avatar segment passes through untouched and uses its existing clip", () => {
  const { b } = fixture(undefined, true);
  b.media["avatar-sintetico"] = { url: "http://127.0.0.1/sintetico/avatar.mp4", mediaType: "video", license: "CLEARED" };
  const r = planToVerticalReel(b);
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.blockers));
  if (r.ok) assert.ok(r.shots.some(s => s.assetId === "avatar-sintetico" && s.mediaType === "video"));
});

test("the bridge is not wired into production: only tests and the local harness import it", () => {
  let raw = "";
  try { raw = execFileSync("git", ["grep", "--untracked", "-l", "render-bridge", "--", "src", "remotion", "scripts"], { encoding: "utf8" }); } catch { raw = ""; }
  const out = raw.trim().split("\n").filter(Boolean);
  assert.ok(out.includes("src/lib/video/director/render-bridge.test.ts"), "the search itself works");
  for (const f of out) assert.ok(f.endsWith(".test.ts") || f.startsWith("scripts/director-bridge-") || f === "src/lib/video/director/render-bridge.ts", f);
});

// ---- Correction 1 (chatgpt-26): non-finite or negative times must block, never reach the props.
const finiteNonNeg = (x: number) => Number.isFinite(x) && x >= 0;
function assertNoBadTimes(r: ReturnType<typeof planToVerticalReel>, label: string) {
  if (!r.ok) return;
  assert.ok(finiteNonNeg(r.props.durationSeconds), `${label}: durationSeconds ${r.props.durationSeconds}`);
  for (const s of r.props.scenes) assert.ok(finiteNonNeg(s.startSeconds) && finiteNonNeg(s.endSeconds) && s.endSeconds > s.startSeconds, `${label}: scene ${s.startSeconds}-${s.endSeconds}`);
  for (const c of r.props.captions) assert.ok(finiteNonNeg(c.startSeconds) && finiteNonNeg(c.endSeconds), `${label}: caption`);
}

test("durationSeconds NaN / ±Infinity / negative blocks explicitly; a valid value still renders", () => {
  for (const d of [NaN, Infinity, -Infinity, -1]) {
    const { b } = fixture();
    b.durationSeconds = d;
    const r = planToVerticalReel(b);
    assertNoBadTimes(r, `duration=${d}`);
    assert.equal(r.ok, false, `duration=${d} must block`);
    assert.ok(!r.ok && r.blockers.some(x => x.code === "INVALID_TIME"), `duration=${d}: ${!r.ok ? r.blockers.map(x => x.code) : ""}`);
  }
  const { b } = fixture();
  const ok = planToVerticalReel(b);
  assert.equal(ok.ok, true);
  assertNoBadTimes(ok, "valid");
});

test("segmentTimes with NaN / ±Infinity / negative start or end / end ≤ start blocks; never produces bad props", () => {
  const cases: [string, number, number][] = [["NaN start", NaN, 3], ["NaN end", 0, NaN], ["+Inf end", 0, Infinity], ["-Inf start", -Infinity, 3],
    ["negative start", -5, 3], ["negative end", -5, -1], ["end = start", 2, 2], ["end < start", 3, 1]];
  for (const [label, start, end] of cases) {
    const { b } = fixture();
    // Shift the first segment only; the rest stay valid so partial checks are exercised.
    b.segmentTimes["scene-0"] = { start, end };
    const r = planToVerticalReel(b);
    assertNoBadTimes(r, label);
    assert.equal(r.ok, false, `${label} must block`);
  }
});

test("captions with non-finite or negative times block; LABEL_NOT_RENDERABLE and the licence/material blocks are unchanged", () => {
  for (const [s, e] of [[NaN, 1], [0, Infinity], [-1, 1]] as const) {
    const { b } = fixture();
    b.captions = [{ text: "x", startSeconds: s, endSeconds: e }];
    const r = planToVerticalReel(b);
    assert.ok(!r.ok && r.blockers.some(x => x.code === "INVALID_TIME"), `caption ${s}-${e}`);
  }
  const ai = fixture(sb => { sb.scenes[1].resourceType = "generated_image"; });
  const r = planToVerticalReel(ai.b);
  assert.ok(!r.ok && r.blockers.some(x => x.code === "LABEL_NOT_RENDERABLE"));
});
