/**
 * chatgpt-26: Director plan → existing VerticalReel props. Synthetic fixtures only (no provider, network, Supabase,
 * Hans media). A passing bridge is not a permission to buy or generate anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cinematicDirectorRenderEnabled } from "./flag";
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

  // An AI recreation is now renderable ONLY because its mandatory label travels to the scene and is drawn.
  const ai = fixture(sb => { sb.scenes[1].resourceType = "generated_image"; });
  const r4 = planToVerticalReel(ai.b);
  assert.ok(r4.ok, !r4.ok ? JSON.stringify(r4.blockers) : "");
  if (r4.ok) {
    const aiShot = r4.applied.find(a => a.planned.label === "recreacion_ia")!;
    assert.equal(aiShot.applied.label, "recreacion_ia");
    assert.ok(r4.props.scenes.some(sc => sc.direction?.label === "recreacion_ia"));
  }
  // A label the composition cannot draw still blocks (the gate stays).
  const odd = fixture();
  odd.b.plan = { ...(odd.plan as object), shots: odd.plan.shots.map((s, i) => (i === 1 ? { ...s, asset: { ...s.asset, label: "sin_soporte" } } : s)) };
  const r5 = planToVerticalReel(odd.b);
  assert.ok(!r5.ok && r5.blockers.some(x => x.code === "CONTRACT_INVALID" || x.code === "LABEL_NOT_RENDERABLE"));
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

test("the bridge reaches production only through reel-render, lazily, behind CINEMATIC_DIRECTOR_RENDER_ENABLED", () => {
  let raw = "";
  try { raw = execFileSync("git", ["grep", "--untracked", "-l", "render-bridge", "--", "src", "remotion", "scripts"], { encoding: "utf8" }); } catch { raw = ""; }
  const out = raw.trim().split("\n").filter(Boolean);
  assert.ok(out.includes("src/lib/video/director/render-bridge.test.ts"), "the search itself works");
  const allowed = new Set(["src/lib/video/director/render-bridge.ts", "src/lib/video/director/reel-render.ts"]);
  for (const f of out) assert.ok(f.endsWith(".test.ts") || f.startsWith("scripts/director-") || allowed.has(f), f);
  // generate-video.ts: only a type import plus a dynamic import inside the flag check (flag off = nothing loaded).
  const gv = readFileSync("src/lib/video/generate-video.ts", "utf8");
  assert.doesNotMatch(gv, /^import \{[^}]*\} from "@\/lib\/video\/director\/reel-render"/m, "no static value import of reel-render");
  const gate = gv.indexOf("if (directorRender && cinematicDirectorRenderEnabled()) {"), dyn = gv.indexOf('await import("@/lib/video/director/reel-render")');
  assert.ok(gate > 0 && dyn > gate && dyn - gate < 200, "the dynamic import sits right inside the flag check");
  assert.equal(cinematicDirectorRenderEnabled({}), false, "off by default");
  assert.equal(cinematicDirectorRenderEnabled({ CINEMATIC_DIRECTOR_V2_ENABLED: "1" }), false, "the inspection flag does not turn the render on");
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

test("captions with non-finite or negative times block; the AI-recreation label is carried to the render", () => {
  for (const [s, e] of [[NaN, 1], [0, Infinity], [-1, 1]] as const) {
    const { b } = fixture();
    b.captions = [{ text: "x", startSeconds: s, endSeconds: e }];
    const r = planToVerticalReel(b);
    assert.ok(!r.ok && r.blockers.some(x => x.code === "INVALID_TIME"), `caption ${s}-${e}`);
  }
  const ai = fixture(sb => { sb.scenes[1].resourceType = "generated_image"; });
  const r = planToVerticalReel(ai.b);
  assert.ok(r.ok && r.props.scenes.filter(sc => sc.direction?.label === "recreacion_ia").length >= 1);
});

test("recipes drive the render: per-shot direction (motion, transitions, label) is in the props and in the applied record", () => {
  const { b } = fixture();
  const r = planToVerticalReel(b);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.applied.length, r.props.scenes.length);
  r.props.scenes.forEach((sc, i) => {
    const a = r.applied[i];
    assert.ok(sc.direction, "every Director scene carries a direction");
    assert.equal(sc.direction!.recipeId, a.recipeId);
    assert.equal(sc.direction!.motion, a.applied.motion);
    // A real clip never gets a synthetic zoom; a still never claims real motion.
    if (sc.mediaType === "video" && a.planned.movement === "real_motion") assert.equal(sc.direction!.motion, "real");
    if (sc.mediaType === "image") assert.notEqual(sc.direction!.motion, "real");
  });
  // The closing CTA recipe asks for fade_to_black: applied as a fade, not as the historic crossfade.
  const cta = r.applied.find(a => a.recipeId === "reel-cta-follow");
  if (cta) assert.equal(cta.applied.transitionOut, "fade");
  // The opening slot takes the safe visual hook: there is no approved presenter/avatar in this fixture (correction 3/3).
  assert.equal(r.applied[0].recipeId, "reel-hook-visual");
  assert.ok(r.applied.every(a => a.recipeId !== "reel-hook-face-or-avatar"));
  assert.equal(r.applied[0].applied.label, "ilustrativa", "stock keeps its illustrative label");
});

test("an approved avatar segment keeps its exact measured window, plays as filmed and is entered/left by cuts", () => {
  const { b, input } = fixture(undefined, true);
  b.media["avatar-sintetico"] = { url: "http://127.0.0.1/sintetico/avatar.mp4", mediaType: "video", license: "CLEARED" };
  const r = planToVerticalReel(b);
  assert.ok(r.ok, !r.ok ? JSON.stringify(r.blockers) : "");
  if (!r.ok) return;
  const i = r.shots.findIndex(s => s.assetId === "avatar-sintetico");
  const sc = r.props.scenes.find(x => x.mediaUrl.endsWith("avatar.mp4"))!;
  const seg0 = input.segments[0].id;
  assert.ok(i >= 0 && Math.abs(sc.startSeconds - b.segmentTimes[seg0].start) < 1e-3 && Math.abs(sc.endSeconds - b.segmentTimes[seg0].end) < 1e-3, "window = measured segment");
  assert.deepEqual([sc.direction!.motion, sc.direction!.transitionIn, sc.direction!.transitionOut], ["real", "cut", "cut"]);
  // An approved, locked avatar opening the Reel carries the presenter hook recipe, and nothing about the segment changes.
  assert.equal(r.applied.find(a => a.shotId === r.shots[i].shotId)!.recipeId, "reel-hook-face-or-avatar");
  assert.equal(r.applied.filter(a => a.recipeId === "reel-hook-face-or-avatar").length, 1, "only the approved avatar carries it");
});
