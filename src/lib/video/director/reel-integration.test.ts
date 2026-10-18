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
import { directorRecordPath, parseDirectorRecord } from "@/lib/video/director-applied";

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
  // chatgpt-06: the same gate now also requires a pilot account (render-access.ts: V2 flag + visual Reel + pilot list).
  assert.match(page, /const directorInspection = directorInspectionAllowed\(user, data\)\s*\?\s*inspectReel\(data\.script_json, \{ renderEnabled: directorRenderAllowed\(user, data\) \}\)\s*:\s*null;/);
  assert.match(page, /\{directorInspection && <DirectorInspectionPanel inspection=\{directorInspection\} \/>\}/);
  const review = page.slice(page.indexOf("<ScriptReview"));
  const props = review.slice(0, review.indexOf("/>"));
  // Anexo C1: the only Director-related prop is the OWNER's optional material ceiling (a number to send, never a
  // decision): the inspection still never gates or changes the generate button.
  const withoutOffer = props.replace(/directorMaterialOffer=\{[\s\S]*?maxUsd: MAX_DIRECTOR_MATERIAL_USD \} : undefined\}/, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(withoutOffer, /director/i, "ScriptReview (and its generate button) gets no Director decision");
  assert.match(props, /directorMaterialOffer=\{isInternalProductionOwner\(user\) && data\.mode === "visual"/, "owner only");
  const ui = src("src/app/dashboard/review/[id]/ScriptReview.tsx");
  assert.doesNotMatch(ui.slice(ui.indexOf("onClick={() => generateFinalVideo()}") - 40, ui.indexOf("onClick={() => generateFinalVideo()}") + 200), /directorMaterial/, "the generate button is not gated by it");
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

test("inspection note tells the truth about the render: proposal-only when the render flag is off, eligible/requested (never applied) when on", () => {
  const off = inspectReel(SCRIPT), on = inspectReel(SCRIPT, { renderEnabled: true });
  assert.ok(off.status !== "error" && on.status !== "error");
  assert.equal(off.renderRequest, "proposal_only");
  assert.match(off.note, /No cambia el guion ni el render/);
  assert.equal(on.renderRequest, "eligible");
  assert.doesNotMatch(on.note, /ni el render/);
  // chatgpt-30 C1: the page only knows Vercel's flags; the worker re-decides with its own. No categorical promise.
  assert.match(on.note, /se solicita/i);
  assert.match(on.note, /solo se confirma después del render/);
  assert.doesNotMatch(on.note, /ese plan dirige el montaje/);
});

test("inspection note matches the fail-closed contract: a requested Director is applied or the render stops with a cause; it is never replaced by the classic montage (proposal-only keeps the classic flow)", () => {
  const off = inspectReel(SCRIPT), on = inspectReel(SCRIPT, { renderEnabled: true });
  assert.ok(off.status !== "error" && on.status !== "error");
  // requested → applied, or requested → failed with an explicit cause before reserving or spending (render-access.ts).
  assert.match(on.note, /se detiene con una causa explícita antes de reservar o gastar/);
  assert.match(on.note, /no se sustituye por el montaje clásico/);
  assert.doesNotMatch(on.note, /el montaje es el clásico|montaje clásico en su lugar|vuelve al montaje clásico/, "never promises a classic fallback for a requested Director");
  assert.doesNotMatch(on.note, /\baplicad[oa]\b(?! solo se confirma)/i, "before the render the note never claims the Director was applied");
  // Not requested: the classic flow stays valid and the note says so, without mentioning any Director failure.
  assert.match(off.note, /«Generar video final» sigue siendo el flujo actual/);
  assert.doesNotMatch(off.note, /se detiene|causa explícita|montaje clásico/);
});

test("applied record: the video page reads only a well-formed ok record and the path sits next to the MP4", () => {
  assert.equal(directorRecordPath("videos/abc/attempt-2/final.mp4"), "videos/abc/attempt-2/director.json");
  const row = { shotId: "s1", anchorText: "Hola", recipeId: "reel-hook", unsupported: ["x"],
    planned: { movement: "push_in_still" }, applied: { motion: "push_in", transitionIn: "cut", transitionOut: "crossfade", label: null, startSeconds: 0, endSeconds: 2.5 } };
  assert.deepEqual(parseDirectorRecord({ ok: true, applied: [row] })?.[0], { shotId: "s1", anchorText: "Hola", recipeId: "reel-hook", startSeconds: 0, endSeconds: 2.5,
    plannedMovement: "push_in_still", motion: "push_in", transitionIn: "cut", transitionOut: "crossfade", label: null, unsupported: ["x"] });
  assert.equal(parseDirectorRecord({ ok: false, blockers: [] }), null, "a blocked plan never shows as applied");
  assert.equal(parseDirectorRecord({ ok: true, applied: [{ shotId: "s1" }] }), null, "malformed rows show nothing instead of guessing");
  assert.equal(parseDirectorRecord(null), null);
});
