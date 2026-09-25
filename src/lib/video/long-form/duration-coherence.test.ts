import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateNarrationDuration,
  LONG_FORM_NARRATION_WORDS_PER_SECOND,
  narrationWordBudget,
} from "./duration-budget";
import { generateDocumentaryScript, LongFormScriptDurationError, type DocumentaryScript } from "./documentary-script";
import { shotsForSpan } from "./shots";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES } from "./production-plan";
import { documentary180sFixture } from "./test-fixtures";

/**
 * P0 2026-09-25 (Canal de Panamá): 180 s pedidos → plan ~4m33 → render
 * ~300 s (9010 fotogramas); plan 69 escenas vs ejecución 74. Sin red ni
 * proveedores: la llamada a Claude se sustituye por `parse`.
 */

test("causa raíz reproducida: las 763 palabras reales de Panamá a 2.5 palabras/s ≈ 305 s (medido: 299.8 s), no 180", () => {
  const e = evaluateNarrationDuration(763, 180);
  assert.ok(Math.abs(e.estimatedSeconds - 299.8) / 299.8 < 0.03, `estimado ${e.estimatedSeconds}`);
  assert.equal(e.withinHardTolerance, false, "un guion así ya no se acepta");
  // Ritmo calibrado con el dato real (763 / 299.817 = 2.545), redondeado a la baja.
  assert.ok(LONG_FORM_NARRATION_WORDS_PER_SECOND <= 763 / 299.817);
});

test("presupuesto de palabras: 180 s → ~450 palabras en 5 beats (antes: ≥ 750 por el '~150-250 palabras/beat' fijo)", () => {
  const b = narrationWordBudget(180);
  assert.equal(b.totalWords, 450);
  assert.equal(b.beats, 5);
  assert.equal(b.wordsPerBeat, 90);
  const b15 = narrationWordBudget(900);
  assert.equal(b15.beats, 10);
  assert.equal(b15.totalWords, 2250);
});

function fakeScript(wordsPerBeat: number, beats = 5): DocumentaryScript {
  const narration = Array.from({ length: wordsPerBeat }, (_, i) => (i === 0 ? "Panamá" : "palabra")).join(" ") + ".";
  return {
    title: "t",
    workingTitleOptions: ["t"],
    hook: "En 1914 un barco cruzó dos océanos en ocho horas.",
    beats: Array.from({ length: beats }, () => ({
      type: "setup" as const,
      purpose: "p",
      narration,
      claims: [],
      visuals: [
        { description: "ship moving through canal locks", motion: true },
        { description: "jungle", motion: false },
      ],
    })),
  };
}

const pack = { topic: "Canal de Panamá", sources: [{ id: "s1", title: "Fuente", kind: "book" as const }], openQuestions: [] };

test("tolerancia aplicada: guion largo (Panamá: ~153 palabras/beat) → UNA corrección; se acepta la versión dentro del presupuesto", async () => {
  const prompts: string[] = [];
  const beats = await generateDocumentaryScript({
    researchPack: pack as never,
    mode: "curiosity_documentary",
    targetDurationSeconds: 180,
    parse: async ({ prompt }) => {
      prompts.push(prompt);
      return prompts.length === 1 ? fakeScript(153) : fakeScript(90);
    },
  });
  assert.equal(prompts.length, 2, "exactamente un reintento");
  assert.match(prompts[0], /450 palabras EN TOTAL/);
  assert.match(prompts[1], /CORRECCIÓN OBLIGATORIA/);
  const words = beats.reduce((s, b) => s + b.narration.split(/\s+/).length, 0);
  assert.ok(evaluateNarrationDuration(words, 180).withinTolerance);
});

test("tolerancia aplicada: si tras la corrección sigue fuera de ±25% → no se acepta (sin tercer intento)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      generateDocumentaryScript({
        researchPack: pack as never,
        mode: "curiosity_documentary",
        targetDurationSeconds: 180,
        parse: async () => ((calls += 1), fakeScript(153)),
      }),
    (err: unknown) => err instanceof LongFormScriptDurationError,
  );
  assert.equal(calls, 2);
});

test("tolerancia: un guion dentro de ±15% no se corrige (una sola llamada)", async () => {
  let calls = 0;
  await generateDocumentaryScript({
    researchPack: pack as never,
    mode: "curiosity_documentary",
    targetDurationSeconds: 180,
    parse: async () => ((calls += 1), fakeScript(95)),
  });
  assert.equal(calls, 1);
});

test("escenas: el número confirmado por beat se respeta si la duración real lo permite (3-8 s por escena)", () => {
  const base = { beatId: "beat-1", beatType: "setup" as const, startSec: 0, narration: "x", strategy: "balanced" as const };
  // Plan: 12 escenas para 48.6 s estimados; real: 53.6 s → default daría 13.
  assert.equal(shotsForSpan({ ...base, endSec: 53.6 }).length, 13);
  assert.equal(shotsForSpan({ ...base, endSec: 53.6, targetCount: 12 }).length, 12);
  // Imposible respetarlo (12 escenas en 20 s = 1.7 s/escena) → reparto por defecto.
  assert.equal(shotsForSpan({ ...base, endSec: 20, targetCount: 12 }).length, shotsForSpan({ ...base, endSec: 20 }).length);
});

test("plan = contrato: el plan registra escenas por beat y la duración pedida", () => {
  const script = documentary180sFixture();
  const plan = computeProductionPlan({ ...script, strategy: "balanced", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false, requestedDurationSeconds: 180 });
  const counts = plan.beatShotCounts ?? {};
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), plan.shotCount);
  assert.equal(plan.requestedDurationSeconds, 180);
  assert.ok(Math.abs(plan.durationSeconds - 180) / 180 <= 0.15, `fixture de 180 s estimada en ${plan.durationSeconds}s`);
});
