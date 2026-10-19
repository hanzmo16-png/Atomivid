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
