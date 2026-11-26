/**
 * Guion con IA de Audio Podcast Studio (P0 2026-11-25). Caso real de aceptación: «Las líneas y momias de Nazca», con
 * notas de dirección personalizadas, 30 minutos, dos voces. USD 0: el modelo se simula (o es la escritura local fixture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceScriptJob, assembleScript, blockCount, blockIssues, cleanBlockText, narrationIssues, newScriptJob, parsePlan, parseScriptJob,
  planPrompt, blockPrompt, ScriptAiError, stepsDone, totalSteps, MAX_ATTEMPTS_PER_STEP, type LlmStepFn, type ScriptAiInput, type ScriptJob,
} from "./script-ai";
import { fixtureLlm, scriptAiAvailability } from "./script-llm";
import { applyInput, estimate, newProject, readinessIssues, scriptLines, wordCount, WORDS_PER_MINUTE } from "./model";
import { memoryStore } from "./store";
import { saveProject, view } from "./service";
import { scriptAction, scriptDailyCapUsd, scriptInputOf, describeFailure, type ScriptDeps } from "./script-service";

const NOW = "2026-11-25T23:30:00.000Z";
const JOB = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const NOTES = "Tono de documental riguroso pero cercano, para público general. Explica qué está comprobado y qué es especulación. Incluye la polémica de las supuestas momias de tres dedos y por qué la comunidad científica las rechaza. Nada de teorías extraterrestres presentadas como hechos.";
const NAZCA: ScriptAiInput = { topic: "Las líneas y momias de Nazca", notes: NOTES, minutes: 30, voiceCount: 2, language: "es", voiceNames: ["Víctor", "Ximena"] };

/** Párrafo con contenido específico de Nazca (distinto en cada llamada, para no repetir). */
const NAZCA_FACTS = [
  "las líneas de Nazca son geoglifos trazados en el desierto del sur del Perú entre aproximadamente el año 500 antes de Cristo y el 500 después de Cristo",
  "María Reiche dedicó décadas a medirlas y protegerlas, y gracias a su trabajo la UNESCO las declaró Patrimonio de la Humanidad en 1994",
  "las figuras del colibrí, el mono y la araña solo se aprecian completas desde el aire o desde los cerros cercanos",
  "en 2017 se difundieron unas supuestas momias de tres dedos que, según los análisis independientes, combinaban huesos humanos y de animales",
  "arqueólogos y el Ministerio de Cultura del Perú advirtieron que esos restos no tienen contexto arqueológico verificable",
  "las hipótesis serias relacionan las líneas con rituales del agua y la fertilidad, no con pistas de aterrizaje",
];
function nazcaLlm(calls: { step: string; prompt: string }[], opts: { badBlock?: (step: string) => string | null } = {}): LlmStepFn {
  let n = 0;
  return async (prompt, o) => {
    calls.push({ step: o.step, prompt });
    if (o.step.startsWith("plan")) {
      return JSON.stringify({ titulo: "Nazca: líneas en el desierto y momias en disputa", bloques: [
        { titulo: "Qué son las líneas de Nazca", puntos: ["Ubicación y datación", "Técnica de trazado", "Figuras principales", "El papel de María Reiche"] },
        { titulo: "Para qué se hicieron", puntos: ["Hipótesis ceremoniales", "El agua y la fertilidad", "Mitos de pistas de aterrizaje", "Qué dice la arqueología"] },
        { titulo: "Las supuestas momias de tres dedos", puntos: ["Origen del caso en 2017", "Análisis independientes", "Postura del Ministerio de Cultura", "Por qué importa el contexto"] },
      ] });
    }
    const bad = opts.badBlock?.(o.step);
    if (bad) return bad;
    const words = Number((prompt.match(/entre (\d+) y \d+ palabras/) ?? [])[1]);
    const lines: string[] = [];
    let w = 0, i = 0;
    const first = /Empieza presentando/.test(prompt), last = /Termina con una conclusión/.test(prompt);
    if (first) lines.push("Voz 1: Hoy viajamos al desierto de Nazca, en el sur del Perú, para entender sus líneas y una polémica reciente.");
    while (w < words) {
      const fact = NAZCA_FACTS[(n + i) % NAZCA_FACTS.length];
      const line = `Voz ${(i % 2) + 1}: ${i % 2 ? "Y ojo, porque" : "Lo interesante es que"} ${fact}, un dato que conviene separar de la especulación número ${n}-${i}.`;
      lines.push(line); w += wordCount(line) - 2; i++;
    }
    if (last) lines.push(`Voz ${(i % 2) + 1}: Gracias por escucharnos; hasta el próximo episodio.`);
    n++;
    return { text: lines.join("\n"), stopReason: "end_turn" };
  };
}

test("estructura: 30 min = escaleta + 3 bloques; 5 min = escaleta + 1 bloque", () => {
  assert.equal(blockCount(30), 3); assert.equal(blockCount(5), 1); assert.equal(blockCount(12), 1); assert.equal(blockCount(60), 6);
  assert.equal(totalSteps({ input: NAZCA }), 4);
});

test("los prompts usan el tema, las notas de dirección, la duración y las dos voces (nada genérico)", () => {
  const p = planPrompt(NAZCA);
  assert.match(p, /Las líneas y momias de Nazca/); assert.match(p, /momias de tres dedos/); assert.match(p, /30 minutos/);
  assert.match(p, /Voz 1 \(se llama Víctor\) y Voz 2 \(se llama Ximena\)/); assert.match(p, /exactamente 3 bloques/);
  const j = { ...newScriptJob(JOB, NAZCA, NOW), plan: parsePlan(JSON.stringify({ titulo: "T", bloques: [1, 2, 3].map((k) => ({ titulo: `B${k}`, puntos: ["a", "b", "c"] })) }), 3) };
  const b = blockPrompt(j, 0);
  assert.match(b, /Las líneas y momias de Nazca/); assert.match(b, /OBLIGATORIAS/); assert.match(b, /teorías extraterrestres/);
  assert.match(b, /«Voz 1:» o «Voz 2:»/); assert.match(b, /TODO lo que escribas se va a narrar/);
  assert.match(b, /entre 1500 y \d+ palabras/);
});

test("caso Nazca: escaleta + 3 bloques → guion completo de ~30 min, con progreso real paso a paso y sin marcadores", async () => {
  const calls: { step: string; prompt: string }[] = [];
  const llm = nazcaLlm(calls);
  let j: ScriptJob = newScriptJob(JOB, NAZCA, NOW);
  const progress: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await advanceScriptJob(j, llm, NOW);
    j = r.job; progress.push(`${stepsDone(j)}/${totalSteps(j)}`);
    assert.equal(r.done, i === 3);
  }
  assert.deepEqual(progress, ["1/4", "2/4", "3/4", "4/4"]);
  assert.deepEqual(calls.map((c) => c.step), ["plan-a1", "b0-a1", "b1-a1", "b2-a1"]);
  assert.ok(calls.every((c) => c.prompt.includes("Las líneas y momias de Nazca") && c.prompt.includes("momias de tres dedos")), "tema y notas en cada llamada");
  assert.equal(j.status, "terminado");
  const script = assembleScript(j);
  assert.match(script, /^## Qué son las líneas de Nazca/);
  assert.match(script, /María Reiche/); assert.match(script, /momias de tres dedos/);
  assert.deepEqual(narrationIssues(script), []);
  const lines = scriptLines(script, 2);
  assert.ok(lines.some((l) => l.voice === 1) && lines.some((l) => l.voice === 0));
  assert.ok(!lines.some((l) => /^##|Voz \d:/.test(l.text)), "los títulos y etiquetas no se narran");
  const e = estimate({ script, voiceCount: 2, targetMinutes: 30, budgetUsd: 50, spentUsd: 0 });
  assert.ok(e.estimatedMinutes >= 27 && e.estimatedMinutes <= 36, String(e.estimatedMinutes));
  assert.equal(j.result?.withinTarget, true);
});

test("la plantilla anterior y las instrucciones internas se detectan y bloquean el gasto de voz", () => {
  const old = "## Apertura\n\nVoz 1: Presenta «Nazca» y cuenta por qué importa hoy. (Reemplaza esta pauta por unas 300 palabras.)\n\nVoz 2: Responde, pregunta o añade un matiz.";
  assert.ok(narrationIssues(old).length >= 1);
  const en = "## Opening\n\nVoice 1: Introduce Nazca. Replace this outline with your English script.\n\nVoice 2: Add a question or another perspective.";
  assert.ok(narrationIssues(en).length >= 1);
  for (const bad of ["Voz 1: [MÚSICA DE ENTRADA] Bienvenidos.", "Voz 1: **Hola** a todos.", "- Primer punto del guion", "Narrador: Esto es Nazca.", "Voz 1: TODO completar este bloque.",
    "Voz 2: (música de fondo) Seguimos.", "Notas de dirección: tono serio.", "Voz 1: Desarrolla esta idea con un ejemplo cotidiano."]) {
    assert.ok(narrationIssues(bad).length, bad);
  }
  for (const ok of ["## Título de sección", "Voz 1: Las líneas miden hasta 300 metros (algunas más).", "Voz 2: ¿Y quién las protegió? María Reiche, durante décadas.", "Un monólogo normal sobre el desierto."]) {
    assert.deepEqual(narrationIssues(ok), [], ok);
  }
  const p = applyInput(newProject({ id: JOB, ownerId: JOB, now: NOW, title: "Nazca", voiceCount: 2 }), { script: `${old}\n\n${"Voz 1: palabra ".repeat(40)}\n\nVoz 2: otra cosa`, targetMinutes: 5 }, NOW);
  assert.ok(readinessIssues(p, estimate(p)).some((i) => /se narraría/.test(i)));
});

test("limpieza: negritas, acotaciones de producción y títulos del modelo no llegan al guion", () => {
  const c = cleanBlockText("```\n## Bloque 1\n**Voz 1:** Hola, esto es Nazca (música suave).\nVOZ 2 — Claro *risas* que sí.\n\n> Voz 1: Seguimos.\n```");
  assert.equal(c.length, 3, JSON.stringify(c));
  assert.ok(c.every((l) => !/\*|\(|##|```/.test(l)), JSON.stringify(c));
  assert.ok(c[0].startsWith("Voz 1: ") && c[1].startsWith("Voz 2: "));
});

test("un bloque con pautas se rechaza y se reintenta; tras 3 intentos inválidos, AGOTADO sin plantilla", async () => {
  const calls: { step: string; prompt: string }[] = [];
  const llm = nazcaLlm(calls, { badBlock: (s) => (s.startsWith("b0") ? "Voz 1: Presenta «Nazca». (Reemplaza esta pauta por unas 500 palabras.)\nVoz 2: Responde, pregunta o añade un matiz." : null) });
  let j = (await advanceScriptJob(newScriptJob(JOB, NAZCA, NOW), llm, NOW)).job;
  for (let a = 1; a <= MAX_ATTEMPTS_PER_STEP; a++) {
    await assert.rejects(advanceScriptJob(j, llm, NOW), (e: ScriptAiError) => { assert.equal(e.code, "INVALIDO"); j = e.job!; return true; });
  }
  assert.equal(j.attempts.b0, 3); assert.equal(j.blocks.length, 0);
  await assert.rejects(advanceScriptJob(j, llm, NOW), (e: ScriptAiError) => e.code === "AGOTADO" && e.job?.status === "fallido" && !e.recoverable);
  assert.deepEqual(calls.map((c) => c.step), ["plan-a1", "b0-a1", "b0-a2", "b0-a3"]);
});

test("un error del proveedor no cambia el trabajo (reintentar repite la misma clave: nunca se paga dos veces)", async () => {
  const j0 = newScriptJob(JOB, NAZCA, NOW);
  const steps: string[] = [];
  const down: LlmStepFn = async (_p, o) => { steps.push(o.step); throw Object.assign(new Error("overloaded"), { status: 529 }); };
  await assert.rejects(advanceScriptJob(j0, down, NOW), /overloaded/);
  await assert.rejects(advanceScriptJob(j0, down, NOW), /overloaded/);
  assert.deepEqual(steps, ["plan-a1", "plan-a1"]);
  assert.equal(describeFailure(Object.assign(new Error("x"), { status: 529 })).status, 502);
  assert.equal(describeFailure(Object.assign(new Error("y"), { name: "SubmissionInFlightError" })).code, "in-flight");
  assert.match(describeFailure(new Error("SUPPLY_UNAVAILABLE:anthropic:daily request quota")).code, /^supply:daily request quota/);
});

test("lo ya pagado se reevalúa gratis antes de pagar otro intento", async () => {
  const calls: { step: string; prompt: string }[] = [];
  const good = nazcaLlm([]);
  let j = (await advanceScriptJob(newScriptJob(JOB, NAZCA, NOW), good, NOW)).job;
  j = { ...j, attempts: { ...j.attempts, b0: 1 } };
  const paid = await good(blockPrompt(j, 0), { step: "b0-a1", maxTokens: 1 });
  const r = await advanceScriptJob(j, async (p, o) => { calls.push({ step: o.step, prompt: p }); throw new Error("no debería pagar"); }, NOW, async (step) => (step === "b0-a1" ? paid : null));
  assert.equal(r.job.blocks.length, 1); assert.equal(calls.length, 0);
});

test("dúo: un bloque sin la segunda voz no sirve; monólogo: sin etiquetas", () => {
  const j = { ...newScriptJob(JOB, { ...NAZCA, minutes: 5 }, NOW), plan: { title: "T", blocks: [{ title: "B", points: ["a", "b"] }] } };
  const solo = Array.from({ length: 40 }, (_, i) => `Voz 1: Las líneas de Nazca y su historia, parte ${i} con contexto suficiente para el bloque.`);
  assert.ok(blockIssues(solo, j, 0).some((x) => /diálogo/.test(x)));
  const mono = { ...j, input: { ...j.input, voiceCount: 1 as const } };
  assert.ok(blockIssues(solo, mono, 0).some((x) => /etiquetas de voz/.test(x)));
});

test("disponibilidad: fixture solo fuera de producción; sin clave o con interruptor apagado, explicada", () => {
  assert.equal(scriptAiAvailability("u", { AUDIO_STUDIO_SCRIPT_AI: "fixture" }).mode, "fixture");
  assert.equal(scriptAiAvailability("u", { AUDIO_STUDIO_SCRIPT_AI: "fixture", VERCEL: "1" }).mode, "off");
  assert.equal(scriptAiAvailability("u", { AUDIO_STUDIO_SCRIPT_AI: "fixture", NODE_ENV: "production", ANTHROPIC_API_KEY: "k" }).mode, "real");
  assert.equal(scriptAiAvailability("u", { ANTHROPIC_API_KEY: "k" }).mode, "real");
  assert.equal(scriptAiAvailability("u", { ANTHROPIC_API_KEY: "k", AUDIO_STUDIO_SCRIPT_AI: "0" }).mode, "off");
  assert.equal(scriptAiAvailability("u", {}).mode, "off");
  assert.equal(scriptDailyCapUsd({}), 2); assert.equal(scriptDailyCapUsd({ AUDIO_STUDIO_SCRIPT_DAILY_USD: "500" }), 20);
});

test("un trabajo guardado se relee de forma defensiva", () => {
  const j = { ...newScriptJob(JOB, NAZCA, NOW), attempts: { plan: 1, evil: 9, b0: 99 } };
  const back = parseScriptJob(JSON.parse(JSON.stringify(j)))!;
  assert.deepEqual(back.attempts, { plan: 1 });
  assert.equal(parseScriptJob({ ...j, jobId: "x" }), null);
  assert.equal(parseScriptJob({ ...j, status: "raro" }), null);
});

// ── Servicio (rutas) con almacén en memoria y la escritura local fixture ─────────────────────────────────────────────
const OWNER = "11111111-1111-4111-8111-111111111111";
async function setup(over: Partial<ScriptDeps> = {}) {
  const store = memoryStore();
  const id = "22222222-2222-4222-8222-222222222222";
  const p = applyInput(newProject({ id, ownerId: OWNER, now: NOW, title: "Las líneas y momias de Nazca", voiceCount: 2 }), { notes: NOTES, targetMinutes: 30, budgetUsd: 50 }, NOW);
  await store.create(p);
  const d: ScriptDeps = { store, now: () => NOW, newId: () => JOB, env: {}, ai: { mode: "fixture", step: () => fixtureLlm(), replay: null }, ...over };
  return { store, id, d, p };
}

test("servicio: iniciar → 4 pasos → guion escrito en el proyecto (revisión nueva), editable y listo para validar", async () => {
  const { d, id, p, store } = await setup();
  assert.equal((await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision + 7 })).status, 409, "revisión vieja");
  const s = await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision });
  assert.equal(s.status, 201);
  assert.equal((await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision })).status, 409, "ya en curso");
  // Mientras escribe: no se puede editar ni generar.
  const blocked = await saveProject({ store, now: () => NOW }, OWNER, id, { revision: p.revision, script: "x" });
  assert.equal(blocked.status, 409);
  const mid = (await store.get(OWNER, id))!;
  assert.ok(view(mid, {}).readiness.some((r) => /La IA está escribiendo/.test(r)));
  const seen: string[] = [];
  let last: Awaited<ReturnType<typeof scriptAction>> | null = null;
  for (let i = 0; i < 4; i++) {
    last = await scriptAction(d, OWNER, id, { action: "paso", jobId: JOB });
    assert.equal(last.status, 200, JSON.stringify(last.body).slice(0, 300));
    const st = (last.body as { scriptStep: { step: number; steps: number; done: boolean } }).scriptStep;
    seen.push(`${st.step}/${st.steps}${st.done ? "✓" : ""}`);
  }
  assert.deepEqual(seen, ["1/4", "2/4", "3/4", "4/4✓"]);
  const done = (await store.get(OWNER, id))!;
  assert.equal(done.scriptJob?.status, "terminado");
  assert.equal(done.revision, p.revision + 1);
  assert.match(done.script, /^## Parte 1/);
  assert.match(done.script, /Nazca/);
  assert.deepEqual(narrationIssues(done.script), []);
  const est = estimate(done);
  assert.ok(Math.abs(est.estimatedMinutes - 30) <= 6, String(est.estimatedMinutes));
  assert.equal(est.words > 0.85 * 30 * WORDS_PER_MINUTE, true);
  // Después: editable.
  assert.equal((await saveProject({ store, now: () => NOW }, OWNER, id, { revision: done.revision, script: `${done.script}\n\nVoz 1: Una línea propia.` })).status, 200);
  assert.equal((await scriptAction(d, OWNER, id, { action: "paso", jobId: JOB })).status, 409, "sin trabajo en curso");
});

test("servicio: tema por defecto, IA apagada, tope diario y cancelación", async () => {
  const { d, id, p, store } = await setup();
  await store.put({ ...p, title: "Episodio sin título" });
  assert.equal((await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision })).status, 422);
  await store.put(p);
  const off = await scriptAction({ ...d, ai: { mode: "off", reason: "apagada" } }, OWNER, id, { action: "iniciar", revision: p.revision });
  assert.equal(off.status, 503);
  await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision });
  const capped = await scriptAction({ ...d, scriptSpend: async () => 5 }, OWNER, id, { action: "paso", jobId: JOB });
  assert.equal(capped.status, 429);
  const ledgerDown = await scriptAction({ ...d, scriptSpend: async () => { throw new Error("x"); } }, OWNER, id, { action: "paso", jobId: JOB });
  assert.equal(ledgerDown.status, 503);
  const c = await scriptAction(d, OWNER, id, { action: "cancelar" });
  assert.equal(c.status, 200);
  const after = (await store.get(OWNER, id))!;
  assert.equal(after.scriptJob?.status, "cancelado"); assert.equal(after.script, p.script, "cancelar no toca el guion");
});

test("servicio: un paso que llega tarde de otra pestaña no retrocede el trabajo", async () => {
  const { d, id, p, store } = await setup();
  await scriptAction(d, OWNER, id, { action: "iniciar", revision: p.revision });
  const stale = (await store.get(OWNER, id))!;
  await scriptAction(d, OWNER, id, { action: "paso", jobId: JOB });
  await scriptAction(d, OWNER, id, { action: "paso", jobId: JOB });
  const advanced = (await store.get(OWNER, id))!;
  assert.equal(stepsDone(advanced.scriptJob!), 2);
  // Respuesta tardía de otra pestaña que partió del estado viejo (1 paso): al guardar ve 2 pasos y no retrocede.
  let first = true;
  const lateStore = { ...store, get: async (o: string, x: string) => { if (first) { first = false; return stale; } return store.get(o, x); } };
  const late = await scriptAction({ ...d, store: lateStore }, OWNER, id, { action: "paso", jobId: JOB });
  assert.equal(late.status, 200);
  assert.equal(stepsDone((await store.get(OWNER, id))!.scriptJob!), 2);
});

test("entrada del trabajo: tema = título, notas, duración, idioma y nombres de las voces del proyecto", () => {
  const p = applyInput(newProject({ id: JOB, ownerId: OWNER, now: NOW, title: "Las líneas y momias de Nazca", voiceCount: 2 }), { notes: NOTES, targetMinutes: 30 }, NOW);
  const i = scriptInputOf(p);
  assert.equal(i.topic, "Las líneas y momias de Nazca"); assert.equal(i.notes, NOTES); assert.equal(i.minutes, 30); assert.equal(i.voiceCount, 2);
  assert.equal(i.voiceNames.length, 2);
});
