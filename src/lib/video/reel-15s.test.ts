/**
 * END GAME C: Shorts de 15 s de punta a punta (formulario → guion → presupuesto → worker → límite de la base).
 * Pure checks only: no provider, no network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALLOWED_DURATIONS, validateCommonFields } from "@/app/dashboard/new/validation";
import { availableVideoDurations } from "@/lib/video/avatar/duration";
import { formProduction } from "@/lib/video/form-production";
import { targetWordsFor } from "@/lib/video/script-pacing";
import { buildScriptRequest } from "@/lib/ai/script";
import { scriptLengthReview } from "@/lib/video/script-length-review";
import { acceptanceWindow, fitForDuration, narrationStats, recommendedCapacity } from "@/lib/video/narration-fit";
import { narrationCharsCeiling, scriptGenerationCeilingUsd } from "@/lib/supply/production-check";
import { checkDuration } from "@/lib/video/duration-check";
import { fixtureScriptProvider } from "@/lib/providers/script/fixture";

const ROOT = path.resolve(__dirname, "../../..");
const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 10 === 9 ? "palabra." : "palabra")).join(" ");
const BASE = { topic: "Un tema", style: "Educativo", language: "es", scriptChoice: "generated" as const, ownText: "", adaptAccepted: false,
  avatarNarrationSource: "tts", maxAvatarSeconds: 90 };

test("15 s: el servidor la acepta y el Reel la ofrece; 30/60/90 siguen igual", () => {
  assert.deepEqual(ALLOWED_DURATIONS, [15, 30, 60, 90]);
  for (const d of [15, 30, 60, 90]) assert.equal(validateCommonFields({ topic: "t", style: "s", durationSeconds: d, language: "es" }), null);
  for (const d of [10, 20, 45, 120]) assert.match(validateCommonFields({ topic: "t", style: "s", durationSeconds: d, language: "es" })!, /Duración no válida/);
  assert.deepEqual(availableVideoDurations("visual", 0), [15, 30, 60, 90]);
  assert.equal(formProduction({ ...BASE, mode: "visual", durationSeconds: 15 }).inputError, null);
});

test("15 s es solo Reel: Avatar no la ofrece ni la acepta por POST directo", () => {
  assert.deepEqual(availableVideoDurations("avatar", 90), [30, 60, 90]);
  assert.match(formProduction({ ...BASE, mode: "avatar", durationSeconds: 15 }).inputError ?? "", /no está disponible para esta modalidad/);
});

test("guion de 15 s: ~41 palabras en 3 escenas, y la revisión de longitud usa la misma ventana", () => {
  assert.equal(targetWordsFor(15), 41);
  const req = buildScriptRequest({ topic: "Mary Celeste", style: "misterio", durationSeconds: 15 });
  assert.deepEqual([req.minWords, req.maxWords], [37, 45]);
  const cap = recommendedCapacity(15);
  assert.ok(cap.minWords <= 41 && 41 <= cap.maxWords);
  assert.equal(scriptLengthReview({ segments: [{ text: words(41) }] } as never, 15), null);
  assert.match(scriptLengthReview({ segments: [{ text: words(83) }] } as never, 15)!, /para 15 segundos necesita entre 37 y 45/);
});

test("fixture de guion de 15 s: 3 escenas dentro de la ventana de palabras", async () => {
  const s = await fixtureScriptProvider.generateScript({ topic: "Mary Celeste", style: "misterio", durationSeconds: 15, language: "es" });
  assert.equal(s.segments.length, 3);
  assert.equal(scriptLengthReview(s, 15), null);
});

test("presupuesto: el sobre de 15 s es estrictamente menor que el de 30 s (voz y guion)", () => {
  assert.ok(narrationCharsCeiling(15) > 0 && narrationCharsCeiling(15) < narrationCharsCeiling(30));
  const at = (d: number) => scriptGenerationCeilingUsd({ topic: "t", style: "s", durationSeconds: d, language: "es" });
  assert.ok(at(15) > 0 && at(15) <= at(30));
});

test("worker: un guion de 15 s que el formulario deja iniciar cabe en la tolerancia ±10 % con una corrección de ritmo", () => {
  for (let n = 20; n <= 70; n++) {
    const stats = narrationStats(words(n));
    const fit = fitForDuration(stats, 15, availableVideoDurations("visual", 0));
    const { strict } = acceptanceWindow(15);
    const mid = stats.estimate.mid, corrected = mid / Math.min(1.15, Math.max(0.85, mid / 15));
    const ok = (mid >= strict.min && mid <= strict.max) || (corrected >= strict.min && corrected <= strict.max);
    if (fit.allowed) assert.ok(ok, `${n} palabras permitido pero el worker lo rechazaría`);
  }
  assert.equal(checkDuration(15, 14.2).withinTolerance, true);
  assert.equal(checkDuration(15, 17).withinTolerance, false);
});

test("base de datos: el CHECK vigente de duración admite 15 s fuera de Long Form (sin migración nueva)", () => {
  const dir = path.join(ROOT, "supabase/migrations");
  const latest = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))
    .filter((f) => /add constraint video_requests_duration_seconds_check/.test(fs.readFileSync(path.join(dir, f), "utf8"))).sort().at(-1)!;
  assert.equal(latest, "20261010050000_long_form_30_minutes.sql");
  assert.match(fs.readFileSync(path.join(dir, latest), "utf8"), /mode <> 'long_form' and duration_seconds > 0 and duration_seconds <= 120/);
});
