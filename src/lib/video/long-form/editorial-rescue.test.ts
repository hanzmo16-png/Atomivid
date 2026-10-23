// Operación rescate del motor editorial — pruebas de los incidentes 23d86d0a / 8c330c37 (job e8048599).
//
// EVIDENCIA REAL vs SIMULACIÓN (explícito):
//  - REAL: el borrador `__fixtures__/incident-e8048599-draft.json` es el checkpoint persistido en producción
//    (EN, 15 min, historia alternativa cinematográfica "Leonidas vs Attila"), leído con SELECT.
//  - SIMULADO: las respuestas del crítico y de la comprobación de apertura. Las respuestas crudas pagadas viven en
//    Storage (no legibles por SQL). La FORMA del incidente (`firstAnswer.evidence.explanation: ""`, excerptId
//    elegible `…:b0:w132`, explicación de 565 caracteres) procede del diagnóstico de PR #190 sobre el ledger real.
//  - Proveedores: ninguna llamada de red. `send` es un ledger en memoria con la misma huella (stableHash) que producción.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialReport } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview, OPENING_UNVERIFIED_EXPLANATION } from "./editorial-opening-repair";
import { DocumentaryResponseError, parseDocumentaryResponse, validateDocumentaryValue } from "./json-response";
import { normalizeToContract, extractJsonDocument } from "./response-normalizer";
import { generateDocumentaryScript, type DocumentaryScript } from "./documentary-script";
import { creativeFixture } from "./editorial.test-fixtures";
import { creativeDirectionIssues, anchorCreativeDirectionQuotes, anchorCreativeDirectionSpans } from "./creative-direction";
import { z } from "zod";

type Fixture = { durationMinutes: number; language: "es" | "en"; sourceIds: string[]; script: DocumentaryScript; creativeHistory?: import("./creative-direction").CreativeHistoryEntry[] };
const REAL = JSON.parse(readFileSync(new URL("./__fixtures__/incident-e8048599-draft.json", import.meta.url), "utf8")) as Fixture;

type Msg = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };
const msg = (body: unknown, stop = "end_turn"): Msg => ({ stop_reason: stop, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] });

/** Ledger simulado: misma clave que producción (stableHash(params,16)); una respuesta COMMITTED se reutiliza gratis. */
function ledger(responder: (params: Record<string, unknown>) => Msg) {
  const committed = new Map<string, Msg>(); let paid = 0; let crashAfter = Infinity;
  const send = async (params: { model: string; max_tokens: number } & Record<string, unknown>) => {
    const key = stableHash(params, 16);
    const hit = committed.get(key); if (hit) return structuredClone(hit);
    if (paid >= crashAfter) throw new Error("SIMULATED_INTERRUPTION");
    paid++; const r = responder(params); committed.set(key, r); return structuredClone(r);
  };
  return { send, get paid() { return paid; }, set crashAfter(n: number) { crashAfter = n; }, committed };
}

function synthetic(beats: number, words: number, lang: "es" | "en"): Fixture {
  const v = lang === "es" ? ["el", "archivo", "fechado", "contradice", "la", "versión", "oficial", "del", "puerto"] : ["the", "ledger", "shows", "a", "shipment", "that", "contradicts", "official", "records"];
  const lead = (i: number) => lang === "es" ? `El registro ${i} del puerto revela una fecha concreta que cambia la versión oficial.` : `Record ${i} from the port reveals a concrete date that changes the official account.`;
  const narr = Array.from({ length: beats }, (_, i) => lead(i) + " " + Array.from({ length: (i === 0 ? Math.max(words, 200) : words) - 14 }, (_, j) => `${v[j % v.length]}${i}k${j}`).join(" "));
  const script = { creativeDirection: creativeFixture(narr), title: "T", workingTitleOptions: ["T"], hook: lead(0),
    storyPlan: { centralQuestion: "Q?", openingPromise: "P", firstAnswer: lead(0), endingAnswer: lead(beats - 1),
      sections: narr.map((s, i) => ({ beatIndex: i, newInformation: s.slice(0, 40), consequence: "C", tension: i % 2 ? "reflection" : "rise" })) },
    beats: narr.map((n, i) => ({ type: i === 0 ? "hook" : i === beats - 1 ? "payoff" : "discovery", purpose: `p${i}`, narration: n, claims: [] })) } as unknown as DocumentaryScript;
  return { durationMinutes: 0, language: lang, sourceIds: ["s1"], script };
}

/** Revisión simulada del crítico con la condición que dispara la comprobación: delivered=true citado DESPUÉS de la palabra 150. */
function criticReview(script: DocumentaryScript) {
  const cat = narrationCatalog(script.beats), first = (i: number) => cat.find(e => e.beatIndex === i)!.id, last = script.beats.length - 1;
  const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) >= 144)!;
  return { sections: script.beats.map((_, i) => ({ excerptId: first(i), contribution: `c${i}`, function: i === last ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "Delivered in the opening block." },
    ending: { resolvesPromise: true, evidence: { excerptId: first(last) }, explanation: "Resolved in the close." }, findings: [] };
}
const eligibleId = (s: DocumentaryScript, w: number) => openingEvidence(s.beats).find(e => e.id.endsWith(`:b0:w${w}`))?.id ?? openingEvidence(s.beats).at(-1)!.id;
/** FORMA exacta del incidente 23d86d0a/8c330c37 (según el ledger real descrito en PR #190). */
const incidentRepair = (s: DocumentaryScript) => msg({ firstAnswer: { delivered: true, evidence: { excerptId: eligibleId(s, 132), explanation: "" },
  explanation: ("The opening states plainly that Leonidas died in 480 BCE and Attila led the Huns about nine hundred years later, a concrete, verifiable payoff. ").repeat(4).slice(0, 565) } });
const isOpeningRepair = (p: Record<string, unknown>) => String(p.system).includes("opening-payoff-evidence-repair-v1");

async function pipeline(fx: Fixture, targetSeconds: number, repair: (s: DocumentaryScript) => Msg, l = ledger(p => { if (isOpeningRepair(p)) return repair(fx.script); throw new Error("unexpected provider call"); })) {
  let report: EditorialReport | undefined; const stages: string[] = [];
  const beats = await generateDocumentaryScript({ researchPack: { topic: "t", sources: fx.sourceIds.map(id => ({ id, title: id, kind: "secondary" as const })), openQuestions: [] },
    mode: "curiosity_documentary", language: fx.language, creativeHistory: fx.creativeHistory, targetDurationSeconds: targetSeconds, referenceContract: "catalog-v1",
    parse: async () => structuredClone(fx.script), review: async () => criticReview(fx.script), send: l.send,
    onStage: async s => { stages.push(s); }, onEditorialApproved: r => { report = r; } });
  return { beats, report, stages, ledger: l };
}

// ── 1. Reproducción del error ORIGINAL con el borrador real ─────────────────────────────────────────
test("REAL e8048599 (15 min, historia alternativa EN): la forma del incidente ya no destruye el guion", async () => {
  const script = REAL.script, raw = criticReview(script);
  const strict = z.object({ firstAnswer: z.object({ delivered: z.boolean(), evidence: z.object({ excerptId: z.string() }).strict(), explanation: z.string() }).strict() }).strict();
  // Mecanismo original (e68da2b): validación estricta sin normalización -> exactamente el mensaje de producción.
  assert.equal(strict.safeParse(JSON.parse(incidentRepair(script).content[0].text!)).success, false);
  const result = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send: async () => incidentRepair(script) });
  assert.equal(result.firstAnswer.delivered, true);
  assert.ok(script.beats[0].narration.includes(result.firstAnswer.evidence.quote), "la evidencia sale de la narración original");
  assert.deepEqual(editorialBlockers(result), []);
});

test("REAL e8048599: pipeline completo aprueba con 1 sola llamada pagada y el reintento cuesta 0", async () => {
  const run1 = await pipeline(REAL, REAL.durationMinutes * 60, incidentRepair);
  assert.ok(run1.report, "aprobado"); assert.equal(run1.ledger.paid, 1);
  assert.ok(run1.stages.includes("Comprobando la primera recompensa de la apertura"));
  const run2 = await pipeline(REAL, REAL.durationMinutes * 60, incidentRepair, run1.ledger);
  assert.equal(run2.ledger.paid, 1, "reintento reutiliza la respuesta persistida");
  assert.deepEqual(run2.report!.scriptHash, run1.report!.scriptHash);
  assert.equal(run2.beats.map(b => b.narration).join("\n"), REAL.script.beats.map(b => b.narration).join("\n"), "la narración nunca cambia");
});

// ── 2. Escenarios por formato ───────────────────────────────────────────────────────────────────────
for (const [name, fx, seconds] of [
  ["documental tradicional ES 5 min (sintético)", synthetic(5, 150, "es"), 300],
  ["documental EN 15 min (sintético)", synthetic(10, 205, "en"), 900],
  ["historia alternativa cinematográfica EN 15 min (REAL)", REAL, 900],
] as const) {
  test(`${name}: respuesta de forma recuperable -> aprobado sin llamadas extra`, async () => {
    const r = await pipeline(fx, seconds, incidentRepair);
    assert.ok(r.report); assert.equal(r.ledger.paid, 1); assert.deepEqual(editorialBlockers(r.report!.reviews.at(-1)!), []);
  });
  test(`${name}: respuesta realmente inválida -> NUNCA aprobado (observación editorial, borrador conservado)`, async () => {
    const bad = () => msg({ firstAnswer: { delivered: "yes", evidence: {}, explanation: "" } });
    const l = ledger(p => { if (isOpeningRepair(p)) return bad(); throw new Error("SIMULATED: corrección pediría nueva llamada"); });
    let approved = false;
    await assert.rejects(pipeline(fx, seconds, bad, l).then(r => { approved = !!r.report; }));
    assert.equal(approved, false);
    const review = await validateOrRepairOpeningReview({ rawReview: criticReview(fx.script), script: fx.script, model: "t", send: async () => bad() });
    assert.equal(review.firstAnswer.delivered, false); assert.equal(review.firstAnswer.explanation, OPENING_UNVERIFIED_EXPLANATION);
    assert.ok(editorialBlockers(review).length > 0);
  });
}

// ── 3. Variantes parcialmente malformadas pero recuperables ────────────────────────────────────────
test("capa B: variantes recuperables aceptadas sin cambiar el significado", async () => {
  const s = REAL.script, id = eligibleId(s, 0), base = { delivered: true, explanation: "Concrete early answer." };
  for (const body of [
    { firstAnswer: { ...base, evidence: { excerptId: id, explanation: "" } } },                 // incidente
    { firstAnswer: { ...base, evidence: { excerptId: id, explanation: null } } },
    { firstAnswer: { ...base, evidence: { excerptId: id, quote: "Picture it: a narrow mountain pass" } } }, // eco de cita (el servidor la deriva del ID)
    { firstAnswer: { ...base, evidence: { excerptId: id, beatIndex: 0, explanation: "early" } } },
  ]) {
    const r = await validateOrRepairOpeningReview({ rawReview: criticReview(s), script: s, model: "t", send: async () => msg(body) });
    assert.equal(r.firstAnswer.delivered, true); assert.equal(r.firstAnswer.evidence.quote, narrationCatalog(s.beats).find(e => e.id === id)!.quote);
  }
  for (const text of ["```json" + JSON.stringify({ a: 1 }) + "```", "\uFEFF" + JSON.stringify({ a: 1 }), "```\n" + JSON.stringify({ a: 1 }) + "\n```"]) assert.deepEqual(extractJsonDocument(text), { a: 1 });
});

test("capa B: lo que NO es forma sigue fallando (sin rebajar el estándar)", () => {
  const schema = z.object({ firstAnswer: z.object({ delivered: z.boolean(), evidence: z.object({ excerptId: z.string().min(1) }).strict(), explanation: z.string().min(1) }).strict() }).strict();
  for (const body of [
    { firstAnswer: { delivered: "yes", evidence: { excerptId: "a" }, explanation: "x" } },       // tipo erróneo
    { firstAnswer: { delivered: true, evidence: {}, explanation: "x" } },                         // falta el ID
    { firstAnswer: { delivered: true, evidence: { quote: "solo cita" }, explanation: "x" } },     // cita sin ID: no es anotación
    { firstAnswer: { delivered: true, evidence: { excerptId: "a" }, explanation: "" } },          // texto requerido vacío
    { firstAnswer: { delivered: true, evidence: { excerptId: "a" }, explanation: "x" }, findings: [] }, // intenta cambiar otros juicios
    { firstAnswer: { delivered: true, evidence: { excerptId: "a", nested: { q: 1 } }, explanation: "x" } }, // contenido estructurado extra
  ]) assert.throws(() => validateDocumentaryValue(schema, body), DocumentaryResponseError);
  for (const r of [msg("Here is the JSON: {\"a\":1}"), msg("{\"a\":1", "end_turn"), msg("{\"a\":1}", "max_tokens")])
    assert.throws(() => parseDocumentaryResponse(z.object({ a: z.number() }), r), DocumentaryResponseError);
  // Idempotencia y no mutación.
  const v = { firstAnswer: { delivered: true, evidence: { excerptId: "a", explanation: "" }, explanation: "x" } }, before = structuredClone(v);
  const once = normalizeToContract(schema, v); assert.deepEqual(v, before);
  assert.deepEqual(normalizeToContract(schema, once.value).actions, []);
});

test("evidencia fuera del límite de 150 palabras o inventada -> bloqueo editorial, nunca aprobación", async () => {
  const s = REAL.script, raw = criticReview(s);
  for (const excerptId of [raw.firstAnswer.evidence.excerptId, "invented:b0:w1"]) {
    const r = await validateOrRepairOpeningReview({ rawReview: raw, script: s, model: "t", send: async () => msg({ firstAnswer: { delivered: true, evidence: { excerptId }, explanation: "late" } }) });
    assert.equal(r.firstAnswer.delivered, false); assert.ok(editorialBlockers(r).length > 0);
  }
});

// ── 4. Interrupción, reanudación y contaminación de estado ─────────────────────────────────────────
test("interrupción antes de la llamada pagada y reanudación: una sola llamada pagada en total", async () => {
  const l = ledger(p => { if (isOpeningRepair(p)) return incidentRepair(REAL.script); throw new Error("unexpected"); });
  l.crashAfter = 0;
  await assert.rejects(pipeline(REAL, 900, incidentRepair, l), /SIMULATED_INTERRUPTION/);
  l.crashAfter = Infinity;
  const r = await pipeline(REAL, 900, incidentRepair, l);
  assert.ok(r.report); assert.equal(l.paid, 1);
  const again = await pipeline(REAL, 900, incidentRepair, l); assert.ok(again.report); assert.equal(l.paid, 1);
});

test("generaciones consecutivas no contaminan estado (A, B, A)", async () => {
  const B = synthetic(5, 150, "es");
  const a1 = await pipeline(REAL, 900, incidentRepair), b = await pipeline(B, 300, incidentRepair), a2 = await pipeline(REAL, 900, incidentRepair);
  assert.equal(a1.report!.scriptHash, a2.report!.scriptHash); assert.notEqual(a1.report!.scriptHash, b.report!.scriptHash);
  assert.deepEqual(a1.report!.reviews, a2.report!.reviews);
});

// ── 5. Marcas de edición (metadatos) vs narrativa ──────────────────────────────────────────────────
test("REAL: protectInEdit[2] parafraseada bloqueaba (e68da2b); se ancla a su tramo literal sin tocar la narración", () => {
  const s = REAL.script, h = REAL.creativeHistory;
  assert.ok(creativeDirectionIssues(anchorCreativeDirectionQuotes(s.creativeDirection, s.beats), s.beats, h).some(i => i.includes("narración literal")));
  const fixed = anchorCreativeDirectionSpans(s.creativeDirection, s.beats);
  assert.deepEqual(creativeDirectionIssues(fixed, s.beats, h), []);
  assert.ok(s.beats[2].narration.includes(fixed.protectInEdit[2].quote));
});
test("una marca inventada (sin tramo literal suficiente) sigue bloqueando", () => {
  const s = structuredClone(REAL.script);
  s.creativeDirection.protectInEdit[2] = { beatIndex: 2, quote: "The Huns surely would have won every battle against any Greek army ever assembled anywhere." };
  assert.ok(creativeDirectionIssues(anchorCreativeDirectionSpans(s.creativeDirection, s.beats), s.beats, REAL.creativeHistory).some(i => i.includes("narración literal")));
});
