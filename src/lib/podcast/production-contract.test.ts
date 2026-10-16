import { test } from "node:test";
import assert from "node:assert/strict";
import { clearAllDrafts, draftKey, INVALID_BODY, isJsonObject, LEGACY_DRAFT_KEYS, parseDraft, productionSummary, purgeForeignDrafts, unsupportedOption, type ReviewableEpisode } from "./production-contract";
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

test("cuerpo: solo un objeto JSON; null, arrays y primitivos se rechazan sin lanzar (antes `key in 1` daba TypeError)", () => {
  for (const v of [null, undefined, 1, 0, true, false, "texto", "", [], [{ narrationMode: "dos_narradores" }]]) {
    assert.equal(isJsonObject(v), false, JSON.stringify(v));
    assert.equal(unsupportedOption(v), INVALID_BODY, JSON.stringify(v));
  }
  assert.equal(unsupportedOption(Object.create({ montageEngine: "director" })), null, "solo cuentan las propiedades propias");
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

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), keys: () => [...m.keys()].sort() };
}

test("borrador: ligado al dueño; otro dueño, sin dueño o forma inválida → no se restaura", () => {
  const ok = { v: 2, owner: "user-a", mode: "tts", title: "T", script: "s".repeat(50), language: "en", voiceId: "v1" };
  assert.deepEqual(parseDraft(JSON.stringify(ok), 10, "user-a"), { ...ok, script: "s".repeat(10) });
  assert.equal(parseDraft(JSON.stringify(ok), 100, "user-b"), null, "el borrador de A no se restaura para B");
  assert.equal(parseDraft(JSON.stringify(ok), 100, ""), null, "sin identidad no hay restauración");
  for (const bad of [null, "", "{", "[]", "1", JSON.stringify({ ...ok, v: 1 }), JSON.stringify({ ...ok, owner: undefined }), JSON.stringify({ ...ok, mode: "dos" }), JSON.stringify({ ...ok, title: 3 }), JSON.stringify({ ...ok, language: "fr" })]) {
    assert.equal(parseDraft(bad, 100, "user-a"), null, String(bad));
  }
});

test("borrador: al montar se descartan los de otras cuentas y el formato antiguo sin dueño; al salir se borran todos", () => {
  const st = memoryStorage({ [draftKey("user-a")]: "a", [draftKey("user-b")]: "b", [LEGACY_DRAFT_KEYS[0]]: "sin-dueno", "otra:clave": "x" });
  purgeForeignDrafts(st, "user-b");
  assert.deepEqual(st.keys(), [draftKey("user-b"), "otra:clave"].sort());
  clearAllDrafts(st);
  assert.deepEqual(st.keys(), ["otra:clave"], "cerrar sesión no deja borradores de podcast; no toca otras claves");
});
