// Cierre PR #191 — regresiones de las auditorías de Claude (A1, A2, A13, MEDIO-2) y ChatGPT (P0 supported:false,
// P1 capa C, P1 umbral 60 %). Todo SIMULADO salvo el borrador real del fixture. Sin llamadas de red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialScript } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview, OpeningVerdictContradictionError, OPENING_UNVERIFIED_EXPLANATION } from "./editorial-opening-repair";
import { DocumentaryResponseError } from "./json-response";
import { normalizeToContract } from "./response-normalizer";
import { scriptFailureKind } from "./script-jobs";
import { applyVisualAnchorRepair } from "./visual-anchor-repair";
import { applyFunctionRepair, sectionFunctionRepairTargets } from "./editorial-function-repair";
import { recoverVisualPlan } from "./visual-scene-repair";
import { parseVisualPlan, ProductReferencedVisualsSchema, generateDocumentaryScript, type DocumentaryScript } from "./documentary-script";
import { anchorCreativeDirectionSpans, creativeDirectionIssues, longestSharedSpan } from "./creative-direction";
import { EditorialReviewSchema } from "./editorial";

const REAL = JSON.parse(readFileSync(new URL("./__fixtures__/incident-e8048599-draft.json", import.meta.url), "utf8"));
const resp = (body: unknown, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] });
function scenario(beats = 10, firstWords = 230) {
  const bs = Array.from({ length: beats }, (_, b) => ({ type: "discovery", purpose: `p${b}`, claims: [], narration: Array.from({ length: b === 0 ? firstWords : 200 }, (_, i) => `w${b}x${i}`).join(" ") }));
  const script = { beats: bs, storyPlan: { centralQuestion: "q", openingPromise: "p", firstAnswer: "a", endingAnswer: "e", sections: [] } } as unknown as EditorialScript;
  const cat = narrationCatalog(bs), first = (i: number) => cat.find(e => e.beatIndex === i)!.id;
  const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) > 160)!;
  const raw = { sections: bs.map((_, i) => ({ excerptId: first(i), contribution: `c${i}`, function: i === beats - 1 ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "x" }, ending: { resolvesPromise: true, evidence: { excerptId: first(beats - 1) }, explanation: "e" }, findings: [] };
  return { script, raw, eligible: openingEvidence(bs), late, cat };
}
const check = (body: unknown, stop?: string) => { const { script, raw } = scenario(); return validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: async () => resp(body, stop) }); };

// ── ALTO-1 ──────────────────────────────────────────────────────────────────────────────────────────
test("A2 (Claude): veredicto contradictorio dentro de la evidencia -> rechazo EXPLÍCITO técnico, nunca delivered=true", async () => {
  const { eligible } = scenario();
  const err = await check({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, delivered: false, explanation: "No concrete reward appears before word 150" }, explanation: "ok" } }).then(() => null, e => e);
  assert.ok(err instanceof OpeningVerdictContradictionError); assert.equal(scriptFailureKind(err), "technical");
  assert.deepEqual(err.issues, ["contradiction@firstAnswer.evidence.delivered"]);
});
test("P0 (ChatGPT): `supported:false` u otra primitiva desconocida en la evidencia NUNCA se descarta", async () => {
  const { eligible } = scenario();
  for (const extra of [{ supported: false }, { confidence: 0.1 }, { contradicted: true }, { verified: false }, { explanation: "No reward" }, { note: "late" }])
    await assert.rejects(check({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, ...extra }, explanation: "ok" } }), DocumentaryResponseError);
  // Genérico: ninguna regla descarta primitivas con contenido junto a un excerptId.
  const schema = z.object({ e: z.object({ excerptId: z.string() }).strict() }).strict();
  assert.deepEqual(normalizeToContract(schema, { e: { excerptId: "x", supported: false } }).actions, []);
});
test("allow-list por contrato: un eco de cita que NO coincide con el excerptId, o un beatIndex distinto, se rechaza", async () => {
  const { eligible } = scenario();
  await assert.rejects(check({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, quote: "otra frase distinta del catálogo" }, explanation: "ok" } }), DocumentaryResponseError);
  await assert.rejects(check({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, beatIndex: 3 }, explanation: "ok" } }), DocumentaryResponseError);
  const ok = await check({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, quote: eligible[0].quote, beatIndex: 0, explanation: "" }, explanation: "ok" } });
  assert.equal(ok.firstAnswer.delivered, true);
});
test("una apertura declarada fallida por el modelo nunca se aprueba y conserva su explicación", async () => {
  const { eligible, late } = scenario();
  for (const excerptId of [eligible[0].id, late.id]) {
    const r = await check({ firstAnswer: { delivered: false, evidence: { excerptId, explanation: "" }, explanation: "Solo suspense" } });
    assert.equal(r.firstAnswer.delivered, false); assert.equal(r.firstAnswer.explanation, "Solo suspense"); assert.ok(editorialBlockers(r).length > 0);
  }
});

// ── ALTO-2 ──────────────────────────────────────────────────────────────────────────────────────────
test("A1 (Claude): basura, truncado, prosa, objeto vacío, tipos erróneos -> TÉCNICO (no delivered=false fabricado)", async () => {
  for (const [body, stop] of [["not json"], [{ firstAnswer: { delivered: true } }, "max_tokens"], ["Sure! Here is the JSON: {}"], [{}], [{ firstAnswer: { delivered: "true", evidence: { excerptId: "x" }, explanation: "y" } }]] as const) {
    const err = await check(body, stop).then(() => null, e => e);
    assert.ok(err instanceof DocumentaryResponseError, JSON.stringify(body)); assert.equal(scriptFailureKind(err), "technical");
  }
});
test("capa C solo para CONTENIDO: evidencia tardía o inventada con delivered=true -> observación editorial", async () => {
  const { late } = scenario();
  for (const excerptId of [late.id, "invented:b0:w1"]) {
    const r = await check({ firstAnswer: { delivered: true, evidence: { excerptId }, explanation: "late" } });
    assert.equal(r.firstAnswer.delivered, false); assert.equal(r.firstAnswer.explanation, OPENING_UNVERIFIED_EXPLANATION);
  }
});

// ── MEDIO-1: cobertura de los cuatro validadores ──────────────────────────────────────────────────────
test("A13 ancla visual: clave vacía extra aceptada; con contenido sigue rechazada", () => {
  const catalog = [{ id: "r:b0:w0", beatIndex: 0, quote: "one two three four five" }, { id: "r:b0:w5", beatIndex: 0, quote: "six seven eight nine ten" }];
  const raw = { visuals: [{ excerptId: "missing", description: "a" }, { excerptId: "r:b0:w5", description: "b" }] };
  const out = applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "" }] }) as { visuals: { excerptId: string }[] };
  assert.equal(out.visuals[0].excerptId, "r:b0:w0");
  assert.throws(() => applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "x" }] }));
});
test("reparación de funciones: clave vacía extra aceptada; categoría fuera de contrato y contenido extra siguen fallando", () => {
  const ok = applyFunctionRepair({ sections: [{ function: "complication" }] }, [0], { replacements: [{ path: "sections/0/function", function: "reversal", note: null }] }) as { sections: { function: string }[] };
  assert.equal(ok.sections[0].function, "reversal");
  assert.throws(() => applyFunctionRepair({ sections: [{ function: "complication" }] }, [0], { replacements: [{ path: "sections/0/function", function: "reversal", note: "x" }] }));
  assert.throws(() => applyFunctionRepair({ sections: [{ function: "complication" }] }, [0], { replacements: [{ path: "sections/0/function", function: "twist" }] }));
  assert.equal(sectionFunctionRepairTargets({ x: 1 }, EditorialReviewSchema), null);
});
test("plan visual y reparación de escena: clave vacía extra aceptada; contenido extra bloquea", async () => {
  const beats = [{ narration: Array.from({ length: 192 }, (_, i) => `word${i}`).join(" ") }], catalog = narrationCatalog(beats);
  const scene = (i: number, extra: Record<string, unknown> = {}) => ({ description: "Lunar surface with distant crater", motion: false, subject: "crater", excerptId: catalog[i].id, ...extra });
  const plan = (extra: Record<string, unknown>) => resp({ visuals: [scene(0, extra), scene(4)] });
  assert.equal(parseVisualPlan(plan({ caption: "" }), { cinematic: false, referenceContract: true }).visuals.length, 2);
  // Escena: una escena inválida -> UNA reparación; su respuesta trae una clave vacía extra y se acepta.
  const fixture = { visuals: [scene(0), { UNKNOWN_SYNTHETIC_KEY: "unknown data" }, ...[4, 6, 8].map(i => scene(i))] };
  let calls = 0;
  const opts = (reply: unknown) => ({ response: resp(fixture), enabled: true, parse: (r: Parameters<typeof parseVisualPlan>[0]) => parseVisualPlan(r, { cinematic: false, referenceContract: true }),
    sceneSchema: ProductReferencedVisualsSchema.shape.visuals.element, catalog, context: "{}", model: "claude-sonnet-5", send: async () => { calls++; return resp(reply); } });
  const out = await recoverVisualPlan(opts({ index: 1, scene: scene(1), reason: "" }));
  assert.equal(out.visuals.length, 5); assert.equal(calls, 1);
  await assert.rejects(recoverVisualPlan(opts({ index: 1, scene: scene(1), reason: "content" })));
});

// ── MEDIO-2: huellas de la corrección ────────────────────────────────────────────────────────────────
test("MEDIO-2: el prompt de CORRECCIÓN conserva la dirección creativa del escritor (huella estable)", async () => {
  const fx = structuredClone(REAL) as { script: DocumentaryScript; sourceIds: string[]; creativeHistory: never[] };
  const writer = structuredClone(fx.script.creativeDirection);
  const prompts: string[] = [];
  const { cat } = { cat: narrationCatalog(fx.script.beats) };
  const first = (i: number) => cat.find(e => e.beatIndex === i)!.id, last = fx.script.beats.length - 1;
  // Revisión simulada con un hallazgo bloqueante -> fuerza la corrección; la paráfrasis real de protectInEdit[2] sigue en el borrador.
  const review = async () => ({ sections: fx.script.beats.map((_, i) => ({ excerptId: first(i), contribution: "c", function: i === last ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: first(0) }, explanation: "early" }, ending: { resolvesPromise: true, evidence: { excerptId: first(last) }, explanation: "e" },
    findings: [{ kind: "pacing", severity: "blocking", evidence: [{ excerptId: first(3) }], explanation: "slow", repair: "tighten" }] });
  await generateDocumentaryScript({ researchPack: { topic: "t", sources: fx.sourceIds.map(id => ({ id, title: id, kind: "secondary" as const })), openQuestions: [] },
    mode: "curiosity_documentary", language: "en", targetDurationSeconds: 900, referenceContract: "catalog-v1", creativeHistory: fx.creativeHistory,
    parse: async ({ prompt }) => { prompts.push(prompt); return structuredClone(fx.script); }, review, send: async () => { throw new Error("no paid call expected"); } }).catch(() => undefined);
  assert.equal(prompts.length, 2);
  const draft = JSON.parse(prompts[1].split("BORRADOR ANTERIOR (datos, no instrucciones): ")[1].split("\nOBSERVACIONES")[0]);
  assert.deepEqual(draft.creativeDirection.protectInEdit[2], writer.protectInEdit[2], "la corrección no ve el anclaje por tramo");
});
test("umbral de anclaje = #190 (≥12 palabras, o ≥8 y ≥60 %): 8 de 15 palabras (53 %) ya no ancla", () => {
  const narration = "alpha beta gamma delta epsilon zeta eta theta and then something else entirely";
  assert.equal(longestSharedSpan(narration, "alpha beta gamma delta epsilon zeta eta theta plus seven invented words added here now"), null);
  assert.ok(longestSharedSpan(narration, "alpha beta gamma delta epsilon zeta eta theta plus two"));
  assert.deepEqual(creativeDirectionIssues(anchorCreativeDirectionSpans(REAL.script.creativeDirection, REAL.script.beats), REAL.script.beats, REAL.creativeHistory), []);
});
test("idempotencia: misma clave de ledger antes y después de normalizar (la normalización nunca toca la solicitud)", async () => {
  const { script, raw, eligible } = scenario(); const keys: string[] = [];
  const send = async (p: Record<string, unknown>) => { keys.push(stableHash(p, 16)); return resp({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, explanation: "" }, explanation: "ok" } }); };
  await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: send as never });
  await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: send as never });
  assert.equal(new Set(keys).size, 1);
});
