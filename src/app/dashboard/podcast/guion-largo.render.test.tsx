/** P0 2026-11-01: el asistente escribe la conversación con IA por bloques, muestra el progreso y continúa tras un error. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasRecoverableDraft, pendingJob, progressText, resumedDraft, WIZARD_RECOVERABLE_KEY } from "./PodcastWizard";

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
  assert.equal(pendingJob(job, { ...ask, hostPersonality: "otra voz" }), null);
  assert.equal(pendingJob(job, { ...ask, guestRole: "ingeniero" }), null);
  assert.equal(pendingJob(null, ask), null);
});

test("el botón usa los pasos con IA (cliente runScriptGeneration, sin useAi ni plantilla de respaldo); la plantilla solo por elección expresa; hasta 60 min", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  const client = readFileSync(path.join(__dirname, "../../../lib/podcast/v3/script-client.ts"), "utf8");
  assert.match(wiz, /runScriptGeneration\(scriptAsk\(\), d\.scriptJob \?\? null,/);
  assert.match(client, /action: "script-step", \.\.\.ask, state/);
  assert.doesNotMatch(wiz, /useAi: true/);
  assert.match(wiz, /data-testid="usar-plantilla">Usar la plantilla breve \(unos 5 min, sin IA\)/);
  assert.match(wiz, /data-testid="progreso-guion"/);
  assert.match(wiz, /type="range" min=\{1\} max=\{60\}/);
  // El estado del trabajo solo se escribe si la generación sigue viva (no fue cancelada por «Empezar de nuevo»).
  assert.match(wiz, /onState: \(st\) => \{ if \(live\(\)\) set\(\{ scriptJob: st \}\); \}/);
  assert.match(wiz, /const live = \(\) => scriptSeq\.current === id && !ctl\.signal\.aborted;/);
});

test("progreso con ampliación y espera real (sin porcentajes inventados)", () => {
  assert.equal(progressText({ step: 3, steps: 4, phase: "ampliando" }), "Ampliando el bloque 3 de 3 (sin repetir lo escrito)…");
  assert.equal(progressText({ step: 2, steps: 4, phase: "bloque", waiting: "El bloque 2 de 3 sigue generándose en el servidor; esperando el resultado…" }), "El bloque 2 de 3 sigue generándose en el servidor; esperando el resultado…");
});

test("«Empezar de nuevo»: cancela la generación, aparca el borrador con trabajo (no lo borra) y abre uno nuevo sin scriptJob", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  const fn = wiz.slice(wiz.indexOf("function startOver()"), wiz.indexOf("function recoverPrevious()"));
  assert.match(fn, /scriptRun\.current\?\.ctl\.abort\(\); scriptSeq\.current\+\+;/, "cancela y cambia la identidad de la generación");
  assert.match(fn, /if \(parkDraft\(localStorage, localStorage\.getItem\(WIZARD_STORAGE_KEY\)\)\) setRecoverable\(true\);/, "aparca el anterior (lista de #269)");
  assert.match(fn, /setRawState\(defaultDraft\(\)\)/);
  assert.match(wiz, /onClick=\{startOver\} data-testid="empezar-de-nuevo"/);
  assert.equal(WIZARD_RECOVERABLE_KEY, "atomivid.podcast.asistente.v2.recuperable", "la misma clave que la entrada «Personalizado» (#269)");
});

test("borrador retomado: se identifica (título y minutos) y uno vacío no se anuncia ni se aparca", () => {
  const script = Array.from({ length: 40 }, (_, i) => `${i % 2 ? "El Duro Hans" : "Valeria Moncler"}: ${"palabra ".repeat(25)}fin.`).join("\n");
  const r = resumedDraft({ title: "Base Dulce", topic: "x", script });
  assert.equal(r?.label, "Base Dulce"); assert.ok((r?.minutes ?? 0) > 1);
  assert.equal(resumedDraft({ title: "", topic: "", script: "" }), null);
  assert.equal(resumedDraft({ topic: "Volcanes" })?.label, "Volcanes");
  assert.equal(hasRecoverableDraft(JSON.stringify({ topic: "", script: "" })), false);
  assert.equal(hasRecoverableDraft(JSON.stringify({ topic: "Base Dulce" })), true);
  assert.equal(hasRecoverableDraft(JSON.stringify({ topic: "", script: "", scriptJob: { segments: [] } })), true);
  assert.equal(hasRecoverableDraft("{roto"), false);
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /data-testid="borrador-retomado"/); assert.match(wiz, /data-testid="empezar-uno-nuevo"/); assert.match(wiz, /data-testid="recuperar-borrador"/);
});
