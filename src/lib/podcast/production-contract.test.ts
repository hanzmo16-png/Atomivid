import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DRAFT_KEY, parseDraft, productionSummary, unsupportedOption, type ReviewableEpisode } from "./production-contract";
import { checkConfirmation, productionFingerprint } from "./production-confirm";

const EP: ReviewableEpisode = { id: "e1", title: "Caso Roswell", language: "es", source: "tts", script: "Guion de prueba con más de veinte caracteres.", voice_id: "v1", voice_name: "Lucía", status: "draft", audio_sha256: null };

test("capacidades: modos y opciones que el servidor no ejecuta se rechazan antes de crear o producir", () => {
  assert.equal(unsupportedOption({ title: "x" }), null);
  assert.equal(unsupportedOption({ narrationMode: "un_narrador" }), null, "el único modo real se acepta explícitamente");
  for (const body of [{ narrationMode: "dos_narradores" }, { narrationMode: "mixto" }, { guestVoiceId: "v2" }, { voices: ["v1", "v2"] }, { montageEngine: "director" }, { avatar: { id: "a" } }]) {
    assert.ok(unsupportedOption(body), JSON.stringify(body));
  }
  assert.match(unsupportedOption({ narrationMode: "dos_narradores" })!, /un narrador/);
});

test("confirmación: ligada a lo que se revisó; si cambia guion, voz, título, idioma o grabación → 409", () => {
  const fp = productionFingerprint(EP);
  assert.equal(productionFingerprint({ ...EP, status: "ready" }), fp, "narrar no cambia lo revisado");
  for (const changed of [{ script: EP.script + "!" }, { voice_id: "v2" }, { title: "Otro" }, { language: "en" as const }]) assert.notEqual(productionFingerprint({ ...EP, ...changed }), fp);
  const up: ReviewableEpisode = { ...EP, source: "upload", script: null, voice_id: null, audio_sha256: "a".repeat(64) };
  assert.notEqual(productionFingerprint({ ...up, audio_sha256: "b".repeat(64) }), productionFingerprint(up), "otra grabación exige revisar de nuevo");
  assert.deepEqual(checkConfirmation(EP, fp), { ok: true });
  assert.equal((checkConfirmation(EP, undefined) as { status: number }).status, 400);
  assert.equal((checkConfirmation(EP, "") as { status: number }).status, 400);
  assert.equal((checkConfirmation({ ...EP, script: "cambiado después de revisar el guion" }, fp) as { status: number }).status, 409);
});

test("resumen de revisión: cada línea es una configuración real; nunca promete dos narradores", () => {
  const rows = productionSummary(EP, { budgetUsd: 3, runBudgetUsd: 1.5, scheduleAt: null, pendingUsd: 1.2 });
  const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.match(map["Narración"], /Un narrador · voz guardada «Lucía»/);
  assert.equal(map["Presupuesto total"], "USD 3.00"); assert.equal(map["Máximo nuevo de esta ejecución"], "USD 1.50"); assert.equal(map["Inicio"], "ahora");
  assert.match(map["Coste pendiente"], /hasta USD 1.20/);
  assert.doesNotMatch(JSON.stringify(rows), /dos narradores|avatar|Director/i);
  const ready = Object.fromEntries(productionSummary({ ...EP, status: "ready" }, { budgetUsd: null, runBudgetUsd: null, scheduleAt: "2026-10-20T10:00:00.000Z", pendingUsd: 0 }).map((r) => [r.label, r.value]));
  assert.match(ready["Coste pendiente"], /USD 0/); assert.equal(ready["Máximo nuevo de esta ejecución"], undefined); assert.match(ready["Inicio"], /programado/);
});

test("borrador: solo se restaura con forma válida y dentro de los límites", () => {
  const ok = { v: 1, mode: "tts", title: "T", script: "s".repeat(50), language: "en", voiceId: "v1" };
  assert.deepEqual(parseDraft(JSON.stringify(ok), 10), { ...ok, script: "s".repeat(10) });
  for (const bad of [null, "", "{", JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, mode: "dos" }), JSON.stringify({ ...ok, title: 3 }), JSON.stringify({ ...ok, language: "fr" })]) assert.equal(parseDraft(bad, 100), null);
  assert.match(DRAFT_KEY, /podcast/);
});

// Orden en las rutas (inspección de la fuente: no es un recorrido HTTP/DB real).
test("rutas: el rechazo temprano y la confirmación ocurren antes de crear o encolar", () => {
  const create = readFileSync("src/app/api/podcast/route.ts", "utf8");
  assert.ok(create.indexOf("unsupportedOption(body)") > 0 && create.indexOf("unsupportedOption(body)") < create.indexOf("createEpisode("));
  const video = readFileSync("src/app/api/podcast/[id]/video/route.ts", "utf8");
  const cancel = video.indexOf("body.cancel === true"), confirm = video.indexOf("checkConfirmation(episode, body.confirm)"), enqueue = video.indexOf("requestPodcastVideo(");
  assert.ok(cancel > 0 && confirm > cancel && enqueue > confirm, "cancelar no exige confirmación; producir sí, antes de encolar");
  assert.ok(video.indexOf("unsupportedOption(body)") < enqueue);
});
