/**
 * Incidente 2026-11-02, «Base Dulce: los siete niveles del horror» (prueba real de Hans). Libro real (caso pod-incidente):
 *  - 44 min, trabajo 08e306d5: s1-a1 (30 turnos) repetía 5 turnos LARGOS de las 6 líneas de contexto (posiciones 22–29) y
 *    s1-a2 (28 turnos) 1 (posición 25): «El bloque 2 de 5 no cumplió los requisitos (1 turnos repetidos…)». Ambos pagados.
 *  - Cuota diaria de Anthropic: 20/20 llamadas, todas del guion largo; «reintenta en unos minutos» era falso (00:00 Cancún).
 * Modelo SIMULADO (USD 0). La prueba real con las respuestas pagadas la hace el caso pod-replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceLongScript, assembleLongScript, dropRepeatedTurns, MAX_ATTEMPTS_PER_STEP, newLongScript, segmentCount, segmentPrompt, extensionPrompt,
  type LlmStepFn, type LongInput, type LongScriptState, type StepReplayFn } from "./long-script";
import { nextLocalMidnight, nextLocalMonthStart, supplyBlockMessage } from "./supply-message";
import { describeLlmFailure, studioAction, type ApiDeps } from "./api";
import { parseLabeledScript } from "./script";

const A = "Valeria Moncler", B = "El Duro Hans";
const input = (minutes = 44): LongInput => ({ topic: "BASE DULCE: LOS SIETE NIVELES DEL HORROR", minutes, hostName: A, guestName: B, hostPersonality: "curiosa", guestPersonality: "escéptico" });
const VOCAB = "el la de que los una base nivel radar túnel señal fuente rumor dato mapa caso relato agua roca luz eco".split(" ");
let uniq = 0;
const turn = (words: number) => { uniq++; const w = Array.from({ length: words }, (_, j) => VOCAB[(uniq * 13 + j * 7) % VOCAB.length]); w[0] = `Dato${uniq}`; w[Math.floor(words / 2)] = `caso${uniq}`; return w.join(" ") + "."; };
const dialogue = (words: number, o: { greet?: boolean; farewell?: boolean } = {}) => {
  const lines: string[] = [];
  for (let left = words, i = 0; left > 0; i++) { const n = Math.min(38, Math.max(6, left)); lines.push(`${i % 2 === 0 ? A : B}: ${turn(n)}`); left -= n; }
  if (o.greet) lines[0] = `${A}: Bienvenidos a este episodio. ${lines[0].slice(A.length + 2)}`;
  if (o.farewell) lines.push(`${B}: Gracias por escucharnos, hasta la próxima.`);
  return lines;
};
const askedWords = (prompt: string) => Number(/entre (\d+) y \d+ palabras/.exec(prompt)?.[1] ?? 0);
const PLAN = (n: number) => JSON.stringify({ titulo: "Base Dulce", bloques: Array.from({ length: n }, (_, j) => ({ titulo: `Bloque ${j + 1}`, puntos: ["a", "b", "c"] })) });
const lastLines = (s: LongScriptState, n: number) => s.segments.flat().slice(-n).map((t) => `${t.speaker === "A" ? A : B}: ${t.text}`);

/** Modelo real del incidente: el bloque k>0 cumple en palabras pero, al final, vuelve a copiar líneas del contexto. */
function echoingModel(minutes: number, copies = 5) {
  const calls: string[] = [];
  let state: LongScriptState | null = null;
  const llm: LlmStepFn = async (prompt, o) => {
    calls.push(o.step);
    if (o.step.startsWith("plan")) return PLAN(segmentCount(minutes));
    const k = Number(/^s(\d+)/.exec(o.step)![1]), n = segmentCount(minutes);
    const lines = dialogue(askedWords(prompt), { greet: k === 0, farewell: k === n - 1 && !/-x/.test(o.step) });
    if (k > 0 && state) { const echo = lastLines(state, 6).slice(0, copies); lines.splice(Math.max(1, lines.length - 8), 0, ...echo); }
    return lines.join("\n");
  };
  return { llm, calls, track: (s: LongScriptState) => { state = s; } };
}

test("causa raíz reproducida: el bloque que copia líneas del contexto ya NO se rechaza; los turnos repetidos no entran al guion", async () => {
  const m = echoingModel(44, 5);
  let s = newLongScript("0f0e0d0c-0b0a-4908-8706-050403020100", input(44));
  for (let i = 0; i < 40; i++) {
    m.track(s);
    const r = await advanceLongScript(s, m.llm);
    s = r.state; if (r.done) break;
  }
  assert.equal(s.segments.length, segmentCount(44), "los 5 bloques quedaron escritos");
  assert.ok(!m.calls.some((c) => /-a2$/.test(c)), `ningún bloque necesitó otro intento pagado: ${m.calls.join(",")}`);
  const all = s.segments.flat().map((t) => t.text);
  assert.equal(new Set(all.filter((t) => t.length >= 40)).size, all.filter((t) => t.length >= 40).length, "ningún turno largo repetido en el guion");
  const out = assembleLongScript(s);
  assert.ok(out.estimatedMinutes > 35, `duración razonable: ${out.estimatedMinutes}`);
});

test("dropRepeatedTurns: quita repetidos de lo ya escrito y dentro del bloque; respeta réplicas breves", () => {
  const s = newLongScript("0f0e0d0c-0b0a-4908-8706-050403020100", input(30));
  const long = "Esta frase es suficientemente larga para contar como un turno real repetido.";
  s.segments = [[{ speaker: "A", text: long }, { speaker: "B", text: "Sí." }]];
  const r = dropRepeatedTurns([{ speaker: "B", text: long }, { speaker: "A", text: "Sí." }, { speaker: "B", text: `${long} Otra cosa nueva.` }, { speaker: "A", text: `${long} Otra cosa nueva.` }], s);
  assert.equal(r.removed, 2); assert.deepEqual(r.turns.map((t) => t.text), ["Sí.", `${long} Otra cosa nueva.`]);
});

test("el prompt ya no invita a copiar el contexto («continúa EXACTAMENTE desde aquí»)", async () => {
  const s = newLongScript("0f0e0d0c-0b0a-4908-8706-050403020100", input(30));
  s.plan = JSON.parse(PLAN(3)).bloques.map((b: { titulo: string; puntos: string[] }) => ({ title: b.titulo, points: b.puntos })) as never;
  s.plan = { title: "Base Dulce", segments: [{ title: "1", points: ["a", "b"] }, { title: "2", points: ["a", "b"] }, { title: "3", points: ["a", "b"] }] };
  s.segments = [[{ speaker: "A", text: "Hola." }, { speaker: "B", text: "Qué tal." }]];
  const p = segmentPrompt(s, 1);
  assert.doesNotMatch(p, /continúa EXACTAMENTE/); assert.match(p, /NO copies ni parafrasees/);
  assert.doesNotMatch(extensionPrompt(s, { k: 1, attempt: 1, ext: 0, turns: [{ speaker: "A", text: "Algo." }] }), /continúa EXACTAMENTE/);
});

/** Estado del incidente: bloque 1 escrito, bloque 2 con N intentos YA PAGADOS e inválidos para la regla antigua. */
async function incidentState(paidAttempts: number) {
  const m = echoingModel(44, 1);
  let s = newLongScript("08e306d5-d789-489d-89dd-f84a02541824", input(44));
  for (let i = 0; i < 2; i++) { m.track(s); s = (await advanceLongScript(s, m.llm)).state; }
  assert.equal(s.segments.length, 1);
  // Respuestas pagadas del bloque 2 que repetían 1 turno del contexto (como s1-a1/s1-a2 reales).
  const paid = new Map<string, string>();
  for (let a = 1; a <= paidAttempts; a++) { const lines = dialogue(1400); lines.splice(lines.length - 3, 0, lastLines(s, 6)[2]); paid.set(`s1-a${a}`, lines.join("\n")); }
  return { s: { ...s, attempts: { ...s.attempts, s1: paidAttempts } }, paid };
}

test("recuperación del trabajo real: intentos ya pagados del bloque 2 se reevalúan GRATIS y el trabajo continúa (0 llamadas)", async () => {
  const { s, paid } = await incidentState(2);
  const calls: string[] = [];
  const llm: LlmStepFn = async (_p, o) => { calls.push(o.step); throw new Error("no debe pagarse otra llamada"); };
  const replay: StepReplayFn = async (step) => paid.get(step) ?? null;
  const r = await advanceLongScript(s, llm, replay);
  assert.equal(calls.length, 0, "cero llamadas pagadas");
  assert.equal(r.state.segments.length, 2, "el bloque 2 queda guardado con el intento ya pagado");
  assert.match(r.note ?? "", /Se quitaron 1 turno\(s\) repetido\(s\)/);
});

test("bloque «agotado» (3 intentos pagados) se recupera gratis; si ninguno sirve, sigue AGOTADO: nunca reintentos ilimitados", async () => {
  const { s, paid } = await incidentState(MAX_ATTEMPTS_PER_STEP);
  const none: LlmStepFn = async () => { throw new Error("no debe pagarse"); };
  const ok = await advanceLongScript(s, none, async (step) => paid.get(step) ?? null);
  assert.equal(ok.state.segments.length, 2);
  // Respuestas inservibles (no es un diálogo): AGOTADO, sin llamar al modelo.
  await assert.rejects(advanceLongScript(s, none, async () => "texto sin turnos"), (e: { code?: string }) => e.code === "AGOTADO");
  await assert.rejects(advanceLongScript(s, none), (e: { code?: string }) => e.code === "AGOTADO", "sin lector de pagos: igual que antes");
});

test("sin pago previo del paso (replay null) se paga UN intento nuevo, normal", async () => {
  const { s } = await incidentState(1);
  const calls: string[] = [];
  const llm: LlmStepFn = async (p, o) => { calls.push(o.step); return dialogue(askedWords(p)).join("\n"); };
  const r = await advanceLongScript(s, llm, async () => null);
  assert.deepEqual(calls, ["s1-a2"]); assert.equal(r.state.segments.length, 2);
});

test("cuota diaria: el mensaje dice el límite real y la hora EXACTA de restablecimiento (00:00 Cancún), nunca «unos minutos»", () => {
  const now = new Date("2026-11-02T04:30:00Z"); // 23:30 del 1-nov en Cancún (UTC−5)
  assert.equal(nextLocalMidnight("America/Cancun", now).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(nextLocalMidnight("America/Cancun", new Date("2026-11-02T05:00:01Z")).toISOString(), "2026-11-03T05:00:00.000Z");
  assert.equal(nextLocalMonthStart("America/Cancun", now).toISOString(), "2026-11-01T05:00:00.000Z".replace("11-01", "12-01"));
  const m = supplyBlockMessage("daily request quota", { maxDailyCalls: 20, timezone: "America/Cancun" }, now);
  assert.match(m.error, /20 llamadas de IA/); assert.match(m.error, /00:00 hora de Cancún \(05:00 UTC, dentro de 30 min\)/);
  assert.match(m.error, /también una respuesta rechazada por calidad/); assert.doesNotMatch(m.error, /unos minutos/);
  assert.equal(m.resetAt, "2026-11-02T05:00:00.000Z");
  const c = supplyBlockMessage("concurrency", null, now);
  assert.match(c.error, /como máximo 5 minutos/); assert.equal(c.resetAt, null);
  assert.doesNotMatch(describeLlmFailure(Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:daily request quota"), { name: "SupplyUnavailableError" })).error, /unos minutos/);
});

test("tope de gasto (proveedor o global): no se sabe si es diario o mensual → sin hora inventada (resetAt null), se explican ambas", () => {
  const now = new Date("2026-11-02T04:30:00Z");
  for (const reason of ["provider funded spend ceiling", "global funded spend ceiling"]) {
    const m = supplyBlockMessage(reason, { maxDailyCalls: 20, timezone: "America/Cancun", dailyCapUsd: 20, monthlyCapUsd: 150 }, now);
    assert.equal(m.resetAt, null, reason);
    assert.match(m.error, /Puede ser el tope diario o el mensual/);
    assert.match(m.error, /Si es el diario, se restablece a las 00:00 hora de Cancún \(05:00 UTC\)/);
    assert.match(m.error, /si es el mensual, el 2026-12-01 a las 00:00 hora de Cancún/);
    assert.doesNotMatch(m.error, /dentro de/); assert.doesNotMatch(m.error, /unos minutos/);
  }
  assert.match(supplyBlockMessage("global funded spend ceiling", null, now).error, /de toda la plataforma/);
  assert.match(supplyBlockMessage("provider funded spend ceiling", null, now).error, /de este proveedor de IA/);
  // La cuota diaria de llamadas sí conserva su medianoche exacta y verificable.
  assert.equal(supplyBlockMessage("daily request quota", { maxDailyCalls: 20, timezone: "America/Cancun" }, new Date("2026-11-02T06:50:00Z")).resetAt, "2026-11-03T05:00:00.000Z");
});

test("API: un bloqueo por cuota responde con la política real y resetAt; el trabajo guardado se devuelve intacto", async () => {
  const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
  const blocked: LlmStepFn = async () => { throw Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:daily request quota"), { name: "SupplyUnavailableError" }); };
  const d: ApiDeps = { userId: "u1", viewer, voices: async () => [], enabled: true, llm: null, llmStep: () => blocked, newJobId: () => "11111111-2222-4333-8444-555555555555", env: {},
    insert: async () => null, load: async () => null, authorize: async () => false, dispatch: async () => false,
    supplyPolicy: async () => ({ maxDailyCalls: 20, timezone: "America/Cancun" }) };
  const r = await studioAction(d, { action: "script-step", topic: input(30).topic, minutes: 30, hostName: A, guestName: B, hostPersonality: "curiosa", guestPersonality: "escéptico", state: null });
  assert.equal(r.status, 503); assert.equal(r.body.recoverable, true);
  assert.match(String(r.body.error), /20 llamadas de IA/); assert.match(String(r.body.resetAt), /T05:00:00\.000Z$/);
  assert.ok(r.body.state, "el estado vuelve al navegador");
});

test("etiqueta abreviada («Hans:» por «El Duro Hans») se asigna a su persona, no por orden de aparición", () => {
  const names = { A: "Valeria Moncler", B: "El Duro Hans" };
  const who = (t: string) => parseLabeledScript(t, names)!.turns.map((x) => x.speaker).join("");
  assert.equal(who("Hans: Uno.\nValeria Moncler: Dos.\nHans: Tres."), "BAB"); // antes «AAA»: bloque rechazado («Solo habla un participante»)
  assert.equal(who("El Duro Hans: Uno.\nValeria: Dos."), "BA"); // antes «BB»
  assert.equal(who("Hans: Uno.\nValeria: Dos."), "BA"); // antes «AB»: voces cruzadas en silencio
  assert.equal(who("Valeria Moncler: Uno.\nEl Duro Hans: Dos."), "AB");
  assert.equal(parseLabeledScript("Ana: Uno.\nLuis: Dos.")!.turns.map((x) => x.speaker).join(""), "AB"); // sin nombres: por orden, como antes
  assert.equal(parseLabeledScript("Hans: a.\nValeria: b.\nNarrador: c.", names), null); // una tercera voz sigue invalidando
});
