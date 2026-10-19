import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRenderEngineFailure, RENDER_ENGINE_CUSTOMER_MESSAGE } from "./render-engine-error";

test("RED→GREEN: el error crudo de Remotion se reconoce y el mensaje humano no filtra rutas ni opciones", () => {
  const raw = `"browserExecutable" was specified as '/nonexistent/chrome-roto-a-proposito' but the path doesn't exist. Pass "null" for "browserExecutable" to download a browser automatically.`;
  assert.equal(isRenderEngineFailure(raw), true);
  for (const r of ["ffmpeg exited with code 1", "Error: Could not find composition with ID VerticalReel (selectComposition)", "Chromium crashed (SIGKILL)"]) assert.equal(isRenderEngineFailure(r), true, r);
  assert.doesNotMatch(RENDER_ENGINE_CUSTOMER_MESSAGE, /browserExecutable|\/|remotion|chrom/i);
  assert.match(RENDER_ENGINE_CUSTOMER_MESSAGE, /Se conservan/); assert.match(RENDER_ENGINE_CUSTOMER_MESSAGE, /reintent/i);
});

test("no captura errores de proveedor ya compuestos (voz, footage, Director)", () => {
  for (const r of ["ElevenLabs respondió 401", "El Director necesita material nuevo por hasta USD 0.14", "Pexels sin resultados para la escena 2"]) assert.equal(isRenderEngineFailure(r), false, r);
});

test("run-job usa la clasificación antes de guardar error_message", () => {
  const src = fs.readFileSync(path.join(__dirname, "run-job.ts"), "utf8");
  assert.match(src, /engineFailure \? RENDER_ENGINE_CUSTOMER_MESSAGE/);
});

test("F40 caos: fallos de pago inciertos/en curso ⇒ mensaje humano (qué pasó, qué se conserva, gasto incierto, siguiente paso), nunca crudo", async () => {
  const { classifyPaidFailure, PAYMENT_UNCERTAIN_MARK } = await import("./render-engine-error");
  const { ReconciliationRequiredError, SubmissionInFlightError } = await import("@/lib/production-intelligence/ledger");
  for (const raw of ["OpenAI Images respondió HTTP 500", "OpenAI Images respondió HTTP 429", "Error de red llamando a OpenAI Images",
    "No se pudo subir la imagen generada (u/x/director-fill-a.png): mock storage fault"]) {
    const m = classifyPaidFailure(new Error(raw)); assert.ok(m && m.includes(PAYMENT_UNCERTAIN_MARK) && /imágenes/.test(m) && !/HTTP|storage|director-fill|\//.test(m), raw);
  }
  const rr = classifyPaidFailure(new ReconciliationRequiredError("op_1: reconcile with the provider before any new submission"));
  assert.ok(rr && !/op_1|reconcile/.test(rr) && /No reintentes todavía/.test(rr));
  assert.match(classifyPaidFailure(new SubmissionInFlightError("op_1: submission already in flight")) ?? "", /en curso/);
  assert.equal(classifyPaidFailure(new Error("Guion inválido")), null);
  const { canReviewReelRetry } = await import("./reel-retry");
  const src = (await import("node:fs")).readFileSync("src/lib/video/reel-retry.ts", "utf8");
  assert.match(src, /verificación de cobro pendiente\|llamada de pago en curso/); void canReviewReelRetry;
  const rj = (await import("node:fs")).readFileSync("src/lib/video/run-job.ts", "utf8");
  assert.match(rj, /engineFailure \? RENDER_ENGINE_CUSTOMER_MESSAGE : paidFailure \? paidFailure/);
});
