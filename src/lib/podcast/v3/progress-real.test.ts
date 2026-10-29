/**
 * Podcast — avance REAL del estudio (incidente ec30c594, 2026-10-29): la página quedó en 0 % con 43 voces, 21
 * ilustraciones y 7 clips ya pagados porque el worker hacía `void` sobre consultas perezosas de Supabase (nunca se
 * enviaban). Sin red: el «cliente» de estas pruebas es perezoso igual que el de Supabase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ledgerActivity, mergeProgress, progressRecord, progressView, stagesFor, STALE_MS, type LedgerOp, type StudioProgress } from "./progress";
import { createProgressWriter } from "./progress-writer";
import { episodeAction } from "./api";
import type { StudioEpisodeRow } from "./store";

const ALL = stagesFor({ video: true, images: true, avatars: true });
const LEDGER: LedgerOp[] = JSON.parse(readFileSync(path.join(__dirname, "__fixtures__/ec30c594-ledger-1824.json"), "utf8"));
const AT_AUDIT = Date.parse("2026-10-29T18:24:39Z");

/** Constructor perezoso como PostgrestBuilder: la «petición» solo sale con then(). */
function lazyUpdate(sink: StudioProgress[], p: StudioProgress): PromiseLike<{ error: null }> {
  return { then(ok, ko) { sink.push(p); return Promise.resolve({ error: null }).then(ok, ko); } };
}

test("causa raíz: un `void` sobre la consulta perezosa no envía nada; el escritor sí guarda cada avance", async () => {
  const sent: StudioProgress[] = [];
  // Lo que hacía el worker: void builder → cero peticiones.
  void lazyUpdate(sent, progressRecord(ALL, "voces", 1, 43));
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0, "reproduce el incidente: nada llega a la base");
  const w = createProgressWriter((p) => lazyUpdate(sent, p));
  w.push(progressRecord(ALL, "preparacion", 1, 1));
  w.push(progressRecord(ALL, "voces", 0, 43));
  for (let i = 1; i <= 43; i++) w.push(progressRecord(ALL, "voces", i, 43));
  await w.flush();
  assert.ok(sent.length >= 2, "se envían avances");
  const last = sent[sent.length - 1];
  assert.equal(last.stage, "voces"); assert.equal(last.done, 43, "el último guardado es el más reciente (sin perder el final)");
  assert.equal(w.stats.failures, 0);
});

test("escritor: de una en una, la última pendiente reemplaza a las anteriores; un fallo se registra y no detiene nada", async () => {
  let inFlight = 0, maxInFlight = 0;
  const seen: number[] = [];
  const logs: string[] = [];
  let fail = true;
  const w = createProgressWriter(async (p) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (fail) { fail = false; return { error: { message: "network" } }; }
    seen.push(p.done);
  }, (l) => logs.push(l));
  for (let i = 1; i <= 20; i++) w.push(progressRecord(ALL, "imagenes", i, 20));
  await w.flush();
  assert.equal(maxInFlight, 1, "nunca dos escrituras a la vez (no se pisan)");
  assert.ok(seen.length < 20, "se agrupan las pendientes");
  assert.equal(seen[seen.length - 1], 20);
  assert.equal(logs.length, 1); assert.match(logs[0], /^STUDIO_PROGRESS_WRITE_FAILED network/);
});

test("nunca retrocede: etapa, unidades y porcentaje solo avanzan; hitos durables por etapa; nunca 100 % sin «ready»", () => {
  let p = mergeProgress(null, progressRecord(ALL, "voces", 43, 43, new Date("2026-10-29T17:56:32Z")));
  p = mergeProgress(p, progressRecord(ALL, "imagenes", 21, 21, new Date("2026-10-29T18:02:39Z")));
  p = mergeProgress(p, progressRecord(ALL, "avatares", 7, 12, new Date("2026-10-29T18:20:57Z")));
  const pct = p.pct;
  const late = mergeProgress(p, progressRecord(ALL, "voces", 40, 43, new Date("2026-10-29T18:21:00Z")));
  assert.equal(late.stage, "avatares"); assert.equal(late.done, 7); assert.equal(late.pct, pct, "un informe tardío no baja la barra");
  const fewer = mergeProgress(p, progressRecord(ALL, "avatares", 5, 12, new Date("2026-10-29T18:21:30Z")));
  assert.equal(fewer.done, 7);
  assert.deepEqual(Object.keys(p.stages ?? {}), ["voces", "imagenes", "avatares"]);
  assert.equal(p.stages?.voces?.done, 43); assert.equal(p.stages?.imagenes?.total, 21);
  const saving = mergeProgress(p, progressRecord(ALL, "guardado", 1, 1));
  assert.ok(saving.pct <= 99);
  // Al volver a abrir la página: los hitos guardados se ven con sus cuentas.
  const v = progressView({ status: "generating", progress: p, updated_at: p.updatedAt }, Date.parse("2026-10-29T18:22:00Z"));
  assert.equal(v.state, "procesando"); assert.equal(v.stage, "avatares"); assert.equal(v.detail, "7 de 12");
  assert.deepEqual(v.stages.map((r) => [r.stage, r.state, r.done, r.total]), [
    ["preparacion", "hecha", null, null], ["voces", "hecha", 43, 43], ["imagenes", "hecha", 21, 21], ["avatares", "activa", 7, 12], ["montaje", "pendiente", null, null], ["guardado", "pendiente", null, null]]);
  assert.ok(v.recent.length > 0 && v.recent.length <= 6);
  // «ready» sin archivo no es 100 %; con archivo sí.
  assert.notEqual(progressView({ status: "ready", progress: saving, audio_path: null }).pct, 100);
  assert.equal(progressView({ status: "ready", progress: saving, audio_path: "u/e/episodio.mp3" }).pct, 100);
});

test("episodio real ec30c594 (libro a las 18:24): sin avance guardado, la página ya no queda en 0 % — etapa y cuentas reales del libro", () => {
  const a = ledgerActivity(LEDGER);
  assert.equal(a.stage, "avatares");
  assert.deepEqual(a.counts, { voces: 43, imagenes: 21, avatares: 7 }, "solo cuenta lo liquidado (el clip reservado aún no)");
  assert.equal(a.lastAt, "2026-10-29T18:23:56.142576+00:00");
  assert.match(a.recent[a.recent.length - 1].text, /^Generando clip de avatar 8$/);
  // Lo que había en la fila: progress NULL, updated_at = hora de autorización (14:34).
  const v = progressView({ status: "generating", progress: null, updated_at: "2026-10-29T14:34:45.602+00:00" }, AT_AUDIT, a);
  assert.equal(v.state, "procesando", "hay actividad reciente en el libro: no es «sin respuesta»");
  assert.equal(v.stage, "avatares");
  assert.ok(v.pct >= 30 && v.pct < 99, `mínimo comprobable (inicio de la etapa de avatares), no 0 %: ${v.pct}`);
  assert.equal(v.pct, Math.floor(((3 + 15 + 12) / 100) * 100), "inicio exacto de «avatares», sin inventar fracción");
  assert.equal(v.detail, "7 listas");
  assert.deepEqual(v.stages.filter((r) => r.done != null).map((r) => [r.stage, r.done]), [["voces", 43], ["imagenes", 21], ["avatares", 7]]);
  // Sin el libro (lo que veía el dueño): 0 % y «sin respuesta» — el error que se corrige.
  const before = progressView({ status: "generating", progress: null, updated_at: "2026-10-29T14:34:45.602+00:00" }, AT_AUDIT);
  assert.equal(before.pct, 0); assert.equal(before.state, "sin_informacion");
});

test("tres estados: espera (nadie lo tomó), produciendo (señal reciente), procesador sin respuesta (sin señal > 10 min)", () => {
  const a = ledgerActivity(LEDGER);
  assert.equal(progressView({ status: "authorized" }, AT_AUDIT, a).state, "espera");
  assert.equal(progressView({ status: "generating", progress: null }, Date.parse(a.lastAt!) + STALE_MS - 1000, a).state, "procesando");
  const stale = progressView({ status: "generating", progress: null }, Date.parse(a.lastAt!) + STALE_MS + 1000, a);
  assert.equal(stale.state, "sin_informacion"); assert.equal(stale.title, "El procesador no responde desde hace un rato");
  assert.equal(stale.pct, 30, "sin respuesta no borra lo hecho");
  // Un latido reciente del worker (avance guardado) basta aunque el libro esté quieto (montaje no llama a proveedores).
  const beat = { ...progressRecord(ALL, "montaje", 10, 40), updatedAt: new Date(Date.parse(a.lastAt!) + STALE_MS + 500).toISOString() };
  assert.equal(progressView({ status: "generating", progress: beat }, Date.parse(a.lastAt!) + STALE_MS + 1000, a).state, "procesando");
  // Una operación liberada (no se hizo) no cuenta como actividad ni unidad.
  assert.deepEqual(ledgerActivity([{ provider: "recraft", op: "ilustracion", state: "released", created_at: "2026-10-29T18:00:00Z" }]), { lastAt: null, counts: {}, stage: null, recent: [] });
});

test("API del episodio: resume la actividad del libro mientras se produce (sin importes ni filas crudas); no la consulta si ya terminó", async () => {
  const row = { id: "ec30c594-21ca-49f8-8d09-817a07147fd8", user_id: "u1", title: "Cosmonautas", mode: "dialogo", spec: { output: "video" }, status: "generating", progress: null, updated_at: "2026-10-29T14:34:45Z", video_path: null, audio_path: null } as unknown as StudioEpisodeRow;
  let calls = 0;
  const ops = async () => { calls++; return LEDGER.map((o) => ({ ...o, reserved_usd: 9, key: "k" }) as LedgerOp); };
  const out = await episodeAction("u1", row, async () => null, ops);
  const body = out.body as { activity: { counts: Record<string, number>; recent: { text: string }[] }; episode: { output: string } };
  assert.equal(out.status, 200); assert.equal(calls, 1);
  assert.deepEqual(body.activity.counts, { voces: 43, imagenes: 21, avatares: 7 });
  assert.doesNotMatch(JSON.stringify(body.activity), /reserved_usd|"key"/, "solo el resumen");
  const ready = await episodeAction("u1", { ...row, status: "ready" } as StudioEpisodeRow, async () => null, ops);
  assert.equal((ready.body as { activity: unknown }).activity, null); assert.equal(calls, 1);
  const other = await episodeAction("u2", row, async () => null, ops);
  assert.equal(other.status, 404); assert.equal(calls, 1, "otro usuario: ni se consulta el libro");
});
