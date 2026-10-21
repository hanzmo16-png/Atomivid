import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecraftSelection, recraftReelEstimateUsd, recraftScenePrompt, parseStoredRecraftStyle, isValidStyleId } from "./recraft-reel";
import { jobSupplyDemands } from "@/lib/supply/job";
import { getFeatureFlags } from "./feature-flags";
import { intentFingerprint } from "./submission-key";

const base = { styleId: "", match: "", styleNote: "", referenceCount: 0 };

test("por defecto (sin elegir) nada cambia: fuente default", () => {
  assert.deepEqual(parseRecraftSelection({ ...base, source: null }, false), { source: "default" });
  assert.deepEqual(parseRecraftSelection({ ...base, source: "default" }, true), { source: "default" });
});
test("Recraft apagado por flag: rechazo claro", () => {
  assert.ok("error" in parseRecraftSelection({ ...base, source: "recraft", referenceCount: 1 }, false));
});
test("Recraft exige style_id o 1-10 referencias", () => {
  assert.ok("error" in parseRecraftSelection({ ...base, source: "recraft" }, true));
  assert.ok("error" in parseRecraftSelection({ ...base, source: "recraft", referenceCount: 11 }, true));
  const ok = parseRecraftSelection({ ...base, source: "recraft", referenceCount: 2, match: "precise" }, true);
  assert.deepEqual(ok, { source: "recraft", styleId: null, match: "precise", styleNote: null });
});
test("el request_id de la prueba manual NO es un style_id", () => {
  assert.equal(isValidStyleId("01a15cd6-f79f-77f1-8f4a-06d582611ae4"), false);
  assert.ok("error" in parseRecraftSelection({ ...base, source: "recraft", styleId: "01a15cd6-f79f-77f1-8f4a-06d582611ae4" }, true));
  assert.equal(isValidStyleId("6654d01b-7c9d-4f87-9f99-80e6cb989380"), true);
});
test("estimado de un Reel de 30 s (6 escenas): 0.215 creando estilo, 0.21 con style_id; techo 10 escenas 0.355", () => {
  assert.equal(recraftReelEstimateUsd(6, false), 0.215);
  assert.equal(recraftReelEstimateUsd(6, true), 0.21);
  assert.equal(recraftReelEstimateUsd(10, false), 0.355);
  assert.equal(recraftReelEstimateUsd(0, false), 0);
});
test("el prompt no impone estética (nada romano/antiguo); solo la nota del usuario", () => {
  const p = recraftScenePrompt({ text: "Ahorra cada mes", visualQuery: "piggy bank coins", visualConcepts: ["saving money jar"] }, undefined, null);
  assert.match(p, /piggy bank coins/);
  assert.doesNotMatch(p.toLowerCase(), /roman|ancient|romano|antigu/);
  assert.match(recraftScenePrompt({ text: "x", visualQuery: "q" }, "storyboard prompt", "acuarela suave"), /^storyboard prompt.*acuarela suave$/);
});
test("configuración guardada inválida → null (el worker falla claro)", () => {
  assert.equal(parseStoredRecraftStyle({ styleId: null, referencePaths: [] }), null);
  assert.deepEqual(parseStoredRecraftStyle({ styleId: null, referencePaths: ["r/recraft-style/ref-0.png"], match: "flexible" }),
    { styleId: null, referencePaths: ["r/recraft-style/ref-0.png"], match: "flexible", styleNote: null });
});
test("sobre de suministro: proveedor 'recraft' solo cuando el Reel lo eligió", () => {
  const row = { mode: "visual", script_json: { title: "t", segments: [{ text: "hola", visualQuery: "q" }] }, recorded_audio_path: null, long_form_production_plan: null };
  const flags = getFeatureFlags();
  assert.equal(jobSupplyDemands(row, "fixture", flags).some((d) => d.provider === "recraft"), false);
  const d = jobSupplyDemands(row, "fixture", flags, { recraftUsd: 0.215 }).find((x) => x.provider === "recraft");
  assert.equal(d?.usd, 0.215);
});
test("huella de intención: sin Recraft idéntica a la anterior; con Recraft distinta", async () => {
  const f = new FormData(); f.set("mode", "visual"); f.set("topic", "t");
  const a = await intentFingerprint(f);
  f.set("reel_image_source", "default");
  assert.deepEqual(await intentFingerprint(f), a);
  f.set("reel_image_source", "recraft"); f.set("recraft_style_id", "6654d01b-7c9d-4f87-9f99-80e6cb989380");
  const b = await intentFingerprint(f);
  assert.equal(b.reel_image_source, "recraft");
  assert.notDeepEqual(b, a);
});
