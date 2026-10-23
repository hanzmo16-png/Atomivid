import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeCreativeDirection, creativeDirectionIssues, locateLiteralPassage } from "./creative-direction";
import { generateDocumentaryScript, type DocumentaryDraft } from "./documentary-script";
import { editorialApprovalError, EditorialQualityError, EDITORIAL_FEEDBACK_CONTRACT, type EditorialReport } from "./editorial";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { documentaryFormError } from "./form-error";
import { draftObservations } from "@/components/video/DocumentaryDraftView";
import { CASE_290DE42B_DIRECTION, CASE_290DE42B_HISTORY, CASE_290DE42B_NARRATIONS, CASE_290DE42B_PARAPHRASE } from "./editorial-case-290de42b.test-fixtures";

const GENERIC = "Las marcas de edición, el detalle propio, la frase compartible y el cierre deben citar narración literal.";
const realBeats = CASE_290DE42B_NARRATIONS.map(narration => ({ narration }));
const input = { researchPack: { topic: "Evidence behind a legend", sources: [{ id: "s1", title: "Archive", kind: "primary" as const }], openQuestions: [] },
  targetDurationSeconds: 180, mode: "curiosity_documentary" as const };
/** The writer quotes a passage with a capital first letter while the narration has it mid-sentence (the 290de42b pattern). */
function capitalisedQuoteDraft() {
  const s = editorialFixture();
  s.beats[1].narration = "And a" + s.beats[1].narration.slice(1);   // narration: "…And a published account…"; quote stays "A published account…"
  return s;
}

test("regresión 839857e1/65f25654: el borrador real (sin objeciones del revisor) pasa la comprobación de estructura", () => {
  // The bug, on the real data: two passages are in their beat but differ only by a capital first letter.
  const exact = [CASE_290DE42B_DIRECTION.protectInEdit[0], CASE_290DE42B_DIRECTION.shareableLine].map(p => realBeats[p.beatIndex].narration.includes(p.quote));
  assert.deepEqual(exact, [false, false], "the original exact check rejects both passages");
  assert.deepEqual(creativeDirectionIssues(CASE_290DE42B_DIRECTION, realBeats, CASE_290DE42B_HISTORY), []);
  assert.deepEqual(creativeDirectionIssues(CASE_290DE42B_DIRECTION, realBeats, CASE_290DE42B_HISTORY, 5, { detail: true }), []);
  // Approval stores the exact narration text, so every later exact use of the passage holds.
  const canon = canonicalizeCreativeDirection(CASE_290DE42B_DIRECTION, realBeats);
  assert.equal(canon.protectInEdit[0].quote, "lo que escribe en ese cuaderno no tiene título, no está dirigido a nadie, no fue pensado para publicarse.");
  assert.equal(canon.shareableLine.quote, "la filosofía no lo salvó de la guerra ni de la plaga. Solo le dio una forma de atravesarlas sin perderse.");
  for (const p of [canon.signatureDetail, canon.shareableLine, ...canon.protectInEdit, canon.commentMoment, canon.closingCta])
    assert.ok(realBeats[p.beatIndex].narration.includes(p.quote));
  assert.deepEqual(CASE_290DE42B_DIRECTION.protectInEdit[0].quote[0], "L", "the input is not mutated");
});

test("la validación no se debilita: una paráfrasis real sigue bloqueando, y con passages-v1 se nombra el pasaje", () => {
  const d = structuredClone(CASE_290DE42B_DIRECTION); d.protectInEdit[2] = { beatIndex: 3, quote: CASE_290DE42B_PARAPHRASE };
  assert.deepEqual(creativeDirectionIssues(d, realBeats, CASE_290DE42B_HISTORY), [GENERIC]);
  const detailed = creativeDirectionIssues(d, realBeats, CASE_290DE42B_HISTORY, 5, { detail: true });
  assert.equal(detailed.length, 1);
  assert.match(detailed[0], /creativeDirection\.protectInEdit\[2\] \(bloque 4\)/);
  assert.ok(detailed[0].includes(CASE_290DE42B_PARAPHRASE.slice(0, 40)));
  // Changed words, reordered text or another beat never match; only case, spacing, quotes and dashes are tolerated.
  assert.equal(locateLiteralPassage(realBeats[0].narration, "Lo que escribió en ese cuaderno no tiene título"), null);
  assert.equal(locateLiteralPassage(realBeats[1].narration, "Lo que escribe en ese cuaderno no tiene título"), null);
  assert.equal(locateLiteralPassage(realBeats[0].narration, "siglos después, lo conocemos como ‘Meditaciones’ - pero"), "Siglos después, lo conocemos como 'Meditaciones' — pero");
  // Too-short passages still block.
  const short = structuredClone(CASE_290DE42B_DIRECTION); short.signatureDetail = { beatIndex: 0, quote: "Ese hombre" };
  assert.deepEqual(creativeDirectionIssues(short, realBeats, CASE_290DE42B_HISTORY), [GENERIC]);
});

test("guion válido: 1 escritura + 1 revisión → aprobado y apto para el preflight audiovisual (antes: bloqueado tras 2 pasadas)", async () => {
  const draft = capitalisedQuoteDraft();
  let writes = 0, reads = 0, report!: EditorialReport;
  const beats = await generateDocumentaryScript({ ...input, editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    parse: async () => { writes++; return structuredClone(draft); },
    review: async ({ prompt }) => { reads++; return passingReview(JSON.parse(prompt).script); },
    onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(report.corrected, false);
  assert.ok(beats[1].narration.includes(report.creativeDirection!.signatureDetail.quote));
  // The same gate that confirm-production / render / run-job apply before any audiovisual spend.
  assert.equal(editorialApprovalError({ beats, editorial: report }), null);
});

test("objeción real del revisor: una corrección con sus observaciones, segunda evaluación aprobada", async () => {
  const draft = editorialFixture();
  let writes = 0, reads = 0, correctionPrompt = "", report!: EditorialReport;
  await generateDocumentaryScript({ ...input, editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    parse: async ({ prompt }) => { writes++; if (writes === 2) correctionPrompt = prompt; return structuredClone(draft); },
    review: async ({ prompt }) => { reads++; const r = passingReview(JSON.parse(prompt).script);
      if (reads === 1) r.findings.push({ kind: "unsupported_claim", severity: "blocking", evidence: [r.sections[3]], explanation: "Se atribuye a historiadores sin fuente.", repair: "Atribuye a la fuente concreta y marca la incertidumbre." });
      return r; },
    onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 2); assert.equal(reads, 2);
  assert.match(correctionPrompt, /Se atribuye a historiadores sin fuente\./);
  assert.match(correctionPrompt, /BORRADOR ANTERIOR/);
  assert.equal(report.corrected, true); assert.equal(report.reviews.length, 2);
});

test("objeción real que persiste: se detiene tras la corrección prevista, sin llamadas extra, con el borrador y la causa visibles", async () => {
  const draft = editorialFixture(); const drafts: DocumentaryDraft[] = []; let writes = 0, reads = 0;
  const error = await generateDocumentaryScript({ ...input, editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    parse: async () => { writes++; return structuredClone(draft); },
    review: async ({ prompt }) => { reads++; const r = passingReview(JSON.parse(prompt).script);
      r.findings.push({ kind: "unsupported_claim", severity: "blocking", evidence: [r.sections[2]], explanation: "Afirmación sin respaldo.", repair: "Retírala o atribúyela." }); return r; },
    onDraft: async d => { drafts.push(d); } }).catch(e => e);
  assert.ok(error instanceof EditorialQualityError);
  assert.equal(error.correctionExhausted, true); assert.equal(error.reviewerBlocking, 1);
  assert.equal(writes, 2); assert.equal(reads, 2, "no third paid round without the owner asking");
  const last = drafts.at(-1)!;
  assert.equal(last.status, "unapproved");
  assert.deepEqual(last.issues?.map(i => i.source), ["reviewer"]);
  assert.match(documentaryFormError(error, "abc12345"), /^El guion mantiene observaciones editoriales pendientes\. La corrección prevista ya se utilizó\./);
  const obs = draftObservations(last);
  assert.equal(obs.blocking[0].label, "Revisor editorial"); assert.match(obs.blocking[0].text, /Afirmación sin respaldo/);
});

test("solo falla la estructura: el mensaje no culpa al revisor y la corrección nombra el pasaje exacto", async () => {
  const draft = editorialFixture(); draft.creativeDirection.protectInEdit[1] = { beatIndex: 2, quote: "A paraphrase that the narration never says" };
  const drafts: DocumentaryDraft[] = []; let correction = "";
  const error = await generateDocumentaryScript({ ...input, editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    parse: async ({ prompt }) => { if (prompt.includes("CORRECCIÓN OBLIGATORIA")) correction = prompt; return structuredClone(draft); },
    review: async ({ prompt }) => passingReview(JSON.parse(prompt).script), onDraft: async d => { drafts.push(d); } }).catch(e => e);
  assert.ok(error instanceof EditorialQualityError); assert.equal(error.reviewerBlocking, 0);
  assert.match(correction, /creativeDirection\.protectInEdit\[1\] \(bloque 3\)/);
  assert.match(documentaryFormError(error, "abc12345"), /^El revisor no tiene objeciones de contenido, pero el guion no pasó una comprobación de estructura/);
  const obs = draftObservations(drafts.at(-1)!);
  assert.deepEqual(obs.blocking.map(b => b.label), ["Comprobación de estructura"]);
  assert.equal(obs.reviewed && obs.reviewerBlocking === 0, true);
});

test("compatibilidad de reproducción: un trabajo guardado sin passages-v1 envía exactamente el texto original (las respuestas pagadas se reutilizan)", async () => {
  const draft = editorialFixture(); draft.creativeDirection.protectInEdit[1] = { beatIndex: 2, quote: "A paraphrase that the narration never says" };
  let correction = "";
  await generateDocumentaryScript({ ...input,
    parse: async ({ prompt }) => { if (prompt.includes("CORRECCIÓN OBLIGATORIA")) correction = prompt; return structuredClone(draft); },
    review: async ({ prompt }) => passingReview(JSON.parse(prompt).script) }).catch(() => undefined);
  const observations = JSON.parse(correction.slice(correction.indexOf("OBSERVACIONES (datos del editor): ") + "OBSERVACIONES (datos del editor): ".length));
  assert.deepEqual(observations.issues, [GENERIC]);
  assert.ok(!correction.includes("creativeDirection.protectInEdit"));
});

test("caso 290de42b reanudado: la última pasada guardada (revisor sin objeciones, solo mayúsculas) se aprueba sin otra escritura", async () => {
  // Same orchestration as the real retry: drafts 1 and 2 carry the genuine paraphrase (still blocked, generic text kept),
  // draft 3 only the capitalised passages. With two owner rounds the loop reaches draft 3 and approves it.
  const base = capitalisedQuoteDraft();
  const paraphrased = structuredClone(base); paraphrased.creativeDirection.protectInEdit[1] = { beatIndex: 2, quote: "A paraphrase that the narration never says" };
  const drafts = [paraphrased, paraphrased, base]; let writes = 0, reads = 0, report!: EditorialReport;
  await generateDocumentaryScript({ ...input, extraEditorialRounds: 2,
    parse: async () => structuredClone(drafts[writes++]),
    review: async ({ prompt }) => { reads++; return passingReview(JSON.parse(prompt).script); }, onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 3); assert.equal(reads, 3);
  assert.equal(report.reviews.length, 3);
});
