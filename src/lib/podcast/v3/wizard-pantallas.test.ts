/**
 * Podcast — asistente Premium 4.0 en 4 pantallas (Participantes · Contenido · Estilo · Producir), formato de 1 o 2
 * personas y borradores del asistente anterior (10 pasos). Sin red.
 * La entrada Personalizado de la portada se simula aquí (las dos rutas: nueva y directa) sin navegador.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCREENS, SCREEN_SECTIONS, STEP, STEPS, WIZARD_ENTRY_TOKENS_KEY, WIZARD_RECOVERY_KEY, WIZARD_STORAGE_KEY, applyFreshHomeEntry, defaultDraft, entryScreenLabel, isFreshHomeEntry, loadDraft, recoveryList, restorePreviousDraft, screenErrors, screenOf, screenStart, withFormat, type DraftStore } from "./wizard";

const ctx = { unavailableVoices: [] as string[] };

test("cuatro pantallas cubren los diez pasos una sola vez; quién habla va ANTES del guion", () => {
  assert.deepEqual([...SCREENS], ["Participantes", "Contenido", "Estilo", "Producir"]);
  const all = SCREEN_SECTIONS.flat();
  assert.equal(all.length, STEPS.length); assert.equal(new Set(all).size, STEPS.length);
  assert.ok(screenOf(STEP.participantes) < screenOf(STEP.tema), "los nombres existen cuando se escribe el guion (episodio 51883d1c)");
  assert.equal(screenOf(STEP.generacion), SCREENS.length - 1);
  for (let i = 0; i < SCREENS.length; i++) assert.equal(screenOf(screenStart(i)), i);
});

test("borradores del asistente de 10 pasos abren al inicio de su pantalla; «generación» se conserva", () => {
  const at = (step: number) => loadDraft(JSON.stringify({ ...defaultDraft(), step })).step;
  assert.equal(at(STEP.voces), screenStart(0)); assert.equal(at(STEP.avatares), screenStart(0));
  assert.equal(at(STEP.tema), screenStart(1)); assert.equal(at(STEP.musica), screenStart(2));
  assert.equal(at(STEP.vista), screenStart(3)); assert.equal(at(STEP.generacion), STEP.generacion);
  assert.equal(loadDraft(JSON.stringify({ step: 99 })).step, screenStart(0), "un paso desconocido no rompe el asistente");
});

test("la pantalla reúne los errores de sus secciones; la autorización del cargo no bloquea «Siguiente»", () => {
  const d = { ...defaultDraft(), modality: "dialogo" as const, mode: "dialogo" as const, count: 2 as const };
  const e = screenErrors(d, 0, ctx);
  assert.ok(e.some((x) => /voz/.test(x)) && e.some((x) => /avatar/.test(x)), e.join(" | "));
  assert.ok(screenErrors({ ...defaultDraft(), modality: null }, 0, ctx).some((x) => /Elige cómo/.test(x)));
  assert.ok(!screenErrors({ ...d, authorized: false, budgetUsd: 5 }, 3, ctx).some((x) => /autorizar/.test(x)));
});

function memoryStore(init: Record<string, string> = {}): DraftStore & { raw: Map<string, string>; removed: string[] } {
  const raw = new Map(Object.entries(init));
  const removed: string[] = [];
  return {
    raw, removed,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => { raw.set(k, v); },
    removeItem: (k) => { removed.push(k); raw.delete(k); },
  };
}

test("entrada directa reanuda el paso 9; Personalizado abre la pantalla 1 y el anterior sigue recuperable", () => {
  const prior = JSON.stringify({ ...defaultDraft(), step: STEP.generacion, title: "Episodio guardado", topic: "tema viejo", episodeId: "ep-9", extra: "no-borrar" });
  const other = "no-tocar";
  const store = memoryStore({ [WIZARD_STORAGE_KEY]: prior, "atomivid.otro": other, [WIZARD_RECOVERY_KEY]: "not-json{" });
  const direct = applyFreshHomeEntry(store, {});
  assert.equal(direct.started, false);
  assert.equal(direct.screen, screenOf(STEP.generacion));
  assert.equal(store.getItem(WIZARD_STORAGE_KEY), prior, "sin señal no se reescribe el borrador");
  assert.equal(store.getItem(WIZARD_RECOVERY_KEY), "not-json{");
  assert.equal(applyFreshHomeEntry(store, { modo: "personalizado" }).started, false);
  assert.equal(applyFreshHomeEntry(store, { entrada: "nueva-1" }).started, false);
  assert.equal(isFreshHomeEntry({ modo: "auto", entrada: "nueva-1" }), false);

  const idea = "  La leyenda   del metro ";
  const first = applyFreshHomeEntry(store, { modo: "personalizado", entrada: "nueva-uno", idea }, { now: "2026-11-01T00:00:00.000Z" });
  assert.equal(first.started, true);
  assert.equal(first.parked, true);
  assert.equal(first.topic, "La leyenda del metro");
  assert.equal(first.screen, 0);
  assert.equal(entryScreenLabel(0).name, "Participantes");
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).step, screenStart(0));
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).topic, "La leyenda del metro");
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).episodeId, null, "la configuración nueva no hereda el episodio anterior");
  const parked = recoveryList(store.getItem(WIZARD_RECOVERY_KEY));
  assert.equal(parked[0]?.raw, prior, "el borrador del paso 9 se guarda byte a byte");
  assert.equal(JSON.parse(parked[0]!.raw).extra, "no-borrar");
  assert.equal(parked[0]?.step, STEP.generacion);
  assert.equal(entryScreenLabel(parked[0]!.step).name, "Producir");
  assert.match(store.getItem(WIZARD_RECOVERY_KEY)!, /not-json\{/, "un valor raro en la copia no se tira");
  assert.equal(store.getItem("atomivid.otro"), other);
  assert.equal(store.removed.includes(WIZARD_STORAGE_KEY), false, "no se borra la clave del asistente");

  const replay = applyFreshHomeEntry(store, { modo: "personalizado", entrada: "nueva-uno", idea: "otra" });
  assert.equal(replay.started, false, "el mismo enlace no vuelve a empezar");
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).topic, "La leyenda del metro");
  assert.equal(recoveryList(store.getItem(WIZARD_RECOVERY_KEY)).length, 1);

  const second = applyFreshHomeEntry(store, { modo: "personalizado", entrada: "nueva-dos", idea: "Segundo tema" }, { now: "2026-11-01T00:01:00.000Z" });
  assert.equal(second.started, true);
  assert.equal(second.topic, "Segundo tema");
  const both = recoveryList(store.getItem(WIZARD_RECOVERY_KEY));
  assert.equal(JSON.parse(both[0]!.raw).topic, "La leyenda del metro");
  assert.equal(both[1]?.raw, prior, "el paso 9 sigue en la copia tras una segunda entrada");

  const back = restorePreviousDraft(store, { now: "2026-11-01T00:02:00.000Z" });
  assert.equal(back.restored, true);
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).topic, "La leyenda del metro");
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).step, screenStart(0));
  const after = recoveryList(store.getItem(WIZARD_RECOVERY_KEY));
  assert.equal(JSON.parse(after[0]!.raw).topic, "Segundo tema", "la configuración de ahora queda aparcada, no se borra");
  assert.ok(after.some((x) => x.raw === prior), "el paso 9 sigue recuperable");
  assert.match(store.getItem(WIZARD_RECOVERY_KEY)!, /not-json\{/);

  const priorIndex = recoveryList(store.getItem(WIZARD_RECOVERY_KEY)).findIndex((x) => x.raw === prior);
  assert.ok(priorIndex > 0, "el paso 9 no queda tapado: se recupera por su sitio, no solo el último");
  const original = restorePreviousDraft(store, { index: priorIndex });
  assert.equal(original.restored, true);
  assert.equal(original.step, STEP.generacion);
  assert.equal(store.getItem(WIZARD_STORAGE_KEY), prior);
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).step, STEP.generacion);
  assert.equal(JSON.parse(store.getItem(WIZARD_STORAGE_KEY)!).episodeId, "ep-9");
  const kept = recoveryList(store.getItem(WIZARD_RECOVERY_KEY));
  assert.ok(kept.every((x) => x.raw !== prior));
  assert.equal(kept.length, 2, "las dos configuraciones nuevas siguen guardadas");
  assert.equal(store.removed.includes(WIZARD_STORAGE_KEY), false);
  const directAgain = applyFreshHomeEntry(store, {});
  assert.equal(directAgain.started, false);
  assert.equal(directAgain.screen, screenOf(STEP.generacion));
  assert.equal(store.getItem(WIZARD_STORAGE_KEY), prior, "volver a abrir /dashboard/podcast reanuda el paso 9");
  assert.ok(readTokens(store).includes("nueva-uno") && readTokens(store).includes("nueva-dos"));
});

function readTokens(store: DraftStore): string[] {
  return JSON.parse(store.getItem(WIZARD_ENTRY_TOKENS_KEY) || "[]") as string[];
}

test("sin borrador previo, Personalizado empieza en Participantes y no inventa una copia", () => {
  const store = memoryStore();
  const r = applyFreshHomeEntry(store, { modo: "personalizado", entrada: "nueva-vacio", idea: "" });
  assert.equal(r.started, true);
  assert.equal(r.parked, false);
  assert.equal(r.screen, 0);
  assert.equal(SCREENS[0], "Participantes");
  assert.equal(store.getItem(WIZARD_RECOVERY_KEY), null);
  assert.equal(restorePreviousDraft(store).restored, false);
  assert.equal(loadDraft(store.getItem(WIZARD_STORAGE_KEY)).step, screenStart(0));
});

test("la página aplica la entrada nueva antes de montar el asistente y no limpia el almacenamiento", () => {
  const page = fs.readFileSync(path.resolve(__dirname, "../../../app/dashboard/podcast/page.tsx"), "utf8");
  const gate = fs.readFileSync(path.resolve(__dirname, "../../../app/dashboard/podcast/PodcastFreshEntry.tsx"), "utf8");
  assert.match(page, /PodcastFreshEntry/);
  assert.match(page, /entrada=\{typeof sp\.entrada === "string" \? sp\.entrada : undefined\}/);
  assert.match(page, /idea=\{typeof sp\.idea === "string" \? sp\.idea : undefined\}/);
  assert.match(gate, /applyFreshHomeEntry/);
  assert.match(gate, /restorePreviousDraft/);
  assert.match(gate, /useSyncExternalStore/);
  assert.match(gate, /if \(!snap\.ready\)/);
  assert.match(gate, /key=\{`\$\{epoch\}:\$\{entrada \?\? ""\}`\}/);
  assert.doesNotMatch(gate, /localStorage\.clear|sessionStorage\.clear|removeItem\(\s*WIZARD_STORAGE_KEY/);
  assert.doesNotMatch(page, /localStorage\.clear/);
});

test("formato 1 o 2 personas: en video con avatares cambia presentador ↔ conversación; en audio, una o dos voces", () => {
  const video = { ...defaultDraft(), modality: "avatar" as const, mode: "avatar" as const, count: 1 as const };
  const two = withFormat(video, 2);
  assert.equal(two.modality, "dialogo"); assert.equal(two.mode, "dialogo"); assert.equal(two.count, 2);
  const one = withFormat(two, 1);
  assert.equal(one.modality, "avatar"); assert.equal(one.mode, "avatar"); assert.equal(one.count, 1);
  const audio = withFormat({ ...defaultDraft(), modality: "audio" as const, mode: "narracion" as const }, 2);
  assert.equal(audio.modality, "audio"); assert.equal(audio.mode, "narracion"); assert.equal(audio.count, 2);
});
