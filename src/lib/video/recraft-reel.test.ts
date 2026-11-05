import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRecraftSelection, recraftReelEstimateUsd, recraftScenePrompt, parseStoredRecraftStyle, isValidStyleId, recraftClientBlockMessage, RECRAFT_CLIENT_NEED_PATH, RECRAFT_CLIENT_BAD_STYLE, RECRAFT_CLIENT_TOO_MANY_REFS, RECRAFT_CLIENT_BAD_REFS, RECRAFT_MAX_REFERENCE_BYTES } from "./recraft-reel";
import { ReelImageSourcePicker } from "@/app/dashboard/new/ReelImageSourcePicker";
import { NewVideoForm } from "@/app/dashboard/new/NewVideoForm";
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
  assert.deepEqual(ok, { source: "recraft", styleId: null, match: "precise", styleNote: null, onMissingStyleId: "stop" });
  const cont = parseRecraftSelection({ ...base, source: "recraft", referenceCount: 1, onMissingStyleId: "same_references" }, true);
  assert.equal("onMissingStyleId" in cont && cont.onMissingStyleId, "same_references");
});
const png = (size = 12) => ({ type: "image/png", size });

test("cliente: Recraft sin estilo ni referencias no se puede enviar", () => {
  assert.equal(recraftClientBlockMessage("", []), RECRAFT_CLIENT_NEED_PATH);
  assert.equal(recraftClientBlockMessage("   ", [{ type: "image/png", size: 0 }]), RECRAFT_CLIENT_NEED_PATH);
  assert.doesNotMatch(RECRAFT_CLIENT_NEED_PATH, /style_id|request_id|fal\.ai/i);
});

test("cliente: un estilo válido o 1–10 referencias válidas dejan pasar el formulario", () => {
  const style = "6654d01b-7c9d-4f87-9f99-80e6cb989380";
  assert.equal(recraftClientBlockMessage(style, []), "");
  assert.equal(recraftClientBlockMessage(`  ${style}  `, []), "");
  assert.equal(recraftClientBlockMessage("", [png()]), "");
  assert.equal(recraftClientBlockMessage("", Array.from({ length: 10 }, () => png())), "");
  assert.equal(recraftClientBlockMessage("", [{ type: "image/jpeg", size: 20 }, { type: "image/webp", size: RECRAFT_MAX_REFERENCE_BYTES }]), "");
  assert.equal(recraftClientBlockMessage(style, [png(), { type: "image/gif", size: 20 }]), "", "con estilo válido las referencias de más no se usan");
});

test("cliente: estilo inválido, más de 10 archivos o un archivo no válido bloquean", () => {
  assert.equal(recraftClientBlockMessage("01a15cd6-f79f-77f1-8f4a-06d582611ae4", [png()]), RECRAFT_CLIENT_BAD_STYLE);
  assert.equal(recraftClientBlockMessage("no es", []), RECRAFT_CLIENT_BAD_STYLE);
  assert.doesNotMatch(RECRAFT_CLIENT_BAD_STYLE, /style_id|request_id|fal\.ai/i);
  assert.equal(recraftClientBlockMessage("6654d01b-7c9d-4f87-9f99-80e6cb989380", Array.from({ length: 11 }, () => png())), RECRAFT_CLIENT_TOO_MANY_REFS);
  assert.equal(recraftClientBlockMessage("", Array.from({ length: 11 }, () => png())), RECRAFT_CLIENT_TOO_MANY_REFS);
  assert.equal(recraftClientBlockMessage("", [{ type: "image/gif", size: 20 }]), RECRAFT_CLIENT_BAD_REFS);
  assert.equal(recraftClientBlockMessage("", [{ type: "image/png", size: RECRAFT_MAX_REFERENCE_BYTES + 1 }]), RECRAFT_CLIENT_BAD_REFS);
  assert.equal(recraftClientBlockMessage("", [{ type: "", size: 20 }]), RECRAFT_CLIENT_BAD_REFS);
});

test("el selector de un Reel empieza en Material de archivo", () => {
  const html = renderToStaticMarkup(createElement(ReelImageSourcePicker));
  assert.match(html, /Material de archivo \(como hasta ahora\)/);
  assert.match(html, /name="reel_image_source"/);
  assert.equal(html.includes("Elige una sola vía"), false, "el panel de Recraft no aparece hasta que la persona lo elige");
  assert.equal(html.includes("Style ID de Recraft (opcional)"), false);
  assert.equal(html.includes('value="default"'), true);
  const checked = html.match(/<input[^>]*name="reel_image_source"[^>]*>/g) ?? [];
  assert.equal(checked.length, 2);
  assert.match(checked[0], /value="default"/);
  assert.match(checked[0], /checked/);
  assert.doesNotMatch(checked[1], /checked/);
});

test("con Recraft elegido, la regla visible no trata el estilo como opcional", () => {
  const html = renderToStaticMarkup(createElement(ReelImageSourcePicker, { defaultSource: "recraft" }));
  assert.match(html, /Elige una sola vía: indica un estilo guardado O sube de 1 a 10 imágenes de referencia\./);
  assert.match(html, /Identificador de estilo guardado/);
  assert.match(html, /Un identificador de solicitud del proveedor no es un estilo guardado\./);
  assert.equal(html.includes("opcional"), true, "la nota de estilo sigue siendo opcional");
  const visible = html.replace(/<[^>]+>/g, " ");
  assert.equal(/\bstyle_id\b|\brequest_id\b|fal\.ai|Style ID/.test(visible), false);
  const checked = html.match(/<input[^>]*name="reel_image_source"[^>]*>/g) ?? [];
  assert.match(checked[1], /value="recraft"/);
  assert.match(checked[1], /checked/);
});

test("el formulario de Reel no preselecciona Recraft cuando la función está activa", () => {
  const html = renderToStaticMarkup(createElement(NewVideoForm, { action: () => {}, avatarModeEnabled: false, existingAvatars: [], recraftReelEnabled: true }));
  assert.match(html, /Material de archivo \(como hasta ahora\)/);
  assert.equal(html.includes("Elige una sola vía"), false);
  const checked = html.match(/<input[^>]*name="reel_image_source"[^>]*>/g) ?? [];
  assert.match(checked[0], /value="default"/);
  assert.match(checked[0], /checked/);
});

test("Long Form conserva la elección inicial anterior si no se pasa defaultSource", () => {
  const html = renderToStaticMarkup(createElement(ReelImageSourcePicker, { format: "long_form" }));
  const checked = html.match(/<input[^>]*name="image_source"[^>]*>/g) ?? [];
  assert.match(checked[1], /value="recraft"/);
  assert.match(checked[1], /checked/);
  assert.match(html, /Elige una sola vía: indica un estilo guardado O sube de 1 a 10 imágenes de referencia\./);
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
  assert.equal(recraftReelEstimateUsd(6, false, "same_references"), 0.24, "each image may create the style again");
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
    { styleId: null, referencePaths: ["r/recraft-style/ref-0.png"], match: "flexible", styleNote: null, onMissingStyleId: "stop" });
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
