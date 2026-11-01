/**
 * P0 2026-11-01 («BASE DULCE», 30 min → plantilla de 5,9 min). Pruebas puras del guion largo por segmentos (USD 0, sin
 * red): modelo SIMULADO que responde como lo haría el real (escaleta JSON y bloques «Nombre: texto»). No sustituyen la
 * validación con el modelo real, que se hace aparte con autorización de gasto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceLongScript, assembleLongScript, checkLongState, LongScriptError, MAX_ATTEMPTS_PER_STEP, newLongScript, parsePlan, planPrompt,
  segmentChars, segmentCount, segmentIssues, segmentPrompt, totalSteps, type LlmStepFn, type LongInput, type LongScriptState,
} from "./long-script";
import { describeLlmFailure, studioAction, type ApiDeps } from "./api";
import { templateConversation } from "./script";

const JOB = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BASE_DULCE = "BASE DULCE: LOS SIETE NIVELES DEL HORROR. Conversación de 30 minutos entre Valeria Moncler y El Duro Hans. Explorar Thomas Castello, Phil Schneider, los supuestos siete niveles subterráneos, la batalla de 1979 y Paul Bennewitz. Estilo cinematográfico, intrigante, conversacional, con humor inteligente y escepticismo. Distinguir afirmaciones, rumores y evidencia verificable.";
const input = (minutes: number): LongInput => ({ topic: BASE_DULCE, minutes, hostName: "Valeria Moncler", guestName: "El Duro Hans", hostPersonality: "curiosa, cinematográfica", guestPersonality: "escéptico, humor seco" });

/** Frases variadas para que ningún turno se repita (como un modelo real). */
const WORDS = "archivo testimonio rumor evidencia documento túnel nivel base Dulce Nuevo México fuente versión relato radar señal informe agencia ingeniero fotografía mapa".split(" ");
function sentence(seed: number, len: number): string {
  const w: string[] = [];
  for (let i = 0; w.join(" ").length < len; i++) w.push(WORDS[(seed * 7 + i * 3) % WORDS.length] + (i % 9 === 8 ? `-${seed}-${i}` : ""));
  return w.join(" ") + ".";
}
type Fake = { llm: LlmStepFn; calls: { step: string; prompt: string; maxTokens: number }[] };
/**
 * Modelo simulado: escaleta con los bloques pedidos y bloques del largo pedido (factor 1 = justo el objetivo). `bad`
 * fuerza respuestas inválidas en ciertos pasos y `fail` lanza errores del proveedor.
 */
function fakeModel(minutes: number, o: { factor?: number; bad?: Record<string, "corto" | "saludo" | "despedida" | "repetido" | "basura">; fail?: Record<string, Error> } = {}): Fake {
  const calls: Fake["calls"] = [];
  let last: string[] = [];
  const llm: LlmStepFn = async (prompt, x) => {
    calls.push({ step: x.step, prompt, maxTokens: x.maxTokens });
    if (o.fail?.[x.step]) throw o.fail[x.step];
    const n = segmentCount(minutes);
    if (x.step.startsWith("plan")) {
      if (o.bad?.[x.step] === "basura") return "Claro, aquí tienes una escaleta: primero hablamos de la base…";
      return `\`\`\`json\n${JSON.stringify({ titulo: "Base Dulce: los siete niveles", bloques: Array.from({ length: n }, (_, j) => ({ titulo: `Bloque ${j + 1}`, puntos: [`punto ${j}a`, `punto ${j}b`, `punto ${j}c`] })) })}\n\`\`\``;
    }
    const k = Number(/^s(\d+)/.exec(x.step)![1]);
    const kind = o.bad?.[x.step];
    if (kind === "basura") return "Lo siento, no puedo ayudar con eso.";
    if (kind === "repetido" && last.length) return last.join("\n");
    const target = segmentChars(minutes) * (kind === "corto" ? 0.5 : o.factor ?? 1.0);
    const lines: string[] = [];
    let chars = 0, i = 0;
    while (chars < target) {
      const who = i % 2 === 0 ? "Valeria Moncler" : "El Duro Hans";
      let text = sentence(k * 1000 + i + Number(/-a(\d+)/.exec(x.step)![1]) * 100000 + Number(/-x(\d+)/.exec(x.step)?.[1] ?? 0) * 7000, 180);
      if (i === 0 && (k === 0 || kind === "saludo")) text = `Bienvenidos a este episodio. ${text}`;
      if (kind === "despedida" && chars + 400 > target) text = `Gracias por escucharnos, hasta la próxima. ${text}`;
      lines.push(`${who}: ${text}`); chars += text.length; i++;
    }
    last = lines;
    return lines.join("\n");
  };
  return { llm, calls };
}
async function runAll(s: LongScriptState, llm: LlmStepFn, max = 40): Promise<LongScriptState> {
  for (let i = 0; i < max; i++) { const r = await advanceLongScript(s, llm); s = r.state; if (r.done) return s; }
  throw new Error("no terminó");
}

test("segmentos por duración: un bloque hasta 12 min; desde ahí, bloques de ~10 min (pocas llamadas)", () => {
  assert.deepEqual([5, 8, 10, 12, 20, 30, 45, 60].map(segmentCount), [1, 1, 1, 1, 2, 3, 5, 6]);
  assert.equal(totalSteps(newLongScript(JOB, input(30))), 4, "30 min = escaleta + 3 bloques");
});

for (const minutes of [10, 20, 30, 45, 60]) {
  test(`${minutes} min: escaleta + ${segmentCount(minutes)} bloques continuos → duración coherente (±10 %), sin plantilla`, async () => {
    const f = fakeModel(minutes);
    const s = await runAll(newLongScript(JOB, input(minutes)), f.llm);
    assert.equal(f.calls.length, 1 + segmentCount(minutes), "una llamada por paso, ninguna de más");
    assert.deepEqual(f.calls.map((c) => c.step), ["plan-a1", ...Array.from({ length: segmentCount(minutes) }, (_, k) => `s${k}-a1`)]);
    const out = assembleLongScript(s);
    assert.equal(out.withinTarget, true, `estimado ${out.estimatedMinutes} de ${minutes}`);
    assert.ok(out.estimatedMinutes >= minutes * 0.9 && out.estimatedMinutes <= minutes * 1.1);
    if (minutes === 30) assert.ok(out.estimatedMinutes >= 27 && out.estimatedMinutes <= 33, `30 min → ${out.estimatedMinutes}`);
    // Ninguna frase de la plantilla de respaldo.
    const tpl = templateConversation({ topic: BASE_DULCE, hostName: "Valeria Moncler", guestName: "El Duro Hans", minutes });
    const all = out.turns.map((t) => t.text).join("\n");
    assert.equal(tpl.filter((t) => all.includes(t.text)).length, 0);
    // Turnos numerados de corrido y de los dos participantes.
    assert.equal(out.turns[0].id, "T001"); assert.ok(out.turns.some((t) => t.speaker === "A") && out.turns.some((t) => t.speaker === "B"));
    // Cada llamada pide los tokens de un bloque, no los de todo el episodio.
    assert.ok(Math.max(...f.calls.map((c) => c.maxTokens)) <= 4500, `${Math.max(...f.calls.map((c) => c.maxTokens))} tokens`);
  });
}

test("un modelo que escribe de más se recorta por el final del desarrollo (sin tocar la voz) y queda dentro del rango", async () => {
  const f = fakeModel(30, { factor: 1.3 });
  const out = assembleLongScript(await runAll(newLongScript(JOB, input(30)), f.llm));
  assert.ok(out.trimmed > 0); assert.ok(out.estimatedMinutes <= 33 && out.estimatedMinutes >= 27, String(out.estimatedMinutes));
});

test("continuidad: cada bloque recibe la escaleta, lo ya cubierto, los últimos turnos literales y la identidad de los anfitriones", async () => {
  const f = fakeModel(30);
  let s = newLongScript(JOB, input(30));
  for (let i = 0; i < 3; i++) s = (await advanceLongScript(s, f.llm)).state;
  const p = f.calls[2].prompt; // bloque 2
  assert.match(p, /bloque 2 de 3/); assert.match(p, /1\. Bloque 1 \(ya cubierto\)/); assert.match(p, /2\. Bloque 2 ← ESTE BLOQUE/);
  assert.match(p, /Valeria Moncler \(anfitrión\/a\): curiosa, cinematográfica/); assert.match(p, /El Duro Hans .*escéptico, humor seco/);
  const lastTurn = s.segments[0].at(-1)!.text;
  assert.ok(p.includes(lastTurn), "incluye el último turno literal del bloque anterior");
  assert.match(p, /NO saludes/); assert.match(p, /NO te despidas/);
  assert.match(segmentPrompt({ ...s, segments: [...s.segments, []] } as LongScriptState, 2), /Termina con una conclusión y la despedida/);
  assert.match(f.calls[0].prompt, /exactamente 3 bloques/); assert.match(f.calls[0].prompt, /afirmaciones, rumores y evidencia verificable/);
  assert.match(planPrompt(input(30)), /Thomas Castello/);
});

test("validación de bloques: saludo a mitad, despedida antes del final, repetición o basura → reintento acotado", async () => {
  // «corto» ya no se rechaza: se completa (ver guion-bloque-corto.test.ts). Aquí, defectos de forma.
  for (const [kind, why] of [["saludo", /saluda/], ["despedida", /despide/], ["repetido", /repetidos/], ["basura", /no es un diálogo/]] as const) {
    const f = fakeModel(30, { bad: { "s1-a1": kind } });
    let s = newLongScript(JOB, input(30));
    s = (await advanceLongScript(s, f.llm)).state; s = (await advanceLongScript(s, f.llm)).state; // escaleta + bloque 1
    const err = await advanceLongScript(s, f.llm).then(() => null, (e) => e as LongScriptError & { state: LongScriptState });
    assert.ok(err instanceof LongScriptError, kind); assert.equal(err.code, "INVALIDO"); assert.equal(err.recoverable, true); assert.match(err.message, why);
    assert.equal(err.state.segments.length, 1, "lo anterior se conserva"); assert.equal(err.state.attempts.s1, 1);
    const ok = await advanceLongScript(err.state, f.llm); // segundo intento, con otra clave del libro
    assert.equal(ok.state.segments.length, 2); assert.equal(f.calls.at(-1)!.step, "s1-a2");
  }
});

test("intentos acotados: tras 3 respuestas inválidas del mismo paso se detiene sin plantilla ni más llamadas", async () => {
  const f = fakeModel(10, { bad: { "plan-a1": "basura", "plan-a2": "basura", "plan-a3": "basura" } });
  let s = newLongScript(JOB, input(10));
  for (let i = 0; i < MAX_ATTEMPTS_PER_STEP; i++) s = await advanceLongScript(s, f.llm).then(() => assert.fail("no debía pasar"), (e) => (e as { state: LongScriptState }).state);
  const end = await advanceLongScript(s, f.llm).then(() => null, (e) => e as LongScriptError);
  assert.equal(end?.code, "AGOTADO"); assert.equal(end?.recoverable, false); assert.equal(f.calls.length, MAX_ATTEMPTS_PER_STEP);
});

test("fallo del proveedor a mitad: el estado no cambia; reintentar repite EXACTAMENTE la misma petición (misma clave) y sigue", async () => {
  const boom = Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:concurrency"), { name: "SupplyUnavailableError" });
  const f = fakeModel(30, { fail: { "s2-a1": boom } });
  let s = newLongScript(JOB, input(30));
  for (let i = 0; i < 3; i++) s = (await advanceLongScript(s, f.llm)).state; // escaleta + 2 bloques
  const before = JSON.stringify(s);
  await assert.rejects(advanceLongScript(s, f.llm), /SUPPLY_UNAVAILABLE/);
  assert.equal(JSON.stringify(s), before, "nada se pierde");
  const failedPrompt = f.calls.at(-1)!.prompt;
  const g = fakeModel(30); // el proveedor vuelve
  const r = await advanceLongScript(s, g.llm);
  assert.equal(g.calls[0].step, "s2-a1", "misma clave de paso: si ya se hubiera pagado, el libro lo reutiliza");
  assert.equal(g.calls[0].prompt, failedPrompt, "mismos parámetros → misma clave idempotente");
  assert.equal(r.state.segments.length, 3);
});

test("escaleta: JSON con el número exacto de bloques y puntos; otra cosa se rechaza", () => {
  assert.equal(parsePlan('{"titulo":"x","bloques":[{"titulo":"a","puntos":["1","2"]}]}', 1)?.segments.length, 1);
  assert.equal(parsePlan('{"titulo":"x","bloques":[{"titulo":"a","puntos":["1","2"]}]}', 2), null);
  assert.equal(parsePlan('{"titulo":"x","bloques":[{"titulo":"a","puntos":["1"]}]}', 1), null);
  assert.equal(parsePlan("no es json", 1), null);
});

test("estado del navegador: se valida forma, tamaños y escaleta; un estado manipulado no llega al modelo", async () => {
  const f = fakeModel(30);
  let s = newLongScript(JOB, input(30));
  for (let i = 0; i < 2; i++) s = (await advanceLongScript(s, f.llm)).state;
  assert.deepEqual(checkLongState(JSON.parse(JSON.stringify(s)), input(30)), s);
  for (const bad of [{ ...s, v: 2 }, { ...s, jobId: "x" }, { ...s, plan: null }, { ...s, segments: Array(4).fill(s.segments[0]) },
    { ...s, segments: [[{ speaker: "C", text: "hola" }]] }, { ...s, segments: [[{ speaker: "A", text: "x".repeat(20000) }]] }]) {
    assert.throws(() => checkLongState(bad, input(30)), (e: unknown) => e instanceof LongScriptError && e.code === "ESTADO");
  }
  const tampered = checkLongState({ ...s, attempts: { plan: 1, s0: 99, "x;drop": 1 } }, input(30));
  assert.deepEqual(tampered.attempts, { plan: 1 });
});

test("una réplica breve puede repetirse entre bloques; un turno largo copiado no", () => {
  const long = "El informe de 1979 describe un túnel distinto al rumor de los siete niveles y no debe copiarse.";
  const s: LongScriptState = {
    ...newLongScript(JOB, input(20)),
    plan: { title: "t", segments: [{ title: "a", points: ["1", "2"] }, { title: "b", points: ["3", "4"] }] },
    segments: [[{ speaker: "A", text: "Exacto." }, { speaker: "B", text: long }]],
  };
  const brief = segmentIssues([{ speaker: "A", text: "Exacto." }, { speaker: "B", text: "Hoy el mapa muestra otra galería, no la del bloque anterior." }], s, 1);
  assert.equal(brief.some((x) => /repetidos/.test(x)), false);
  const copied = segmentIssues([{ speaker: "B", text: long }, { speaker: "A", text: "Y el radar de ese día no confirma la batalla." }], s, 1);
  assert.ok(copied.some((x) => /repetidos/.test(x)));
});

test("segmentIssues detecta repeticiones de bloques anteriores aunque cambien mayúsculas y acentos", async () => {
  const f = fakeModel(20);
  let s = newLongScript(JOB, input(20));
  for (let i = 0; i < 2; i++) s = (await advanceLongScript(s, f.llm)).state;
  const again = s.segments[0].map((t) => ({ ...t, text: t.text.toUpperCase() }));
  assert.ok(segmentIssues(again, s, 1).some((x) => /repetidos/.test(x)));
});

// ---------------- API (ruta /api/podcast/v3, acción «script-step»), con dependencias simuladas ----------------
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const deps = (llmStep: ApiDeps["llmStep"], over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer, voices: async () => [], enabled: true, llm: null, llmStep, newJobId: () => JOB, env: {},
  insert: async () => null, load: async () => null, authorize: async () => false, dispatch: async () => false, ...over });
const body = (minutes: number, state: unknown = null) => ({ action: "script-step", topic: BASE_DULCE, minutes, hostName: "Valeria Moncler", guestName: "El Duro Hans", hostPersonality: "curiosa, cinematográfica", guestPersonality: "escéptico, humor seco", state });

test("API: 30 min BASE DULCE de principio a fin por pasos (lo que hace el asistente) → guion de 27–33 min, fuente IA", async () => {
  const f = fakeModel(30);
  const d = deps(() => f.llm);
  let state: unknown = null, last: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) {
    const r = await studioAction(d, body(30, state));
    assert.equal(r.status, 200, String(r.body.error)); last = r.body; state = r.body.state;
    assert.equal(r.body.steps, 4);
    if (r.body.done) break;
  }
  assert.equal(last.done, true); assert.equal(last.source, "llm"); assert.equal(last.withinTarget, true);
  const est = Number(last.estimatedMinutes); assert.ok(est >= 27 && est <= 33, String(est));
  assert.match(String(last.note), /Conversación original generada con IA en 3 bloques/);
  assert.match(String(last.script), /^Valeria Moncler: Bienvenidos/); assert.doesNotMatch(String(last.script), /plantilla/i);
  assert.equal(f.calls.length, 4, "30 min = 4 llamadas (escaleta + 3 bloques)");
});

test("API: sin IA disponible → error claro, NUNCA la plantilla", async () => {
  for (const d of [deps(null), deps(() => fakeModel(30).llm, { enabled: false })]) {
    const r = await studioAction(d, body(30));
    assert.equal(r.status, 503); assert.equal(r.body.code, "IA_NO_DISPONIBLE"); assert.equal(r.body.script, undefined);
  }
  // La acción antigua ya no cae a la plantilla cuando se pidió IA.
  const old = await studioAction(deps(() => fakeModel(30).llm), { action: "script", topic: BASE_DULCE, minutes: 30, useAi: true });
  assert.equal(old.status, 409); assert.equal(old.body.script, undefined);
  // La plantilla sigue existiendo como elección expresa, y dice cuánto dura de verdad.
  const tpl = await studioAction(deps(null), { action: "script", topic: BASE_DULCE, minutes: 30 });
  assert.equal(tpl.body.source, "plantilla"); assert.match(String(tpl.body.note), /La plantilla da para unos .* y pediste 30/);
});

test("API: fallo del proveedor → 503/502 recuperable con el estado intacto; reintento sin duplicar trabajo ni pasos pagados", async () => {
  const boom = Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:concurrency"), { name: "SupplyUnavailableError" });
  const f = fakeModel(20, { fail: { "s1-a1": boom } });
  const d = deps(() => f.llm);
  let r = await studioAction(d, body(20)); r = await studioAction(d, body(20, r.body.state)); // escaleta + bloque 1
  const kept = r.body.state;
  r = await studioAction(d, body(20, kept));
  assert.equal(r.status, 503); assert.equal(r.body.code, "IA_FALLO"); assert.equal(r.body.recoverable, true); assert.match(String(r.body.error), /otra generación con IA está en curso/);
  assert.match(String(r.body.error), /No se cobró nada/); assert.deepEqual(r.body.state, kept); assert.equal(r.body.script, undefined);
  const g = fakeModel(20);
  r = await studioAction(deps(() => g.llm), body(20, r.body.state));
  assert.equal(r.status, 200); assert.equal(r.body.done, true); assert.deepEqual(g.calls.map((c) => c.step), ["s1-a1"], "solo el paso pendiente");
});

test("API: un trabajo guardado de otro tema o duración NO se sustituye en silencio (OTRO_TRABAJO); otro guion solo con state null", async () => {
  const f = fakeModel(10);
  const r1 = await studioAction(deps(() => f.llm), body(10));
  const r2 = await studioAction(deps(() => f.llm, { newJobId: () => "11111111-2222-4333-8444-555555555555" }), body(20, r1.body.state));
  assert.equal(r2.status, 409); assert.equal(r2.body.code, "OTRO_TRABAJO"); assert.equal(r2.body.state, undefined);
  const r3 = await studioAction(deps(() => f.llm, { newJobId: () => "11111111-2222-4333-8444-555555555555" }), body(20, null));
  assert.equal((r3.body.state as LongScriptState).jobId, "11111111-2222-4333-8444-555555555555"); assert.equal((r3.body.state as LongScriptState).input.minutes, 20);
});

test("describeLlmFailure: motivos del control de gasto, en curso, reconciliación y error HTTP; sin texto del proveedor", () => {
  assert.equal(describeLlmFailure(Object.assign(new Error("SUPPLY_UNAVAILABLE:anthropic:daily request quota"), { name: "SupplyUnavailableError" })).detail, "supply:daily request quota");
  assert.equal(describeLlmFailure(Object.assign(new Error("x"), { name: "SubmissionInFlightError" })).status, 409);
  assert.match(describeLlmFailure(Object.assign(new Error("x"), { name: "ScriptReconciliationRequiredError" })).error, /Lo ya escrito se conserva/);
  assert.equal(describeLlmFailure(Object.assign(new Error("secreto del proveedor"), { status: 500 })).detail, "provider:500");
  assert.doesNotMatch(describeLlmFailure(new Error("sk-ant-123 detalle")).error, /sk-ant/);
});

test("API: tope diario por persona (24 h): al alcanzarlo no se llama a la IA y el trabajo se conserva; sin lectura del libro, falla cerrado", async () => {
  const f = fakeModel(30);
  const full = await studioAction(deps(() => f.llm, { scriptSpend: async () => 3.2 }), body(30));
  assert.equal(full.status, 429); assert.equal(full.body.code, "LIMITE_DIARIO"); assert.equal(f.calls.length, 0); assert.match(String(full.body.error), /USD 3\.00/);
  const raised = await studioAction(deps(() => f.llm, { scriptSpend: async () => 3.2, env: { PODCAST_SCRIPT_DAILY_USD: "10" } }), body(30));
  assert.equal(raised.status, 200); assert.equal(f.calls.length, 1);
  const down = await studioAction(deps(() => f.llm, { scriptSpend: async () => { throw new Error("ledger"); } }), body(30));
  assert.equal(down.status, 503); assert.equal(f.calls.length, 1, "sin lectura del libro no se llama a la IA");
});

test("libro de gastos: el guion del estudio NO está en el espacio «podcast-» de los episodios (allí exige autorización de episodio)", async () => {
  const { studioScriptProject } = await import("./adapters");
  const id = studioScriptProject("6b1c2d3e-0000-4000-8000-000000000001", JOB);
  assert.equal(id, `studio-script:6b1c2d3e-0000-4000-8000-000000000001:${JOB}`);
  assert.ok(!id.startsWith("podcast-"), "el gate pi_submit_with_supply de 'podcast-%' rechaza todo lo que no sea un episodio autorizado");
  const { requiresAuthorization } = await import("@/lib/supply/spend-authorization");
  assert.equal(requiresAuthorization(id), false, "studio-script queda fuera del gate de episodios y puede enviarse a Anthropic");
  assert.equal(requiresAuthorization("podcast-studio:x:y"), true, "el prefijo antiguo caía en el gate (causa raíz)");
});

test("60 min y un tema de 2.000 caracteres caben en el episodio (el tope de 30.000 rechazaba 45–60 min)", async () => {
  const { STUDIO_VERSION, StudioSpec } = await import("./spec");
  const out = assembleLongScript(await runAll(newLongScript(JOB, input(60)), fakeModel(60).llm));
  const script = out.turns.map((t) => `${t.speaker === "A" ? "Valeria Moncler" : "El Duro Hans"}: ${t.text}`).join("\n");
  const parsed = StudioSpec.safeParse({
    version: STUDIO_VERSION, mode: "dialogo", title: "Base Dulce", topic: "t".repeat(2000), script, target_minutes: 60,
    participants: [
      { id: "A", name: "Valeria Moncler", voice_id: "voiceAnaHost1", avatar: { kind: "ninguno" } },
      { id: "B", name: "El Duro Hans", voice_id: "voiceLeoHost2", avatar: { kind: "ninguno" } },
    ],
    visual: {}, music: {}, budget_usd: 10,
  });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.ok(script.length > 30_000, `este guion de 60 min mide ${script.length} y el tope antiguo lo rechazaba`);
});
