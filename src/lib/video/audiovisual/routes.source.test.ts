import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidateDirection, isMissingColumnError, loadAudiovisualState } from "./persistence";

/**
 * Las rutas viven bajo carpetas con corchetes ([id]); `node --test` no puede
 * ejecutar tests dentro de ellas (ver render-route-cas.test.ts), así que
 * estas pruebas leen el código fuente y verifican el contrato de
 * persistencia/validación de la dirección audiovisual.
 */
const APP = path.join(__dirname, "..", "..", "..", "app");
const read = (...p: string[]) => readFileSync(path.join(APP, ...p), "utf8");

test("render: resuelve/reutiliza la dirección y comprueba disponibilidad ANTES de marcar processing, y la guarda en el mismo UPDATE atómico", () => {
  const src = read("api", "generate", "[id]", "render", "route.ts");
  const resolve = src.indexOf("directionForApprovedScript(");
  const readiness = src.indexOf("evaluateDirectionReadiness(");
  const cas = src.indexOf('status: "processing"');
  assert.ok(resolve > 0 && readiness > resolve && cas > readiness);
  assert.match(src, /status: 409/);
  const update = src.slice(cas, src.indexOf(".select(\"id\")", cas));
  assert.ok(update.includes("...directionUpdate"), "la dirección se escribe junto a la transición a processing");
  assert.ok(src.indexOf('if (videoRequest.mode === "visual")') < resolve, "solo Reels");
});

test("guion: generar, editar o regenerar una escena invalida la dirección resuelta; la guía solo aplica con selección", () => {
  const script = read("api", "generate", "[id]", "script", "route.ts");
  assert.match(script, /audiovisual_direction: null/);
  assert.match(script, /\.\.\.invalidateDirection \}\)/);
  assert.match(script, /script_json: body, \.\.\.\(av\?\.selection \? \{ audiovisual_direction: null \} : \{\}\)/);
  assert.match(script, /av\?\.selection \? scriptGuidanceFor\(/);
  const regen = read("api", "generate", "[id]", "script", "regenerate-scene", "route.ts");
  assert.match(regen, /script_json: script, \.\.\.\(av\?\.selection \? \{ audiovisual_direction: null \} : \{\}\)/);
});

test("worker: verifica que la dirección guardada corresponde al guion antes de producir (defensa en profundidad)", () => {
  const src = readFileSync(path.join(__dirname, "..", "run-job.ts"), "utf8");
  const check = src.indexOf("assertDirectionMatches(");
  assert.ok(check > 0 && check < src.indexOf("await generateVideoFromScript("));
  assert.match(src, /\.\.\.\(direction \? \{ direction \} : \{\}\)/);
});

test("creación: la selección se valida en servidor y solo con el flag; nunca se crea sin la dirección elegida", () => {
  const src = read("dashboard", "new", "actions.ts");
  assert.match(src, /if \(flags\.audiovisualProfilesEnabled\) \{/);
  assert.match(src, /parseSelection\(\{/);
  assert.match(src, /isMissingColumnError\(error\)/);
  // Avatar no recibe selección: el bloque vive dentro de mode === "visual".
  const visual = src.indexOf('if (mode === "visual") {');
  assert.ok(src.indexOf("parseSelection({") > visual && src.indexOf("parseSelection({") < src.indexOf("// --- Modo avatar"));
});

function fakeService(result: { data?: unknown; error?: { code?: string; message?: string } | null }, updates: unknown[] = []) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }) }) }),
      update: (v: unknown) => ({ eq: async () => { updates.push(v); return { error: null }; } }),
    }),
  } as unknown as SupabaseClient;
}

test("persistencia: sin la migración 0020 se comporta como antes (sin selección), nunca rompe las rutas", async () => {
  assert.equal(isMissingColumnError({ code: "42703", message: "column video_requests.audiovisual_selection does not exist" }), true);
  assert.equal(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'audiovisual_selection' column" }), true);
  assert.equal(isMissingColumnError({ code: "42501", message: "permission denied" }), false);
  const missing = await loadAudiovisualState(fakeService({ error: { code: "42703", message: "column does not exist" } }), "r");
  assert.deepEqual(missing, { available: false, selection: null, direction: null });
  await assert.rejects(loadAudiovisualState(fakeService({ error: { code: "08006", message: "connection lost" } }), "r"));
});

test("persistencia: solicitudes antiguas (NULL) siguen sin dirección; una selección corrupta nunca se interpreta a medias", async () => {
  const legacy = await loadAudiovisualState(fakeService({ data: { audiovisual_selection: null, audiovisual_direction: null } }), "r");
  assert.deepEqual(legacy, { available: true, selection: null, direction: null });
  await assert.rejects(loadAudiovisualState(fakeService({ data: { audiovisual_selection: { version: 1, profile: "vaporwave" } } }), "r"), /no es válida/);
  const updates: unknown[] = [];
  await invalidateDirection(fakeService({}, updates), "r", legacy);
  assert.deepEqual(updates, [], "nunca escribe en filas sin selección");
  await invalidateDirection(fakeService({}, updates), "r", { available: true, selection: { version: 1, profile: "anime" }, direction: { x: 1 } });
  assert.deepEqual(updates, [{ audiovisual_direction: null }]);
});
