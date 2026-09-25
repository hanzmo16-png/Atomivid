import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRenderStale, evaluateRenderStart } from "../render-guard";
import { LONG_FORM_HEARTBEAT_STALE_MS, RENDER_TIMEOUT_MS } from "../limits";
import { deriveVisualsFromNarration, normalizeDeclaredVisuals, textCardForShot, visualsForBeat, documentaryImagePrompt } from "./visual-intents";
import { githubActionsWorker } from "@/lib/worker/github-actions";

const ROOT = path.join(__dirname, "..", "..", "..", "..");

// --- Heartbeat: una producción larga que sigue latiendo nunca es "colgada" ---

test("Long Form que sigue latiendo NO se considera colgado aunque pasen más de 15 min (evita un 2º intento pagado en paralelo)", () => {
  const started = Date.parse("2026-09-25T10:00:00Z");
  const now = started + 40 * 60 * 1000;
  const row = {
    status: "processing",
    render_attempts: 1,
    render_started_at: new Date(started).toISOString(),
    mode: "long_form",
    long_form_progress: { stage: "rendering", unitsCompleted: 100, unitsTotal: 5400, unitLabel: "fotogramas", updatedAt: new Date(now - 60_000).toISOString() },
  };
  assert.ok(now - started > RENDER_TIMEOUT_MS);
  assert.equal(isRenderStale(row, now), false);
  const decision = evaluateRenderStart(row, now);
  assert.equal(decision.allowed, false, "sin reintento mientras el worker late");
});

test("Long Form sin latidos por más de LONG_FORM_HEARTBEAT_STALE_MS sí es recuperable", () => {
  const started = Date.parse("2026-09-25T10:00:00Z");
  const lastBeat = started + 5 * 60 * 1000;
  const row = {
    status: "processing",
    render_attempts: 1,
    render_started_at: new Date(started).toISOString(),
    mode: "long_form",
    long_form_progress: { stage: "assets", unitsCompleted: 3, unitsTotal: 45, unitLabel: "escenas", updatedAt: new Date(lastBeat).toISOString() },
  };
  assert.equal(isRenderStale(row, lastBeat + LONG_FORM_HEARTBEAT_STALE_MS - 1000), false);
  assert.equal(isRenderStale(row, lastBeat + LONG_FORM_HEARTBEAT_STALE_MS + 1000), true);
});

test("Reel/Avatar conservan exactamente el umbral histórico de 15 min", () => {
  const started = Date.parse("2026-09-25T10:00:00Z");
  const row = { status: "processing", render_attempts: 1, render_started_at: new Date(started).toISOString(), mode: "visual" };
  assert.equal(isRenderStale(row, started + RENDER_TIMEOUT_MS - 1), false);
  assert.equal(isRenderStale(row, started + RENDER_TIMEOUT_MS + 1), true);
});

// --- Intenciones visuales reales ---

test("visuales declarados (inglés) se validan y se usan tal cual; basura se descarta", () => {
  const visuals = normalizeDeclaredVisuals([
    { description: " ships moving through locks ", motion: true },
    { description: "" },
    "no-object",
    { description: "old map of the isthmus" },
  ]);
  assert.deepEqual(visuals, [
    { description: "ships moving through locks", motion: true },
    { description: "old map of the isthmus", motion: false },
  ]);
});

test("guion sin visuales: descripciones derivadas del tema + palabras de la narración (nunca un placeholder)", () => {
  const derived = deriveVisualsFromNarration("El Canal de Panamá", "Las esclusas elevaron barcos gigantes. Miles de trabajadores murieron.");
  assert.equal(derived.length, 2);
  assert.ok(derived.every((v) => v.description.startsWith("El Canal de Panamá") && !v.motion));
  assert.match(derived[0].description, /esclusas/);
  assert.deepEqual(visualsForBeat({ narration: "..." }, "Tema"), [{ description: "Tema", motion: false }]);
});

test("prompt de imagen documental: incluye la intención real y prohíbe texto/logos", () => {
  const prompt = documentaryImagePrompt("steam shovels digging a canal");
  assert.match(prompt, /steam shovels digging a canal/);
  assert.match(prompt, /No text/);
});

test("tarjeta de texto real: oración de la narración según el índice del shot, nunca fixture", () => {
  const card = textCardForShot({ id: "beat-2-shot-2", captionText: "Primera oración. Segunda oración." }, "Tema");
  assert.deepEqual(card, { kind: "text", title: "Tema", body: "Segunda oración.", isFixture: false });
});

// --- Worker: mode en el dispatch y credenciales solo para Long Form ---

test("dispatch a GitHub incluye mode solo cuando se pasa (Reel/Avatar: payload idéntico al histórico)", async () => {
  const originalFetch = global.fetch;
  const bodies: unknown[] = [];
  global.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const prev = { t: process.env.GH_WORKER_TOKEN, r: process.env.GH_WORKER_REPO };
  process.env.GH_WORKER_TOKEN = "t";
  process.env.GH_WORKER_REPO = "o/r";
  try {
    await githubActionsWorker.trigger({ requestId: "a", renderAttempt: 1, mode: "long_form" });
    await githubActionsWorker.trigger({ requestId: "b", renderAttempt: 1 });
  } finally {
    global.fetch = originalFetch;
    process.env.GH_WORKER_TOKEN = prev.t;
    process.env.GH_WORKER_REPO = prev.r;
  }
  assert.deepEqual((bodies[0] as { client_payload: unknown }).client_payload, { requestId: "a", renderAttempt: 1, mode: "long_form" });
  assert.deepEqual((bodies[1] as { client_payload: unknown }).client_payload, { requestId: "b", renderAttempt: 1 });
});

test("render.yml: LONG_FORM_REAL_RUN_CONFIRM / OPENAI / VEO solo llegan al worker con mode=long_form, y el confirm viene de un secret (nunca en claro)", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "render.yml"), "utf-8");
  for (const name of ["LONG_FORM_REAL_RUN_CONFIRM", "OPENAI_API_KEY", "VEO_API_KEY", "IMAGE_PROVIDER", "VIDEO_PROVIDER", "LONG_FORM_AI_VIDEO_ENABLED", "PREMIUM_CLIPS_ENABLED"]) {
    const line = yml.split("\n").find((l) => l.trim().startsWith(`${name}:`));
    assert.ok(line, `${name} presente`);
    assert.match(line!, /mode == 'long_form'/, `${name} condicionado a Long Form`);
  }
  assert.match(yml, /LONG_FORM_REAL_RUN_CONFIRM: \$\{\{[^}]*secrets\.LONG_FORM_REAL_RUN_CONFIRM/);
  assert.doesNotMatch(yml, /YES_SPEND_REAL_MONEY'/, "el valor de confirmación nunca se escribe en el workflow");
  assert.match(yml, /timeout-minutes: \$\{\{ \(github\.event\.client_payload\.mode == 'long_form'/);
});

test("run-job.ts valida el snapshot confirmado (resolveExecutablePlan) ANTES de ejecutar el pipeline de Long Form", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "lib", "video", "run-job.ts"), "utf-8");
  const validate = src.indexOf("resolveExecutablePlan({");
  const execute = src.indexOf("await generateLongFormVideoFromScript({");
  assert.ok(validate > 0 && execute > validate);
  assert.doesNotMatch(src, /\?\? "balanced"/, "nunca cae a una estrategia por defecto");
});
