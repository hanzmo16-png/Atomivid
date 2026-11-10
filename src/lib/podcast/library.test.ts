/** Podcast — biblioteca limpia (T-20261030-1118): vistas, orden y archivar/restaurar sin borrar. Sin red ni base. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ACTION_NOTE, ARCHIVE_COLUMN_MISSING, AUTO_GROUPED, bucketOf, isAvatarQuotaError, recoverableFailure, restoreNote, fetchAllByCursor, incompleteLibraryNotice, isMissingRelation, isTestTitle, libraryAction, libraryView, listClassicEpisodes, ownerRowsByCursor, shownCount, VIEW_STEP, type LibraryItem, type OwnerRowsClient, type PageCursor } from "./library";
import { listStudioEpisodes } from "./v3/store";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  assert.match(page, /!archiveReady && !v2Out\.failed && <p[^>]*data-testid="biblioteca-archivo-bloqueado"/);
});

test("B3: sin tope invisible: las dos fuentes usan la misma consulta por cursor (updated_at, id) DESC con user_id, sin .limit(100)", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "../../..", p), "utf8");
  const page = read("src/app/dashboard/podcast/page.tsx"), store = read("src/lib/podcast/v3/store.ts"), lib = read("src/lib/podcast/library.ts");
  for (const src of [page, store]) {
    assert.doesNotMatch(src, /\.limit\(100\)/, "el tope de 100 ya no existe");
    assert.match(src, /ownerRowsByCursor|listClassicEpisodes/);
    assert.doesNotMatch(src, /fetchAllByCursor/, "nadie arma su propia paginación");
  }
  assert.match(lib, /\.eq\("user_id", userId\)/, "siempre filtrado por el dueño");
  assert.match(lib, /\.or\(afterCursorFilter\(after\)\)/);
  assert.match(lib, /\.order\("updated_at", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\)\.limit\(n\)/);
  assert.match(page, /listClassicEpisodes<[^>]+>\(service as unknown as OwnerRowsClient, user\.id, V2_COLS\)/);
  // CORRECCION-1/2: el truncamiento o fallo inicial de las dos fuentes llega a la página y se muestra; la vista vacía
  // no se presenta como completa cuando hay aviso.
  assert.match(page, /incompleteLibraryNotice\(\{ studio: !!studioOut\?\.truncated, classic: v2Out\.truncated \}\)/);
  assert.match(page, /\{empty && !incompleteNotice && <p[^>]*data-testid="biblioteca-vacia"/);
  assert.match(page, /\{incompleteNotice && <p role="status"[^>]*data-testid="biblioteca-incompleta">\{incompleteNotice\}<\/p>\}/);
});

/** Fuente simulada con la MISMA semántica que la consulta PostgREST: (updated_at, id) < cursor, orden DESC, límite. */
const keysetSource = <T extends { id: string; updated_at: string }>(rows: T[]) => {
  const sorted = [...rows].sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1));
  let calls = 0;
  const page = async (after: PageCursor | null, size: number) => { calls++;
    return sorted.filter((r) => !after || r.updated_at < after.updated_at || (r.updated_at === after.updated_at && r.id < after.id)).slice(0, size); };
  return { page, calls: () => calls };
};

test("B3: 150 episodios sintéticos (estudio + clásico, con fechas repetidas) → la vista los muestra todos, sin perder ni duplicar", async () => {
  // 80 de estudio y 70 clásicos; muchas fechas idénticas (bloques de 7) para forzar el desempate por id en el cursor.
  const at = (n: number) => new Date(NOW - Math.floor(n / 7) * 60_000).toISOString();
  const studio = Array.from({ length: 80 }, (_, n) => ({ kind: "studio" as const, id: id(1000 + n), status: "ready", created_at: ago(30), updated_at: at(n) }));
  const v2 = Array.from({ length: 70 }, (_, n) => ({ kind: "v2" as const, id: id(5000 + n), status: "ready", created_at: ago(30), updated_at: at(n + 3) }));
  for (const size of [7, 25, 100]) {
    const S = keysetSource(studio), V = keysetSource(v2);
    const [a, b] = [await fetchAllByCursor(S.page, size), await fetchAllByCursor(V.page, size)];
    assert.ok(a && b && !a.truncated && !b.truncated);
    assert.equal(new Set(a!.rows.map((r) => r.id)).size, 80, `estudio completo con páginas de ${size}`);
    assert.equal(new Set(b!.rows.map((r) => r.id)).size, 70, `clásico completo con páginas de ${size}`);
    assert.equal(a!.rows.length + b!.rows.length, 150, "sin duplicados");
    const view = libraryView([...a!.rows, ...b!.rows], "principal", NOW);
    // Recorrido «Ver más» de 50 en 50: cada corte es prefijo del siguiente y el último cubre las 150 exactamente una vez.
    const seen: string[] = [];
    for (let shown = shownCount(undefined, view.length); ; shown = shownCount(String(shown + VIEW_STEP), view.length)) {
      const slice = view.slice(0, shown);
      assert.deepEqual(slice.slice(0, seen.length).map((x) => x.id), seen, "el corte anterior no cambia");
      seen.splice(0, seen.length, ...slice.map((x) => x.id));
      if (shown >= view.length) break;
    }
    assert.equal(seen.length, 150); assert.equal(new Set(seen).size, 150);
    // Orden global conservado: actividad más reciente primero, mezclando fuentes.
    for (let i = 1; i < view.length; i++) assert.ok(Date.parse(view[i - 1].updated_at!) >= Date.parse(view[i].updated_at!), `orden en ${i}`);
  }
  assert.equal(shownCount("abc", 150), VIEW_STEP); assert.equal(shownCount("-5", 150), VIEW_STEP); assert.equal(shownCount("999999", 150), 150);
});

test("B3: una fuente que falla en la primera página → null (como antes); a mitad → lo leído y truncated (nunca se oculta en silencio)", async () => {
  assert.equal(await fetchAllByCursor(async () => null, 10), null);
  let n = 0;
  const half = await fetchAllByCursor(async () => (n++ === 0 ? Array.from({ length: 10 }, (_, i) => ({ id: id(i), updated_at: ago(i) })) : null), 10);
  assert.ok(half && half.truncated && half.rows.length === 10);
  const capped = await fetchAllByCursor(async (after) => Array.from({ length: 10 }, (_, i) => ({ id: id(i + (after ? 100 : 0)), updated_at: ago(i + (after ? 100 : 0)) })), 10, 20);
  assert.ok(capped && capped.truncated && capped.rows.length === 20);
});

/**
 * Cliente de Supabase simulado para los LLAMADORES reales (`listStudioEpisodes`, `ownerRowsByCursor` de la página):
 * interpreta el filtro de `afterCursorFilter`, `eq("user_id")`, el orden y el límite. `failAt` = nº de consulta que falla;
 * `missing` = columnas ausentes (la primera página falla como en PostgREST).
 */
const fakeClient = (rows: { id: string; user_id: string; updated_at: string }[], opts: { failAt?: number; missing?: string; failAll?: boolean; errorCode?: string } = {}) => {
  let calls = 0; const seen: { user?: string; limit?: number; cols: string }[] = [];
  const client: OwnerRowsClient = { from: () => ({ select: (cols: string) => {
    const st: { user?: string; after?: PageCursor; limit?: number } = {};
    const q = {
      eq(col: string, v: string) { assert.equal(col, "user_id"); st.user = v; return q; },
      or(f: string) { const m = /^updated_at\.lt\."(.+)",and\(updated_at\.eq\."(.+)",id\.lt\.(.+)\)$/.exec(f); assert.ok(m && m[1] === m[2], f); st.after = { updated_at: m![1], id: m![3] }; return q; },
      order() { return q; },
      limit(n: number) { st.limit = n; return q; },
      then<A = { data: unknown; error: unknown }, B = never>(res?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, rej?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
        calls++; seen.push({ user: st.user, limit: st.limit, cols });
        const fail = opts.failAll || calls === opts.failAt || (opts.missing && cols.includes(opts.missing));
        const data = fail ? null : rows.filter((r) => r.user_id === st.user)
          .sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1))
          .filter((r) => !st.after || r.updated_at < st.after.updated_at || (r.updated_at === st.after.updated_at && r.id < st.after.id))
          .slice(0, st.limit);
        const err = !fail ? null : opts.missing && cols.includes(opts.missing) ? { code: "42703", message: `column podcast.${opts.missing} does not exist` } : { code: opts.errorCode ?? "57014", message: "simulado" };
        return Promise.resolve({ data, error: err }).then(res, rej);
      },
    };
    return q;
  } }) };
  return { client, calls: () => calls, seen };
};
const owned = (n: number, user = "u1", offset = 0) => Array.from({ length: n }, (_, i) => ({ id: id(offset + i), user_id: user, updated_at: new Date(NOW - Math.floor(i / 7) * 60_000).toISOString() }));

test("CORRECCION-1: listStudioEpisodes (llamador real) — exactamente 5000 NO es truncada; 5001 sí; a mitad falla → truncated con lo leído", async () => {
  const asSb = (c: OwnerRowsClient) => c as unknown as SupabaseClient;
  const exact = fakeClient([...owned(5000), ...owned(30, "u2", 9000)]);
  const a = await listStudioEpisodes(asSb(exact.client), "u1");
  assert.ok(a); assert.equal(a.rows.length, 5000); assert.equal(a.truncated, false, "5000 exactas: sin aviso falso");
  assert.equal(new Set(a.rows.map((r) => r.id)).size, 5000);
  assert.ok(exact.seen.every((q) => q.user === "u1"), "cada página filtra por el dueño");
  const over = await listStudioEpisodes(asSb(fakeClient(owned(5001)).client), "u1");
  assert.ok(over); assert.equal(over.rows.length, 5000); assert.equal(over.truncated, true, "5001: se avisa");
  const mid = await listStudioEpisodes(asSb(fakeClient(owned(250), { failAt: 2 }).client), "u1");
  assert.ok(mid); assert.equal(mid.rows.length, 100); assert.equal(mid.truncated, true, "fallo en la página 2: lo leído + aviso");
  // Sin la columna de archivo: la primera página falla y se reintenta sin ella (como antes); completa y sin aviso.
  const legacy = fakeClient(owned(120), { missing: "archived_at" });
  const l = await listStudioEpisodes(asSb(legacy.client), "u1");
  assert.ok(l); assert.equal(l.rows.length, 120); assert.equal(l.truncated, false);
  assert.ok(legacy.seen.some((q) => !q.cols.includes("archived_at")));

});

test("CORRECCION-1: clásico de la página (ownerRowsByCursor sobre podcast_episodes) — exacto 5000, 5001+ y fallo intermedio", async () => {
  const cols = "id,updated_at,archived_at";
  const exact = await ownerRowsByCursor(fakeClient(owned(5000)).client, "podcast_episodes", cols, "u1");
  assert.ok(exact && exact.rows.length === 5000 && !exact.truncated);
  const over = await ownerRowsByCursor(fakeClient(owned(5003)).client, "podcast_episodes", cols, "u1");
  assert.ok(over && over.rows.length === 5000 && over.truncated);
  const mid = await ownerRowsByCursor(fakeClient(owned(300), { failAt: 3 }).client, "podcast_episodes", cols, "u1");
  assert.ok(mid && mid.rows.length === 200 && mid.truncated);
  // El aviso: visible, no destructivo y nombra la fuente; sin truncamiento, nada.
  assert.equal(incompleteLibraryNotice({ studio: false, classic: false }), null);
  assert.match(incompleteLibraryNotice({ studio: false, classic: true })!, /clásicos: esta lista puede estar incompleta\. No se borró ni ocultó nada/);
  assert.match(incompleteLibraryNotice({ studio: true, classic: true })!, /de estudio y clásicos/);
  // Tope no múltiplo del tamaño de página: nunca pasa de maxRows y la sonda de 1 fila decide.
  const odd = await fetchAllByCursor(keysetSource(owned(23)).page, 10, 23);
  assert.ok(odd && odd.rows.length === 23 && !odd.truncated);
  const odd2 = await fetchAllByCursor(keysetSource(owned(24)).page, 10, 23);
  assert.ok(odd2 && odd2.rows.length === 23 && odd2.truncated);
});

test("CORRECCION-2: fallo en la PRIMERA página no es «sin episodios» (estudio, clásico o ambos); vacía de verdad y respaldo sin aviso", async () => {
  const asSb = (c: OwnerRowsClient) => c as unknown as SupabaseClient;
  const COLS = "id,updated_at";
  const view = async (studioC: OwnerRowsClient, classicC: OwnerRowsClient) => {
    const st = await listStudioEpisodes(asSb(studioC), "u1"), cl = await listClassicEpisodes(classicC, "u1", COLS);
    const notice = incompleteLibraryNotice({ studio: !!st?.truncated, classic: cl.truncated });
    const rows = (st?.rows.length ?? 0) + cl.rows.length;
    return { st, cl, notice, rows, emptyShownAsComplete: rows === 0 && !notice };
  };
  // Estudio falla en su primera página (los dos intentos) y el clásico funciona → aviso del estudio, clásicos visibles.
  const a = await view(fakeClient(owned(40), { failAll: true }).client, fakeClient(owned(12)).client);
  assert.ok(a.st && a.st.truncated && a.st.rows.length === 0); assert.equal(a.cl.rows.length, 12);
  assert.match(a.notice!, /episodios de estudio:/); assert.doesNotMatch(a.notice!, /clásicos/);
  // Clásico final falla en su primera página y el estudio funciona → aviso del clásico; no se dice que archivar esté bloqueado por migración.
  const b = await view(fakeClient(owned(9)).client, fakeClient(owned(30), { failAll: true }).client);
  assert.equal(b.st!.rows.length, 9); assert.ok(b.cl.failed && b.cl.truncated && !b.cl.archiveReady);
  assert.match(b.notice!, /episodios clásicos:/);
  // Ambas fallan → aviso de las dos; la vista vacía nunca se presenta como completa.
  const c = await view(fakeClient(owned(40), { failAll: true }).client, fakeClient(owned(30), { failAll: true }).client);
  assert.equal(c.rows, 0); assert.equal(c.emptyShownAsComplete, false); assert.match(c.notice!, /de estudio y clásicos/);
  // Primer intento clásico falla SOLO por la columna archived_at → respaldo sin ella: completo y sin aviso falso.
  const d = await view(fakeClient(owned(5)).client, fakeClient(owned(130), { missing: "archived_at" }).client);
  assert.ok(!d.cl.failed && !d.cl.truncated && !d.cl.archiveReady); assert.equal(d.cl.rows.length, 130); assert.equal(d.notice, null);
  // Fuentes realmente vacías y sin error → estado vacío normal, sin aviso.
  const e = await view(fakeClient([]).client, fakeClient([]).client);
  assert.equal(e.rows, 0); assert.equal(e.notice, null); assert.equal(e.emptyShownAsComplete, true);
  // Tabla de estudio ausente (migración no aplicada) → la lista de estudio no aparece, como antes, sin aviso falso.
  for (const code of ["42P01", "PGRST205"]) assert.equal(await listStudioEpisodes(asSb(fakeClient(owned(3), { failAll: true, errorCode: code }).client), "u1"), null);
  assert.ok(isMissingRelation({ message: 'relation "public.podcast_studio_episodes" does not exist' }));
  assert.ok(!isMissingRelation({ code: "42703", message: "column podcast_studio_episodes.archived_at does not exist" }), "una columna ausente no es tabla ausente");
  assert.ok(!isMissingRelation({ code: "PGRST204", message: "Could not find the 'archived_at' column" }));
  assert.ok(!isMissingRelation(null));
  // Regresión del clásico real: 5000 exactas, 5001 y fallo intermedio; dueño en cada página.
  const ex = fakeClient([...owned(5000), ...owned(20, "u2", 9000)]);
  const r1 = await listClassicEpisodes(ex.client, "u1", COLS);
  assert.ok(r1.rows.length === 5000 && !r1.truncated && r1.archiveReady && ex.seen.every((q) => q.user === "u1"));
  const r2 = await listClassicEpisodes(fakeClient(owned(5001)).client, "u1", COLS);
  assert.ok(r2.rows.length === 5000 && r2.truncated);
  const r3 = await listClassicEpisodes(fakeClient(owned(300), { failAt: 2 }).client, "u1", COLS);
  assert.ok(r3.rows.length === 100 && r3.truncated && !r3.failed);
});

test("B2: archivar dos veces no reescribe la fecha; restaurar dos veces no escribe; con carrera, la segunda responde igual", async () => {
  const db = fakeDb({ [id(7)]: { user_id: "u1", status: "ready", archived_at: null } });
  const first = await libraryAction("u1", { kind: "studio", id: id(7), action: "archive" }, db.deps);
  const at = db.rows[id(7)].archived_at;
  assert.equal(first.status, 200); assert.ok(at);
  const second = await libraryAction("u1", { kind: "studio", id: id(7), action: "archive" }, db.deps);
  assert.equal(second.status, 200); assert.equal(second.body.unchanged, true);
  assert.equal(db.rows[id(7)].archived_at, at, "la fecha original se conserva"); assert.equal(db.writes.length, 1);
  assert.equal((await libraryAction("u1", { kind: "studio", id: id(7), action: "restore" }, db.deps)).status, 200);
  const again = await libraryAction("u1", { kind: "studio", id: id(7), action: "restore" }, db.deps);
  assert.equal(again.status, 200); assert.equal(again.body.unchanged, true); assert.equal(db.writes.length, 2, "restaurar dos veces escribe una sola vez");
  // Carrera: la escritura condicional no afecta filas (otra petición archivó entre la lectura y la escritura) → 200 sin reescribir.
  let stored: string | null = null;
  const race = await libraryAction("u1", { kind: "v2", id: id(8), action: "archive" }, {
    load: async () => ({ user_id: "u1", status: "ready", archived_at: stored }),
    setArchived: async () => { stored = "2026-10-31T19:00:00.000Z"; return false; },
  });
  assert.equal(race.status, 200); assert.equal(race.body.unchanged, true);
  // Ajeno o inexistente siguen siendo 404, y en producción 409, también en la repetición.
  assert.equal((await libraryAction("u2", { kind: "studio", id: id(7), action: "archive" }, db.deps)).status, 404);
});

test("B2: la ruta escribe de forma condicional (archivar solo si no estaba; restaurar solo si estaba) y sigue sin delete", () => {
  const route = readFileSync(path.join(__dirname, "../../..", "src/app/api/podcast/library/route.ts"), "utf8");
  assert.match(route, /at \? q\.is\("archived_at", null\) : q\.not\("archived_at", "is", null\)/);
  assert.doesNotMatch(route, /\.delete\(|\.remove\(/);
});

test("tarjeta de estudio archivada: no pide enlaces firmados hasta «Ver episodio»; abrir solo lee (GET propio), no restaura", () => {
  const card = readFileSync(path.join(__dirname, "../../..", "src/app/dashboard/podcast/StudioEpisodeList.tsx"), "utf8");
  assert.match(card, /const closedByDefault = !!episode\.archived \|\| !!episode\.autoNote;/);
  assert.match(card, /useState\(!closedByDefault\)/);
  assert.match(card, /const live = opened && /, "sin abrir no hay fetch (ni URLs firmadas)");
  assert.match(card, /data-testid=\{`studio-abrir-\$\{episode\.id\}`\}/);
  assert.doesNotMatch(card.slice(card.indexOf("studio-abrir")), /api\/podcast\/library|method: "POST"/, "«Ver episodio» no archiva ni restaura");
});

test("la migración archived_at es solo aditiva y su reversión vive fuera de supabase/migrations", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "../../..", p), "utf8");
  const sql = read("supabase/migrations/20261030170000_podcast_library_archive.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /\b(drop|truncate|delete|update|rename|alter\s+column)\b/i, "sin SQL destructivo ni cambios de datos");
  assert.equal((sql.match(/add column if not exists archived_at timestamptz/g) ?? []).length, 2);
  assert.match(sql, /notify pgrst, 'reload schema'/);
  assert.doesNotMatch(sql, /grant|policy|revoke/i, "los permisos de anon/authenticated no cambian");
  assert.ok(readdirSync(path.join(__dirname, "../../../supabase/migrations")).every((f) => !/rollback/i.test(f)), "ninguna reversión en migrations/");
  assert.match(read("supabase/rollbacks/20261030170000_podcast_library_archive.rollback.sql"), /drop column if exists archived_at/);
});

test("T-20261107-2314: quitar el archivo manual — un listo vuelve a «Mis episodios»; fallido, prueba y borrador viejo siguen agrupados y se avisa antes", () => {
  // Listo archivado: restaurar lo devuelve a la vista principal y no hay aviso.
  const ready = it(1, "ready", 3, { archived_at: ago(1) });
  assert.equal(restoreNote(ready, NOW), null);
  assert.equal(libraryView([{ ...ready, archived_at: null }], "principal", NOW).length, 1);
  // Borrador reciente archivado: también vuelve (sin aviso).
  assert.equal(restoreNote(it(2, "draft", 2, { archived_at: ago(1) }), NOW), null);
  // Fallido, prueba y borrador viejo archivados: al quitar el archivo siguen en «Archivados», con su motivo de grupo.
  const cases: [LibraryItem, RegExp, string][] = [
    [it(3, "failed", 2, { archived_at: ago(1) }), /tiene un error/, "fallido"],
    [it(4, "ready", 1, { archived_at: ago(0.5), title: "QA micrófono" }), /es un episodio de prueba/, "prueba"],
    [it(5, "draft", 10, { archived_at: ago(9) }), /más de 7 días sin terminar/, "antiguo"],
  ];
  for (const [item, reason, bucket] of cases) {
    const note = restoreNote(item, NOW);
    assert.ok(note && reason.test(note) && /seguirá en «Archivados»/.test(note) && /no se borra nada/.test(note), `${bucket}: ${note}`);
    const after = { ...item, archived_at: null };
    assert.equal(bucketOf(after, NOW), bucket);
    assert.equal(libraryView([after], "principal", NOW).length, 0, `${bucket}: no se fuerza a la vista principal`);
    assert.equal(libraryView([after], "archivados", NOW).length, 1, `${bucket}: sigue recuperable en «Archivados»`);
    assert.equal(after.status, item.status, "no se cambia el estado para simular la recuperación");
  }
  // Sin archivo manual o en producción: nada que avisar.
  assert.equal(restoreNote(it(6, "failed", 2), NOW), null);
  assert.equal(restoreNote(it(7, "generating", 0.1, { archived_at: ago(1) }), NOW), null);
});

test("fallido recuperable (límite diario del avatar, incidente 4290175a): se queda en «Mis episodios» con «Necesita tu decisión»", () => {
  const QUOTA_OLD = "HeyGen (avatar): alcanzó su cuota diaria de llamadas.";  // texto que hoy guarda producción
  const QUOTA_NEW = "Proveedor no listo: HeyGen (avatar): este episodio necesita 48 llamadas y el límite diario de la plataforma es 40; no cabe en un día aunque se espere.";
  const items = [it(1, "failed", 2, { error: QUOTA_OLD }), it(2, "failed", 1, { error: QUOTA_NEW }), it(3, "failed", 1, { error: "ElevenLabs (voz): no se pudo verificar un saldo suficiente." }),
    it(4, "ready", 0.5), it(5, "generating", 0.1), it(6, "failed", 3, { error: QUOTA_OLD, archived_at: ago(0.2) }), it(7, "failed", 1, { error: QUOTA_OLD, title: "QA prueba de cuota" }),
    { kind: "v2", id: id(8), status: "failed", created_at: ago(1), error: QUOTA_OLD } as LibraryItem];
  const main = libraryView(items, "principal", NOW);
  // En curso → recuperables (más reciente arriba) → terminados.
  assert.deepEqual(main.map((x) => [x.id.slice(-1), x.bucket]), [["5", "en_curso"], ["2", "recuperable"], ["1", "recuperable"], ["4", "listo"]]);
  const arch = libraryView(items, "archivados", NOW);
  assert.deepEqual(arch.map((x) => [x.id.slice(-1), x.bucket]).sort(), [["3", "fallido"], ["6", "archivado"], ["7", "prueba"], ["8", "fallido"]].sort(),
    "otro error, archivado a mano, de prueba o del clásico: siguen en «Archivados»");
  assert.equal(main.length + arch.length, items.length, "nada se pierde");
  assert.ok(ACTION_NOTE.recuperable && /Necesita tu decisión/.test(ACTION_NOTE.recuperable) && /sin perder el guion/.test(ACTION_NOTE.recuperable));
  assert.equal("recuperable" in AUTO_GROUPED, false, "no es un grupo automático: se puede archivar a mano");
  assert.equal(isAvatarQuotaError(QUOTA_OLD), true); assert.equal(recoverableFailure({ kind: "studio", status: "ready", error: QUOTA_OLD }), false);
});

test("recuperable archivado a mano: al restaurar vuelve a «Mis episodios» (sin aviso de que seguiría oculto)", () => {
  const e = it(1, "failed", 2, { error: "HeyGen (avatar): alcanzó su cuota diaria de llamadas.", archived_at: ago(0.1) });
  assert.equal(bucketOf(e, NOW), "archivado");
  assert.equal(restoreNote(e, NOW), null);
  assert.equal(bucketOf({ ...e, archived_at: null }, NOW), "recuperable");
});
