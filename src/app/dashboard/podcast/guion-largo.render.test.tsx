/** P0 2026-11-01: el asistente escribe la conversación con IA por bloques, muestra el progreso y continúa tras un error. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pendingJob, progressText } from "./PodcastWizard";

test("progreso por bloques, en español y con números reales", () => {
  assert.equal(progressText({ step: 1, steps: 7 }), "Escaleta lista. Escribiendo el bloque 1 de 6…");
  assert.equal(progressText({ step: 3, steps: 7 }), "Bloque 2 de 6 listo. Escribiendo el bloque 3 de 6…");
  assert.equal(progressText({ step: 7, steps: 7 }), "Uniendo los bloques…");
});

test("un trabajo a medias se ofrece como «Continuar» solo si es del mismo tema, duración y anfitriones", () => {
  const ask = { topic: "Base Dulce", minutes: 30, hostName: "Valeria Moncler", guestName: "El Duro Hans" };
  const job = { input: { ...ask }, plan: { segments: [1, 2, 3, 4, 5, 6] }, segments: [[], []] };
  assert.equal(pendingJob(job, ask), "bloque 3 de 6");
  assert.equal(pendingJob({ ...job, plan: null, segments: [] }, ask), "escaleta");
  assert.equal(pendingJob(job, { ...ask, minutes: 45 }), null);
  assert.equal(pendingJob(job, { ...ask, topic: "otro" }), null);
  assert.equal(pendingJob(null, ask), null);
});

test("el botón usa los pasos con IA (sin useAi ni plantilla de respaldo); la plantilla solo por elección expresa; hasta 60 min", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /action: "script-step", \.\.\.scriptAsk\(\), state/);
  assert.doesNotMatch(wiz, /useAi: true/);
  assert.match(wiz, /data-testid="usar-plantilla">Usar la plantilla breve \(unos 5 min, sin IA\)/);
  assert.match(wiz, /data-testid="progreso-guion"/);
  assert.match(wiz, /type="range" min=\{1\} max=\{60\}/);
  // Un error recuperable conserva el trabajo en el borrador (localStorage); uno no recuperable lo descarta.
  assert.match(wiz, /if \(r\.state !== undefined\) \{ state = r\.state; set\(\{ scriptJob: r\.state \}\); \}/);
  assert.match(wiz, /if \(r\.recoverable === false\) set\(\{ scriptJob: null \}\);/);
});
