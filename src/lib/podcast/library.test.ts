/** Podcast — biblioteca limpia (T-20261030-1118): vistas, orden y archivar/restaurar sin borrar. Sin red ni base. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ARCHIVE_COLUMN_MISSING, AUTO_GROUPED, bucketOf, isTestTitle, libraryAction, libraryView, type LibraryItem } from "./library";

const NOW = Date.parse("2026-10-30T17:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const it = (n: number, status: string, days: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({ kind: "studio", id: id(n), status, created_at: ago(days), ...extra });

test("vista principal: en curso, terminados y borradores recientes; fallidos, borradores viejos y archivados van a «Archivados»", () => {
  const items = [it(1, "failed", 20), it(2, "ready", 3), it(3, "generating", 0.1), it(4, "draft", 10), it(5, "failed", 1), it(6, "ready", 1, { archived_at: ago(0.5) }), it(7, "ready", 40), it(8, "draft", 2)];
  const main = libraryView(items, "principal", NOW);
  assert.deepEqual(main.map((x) => [x.id.slice(-1), x.bucket]), [["3", "en_curso"], ["2", "listo"], ["7", "listo"], ["8", "borrador"]]);
  const arch = libraryView(items, "archivados", NOW);
  assert.deepEqual(arch.map((x) => [x.id.slice(-1), x.bucket]), [["6", "archivado"], ["5", "fallido"], ["1", "fallido"], ["4", "antiguo"]]);
  assert.equal(main.length + arch.length, items.length, "nada se pierde: cada episodio está en una de las dos vistas");
});

test("lo que está en producción nunca se oculta (aunque esté marcado o sea antiguo)", () => {
  assert.equal(bucketOf(it(1, "generating", 30, { archived_at: ago(1) }), NOW), "en_curso");
  assert.equal(bucketOf(it(2, "authorized", 30), NOW), "en_curso");
  assert.equal(bucketOf({ kind: "v2", id: id(3), status: "ready", created_at: ago(30), video_status: "running" }, NOW), "en_curso");
  assert.equal(bucketOf(it(4, "ready", 400), NOW), "listo", "un episodio terminado no caduca");
});

test("orden global entre estudio y clásico: una sola secuencia, no una lista por fuente", () => {
  const v2 = (n: number, status: string, days: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({ kind: "v2", id: id(n), status, created_at: ago(days), ...extra });
  const items = [it(1, "draft", 0.2), v2(2, "ready", 2), it(3, "ready", 0.5), v2(4, "ready", 1, { video_status: "running" }), v2(5, "draft", 1)];
  const main = libraryView(items, "principal", NOW).map((x) => `${x.kind}:${x.id.slice(-1)}`);
  // En curso (v2 con video en producción) → terminados por actividad (estudio 0,5 d, luego clásico 2 d) → borradores recientes.
  assert.deepEqual(main, ["v2:4", "studio:3", "v2:2", "studio:1", "v2:5"]);
});

test("clásico usa updated_at: creado hace un mes pero editado ayer sigue a la vista; sin updated_at se agrupa como viejo", () => {
  const edited: LibraryItem = { kind: "v2", id: id(1), status: "draft", created_at: ago(30), updated_at: ago(1) };
  const untouched: LibraryItem = { kind: "v2", id: id(2), status: "draft", created_at: ago(30) };
  assert.equal(bucketOf(edited, NOW), "borrador");
  assert.equal(bucketOf(untouched, NOW), "antiguo");
  const twoReady = [{ kind: "v2" as const, id: id(3), status: "ready", created_at: ago(60), updated_at: ago(0.1) }, { kind: "v2" as const, id: id(4), status: "ready", created_at: ago(5) }];
  assert.deepEqual(libraryView(twoReady, "principal", NOW).map((x) => x.id.slice(-1)), ["3", "4"], "la actividad reciente ordena, no la fecha de creación");
});

test("episodios de prueba: regla determinista por título; se agrupan en «Archivados» sin borrarse", () => {
  for (const t of ["Prueba real POD-CREAR 2026-10-30", "QA aceptación samsung 1730", "[test] voces", "[Prueba] guion", "Validación (ficticio)", "Prueba de montaje largo (simulada)"]) assert.equal(isTestTitle(t), true, t);
  for (const t of ["Prueba de sonido con mi abuela", "La prueba real del amor", "Qatar 2022", "Equipo de QA en México", "Historia del test de Turing", "", null]) assert.equal(isTestTitle(t), false, String(t));
  const items = [it(1, "ready", 1, { title: "Prueba real POD-INICIO" }), it(2, "ready", 1, { title: "Cosmonautas: mito o realidad" })];
  assert.deepEqual(libraryView(items, "principal", NOW).map((x) => x.id.slice(-1)), ["2"]);
  assert.deepEqual(libraryView(items, "archivados", NOW).map((x) => [x.id.slice(-1), x.bucket]), [["1", "prueba"]]);
  assert.equal(bucketOf(it(3, "generating", 0, { title: "QA en curso" }), NOW), "en_curso", "una prueba en producción sigue a la vista");
  assert.equal(bucketOf(it(4, "ready", 1, { title: "QA archivado", archived_at: ago(0.2) }), NOW), "archivado", "lo archivado a mano se puede restaurar");
});

test("sin la columna archived_at, «Archivados» se consulta igual (agrupación automática, sin escribir) y explica cada grupo", () => {
  const rows: LibraryItem[] = [it(1, "failed", 1), it(2, "ready", 1, { title: "QA x" }), it(3, "draft", 20), it(4, "ready", 1)];
  assert.ok(rows.every((r) => !("archived_at" in r)));
  const arch = libraryView(rows, "archivados", NOW);
  assert.deepEqual(arch.map((x) => x.bucket), ["fallido", "prueba", "antiguo"]);
  assert.ok(arch.every((x) => typeof AUTO_GROUPED[x.bucket] === "string"), "cada grupo automático dice por qué está ahí");
});

function fakeDb(rows: Record<string, { user_id: string; status: string; video_status?: string | null; archived_at: string | null; video_path?: string; cost_usd?: number }>, opts: { column?: boolean } = {}) {
  const writes: { id: string; at: string | null }[] = [];
  return { rows, writes, deps: {
    load: async (_k: "studio" | "v2", x: string) => (opts.column === false ? "sin_columna" as const : rows[x] ? { ...rows[x] } : null),
    setArchived: async (_k: "studio" | "v2", x: string, at: string | null) => { writes.push({ id: x, at }); rows[x] = { ...rows[x], archived_at: at }; return true; },
  } };
}

test("archivar y restaurar solo cambia la marca del dueño; video, costos y estado intactos", async () => {
  const db = fakeDb({ [id(1)]: { user_id: "u1", status: "ready", archived_at: null, video_path: "u1/e1/video.mp4", cost_usd: 5.29 } });
  const a = await libraryAction("u1", { kind: "studio", id: id(1), action: "archive" }, db.deps);
  assert.equal(a.status, 200); assert.ok(db.rows[id(1)].archived_at);
  assert.equal(db.rows[id(1)].video_path, "u1/e1/video.mp4"); assert.equal(db.rows[id(1)].cost_usd, 5.29); assert.equal(db.rows[id(1)].status, "ready");
  const r = await libraryAction("u1", { kind: "studio", id: id(1), action: "restore" }, db.deps);
  assert.equal(r.status, 200); assert.equal(db.rows[id(1)].archived_at, null);
});

test("aislamiento: un episodio de otra cuenta responde como inexistente y no se escribe nada", async () => {
  const db = fakeDb({ [id(2)]: { user_id: "u2", status: "ready", archived_at: null } });
  const out = await libraryAction("u1", { kind: "v2", id: id(2), action: "archive" }, db.deps);
  assert.equal(out.status, 404); assert.equal(db.writes.length, 0); assert.equal(db.rows[id(2)].archived_at, null);
});

test("en producción no se archiva; sin la columna no se escribe y se explica; peticiones inválidas se rechazan", async () => {
  const db = fakeDb({ [id(3)]: { user_id: "u1", status: "generating", archived_at: null }, [id(4)]: { user_id: "u1", status: "ready", video_status: "queued", archived_at: null } });
  assert.equal((await libraryAction("u1", { kind: "studio", id: id(3), action: "archive" }, db.deps)).status, 409);
  assert.equal((await libraryAction("u1", { kind: "v2", id: id(4), action: "archive" }, db.deps)).status, 409);
  assert.equal(db.writes.length, 0);
  const none = fakeDb({ [id(5)]: { user_id: "u1", status: "ready", archived_at: null } }, { column: false });
  const m = await libraryAction("u1", { kind: "studio", id: id(5), action: "archive" }, none.deps);
  assert.equal(m.status, 409); assert.equal(m.body.error, ARCHIVE_COLUMN_MISSING); assert.equal(none.writes.length, 0);
  for (const bad of [null, {}, { kind: "x", id: id(5), action: "archive" }, { kind: "studio", id: "1; drop", action: "archive" }, { kind: "studio", id: id(5), action: "delete" }])
    assert.equal((await libraryAction("u1", bad, db.deps)).status, 400, JSON.stringify(bad));
});

test("cero borrado directo: la ruta y la página solo actualizan archived_at de filas del dueño", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "../../..", p), "utf8");
  const route = read("src/app/api/podcast/library/route.ts"), page = read("src/app/dashboard/podcast/page.tsx");
  for (const src of [route, page]) {
    assert.doesNotMatch(src, /\.delete\(|\.remove\(|\.upsert\(|\.insert\(/);
    assert.doesNotMatch(src, /ledger|paid_operations|storage\.from\([^)]*\)\.(remove|move)/i);
  }
  assert.equal((route.match(/\.update\(/g) ?? []).length, 1);
  assert.match(route, /\.update\(\{ archived_at: at \}\)\.eq\("id", id\)\.eq\("user_id", user\.id\)/);
  assert.doesNotMatch(page, /\.update\(/);
  // Sin la columna, la página no ofrece archivar y lo dice (el aviso solo aparece con archiveReady = false).
  assert.match(page, /!archiveReady && <p[^>]*data-testid="biblioteca-archivo-bloqueado"/);
});
