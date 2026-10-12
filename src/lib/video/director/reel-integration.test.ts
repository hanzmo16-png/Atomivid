/**
 * chatgpt-23: optional, read-only Director inspection of Reels. Synthetic fixtures only: no provider, network,
 * Supabase or render. Nothing here proves production autonomy or visual quality.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GeneratedScript } from "@/lib/providers/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { auditPlan, maxSameRecipeRun, recipeVariety } from "./audit";
import { DirectorPlanSchema } from "./contract";
import { cinematicDirectorV2Enabled } from "./flag";
import { inputFromReel } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog, loadRecipeCatalog } from "./recipes";
import { inspectReel } from "./reel-inspection";

const SCRIPT: GeneratedScript = {
  title: "Tu idea en video",
  segments: [
    { text: "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo?", visualQuery: "tired creator laptop", visualConcepts: ["tired creator at laptop", "person checking clock"], energy: "high" },
    { text: "Escribe tu idea y la aplicación prepara guion, voz e imágenes.", visualQuery: "app screen typing", visualConcepts: ["hands typing on phone app", "app pantalla"], energy: "medium" },
    { text: "Mira algunos resultados de nuestras pruebas.", visualQuery: "video results montage", visualConcepts: ["videos resultado montage", "phone showing videos"], energy: "medium" },
    { text: "Síguenos para enterarte del lanzamiento.", visualQuery: "person smiling at camera", visualConcepts: ["woman smiling at camera", "creator waving"], energy: "low" },
  ],
};
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test("flag off by default; the review page computes the inspection only behind the flag and never touches ScriptReview props", () => {
  assert.equal(cinematicDirectorV2Enabled({}), false);
  assert.equal(cinematicDirectorV2Enabled({ CINEMATIC_DIRECTOR_V2_ENABLED: "0" }), false);
  assert.equal(cinematicDirectorV2Enabled({ CINEMATIC_DIRECTOR_V2_ENABLED: "true" }), true);
  const page = src("src/app/dashboard/review/[id]/page.tsx");
  assert.match(page, /const directorInspection = cinematicDirectorV2Enabled\(\) && data\.mode !== "avatar" && data\.mode !== "long_form" && !data\.recorded_audio_path\s*\?\s*inspectReel\(data\.script_json\)\s*:\s*null;/);
  assert.match(page, /\{directorInspection && <DirectorInspectionPanel inspection=\{directorInspection\} \/>\}/);
  const review = page.slice(page.indexOf("<ScriptReview"));
  assert.doesNotMatch(review.slice(0, review.indexOf("/>")), /director/i, "ScriptReview (and its generate button) gets no Director input");
});

test("flag on: a real Reel script yields a valid 9:16 proposal plan, executable=false, paidCalls=0, full coverage", () => {
  const r = inspectReel(SCRIPT);
  assert.notEqual(r.status, "error", r.status === "error" ? r.message : "");
  if (r.status === "error") return;
  assert.equal(r.mode, "proposal"); assert.equal(r.executable, false); assert.equal(r.paidCalls, 0);
  assert.equal(r.storyboardSource, "simulated");
  assert.ok(r.metrics);
  assert.equal(r.metrics!.coveragePct, 100);
  assert.equal(r.metrics!.durationOk, true);
  assert.equal(r.metrics!.paidCalls, 0);
  assert.ok(r.shots.length >= SCRIPT.segments.length);
  // Every shot anchors on the literal script text of its scene.
  const sb = simulateStoryboard(SCRIPT);
  for (const s of r.shots) assert.ok(sb.scenes.find(sc => sc.id === s.segmentId)!.narrationText.includes(s.anchorText), s.id);
  // Planned stock is not chosen yet: licences are reported as pending, never as approved.
  assert.ok(r.issues.some(i => i.code === "LICENSE_PENDING"));
  // Hook/closing recipes are placed on the VIDEO's first/last unit (a Reel is one sequence), never mid-video.
  const catalog = bundledRecipeCatalog();
  const pos = new Map(catalog.recipes.map(x => [x.id, x.select.position]));
  const lastSeg = r.shots[r.shots.length - 1].segmentId;
  for (const s of r.shots) {
    if (s.recipeId && pos.get(s.recipeId) === "first") assert.equal(s.segmentId, "scene-0", s.id);
    if (s.recipeId && pos.get(s.recipeId) === "last") assert.equal(s.segmentId, lastSeg, s.id);
  }
  const raw = inputFromReel(sb);
  assert.equal(raw.aspect, "9:16"); assert.equal(raw.genre, "reel"); assert.equal(raw.budget.remainingUsd, 0);
});

test("invalid or tampered proposals are rejected by the gate and nothing in the inspection path can pay", () => {
  const catalog = bundledRecipeCatalog();
  const raw = inputFromReel(simulateStoryboard(SCRIPT));
  const plan = proposePlan(raw, catalog);
  for (const tamper of [{ paidCalls: 1 }, { executable: true }, { mode: "execute" }]) {
    const a = auditPlan({ ...plan, ...tamper }, raw, catalog);
    assert.equal(a.ok, false);
    assert.ok(a.issues.some(i => i.code === "CONTRACT_INVALID" || i.code === "PAID_EXECUTION"), JSON.stringify(tamper));
  }
  // A broken script degrades to an error object, never an exception on the review page.
  assert.equal(inspectReel({ title: "x", segments: [] }).status, "error");
  assert.equal(inspectReel(null as unknown as GeneratedScript).status, "error");
  // Import graph of the inspection: no provider, ledger, Supabase, worker or HTTP client anywhere.
  const files = ["reel-inspection.ts", "from-reel.ts", "propose.ts", "audit.ts", "report.ts", "recipes.ts", "contract.ts", "policy.ts"].map(f => `src/lib/video/director/${f}`);
  files.push("src/lib/video/storyboard/simulate.ts");
  for (const f of files) {
    const code = src(f);
    assert.doesNotMatch(code, /from "@\/lib\/(providers\/(?!types)|paid-calls|supply|supabase|worker)|\bfetch\(|createClient|createServiceClient/, f);
  }
  assert.equal(DirectorPlanSchema.safeParse({ ...plan, paidCalls: 1 }).success, false);
});

test("avatar continuity, labels and real movement survive the Reel adaptation", () => {
  const catalog = bundledRecipeCatalog();
  const sb = simulateStoryboard(SCRIPT);
  sb.scenes[1].resourceType = "generated_image"; // AI still: must carry the recreation label and never fake motion
  const raw = inputFromReel(sb, { avatarScenes: [{ sceneId: "scene-0", assetId: "avatar-approved" }] });
  const plan = proposePlan(raw, catalog);
  const audit = auditPlan(plan, raw, catalog);
  const locked = plan.shots.filter(s => s.segmentId === "scene-0");
  assert.ok(locked.length >= 1 && locked.every(s => s.asset.status === "locked" && s.asset.assetId === "avatar-approved"));
  assert.ok(!audit.issues.some(i => i.code === "LOCKED_SEGMENT_ALTERED" || i.code === "CONTINUITY_CONFLICT"));
  const still = plan.shots.filter(s => s.segmentId === "scene-1" && s.asset.assetId === "scene-1:planned");
  for (const s of still) { assert.equal(s.asset.label, "recreacion_ia"); assert.equal(s.movement.realMotion, false); }
  assert.ok(!audit.issues.some(i => i.code === "FAKE_MOTION" || i.code === "RECREATION_WITHOUT_LABEL"));
  assert.equal(audit.metrics?.labelsOk, true);
  const video = plan.shots.filter(s => s.asset.assetId?.endsWith(":planned") && s.segmentId !== "scene-1");
  assert.ok(video.every(s => s.movement.kind !== "push_in_still" || !s.movement.realMotion), "a zoom on a still is never reported as real motion");
});

test("recipeVariety excludes the absence of a recipe and stays within 0..1; pending shots break runs", () => {
  assert.equal(recipeVariety(["a", null, null, "b"], 8), 1);
  assert.equal(recipeVariety(["a", "a", null], 8), 0.5);
  assert.equal(recipeVariety([null, null], 8), 0);
  assert.equal(recipeVariety([], 8), 0);
  assert.equal(recipeVariety(["a", "b", "c"], 2), 1); // capped by the genre pool (a 3rd id can only be an unknown recipe)
  for (let n = 0; n < 200; n++) {
    const ids = Array.from({ length: 1 + (n % 12) }, (_, i) => ((n * 7 + i * 3) % 5 === 0 ? null : `r${(n + i) % 6}`));
    const v = recipeVariety(ids, 1 + (n % 9));
    assert.ok(v >= 0 && v <= 1, `${v} for ${JSON.stringify(ids)}`);
  }
  assert.equal(maxSameRecipeRun(["a", "a", null, "a"]), 2);
  assert.equal(maxSameRecipeRun([null, null, null]), 0);
  assert.equal(maxSameRecipeRun(["a", "b", "b", "b"]), 3);
  // On a real plan the metric is coherent with the shots.
  const catalog = loadRecipeCatalog();
  const raw = inputFromReel(simulateStoryboard(SCRIPT));
  const m = auditPlan(proposePlan(raw, catalog), raw, catalog).metrics!;
  assert.ok(m.recipeVariety >= 0 && m.recipeVariety <= 1);
});
