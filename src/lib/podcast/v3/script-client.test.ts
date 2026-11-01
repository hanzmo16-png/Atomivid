/**
 * Incidente 2026-11-01 (tras «Empezar de nuevo»: guion vacío, «No se pudo conectar con el servidor» y «Continuar
 * (bloque 1 de 3)»). Regresiones del cliente del guion por bloques (USD 0, sin red): errores distinguidos, reintentos
 * idempotentes con el mismo estado, paso en curso, cancelación sin escrituras tardías y, de punta a punta contra la ruta
 * real en memoria, que perder una respuesta no cobra dos veces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScriptGeneration, type ScriptAsk, type ScriptClientDeps } from "./script-client";
import { studioAction, type ApiDeps } from "./api";
import { segmentCount, type LlmStepFn } from "./long-script";

const ask: ScriptAsk = { topic: "BASE DULCE: LOS SIETE NIVELES DEL HORROR", minutes: 30, hostName: "Valeria Moncler", guestName: "El Duro Hans" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Sent = { state: unknown };
function deps(responses: ((sent: Sent, init?: RequestInit) => Response | Promise<Response>)[], over: Partial<ScriptClientDeps> = {}) {
  const sent: Sent[] = [], states: unknown[] = [], progress: unknown[] = [], sleeps: number[] = [];
  let i = 0;
  const d: ScriptClientDeps = {
    fetchImpl: (async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); sent.push({ state: body.state }); const f = responses[Math.min(i++, responses.length - 1)]; return f({ state: body.state }, init); }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); }, onState: (s) => states.push(s), onProgress: (p) => progress.push(p), ...over,
  };
  return { d, sent, states, progress, sleeps };
}
const S1 = { v: 1, jobId: "j", plan: { segments: [1, 2, 3] }, segments: [] };
const S2 = { ...S1, segments: [["b1"]] };
const step = (state: unknown, n: number) => () => json(200, { state, step: n, steps: 4, phase: "bloque", done: false });
const done = () => json(200, { state: S2, step: 4, steps: 4, done: true, script: "Valeria Moncler: Hola.\nEl Duro Hans: Hola.", estimatedMinutes: 29.6, withinTarget: true, note: "ok" });
const netDown = () => { throw new TypeError("Failed to fetch"); };

test("red caída a mitad: reintenta con el MISMO estado (no empieza de cero) y termina", async () => {
  const t = deps([step(S1, 1), netDown, step(S2, 2), done]);
  const r = await runScriptGeneration(ask, null, t.d);
  assert.equal(r.kind, "done");
  assert.deepEqual(t.sent.map((x) => x.state), [null, S1, S1, S2], "el reintento reenvía S1, no null");
  assert.deepEqual(t.sleeps, [5000]);
});

test("red caída persistente: error «red» recuperable, con el bloque donde quedó; nunca «sin internet» genérico", async () => {
  const t = deps([step(S1, 1), netDown]);
  const r = await runScriptGeneration(ask, null, t.d);
  assert.equal(r.kind, "error");
  if (r.kind !== "error") return;
  assert.equal(r.reason, "red"); assert.equal(r.recoverable, true);
  assert.match(r.message, /Se interrumpió la conexión con el servidor/); assert.match(r.message, /bloque 1 de 3/); assert.match(r.message, /no se cobrará dos veces/);
  assert.deepEqual(t.states.at(-1), S1, "el progreso guardado no se borra");
});

test("tiempo agotado: se distingue de la red y no pierde progreso", async () => {
  const hang = (_s: Sent, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const t = deps([step(S1, 1), hang, hang, hang], { timeoutMs: 20 });
  const r = await runScriptGeneration(ask, null, t.d);
  assert.equal(r.kind === "error" && r.reason, "tiempo");
  assert.match(r.kind === "error" ? r.message : "", /tardó demasiado/);
  assert.deepEqual(t.states.at(-1), S1);
});

test("HTTP 500 y 504 sin JSON (tiempo límite de la plataforma): transitorios, mismo estado; un 500 persistente se informa con su código", async () => {
  const html = () => new Response("<html>FUNCTION_INVOCATION_TIMEOUT</html>", { status: 504 });
  const t = deps([step(S1, 1), () => json(500, { error: "Internal" }), html, step(S2, 2), done]);
  assert.equal((await runScriptGeneration(ask, null, t.d)).kind, "done");
  assert.deepEqual(t.sent.map((x) => x.state), [null, S1, S1, S1, S2]);
  const u = deps([() => json(500, { error: "Internal" })]);
  const r = await runScriptGeneration(ask, null, u.d);
  assert.equal(r.kind === "error" && r.reason, "http"); assert.equal(r.kind === "error" && r.status, 500); assert.match(r.kind === "error" ? r.message : "", /\(500\)/);
});

test("paso todavía ejecutándose (409 in-flight): espera y consulta de nuevo con el mismo estado; no lo duplica", async () => {
  const inflight = () => json(409, { error: "Ese paso ya se está generando", code: "IA_FALLO", detail: "in-flight", recoverable: true, state: S1 });
  const t = deps([step(S1, 1), inflight, inflight, step(S2, 2), done]);
  assert.equal((await runScriptGeneration(ask, null, t.d)).kind, "done");
  assert.deepEqual(t.sleeps, [20000, 20000]);
  assert.ok(t.progress.some((p) => /sigue generándose/.test(String((p as { waiting?: string })?.waiting))));
});

test("sesión expirada (401): mensaje de sesión, progreso intacto", async () => {
  const t = deps([step(S1, 1), () => json(401, { error: "No autenticado" })]);
  const r = await runScriptGeneration(ask, null, t.d);
  assert.equal(r.kind === "error" && r.reason, "sesion"); assert.deepEqual(t.states.at(-1), S1);
});

test("proveedor no disponible: error explícito, sin plantilla; control de gasto y límite diario → «presupuesto»", async () => {
  const off = deps([() => json(503, { error: "La generación con IA no está disponible…", code: "IA_NO_DISPONIBLE" })]);
  const r = await runScriptGeneration(ask, null, off.d);
  assert.equal(r.kind === "error" && r.reason, "proveedor"); assert.equal(r.kind === "error" && r.recoverable, false);
  const sup = deps([() => json(503, { error: "La IA no pudo empezar: …", code: "IA_FALLO", detail: "supply:concurrency", recoverable: true, state: S1 })]);
  assert.equal((await runScriptGeneration(ask, null, sup.d) as { reason?: string }).reason, "presupuesto");
  const cap = deps([() => json(429, { error: "Alcanzaste el límite diario…", code: "LIMITE_DIARIO", recoverable: true, state: S1 })]);
  assert.equal((await runScriptGeneration(ask, null, cap.d) as { reason?: string }).reason, "presupuesto");
});

test("respuesta inválida del modelo: un reintento automático; si vuelve a fallar, error de validación recuperable", async () => {
  const invalid = () => json(422, { error: "El bloque 2 de 3 no cumplió…", code: "INVALIDO", recoverable: true, state: S1 });
  const t = deps([step(S1, 1), invalid, step(S2, 2), done]);
  assert.equal((await runScriptGeneration(ask, null, t.d)).kind, "done");
  const u = deps([invalid, invalid]);
  const r = await runScriptGeneration(ask, null, u.d);
  assert.equal(r.kind === "error" && r.reason, "validacion"); assert.equal(u.sent.length, 2);
});

test("QA P1-3: reconciliación (llamada sin confirmar): NO se borra el trabajo (único ancla de lo pagado); error recuperable", async () => {
  const t = deps([() => json(409, { error: "Una llamada de este guion quedó sin confirmar…", code: "IA_FALLO", detail: "reconciliation", recoverable: true, state: S2 })]);
  const r = await runScriptGeneration(ask, S2, t.d);
  assert.equal(r.kind === "error" && r.reason, "reconciliacion"); assert.equal(r.kind === "error" && r.recoverable, true);
  assert.ok(!t.states.includes(null), "el scriptJob no se anula"); assert.deepEqual(t.states.at(-1), S2);
});

test("no recuperable (agotado): el trabajo guardado se descarta (onState null) para empezar limpio", async () => {
  const t = deps([() => json(409, { error: "…tras 3 intentos…", code: "AGOTADO", recoverable: false, state: S1 })]);
  const r = await runScriptGeneration(ask, S1, t.d);
  assert.equal(r.kind === "error" && r.recoverable, false); assert.equal(t.states.at(-1), null);
});

test("«Empezar de nuevo» durante una generación: tras cancelar no se escribe NINGÚN estado ni progreso tardío", async () => {
  const ctl = new AbortController();
  let release!: () => void;
  const slow = (_s: Sent, init?: RequestInit) => new Promise<Response>((res, rej) => { release = () => res(step(S1, 1)()); init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
  const t = deps([slow, step(S2, 2)], { signal: ctl.signal });
  const p = runScriptGeneration(ask, null, t.d);
  await new Promise((r) => setTimeout(r, 5));
  ctl.abort(); release();
  const r = await p;
  assert.equal(r.kind === "error" && r.reason, "cancelado");
  assert.deepEqual(t.states, [], "ningún estado del trabajo viejo llega al borrador nuevo");
  assert.deepEqual(t.progress, []);
});

test("terminado sin guion: «incompleta», no se presenta como completado", async () => {
  const t = deps([() => json(200, { state: S2, step: 4, steps: 4, done: true, script: "" })]);
  const r = await runScriptGeneration(ask, S1, t.d);
  assert.equal(r.kind === "error" && r.reason, "incompleta");
});

// ---- De punta a punta contra la ruta real (studioAction) con un «libro» que cobra una vez por clave ----
test("integración: la respuesta del bloque 2 se pierde por la red; el reintento reutiliza lo pagado (cero cargos duplicados)", async () => {
  const paid = new Map<string, string>();
  let paidCalls = 0;
  const VOC = "el la de que los base nivel radar túnel señal fuente rumor dato mapa caso relato".split(" ");
  let u = 0;
  const model = (prompt: string, stepKey: string) => {
    if (stepKey.startsWith("plan")) return JSON.stringify({ titulo: "Base Dulce", bloques: Array.from({ length: segmentCount(30) }, (_, j) => ({ titulo: `B${j + 1}`, puntos: ["a", "b"] })) });
    const words = Number(/entre (\d+) y/.exec(prompt)![1]);
    const lines: string[] = [];
    for (let left = words, i = 0; left > 0; i++) { const n = Math.min(38, left); u++; lines.push(`${i % 2 ? "El Duro Hans" : "Valeria Moncler"}: ${Array.from({ length: n }, (_, j) => j === 0 ? `Dato${u}` : VOC[(u + j * 5) % VOC.length]).join(" ")}.`); left -= n; }
    if (stepKey.startsWith("s2")) lines.push("El Duro Hans: Gracias por escucharnos, hasta la próxima.");
    return lines.join("\n");
  };
  // Igual que el libro de gastos: la clave es trabajo + paso + parámetros; si ya se pagó, se devuelve sin cobrar.
  const llmStep = (jobId: string): LlmStepFn => async (prompt, o) => {
    const key = `${jobId}:${o.step}:${prompt.length}:${prompt.slice(-200)}`;
    if (!paid.has(key)) { paidCalls++; paid.set(key, model(prompt, o.step)); }
    return paid.get(key)!;
  };
  const api: ApiDeps = { userId: "u1", viewer: { id: "u1", email: "h@example.com", email_confirmed_at: "x" }, voices: async () => [], enabled: true, llm: null, llmStep, newJobId: () => "0f0e0d0c-0b0a-4908-8706-050403020100", env: {},
    insert: async () => null, load: async () => null, authorize: async () => false, dispatch: async () => false };
  let n = 0;
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const out = await studioAction(api, JSON.parse(String(init?.body)));
    n++;
    if (n === 3) throw new TypeError("Failed to fetch"); // el servidor terminó el bloque 2, pero la respuesta no llegó
    return json(out.status, out.body);
  }) as typeof fetch;
  const states: unknown[] = [];
  const r = await runScriptGeneration({ ...ask, topic: "BASE DULCE: LOS SIETE NIVELES DEL HORROR y Paul Bennewitz" }, null, { fetchImpl, sleep: async () => {}, onState: (s) => states.push(s), onProgress: () => {} });
  assert.equal(r.kind, "done");
  assert.equal(paidCalls, 4, "escaleta + 3 bloques: el bloque repetido tras la caída NO se cobró de nuevo");
  assert.equal(paid.size, 4);
  if (r.kind === "done") { assert.ok(r.estimatedMinutes >= 27 && r.estimatedMinutes <= 33, String(r.estimatedMinutes)); assert.equal(r.withinTarget, true); }
  assert.equal(states.at(-1), null, "al terminar, el trabajo en curso se cierra en el borrador");
});
