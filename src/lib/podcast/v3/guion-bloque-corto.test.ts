/**
 * Incidente 2026-11-01, «BASE DULCE» 30 min: «El bloque 1 de 3 no cumplió los requisitos (corto: 6577 de 7852
 * caracteres)». Regresiones del motor por bloques (USD 0, modelo SIMULADO; no sustituyen la prueba con el modelo real):
 *  - un modelo que cumple lo pedido en PALABRAS ya no queda por debajo del mínimo en caracteres;
 *  - un bloque corto se compensa con los siguientes o se AMPLÍA sin repetir lo escrito (nunca se rechaza todo);
 *  - una respuesta truncada pierde solo su turno a medias;
 *  - un fallo a mitad conserva lo hecho y reintenta por la misma clave; las ampliaciones están acotadas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceLongScript, assembleLongScript, blockTarget, checkLongState, CHARS_PER_SPOKEN_WORD, MAX_EXTENSIONS_PER_BLOCK, newLongScript, segmentChars,
  segmentCount, type LlmStepFn, type LlmStepOut, type LongInput, type LongScriptState,
} from "./long-script";
import { targetChars } from "./script";
import { studioAction, type ApiDeps } from "./api";

const JOB = "0f0e0d0c-0b0a-4908-8706-050403020100";
const TOPIC = "BASE DULCE: LOS SIETE NIVELES DEL HORROR. Conversación de 30 minutos entre Valeria Moncler y El Duro Hans. Explorar Thomas Castello, Phil Schneider, los supuestos siete niveles subterráneos, la batalla de 1979 y Paul Bennewitz.";
const input = (minutes = 30): LongInput => ({ topic: TOPIC, minutes, hostName: "Valeria Moncler", guestName: "El Duro Hans", hostPersonality: "curiosa", guestPersonality: "escéptico" });
const A = "Valeria Moncler", B = "El Duro Hans";

// Vocabulario variado: palabras de ~4,3 letras + espacio ≈ 5,3 caracteres por palabra, como el español conversacional.
const VOCAB = "el la de que los una base nivel radar túnel señal fuente rumor dato mapa caso relato agua roca luz eco".split(" ");
let uniq = 0;
/** Un turno de `words` palabras únicas (nunca repetido), con puntuación final. */
function turn(words: number): string {
  uniq++;
  const w = Array.from({ length: words }, (_, j) => VOCAB[(uniq * 13 + j * 7) % VOCAB.length]);
  w[0] = `Dato${uniq}`; w[Math.floor(words / 2)] = `caso${uniq}`;
  return w.join(" ") + ".";
}
/** Diálogo alternado hasta `words` palabras habladas (turnos de ~38 palabras). */
function dialogue(words: number, o: { greet?: boolean; farewell?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (let left = words, i = 0; left > 0; i++) { const n = Math.min(38, Math.max(6, left)); lines.push(`${i % 2 === 0 ? A : B}: ${turn(n)}`); left -= n; }
  if (o.greet) lines[0] = `${A}: Bienvenidos a este episodio. ${lines[0].slice(A.length + 2)}`;
  if (o.farewell) lines.push(`${B}: Gracias por escucharnos, hasta la próxima.`);
  return lines;
}
const askedWords = (prompt: string) => Number(/entre (\d+) y \d+ palabras/.exec(prompt)?.[1] ?? 0);
const PLAN = (n: number) => JSON.stringify({ titulo: "Base Dulce", bloques: Array.from({ length: n }, (_, j) => ({ titulo: `Bloque ${j + 1}`, puntos: ["a", "b", "c"] })) });

type Call = { step: string; prompt: string };
/**
 * Modelo que CUMPLE en palabras el mínimo que se le pide (lo que hizo el real el 1-nov). `override` fuerza la respuesta
 * de un paso concreto (corta, truncada, inválida o un error del proveedor).
 */
function compliantModel(minutes: number, override: Record<string, (prompt: string) => LlmStepOut | Promise<LlmStepOut>> = {}) {
  const calls: Call[] = [];
  const llm: LlmStepFn = async (prompt, o) => {
    calls.push({ step: o.step, prompt });
    if (override[o.step]) return override[o.step](prompt);
    if (o.step.startsWith("plan")) return PLAN(segmentCount(minutes));
    const k = Number(/^s(\d+)/.exec(o.step)![1]), n = segmentCount(minutes);
    const ext = /-x\d+$/.test(o.step);
    return dialogue(askedWords(prompt), { greet: k === 0 && !ext, farewell: k === n - 1 && !ext }).join("\n");
  };
  return { llm, calls };
}
async function runAll(s: LongScriptState, llm: LlmStepFn, max = 30) {
  const phases: string[] = [];
  for (let i = 0; i < max; i++) { const r = await advanceLongScript(s, llm); s = r.state; phases.push(r.phase); if (r.done) return { s, phases }; }
  throw new Error("no terminó");
}

test("causa raíz: con chars/6 el mínimo pedido daba 6.577 de 7.852 (fallaba); con 5,3 car./palabra el bloque cumple", async () => {
  const base = segmentChars(30);
  assert.equal(base, 7852, "el objetivo del incidente");
  const oldMinWords = Math.round((base / 6) * 0.95);
  assert.equal(oldMinWords, 1243);
  assert.ok(Math.abs(oldMinWords * 5.29 - 6577) < 5, "1.243 palabras × 5,29 = los 6.577 caracteres observados");
  assert.ok(6577 < base * 0.85, "y eso quedaba bajo el 85 %: rechazo de un modelo que cumplió");
  // Ahora: el prompt pide palabras a 5,3 car./palabra y el mismo modelo «cumplidor» llega al objetivo.
  const m = compliantModel(30);
  let s = newLongScript(JOB, input());
  s = (await advanceLongScript(s, m.llm)).state; // escaleta
  const r = await advanceLongScript(s, m.llm);   // bloque 1
  assert.equal(askedWords(m.calls[1].prompt), Math.round(base / CHARS_PER_SPOKEN_WORD));
  assert.equal(r.phase, "bloque"); assert.equal(r.state.segments.length, 1, "aceptado al primer intento");
  const chars = r.state.segments[0].reduce((n, t) => n + t.text.length, 0);
  assert.ok(chars >= base * 0.85, `${chars} de ${base}`);
});

test("BASE DULCE 30 min, modelo que cumple: escaleta + 3 bloques, 4 llamadas, 27–33 min, sin ampliaciones", async () => {
  const m = compliantModel(30);
  const { s, phases } = await runAll(newLongScript(JOB, input()), m.llm);
  assert.deepEqual(m.calls.map((c) => c.step), ["plan-a1", "s0-a1", "s1-a1", "s2-a1"]);
  assert.ok(!phases.includes("ampliando"));
  const out = assembleLongScript(s);
  assert.ok(out.estimatedMinutes >= 27 && out.estimatedMinutes <= 33, String(out.estimatedMinutes));
});

test("reproducción exacta: bloque 1 de 6.577 caracteres → se acepta y los bloques 2–3 lo compensan (sin rechazo ni relleno)", async () => {
  const words6577 = Math.round(6577 / 5.29);
  const m = compliantModel(30, { "s0-a1": () => dialogue(words6577, { greet: true }).join("\n") });
  let s = newLongScript(JOB, input());
  s = (await advanceLongScript(s, m.llm)).state;
  const r1 = await advanceLongScript(s, m.llm);
  assert.equal(r1.phase, "bloque"); assert.equal(r1.state.segments.length, 1); assert.match(r1.note ?? "", /los siguientes lo compensan/);
  const b1 = r1.state.segments[0].reduce((n, t) => n + t.text.length, 0);
  assert.ok(b1 < 7852 * 0.85 && b1 > 6000, `bloque 1 = ${b1}`);
  assert.ok(blockTarget(r1.state, 1) > segmentChars(30), "el bloque 2 se pide más largo para compensar");
  const { s: end, phases } = await runAll(r1.state, m.llm);
  assert.ok(!phases.includes("ampliando"));
  const out = assembleLongScript(end);
  assert.ok(out.estimatedMinutes >= 27 && out.estimatedMinutes <= 33, `total ${out.estimatedMinutes}`);
  assert.equal(new Set(out.turns.map((t) => t.text)).size, out.turns.length, "ningún turno repetido");
});

test("último bloque corto → se AMPLÍA antes de la despedida (clave s2-a1-x1), sin repetir y dentro de 27–33 min", async () => {
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n") });
  const { s, phases } = await runAll(newLongScript(JOB, input()), m.llm);
  assert.ok(phases.includes("ampliando"));
  assert.ok(m.calls.some((c) => c.step === "s2-a1-x1"), m.calls.map((c) => c.step).join(","));
  const ext = m.calls.find((c) => c.step === "s2-a1-x1")!;
  assert.match(ext.prompt, /NO copies ni parafrasees ninguna de estas líneas/); assert.match(ext.prompt, /Después de lo que escribas vendrá este cierre, que NO debes escribir/);
  const last = s.segments[2];
  assert.match(last.at(-1)!.text, /hasta la próxima/, "la despedida sigue al final");
  assert.equal(last.filter((t) => /hasta la próxima/.test(t.text)).length, 1);
  const out = assembleLongScript(s);
  assert.ok(out.estimatedMinutes >= 27 && out.estimatedMinutes <= 33, String(out.estimatedMinutes));
  assert.equal(new Set(out.turns.map((t) => t.text)).size, out.turns.length);
});

test("respuesta truncada (stop_reason max_tokens, frase a medias): se descarta solo el turno cortado y se completa", async () => {
  const cut = () => ({ text: [...dialogue(500), `${A}: Y entonces el informe de 1979 dice que el túnel del nivel sie`].join("\n"), stopReason: "max_tokens" });
  const m = compliantModel(30, { "s1-a1": cut });
  const { s } = await runAll(newLongScript(JOB, input()), m.llm);
  assert.ok(!s.segments.flat().some((t) => /nivel sie$/.test(t.text)), "el turno a medias no entra al guion");
  assert.ok(m.calls.some((c) => c.step === "s1-a1-x1"), "el bloque truncado se amplía");
  const out = assembleLongScript(s);
  assert.ok(out.estimatedMinutes >= 27 && out.estimatedMinutes <= 33, String(out.estimatedMinutes));
});

test("también sin stop_reason: una última línea sin puntuación final se trata como truncada", async () => {
  const m = compliantModel(30, { "s0-a1": () => [...dialogue(1400, { greet: true }), `${B}: y lo que nadie dice es que la`].join("\n") });
  let s = newLongScript(JOB, input());
  s = (await advanceLongScript(s, m.llm)).state;
  const r = await advanceLongScript(s, m.llm);
  assert.ok(!r.state.segments[0].some((t) => /nadie dice es que la$/.test(t.text)));
});

test("ampliaciones acotadas: si la ampliación no sirve dos veces, se conserva lo escrito (sin bucle ni más llamadas)", async () => {
  const bad = () => `${A}: Bienvenidos otra vez, hola a todos.\n${B}: Gracias por escucharnos, hasta la próxima.`;
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n"), "s2-a1-x1": bad, "s2-a1-x2": bad });
  let s = newLongScript(JOB, input());
  for (let i = 0; i < 3; i++) s = (await advanceLongScript(s, m.llm)).state; // escaleta + bloques 1 y 2
  let r = await advanceLongScript(s, m.llm); // bloque 3 corto → ampliar
  assert.equal(r.phase, "ampliando"); s = r.state;
  const e1 = await advanceLongScript(s, m.llm).catch((e) => e);
  assert.equal(e1.code, "INVALIDO"); assert.equal(e1.recoverable, true); assert.equal(e1.state.partial.ext, 1, "se gastó una ampliación; lo escrito sigue");
  r = await advanceLongScript(e1.state, m.llm);
  assert.equal(r.done, true, "tras la segunda ampliación inválida se conserva lo escrito");
  assert.match(r.note ?? "", /se conservó lo escrito/);
  assert.equal(m.calls.filter((c) => /-x\d$/.test(c.step)).length, MAX_EXTENSIONS_PER_BLOCK);
  const out = assembleLongScript(r.state);
  assert.equal(out.withinTarget, false, "más corto que lo pedido: se informa, no se disfraza");
});

test("fallo del proveedor durante una ampliación: el bloque parcial se conserva y el reintento usa la MISMA clave", async () => {
  const boom = Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:concurrency"), { name: "SupplyUnavailableError" });
  let fail = true;
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n"), "s2-a1-x1": (p) => { if (fail) { fail = false; throw boom; } return dialogue(askedWords(p)).join("\n"); } });
  let s = newLongScript(JOB, input());
  for (let i = 0; i < 4; i++) s = (await advanceLongScript(s, m.llm)).state; // … bloque 3 corto → partial
  assert.equal(s.partial?.k, 2);
  const before = JSON.stringify(s);
  await assert.rejects(advanceLongScript(s, m.llm), /SUPPLY_UNAVAILABLE/);
  assert.equal(JSON.stringify(s), before, "nada se pierde");
  const r = await advanceLongScript(s, m.llm);
  assert.deepEqual(m.calls.filter((c) => c.step === "s2-a1-x1").length, 2, "mismo paso, misma clave (el libro reutiliza si ya se pagó)");
  assert.equal(r.done, true);
});

test("fallo en el bloque 2 de 3: el bloque 1 se conserva intacto", async () => {
  const boom = Object.assign(new Error("Anthropic 500"), { status: 500 });
  const m = compliantModel(30, { "s1-a1": () => { throw boom; } });
  let s = newLongScript(JOB, input());
  for (let i = 0; i < 2; i++) s = (await advanceLongScript(s, m.llm)).state;
  const b1 = JSON.stringify(s.segments[0]);
  await assert.rejects(advanceLongScript(s, m.llm));
  assert.equal(JSON.stringify(s.segments[0]), b1); assert.equal(s.segments.length, 1);
});

test("estado del navegador con bloque en ampliación: se valida (k, intento, ampliaciones) y se rechaza manipulado", async () => {
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n") });
  let s = newLongScript(JOB, input());
  for (let i = 0; i < 4; i++) s = (await advanceLongScript(s, m.llm)).state;
  assert.ok(s.partial);
  assert.deepEqual(checkLongState(JSON.parse(JSON.stringify(s)), input()), s);
  for (const bad of [{ ...s, partial: { ...s.partial!, k: 0 } }, { ...s, partial: { ...s.partial!, ext: 9 } }, { ...s, partial: { ...s.partial!, ext: MAX_EXTENSIONS_PER_BLOCK + 1 } },
    { ...s, partial: { ...s.partial!, attempt: 0 } }, { ...s, partial: { ...s.partial!, attempt: 2 } }, { ...s, partial: { ...s.partial!, turns: [{ speaker: "C", text: "x" }] } }]) {
    assert.throws(() => checkLongState(bad, input()), /no es válido/);
  }
});

test("45 y 60 min con un modelo que cumple: completos, en rango y sin ampliaciones", async () => {
  for (const minutes of [45, 60]) {
    const m = compliantModel(minutes);
    const { s, phases } = await runAll(newLongScript(JOB, input(minutes)), m.llm);
    assert.ok(!phases.includes("ampliando"), String(minutes));
    const out = assembleLongScript(s);
    assert.ok(out.withinTarget, `${minutes} → ${out.estimatedMinutes}`);
    assert.ok(out.turns.reduce((n, t) => n + t.text.length, 0) >= targetChars(minutes) * 0.9);
  }
});

test("QA P1-1: un estado con las ampliaciones agotadas (ext = 2) no paga una tercera: se cierra sin llamar al modelo", async () => {
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n") });
  let s = newLongScript(JOB, input());
  for (let i = 0; i < 4; i++) s = (await advanceLongScript(s, m.llm)).state;
  assert.equal(s.partial?.ext, 0);
  const atCap = { ...s, partial: { ...s.partial!, ext: MAX_EXTENSIONS_PER_BLOCK } };
  assert.equal(checkLongState(atCap, input()).partial?.ext, MAX_EXTENSIONS_PER_BLOCK, "ext = 2 se admite (no se pierde el ancla)");
  const before = m.calls.length;
  const r = await advanceLongScript(atCap, m.llm);
  assert.equal(m.calls.length, before, "cero llamadas");
  assert.ok(!m.calls.some((c) => /-x3$/.test(c.step)));
  assert.equal(r.done, true); assert.match(r.note ?? "", /se conservó lo escrito/);
  assert.equal(r.state.jobId, JOB, "mismo trabajo");
});

// Ruta real (/api/podcast/v3, «script-step») con dependencias simuladas: lo que recibe el navegador.
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const routeDeps = (llmStep: ApiDeps["llmStep"]): ApiDeps => ({ userId: "u1", viewer, voices: async () => [], enabled: true, llm: null, llmStep, newJobId: () => "11111111-2222-4333-8444-555555555555", env: {},
  insert: async () => null, load: async () => null, authorize: async () => false, dispatch: async () => false });
const stepBody = (state: unknown) => ({ action: "script-step", topic: TOPIC, minutes: 30, hostName: A, guestName: B, hostPersonality: "curiosa", guestPersonality: "escéptico", state });

test("QA P1-1 por HTTP: ext = 2 cierra el bloque con el MISMO jobId y cero llamadas; ext = 3 o un intento distinto se rechazan sin llamar", async () => {
  const m = compliantModel(30, { "s2-a1": () => dialogue(600, { farewell: true }).join("\n") });
  const d = routeDeps(() => m.llm);
  let st: unknown = null;
  for (let i = 0; i < 4; i++) { const r = await studioAction(d, stepBody(st)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200)); st = r.body.state; }
  const s = st as LongScriptState;
  assert.equal(s.partial?.ext, 0);
  const job = s.jobId, before = m.calls.length;
  // Tope alcanzado (p. ej. guardado por una versión anterior): se cierra con lo escrito, sin «-x3» y sin jobId nuevo.
  const ok = await studioAction(d, stepBody({ ...s, partial: { ...s.partial!, ext: MAX_EXTENSIONS_PER_BLOCK } }));
  assert.equal(ok.status, 200); assert.equal(ok.body.done, true);
  assert.equal(m.calls.length, before, "cero llamadas pagadas"); assert.ok(!m.calls.some((c) => /-x3$/.test(c.step)));
  // Estados manipulados: ESTADO, sin llamar al modelo (el cliente conserva el ancla: script-client.test.ts).
  for (const bad of [{ ...s, partial: { ...s.partial!, ext: MAX_EXTENSIONS_PER_BLOCK + 1 } }, { ...s, partial: { ...s.partial!, attempt: 2 } }]) {
    const r = await studioAction(d, stepBody(bad));
    assert.equal(r.status, 400); assert.equal(r.body.code, "ESTADO"); assert.equal(r.body.recoverable, false);
  }
  assert.equal(m.calls.length, before, "tampoco al rechazar");
  // Recarga: el mismo estado reenviado mantiene el jobId y las claves (nada nuevo que pagar).
  assert.equal((ok.body.state as LongScriptState | null)?.jobId ?? job, job);
});
test("defecto 4 por HTTP: un estado de OTRA configuración (nombre cambiado) no acuña otro jobId ni llama al modelo; state null sí empieza otro", async () => {
  const m = compliantModel(30);
  const d = routeDeps(() => m.llm);
  const r1 = await studioAction(d, stepBody(null));
  const s = r1.body.state as LongScriptState; const before = m.calls.length;
  const renamed = { ...stepBody(s), hostName: "Valeria M." };
  const r = await studioAction(d, renamed);
  assert.equal(r.status, 409); assert.equal(r.body.code, "OTRO_TRABAJO"); assert.equal(r.body.recoverable, true);
  assert.equal(r.body.state, undefined, "no devuelve un trabajo nuevo que sustituya al guardado");
  assert.equal(m.calls.length, before, "cero llamadas");
  const again = await studioAction(d, stepBody(s));
  assert.equal(again.status, 200); assert.equal((again.body.state as LongScriptState).jobId, s.jobId, "con la configuración original continúa el MISMO jobId");
  const fresh = await studioAction(d, { ...renamed, state: null });
  assert.equal(fresh.status, 200, "empezar otro es explícito (state: null)");
});
