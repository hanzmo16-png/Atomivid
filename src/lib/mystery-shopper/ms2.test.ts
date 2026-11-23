import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultCatalog } from "./catalog";
import { jobStore, memoryBucket, newJobId, STALE_MS, MAX_ATTEMPTS, type JobStatus } from "./jobs";
import { startEvaluation, resolveTarget, StartError, type Dispatcher } from "./start";
import { durationConformity, mediaCheck, verdictFor, findingsFrom, type PageMetrics } from "./live";

const T0 = new Date("2026-11-23T18:00:00Z");
const env = {} as Record<string, string | undefined>;
function setup(dispatchOk = true) {
  const bucket = memoryBucket();
  const store = jobStore(bucket);
  const calls: { jobId: string; attempt: number }[] = [];
  const dispatch: Dispatcher = async (p) => { calls.push(p); return dispatchOk ? { ok: true, detail: "HTTP 204" } : { ok: false, detail: "red" }; };
  const deps = { store, catalog: defaultCatalog(), dispatch, now: () => T0, env };
  return { bucket, store, calls, deps };
}
const input = (id: string, extra: Record<string, unknown> = {}) => ({ id, missionId: "audio-proyecto-prueba", profile: "impaciente", source: "panel" as const, requestedBy: "command-center", requestedSha: "abc1234", ...extra });

test("botón: crea un trabajo persistente y despacha el worker (no devuelve un recorrido grabado)", async () => {
  const { store, calls, deps, bucket } = setup();
  const r = await startEvaluation(input("ms-20261123t180000z-aaaaaa"), deps);
  assert.equal(r.created, true); assert.equal(r.dispatched, true); assert.equal(r.view.status.state, "en_cola");
  assert.equal(calls.length, 1);
  assert.equal(r.view.hasReport, false);
  assert.ok([...bucket.objects.keys()].every((k) => k.startsWith("mystery-shopper/v2/runs/ms-20261123t180000z-aaaaaa/")));
  assert.equal((await store.list()).length, 1);
});

test("doble clic / dos solicitudes simultáneas con el mismo id → un trabajo y un despacho", async () => {
  const { store, calls, deps } = setup();
  const id = "ms-20261123t180000z-bbbbbb";
  const rs = await Promise.all([startEvaluation(input(id), deps), startEvaluation(input(id), deps), startEvaluation(input(id), deps)]);
  assert.equal(rs.filter((r) => r.created).length, 1);
  assert.equal(calls.length, 1);
  assert.equal((await store.list()).length, 1);
});

test("respuesta perdida: reintentar con el mismo id no despacha otra vez; si el despacho falló, sí se reintenta (acotado)", async () => {
  const ok = setup();
  const id = "ms-20261123t180000z-cccccc";
  await startEvaluation(input(id), ok.deps);
  const again = await startEvaluation(input(id), ok.deps);
  assert.equal(again.dispatched, false); assert.match(again.message, /ya está en cola/);
  assert.equal(ok.calls.length, 1);
  const bad = setup(false);
  for (let i = 0; i < 5; i++) await startEvaluation(input(id), bad.deps);
  assert.equal(bad.calls.length, 3, "como mucho MAX_DISPATCHES despachos");
});

test("el mismo id con otra misión es un conflicto, no un reintento", async () => {
  const { deps } = setup();
  const id = "ms-20261123t180000z-dddddd";
  await startEvaluation(input(id), deps);
  await assert.rejects(startEvaluation(input(id, { missionId: "cuenta-navegacion" }), deps), (e: unknown) => e instanceof StartError && e.http === 409);
});

test("workers concurrentes: solo uno gana el intento; un worker vivo no se pisa; uno muerto se reemplaza; se acota", async () => {
  const { store, deps } = setup();
  const id = "ms-20261123t180000z-eeeeee";
  await startEvaluation(input(id), deps);
  const now = T0.getTime();
  const [a, b] = await Promise.all([store.claim(id, "w1", now), store.claim(id, "w2", now)]);
  assert.equal([a, b].filter((c) => c.ok).length, 1);
  const winner = a.ok ? "w1" : "w2", loser = a.ok ? "w2" : "w1";
  const live: JobStatus = { ...(await store.get(id))!.status, state: "en_proceso", heartbeatAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), runnerId: winner };
  await store.setStatus(id, winner, live);
  await assert.rejects(store.setStatus(id, loser, live), /ya no tiene el trabajo/);
  const busy = await store.claim(id, "w3", now + 60_000);
  assert.equal(busy.ok, false);
  const takeover = await store.claim(id, "w4", now + STALE_MS + 1);
  assert.deepEqual(takeover, { ok: true, attempt: 2 });
  await store.claim(id, "w5", now + 3 * STALE_MS);
  const exhausted = await store.claim(id, "w6", now + 6 * STALE_MS);
  assert.equal(exhausted.ok, false); assert.equal(!exhausted.ok && exhausted.reason, "agotado");
  assert.equal(MAX_ATTEMPTS, 3);
});

test("un trabajo con informe no se vuelve a ejecutar y el informe es inmutable", async () => {
  const { store, deps } = setup();
  const id = "ms-20261123t180000z-ffffff";
  await startEvaluation(input(id), deps);
  assert.equal(await store.putReport(id, { v: 1 }), true);
  assert.equal(await store.putReport(id, { v: 2 }), false);
  assert.deepEqual(await store.getReport(id), { v: 1 });
  const c = await store.claim(id, "w", T0.getTime());
  assert.equal(c.ok, false); assert.equal(!c.ok && c.reason, "terminado");
});

test("bloqueo económico: el modo real con presupuesto aprobado USD 0 no crea nada", async () => {
  const { store, calls, deps } = setup();
  await assert.rejects(startEvaluation(input("ms-20261123t180000z-gggggg", { mode: "real", maxBudgetUsd: 0 }), deps), /presupuesto/);
  await assert.rejects(startEvaluation(input("ms-20261123t180000z-hhhhhh", { mode: "real", maxBudgetUsd: 5 }), deps), /supera el aprobado/);
  assert.equal(calls.length, 0); assert.equal((await store.list()).length, 0);
});

test("solo se evalúa ATOMIVID: producción, Previews del proyecto y local solo con permiso explícito", () => {
  assert.equal(resolveTarget(undefined, {}).kind, "production");
  assert.equal(resolveTarget("https://atomivid-git-x-atomivid.vercel.app", {}).kind, "preview");
  assert.throws(() => resolveTarget("https://evil.example.com", {}), StartError);
  assert.throws(() => resolveTarget("http://127.0.0.1:3300", {}), StartError);
  assert.equal(resolveTarget("http://127.0.0.1:3300", { MYSTERY_SHOPPER_ALLOW_LOCAL: "1" }).kind, "local");
});

test("ids: formato estricto, sin rutas", async () => {
  assert.match(newJobId(T0, () => "a1b2c3d4"), /^ms-20261123t180000z-a1b2c3d4$/);
  const { store } = setup();
  await assert.rejects(store.evidenceUrl("../x", "a.png"));
  await assert.rejects(store.get("ms-../../etc"));
  await assert.rejects(store.putEvidence("ms-20261123t180000z-aaaaaa", "../../x.png", "x", "image/png"));
});

test("duración: un MP3 válido de 2,16 s para una misión de 10 min es FAIL funcional", () => {
  assert.equal(durationConformity(600, 2.16), "FAIL");
  assert.equal(durationConformity(600, 560), "PASS");
  assert.equal(durationConformity(30, 30.03), "PASS");
  assert.equal(durationConformity(null, 30), "NO_MEDIDO");
  const m = mediaCheck({ file: "a.mp3", container: "mp3", durationSeconds: 2.16, decodeOk: true, requestedSeconds: 600, meanVolumeDb: -20, inLibrary: true });
  assert.equal(m.technical, "PASS"); assert.equal(m.durationConformity, "FAIL"); assert.equal(m.lipSync, "NO_MEDIDO");
  const f = findingsFrom("audio-podcast", "principiante", [], [], [m]);
  assert.equal(f[0].severity, "P0");
  const v = verdictFor("audio-podcast", [{ text: "x", met: true, evidence: "" }], f, null);
  assert.equal(v.verdict, "BLOQUEADO"); assert.equal(v.score, null, "una nota alta no tapa un bloqueo");
});

test("sin misión cumplida no hay nota: NO EVALUADO; hallazgos solo de mediciones", () => {
  const v = verdictFor("reels", [{ text: "a", met: true, evidence: "" }, { text: "b", met: null, evidence: "" }], [], null);
  assert.equal(v.coverage, "PARCIAL"); assert.equal(v.verdict, "NO_EVALUADO"); assert.equal(v.score, null);
  const page: PageMetrics = { url: "https://atomivid.vercel.app/dashboard", viewport: { width: 390, height: 844 }, horizontalOverflowPx: 0, smallTargets: 0, unlabeledFields: 0, technicalTerms: [], costVisible: true, errorsVisible: [], consoleErrors: 0, loadMs: 900, httpStatus: 200 };
  assert.equal(findingsFrom("reels", "creador", [page], [], []).length, 0, "nada medido → ninguna crítica inventada");
  const over = findingsFrom("reels", "impaciente", [{ ...page, horizontalOverflowPx: 40 }], [], []);
  assert.equal(over[0].severity, "P1"); assert.ok(over[0].fact && over[0].interpretation && over[0].recommendation);
  const ok = verdictFor("reels", [{ text: "a", met: true, evidence: "" }], over, null);
  assert.equal(ok.verdict, "CON_PROBLEMAS"); assert.equal(ok.score, 88);
});

test("la API ya no usa recorridos grabados para el botón, ni /tmp como historial", async () => {
  const route = await readFile("src/app/api/admin/mystery-shopper/route.ts", "utf8");
  assert.doesNotMatch(route, /handleMystery|path\.join\("\/tmp"|writeFile|recordedJourneys\(\)\.find/);
  assert.match(route, /startEvaluation/);
  assert.match(route, /requireCommandCenterAdmin/);
});

test("el worker no escribe secretos y abre un contexto nuevo", async () => {
  const w = await readFile("scripts/mystery-shopper/worker.ts", "utf8");
  assert.match(w, /browser\.newContext/); assert.match(w, /freshContext/); assert.match(w, /redact\(/);
  assert.match(w, /MYSTERY_SHOPPER_QA_PASSWORD/);
  assert.doesNotMatch(w, /password\s*[:=]\s*["'][^"']+["']/i);
  assert.match(w, /blockedbyclient/);
});

test("un hallazgo repetido en la misma pantalla cuenta una vez", () => {
  const base: PageMetrics = { url: "https://atomivid.vercel.app/dashboard/audio-studio/d8e199a9-d60d-4642-bc53-64c8b1f22f7b", viewport: { width: 390, height: 844 }, horizontalOverflowPx: 0, smallTargets: 9, unlabeledFields: 0, technicalTerms: [], costVisible: true, errorsVisible: [], consoleErrors: 0, loadMs: 900, httpStatus: 200 };
  const f = findingsFrom("audio-podcast", "impaciente", [base, { ...base, smallTargets: 8 }, { ...base, url: base.url.replace("d8e199a9", "aaaaaaaa") }], [], []);
  assert.equal(f.length, 1); assert.equal(f[0].screen, "/dashboard/audio-studio/:id");
});

test("disparo automático: apagado sin MYSTERY_SHOPPER_AUTO; activado (controlado, sin gasto) espera al CI, valida y no duplica", async () => {
  const { ciStart } = await import("./ci");
  const { store } = setup();
  let calls = 0; const states = [[{ name: "e2e", status: "in_progress", conclusion: null }], [{ name: "e2e", status: "completed", conclusion: "success" }, { name: "automatico", status: "in_progress", conclusion: null }]];
  const fetchImpl = (async () => { const runs = states[Math.min(calls++, states.length - 1)]; return new Response(JSON.stringify({ check_runs: runs }), { status: 200 }); }) as unknown as typeof fetch;
  let t = T0.getTime(); const deps = { store, fetchImpl, sleep: async (ms: number) => { t += ms; }, now: () => new Date(t), env: {} };
  const ev = { repo: "o/r", eventRepo: "o/r", state: "success", environment: "Preview", sha: "a".repeat(40), url: "https://atomivid-abc123-atomivid.vercel.app", githubToken: "x" };
  const off = await ciStart({ ...ev }, deps);
  assert.equal(off.accepted, false); assert.match(off.reason, /MYSTERY_SHOPPER_AUTO/); assert.equal(calls, 0); assert.equal((await store.list()).length, 0);
  const on = await ciStart({ ...ev, autoFlag: "1" }, deps);
  assert.equal(on.accepted, true, on.reason); assert.equal(calls, 2, "esperó a que el CI terminara");
  assert.deepEqual(on.created.sort(), on.jobs.sort()); assert.equal(on.jobs.length, 3);
  const again = await ciStart({ ...ev, autoFlag: "1" }, deps);
  assert.equal(again.created.length, 0, "el mismo evento no crea trabajos nuevos"); assert.equal((await store.list()).length, 3);
  for (const bad of [{ eventRepo: "x/y" }, { environment: "Production" }, { url: "https://evil.example.com" }, { sha: "123" }, { state: "failure" }]) {
    const r = await ciStart({ ...ev, autoFlag: "1", ...bad }, deps); assert.equal(r.accepted, false, JSON.stringify(bad));
  }
  calls = 0; states.splice(0, states.length, [{ name: "e2e", status: "completed", conclusion: "failure" }]);
  const red = await ciStart({ ...ev, sha: "b".repeat(40), autoFlag: "1" }, deps);
  assert.equal(red.accepted, false); assert.match(red.reason, /CI con fallos: e2e/); assert.equal((await store.list()).length, 3);
});
