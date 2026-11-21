/**
 * T-30 — Leer el Audio Podcast Studio no escribe nada.
 * Defecto (QA T-29): el primer GET de la biblioteca de la cuenta dueña creaba el «episodio inicial» en Storage
 * (page.tsx llamaba a ensureSeed durante el render). Ahora:
 *  - biblioteca y editor muestran el episodio inicial VIRTUAL con su id estable, con 0 escrituras;
 *  - solo una acción explícita (guardar, archivar, marcar listo, generar…) lo persiste, y como máximo una vez;
 *  - una semilla ya guardada (editada o archivada) se respeta: no se duplica, no se pisa y no se resucita;
 *  - nunca aparece en la cuenta de otra persona ni para cuentas que no son la dueña.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memoryStore, type ProjectStore } from "./store";
import { ensureSeed, materializeSeed, readLibrary, readProject, saveProject, seedId, setArchived, type Deps } from "./service";
import { SEED_EPISODE } from "./seed";

const A = "0f0f0f0f-1111-4111-8111-00000000000a";
const B = "0f0f0f0f-2222-4222-8222-00000000000b";

/** Store que cuenta TODAS las escrituras (create/put/putBlob) por debajo de la interfaz real. */
function spied() {
  const inner = memoryStore();
  const writes: string[] = [];
  const store = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v === "function" && /^(create|put|putBlob|remove|delete)/.test(String(k))) return async (...a: unknown[]) => {
        const r = await v.apply(t, a);
        // Un create rechazado (el objeto ya existía) no escribe nada: se anota aparte.
        writes.push(String(k) === "create" && r === false ? "create:rechazado" : String(k));
        return r;
      };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ProjectStore;
  let n = 0;
  const d: Deps = { store, now: () => `2026-11-19T22:00:${String(n++ % 60).padStart(2, "0")}.000Z` };
  return { d, store, writes };
}

test("reproducción del defecto: la secuencia de la página anterior (ensureSeed en el GET) escribe 1 objeto", async () => {
  const { d, writes } = spied();
  await ensureSeed(d, A);
  assert.deepEqual(writes, ["create"], "la base escribía durante la lectura");
  // Y la página ya no usa esa secuencia durante el render:
  const page = readFileSync("src/app/dashboard/audio-studio/page.tsx", "utf8");
  assert.doesNotMatch(page, /ensureSeed\(/, "la biblioteca no puede sembrar al leer");
  assert.match(page, /readLibrary\(/);
  const editor = readFileSync("src/app/dashboard/audio-studio/[id]/page.tsx", "utf8");
  assert.match(editor, /readProject\(/);
});

test("primer GET de biblioteca y editor: episodio inicial visible con id estable y CERO escrituras", async () => {
  const { d, writes } = spied();
  for (let i = 0; i < 3; i++) {
    const lib = await readLibrary(d, A, { owner: true });
    assert.ok(lib.ok);
    const seed = lib.body.projects.find((p) => p.id === seedId(A));
    assert.ok(seed, "el episodio inicial se ve en la biblioteca");
    assert.equal(seed.title, SEED_EPISODE.title);
    assert.equal(seed.revision, 1);
    assert.equal(seed.archivedAt, null);
    const ed = await readProject(d, A, seedId(A), { owner: true });
    assert.ok(ed.ok);
    assert.equal(ed.body.id, seedId(A), "id estable entre recargas");
    assert.equal(ed.body.script, SEED_EPISODE.script);
  }
  assert.deepEqual(writes, [], "leer (y recargar) no escribe nada");
});

test("una acción explícita lo persiste UNA vez: guardar dos veces, en carrera o tras recargar, no duplica", async () => {
  const { d, store, writes } = spied();
  const v = await readProject(d, A, seedId(A), { owner: true });
  assert.ok(v.ok);
  // Dos pestañas guardan a la vez sobre la vista virtual (revisión 1).
  assert.deepEqual(await Promise.all([materializeSeed(d, A, seedId(A), { owner: true }), materializeSeed(d, A, seedId(A), { owner: true })]).then((r) => r.sort()), ["created", "exists"]);
  const s1 = await saveProject(d, A, seedId(A), { revision: 1, script: "## Apertura\n\nMi versión." });
  assert.ok(s1.ok, JSON.stringify(s1.body));
  assert.equal(await materializeSeed(d, A, seedId(A), { owner: true }), "exists");
  assert.equal(writes.filter((w) => w === "create").length, 1, "como máximo una creación");
  assert.equal((await store.list(A)).filter((p) => p.id === seedId(A)).length, 1, "sin duplicados");
  // Tras recargar se ve la versión guardada, no la semilla original.
  const after = await readProject(d, A, seedId(A), { owner: true });
  assert.ok(after.ok);
  assert.match(after.body.script, /Mi versión/);
  const w = writes.length;
  await readLibrary(d, A, { owner: true });
  await readProject(d, A, seedId(A), { owner: true });
  assert.equal(writes.length, w, "volver a leer tampoco escribe");
});

test("semilla existente editada se preserva; semilla archivada NO se resucita ni se duplica", async () => {
  const { d, store } = spied();
  await ensureSeed(d, A);
  await saveProject(d, A, seedId(A), { revision: 1, script: "## Mía\n\nEditada." });
  await setArchived(d, A, seedId(A), true);
  const before = JSON.stringify(await store.get(A, seedId(A)));
  const lib = await readLibrary(d, A, { owner: true });
  assert.ok(lib.ok);
  const seeds = lib.body.projects.filter((p) => p.id === seedId(A));
  assert.equal(seeds.length, 1, "una sola entrada");
  assert.ok(seeds[0].archivedAt, "sigue archivada (no aparece una semilla virtual nueva)");
  const ed = await readProject(d, A, seedId(A), { owner: true });
  assert.ok(ed.ok);
  assert.match(ed.body.script, /Editada/);
  assert.equal(await materializeSeed(d, A, seedId(A), { owner: true }), "exists");
  assert.equal(JSON.stringify(await store.get(A, seedId(A))), before, "el objeto guardado queda idéntico");
});

test("aislamiento: otra cuenta no ve ni puede materializar la semilla ajena; una cuenta no dueña no tiene semilla", async () => {
  const { d, writes } = spied();
  const libB = await readLibrary(d, B, { owner: false });
  assert.ok(libB.ok);
  assert.equal(libB.body.projects.length, 0, "cuenta no dueña: biblioteca vacía, sin semilla");
  assert.equal((await readProject(d, B, seedId(A), { owner: true })).status, 404, "el id de la semilla de A no existe para B");
  assert.equal((await readProject(d, B, seedId(B), { owner: false })).status, 404, "sin dueño no hay semilla virtual");
  assert.equal(await materializeSeed(d, B, seedId(A), { owner: true }), "no_seed", "solo el id propio");
  assert.equal(await materializeSeed(d, B, seedId(B), { owner: false }), "no_seed", "solo la cuenta dueña");
  assert.deepEqual(writes, []);
});

test("ids ajenos al episodio inicial no cambian: proyecto inexistente sigue en 404 sin escrituras", async () => {
  const { d, writes } = spied();
  assert.equal((await readProject(d, A, "0f0f0f0f-3333-4333-8333-000000000003", { owner: true })).status, 404);
  assert.equal(await materializeSeed(d, A, "0f0f0f0f-3333-4333-8333-000000000003", { owner: true }), "no_seed");
  assert.equal((await readProject(d, A, "no-es-uuid", { owner: true })).status, 404);
  assert.deepEqual(writes, []);
});
