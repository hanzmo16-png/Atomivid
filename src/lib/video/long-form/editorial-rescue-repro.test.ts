// Reproducción del error ORIGINAL (incidentes 23d86d0a / 8c330c37, job e8048599). Solo usa APIs que ya existían
// en e68da2b, para poder ejecutar ESTE archivo contra el código de producción y contra la corrección:
//   e68da2b  -> falla con "La respuesta no cumple el formato editorial requerido" (el error de producción)
//   rama     -> pasa.
// REAL: borrador persistido (fixture). SIMULADO: respuestas del crítico/comprobación (forma tomada del ledger, PR #190).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialReport } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview } from "./editorial-opening-repair";
import { generateDocumentaryScript } from "./documentary-script";

const REAL = JSON.parse(readFileSync(new URL("./__fixtures__/incident-e8048599-draft.json", import.meta.url), "utf8"));
const script = REAL.script;
const cat = narrationCatalog(script.beats), last = script.beats.length - 1, first = (i: number) => cat.find(e => e.beatIndex === i)!.id;
const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) >= 144)!;
const critic = () => ({ sections: script.beats.map((_: unknown, i: number) => ({ excerptId: first(i), contribution: `c${i}`, function: i === last ? "resolution" : "new_information" })),
  firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "Delivered in the opening block." },
  ending: { resolvesPromise: true, evidence: { excerptId: first(last) }, explanation: "Resolved in the close." }, findings: [] });
const eligible = openingEvidence(script.beats).find(e => e.id.endsWith(":b0:w132"))!;
const incident = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ firstAnswer: { delivered: true,
  evidence: { excerptId: eligible.id, explanation: "" }, explanation: "The opening states that Leonidas died in 480 BCE and Attila led the Huns about nine hundred years later.".padEnd(565, " A concrete payoff.").slice(0, 565) } }) }] });

test("repro: la respuesta del incidente (clave vacía extra) es aceptada en la comprobación de apertura", async () => {
  const r = await validateOrRepairOpeningReview({ rawReview: critic(), script, model: "claude-sonnet-5", send: async () => incident() });
  assert.equal(r.firstAnswer.delivered, true); assert.equal(r.firstAnswer.evidence.quote, eligible.quote); assert.deepEqual(editorialBlockers(r), []);
});

test("repro: el job REAL completo llega a guion aprobado reutilizando la respuesta persistida (0 llamadas nuevas al reintentar)", async () => {
  const committed = new Map<string, unknown>(); let paid = 0;
  const send = async (p: Record<string, unknown>) => { const k = stableHash(p, 16); if (!committed.has(k)) { paid++; committed.set(k, incident()); } return structuredClone(committed.get(k)) as ReturnType<typeof incident>; };
  const run = async () => { let report: EditorialReport | undefined;
    await generateDocumentaryScript({ researchPack: { topic: "t", sources: REAL.sourceIds.map((id: string) => ({ id, title: id, kind: "secondary" as const })), openQuestions: [] },
      mode: "curiosity_documentary", language: "en", targetDurationSeconds: 900, referenceContract: "catalog-v1", creativeHistory: REAL.creativeHistory,
      parse: async () => structuredClone(script), review: async () => critic(), send, onEditorialApproved: r => { report = r; } });
    return report; };
  assert.ok(await run()); assert.ok(await run()); assert.equal(paid, 1);
});
