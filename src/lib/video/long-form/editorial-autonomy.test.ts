import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDocumentaryScript, type DocumentaryDraft, type DocumentaryScript } from "./documentary-script";
import { autoCorrectionBudget, editorialApprovalError, editorialBlockers, EditorialQualityError, validateEditorialReview, EDITORIAL_AUTONOMY_CONTRACT,
  EDITORIAL_FEEDBACK_CONTRACT, EDITORIAL_REVIEWER_SYSTEM, EDITORIAL_RUBRIC, type EditorialReport, type EditorialReview } from "./editorial";
import { creativeFixture, editorialFixture, passingReview } from "./editorial.test-fixtures";
import { documentaryFormError } from "./form-error";
import { scriptFailureKind } from "./script-jobs";
import { CASE_54740B5A_DRAFT, CASE_54740B5A_REVIEW, CASE_54740B5A_SOURCES } from "./editorial-case-54740b5a.test-fixtures";
import { CASE_290DE42B_HISTORY } from "./editorial-case-290de42b.test-fixtures";

const AUTO = { editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT, editorialAutonomy: EDITORIAL_AUTONOMY_CONTRACT, autoCorrections: 2 } as const;
const pack = (topic: string) => ({ topic, sources: [{ id: "s1", title: "Archive", kind: "primary" as const }], openQuestions: [] });

/** A five-block documentary on `topic` (synthetic narration; tests orchestration, never live model judgment). */
function topicScript(topic: string, openings: string[]): DocumentaryScript {
  const s = editorialFixture();
  s.title = topic; s.workingTitleOptions = [topic]; s.hook = openings[0];
  s.beats.forEach((b, i) => { b.purpose = openings[i]; b.narration = openings[i] + " " + b.narration.split(" ").slice(openings[i].split(/\s+/).length).join(" "); });
  s.creativeDirection = creativeFixture(s.beats.map(b => b.narration));
  s.storyPlan.firstAnswer = openings[0]; s.storyPlan.endingAnswer = openings[4];
  s.storyPlan.sections.forEach((x, i) => { x.newInformation = openings[i]; });
  return s;
}
/** Simulated reviewer: judges the narration it receives (marker words stand for the defect a real critic would see). */
function judge(script: DocumentaryScript): EditorialReview {
  const r = passingReview(script);
  script.beats.forEach((b, i) => {
    if (b.narration.includes("REPITE")) r.sections[i].function = "restatement";
    if (b.narration.includes("SIN-FUENTE")) r.findings.push({ kind: "unsupported_claim", severity: "blocking",
      evidence: [{ beatIndex: i, quote: b.narration.split(" ").slice(0, 7).join(" ") }],
      explanation: `El bloque ${i + 1} presenta como hecho una cifra que el material no respalda.`, repair: "Atribuye la cifra a la fuente o márcala como estimación." });
    if (i === 0 && b.narration.includes("TARDE")) r.firstAnswer = { ...r.firstAnswer, delivered: false, explanation: "La apertura aplaza el dato central." };
  });
  return r;
}
/** Simulated writer, stateless like a provider call: rewrites a block ONLY when the correction prompt carries a located
 * instruction for it, and keeps its creative-direction quotes in sync with what it rewrote (as the contract requires). */
function writer(base: DocumentaryScript, fix: (prompt: string, draft: DocumentaryScript) => DocumentaryScript | null) {
  const prompts: string[] = []; const systems: string[] = [];
  return { prompts, systems, parse: async ({ system, prompt }: { system: string; prompt: string }) => {
    prompts.push(prompt); systems.push(system);
    return structuredClone(prompt.includes("CORRECCIÓN OBLIGATORIA") ? fix(prompt, structuredClone(base)) ?? base : base);
  } };
}
const repairBlock = (s: DocumentaryScript, i: number, marker: string) => {
  s.beats[i].narration = s.beats[i].narration.replace(marker, "nuevo dato respaldado");
  s.creativeDirection = creativeFixture(s.beats.map(b => b.narration));
  return s;
};

test("regresión 54740b5a (Voyager 1): el veredicto REAL del revisor ya no se convierte en bloqueo y el borrador real se aprueba sin corrección", async () => {
  const review = validateEditorialReview(CASE_54740B5A_REVIEW, CASE_54740B5A_DRAFT);
  // What the reviewer actually said: no blocking finding, payoff delivered, resolution in block 4, close labelled restatement.
  assert.equal(review.findings.filter(f => f.severity === "blocking").length, 0);
  assert.equal(review.ending.resolvesPromise, true); assert.equal(review.ending.evidence.beatIndex, 3);
  assert.equal(review.sections[4].function, "restatement");
  assert.deepEqual(editorialBlockers(review), [], "before the fix: [\"El bloque 5 repite sin avanzar: Reencuadra el arreglo…\"]");
  let writes = 0, reads = 0, report!: EditorialReport;
  const beats = await generateDocumentaryScript({ researchPack: { topic: "Voyager 1", sources: CASE_54740B5A_SOURCES, openQuestions: [] },
    targetDurationSeconds: 420, mode: "curiosity_documentary", language: "es", creativeHistory: CASE_290DE42B_HISTORY, ...AUTO,
    parse: async () => { writes++; return structuredClone({ ...CASE_54740B5A_DRAFT, beats: CASE_54740B5A_DRAFT.beats.map(b => ({ ...b,
      visuals: [{ description: "Voyager probe in deep space", motion: false, subject: "Voyager probe", quote: b.narration.split(" ").slice(0, 6).join(" ") },
        { description: "Deep Space Network dish at night", motion: false, subject: "radio dish", quote: b.narration.split(" ").slice(-6).join(" ") }] })) }); },
    review: async () => { reads++; return structuredClone(CASE_54740B5A_REVIEW); }, onEditorialApproved: r => { report = r; } });
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(report.corrected, false);
  assert.equal(editorialApprovalError({ beats, editorial: report }), null, "the production gate accepts it");
});

test("la integridad no baja: un bloque INTERMEDIO que repite, un cierre sin resolución o un cierre señalado como relleno siguen bloqueando", () => {
  const script = editorialFixture();
  const middle = passingReview(script); middle.sections[2].function = "restatement";
  assert.match(editorialBlockers(middle)[0], /^El bloque 3 repite sin avanzar/);
  const unresolved = passingReview(script); unresolved.sections[4].function = "restatement";
  unresolved.ending = { ...unresolved.ending, resolvesPromise: false, explanation: "El cierre no responde la pregunta." };
  assert.equal(editorialBlockers(unresolved).length, 2);
  const padded = passingReview(script); padded.sections[4].function = "restatement"; padded.ending.evidence = { ...padded.sections[3] };
  padded.findings.push({ kind: "padding", severity: "blocking", evidence: [{ beatIndex: 4, quote: padded.sections[4].quote }], explanation: "El cierre solo resume.", repair: "Di qué significa." });
  assert.deepEqual(editorialBlockers(padded), ["El cierre solo resume. Di qué significa."]);
});

const TOPICS: { topic: string; openings: string[]; defect: string; block: number; expectWrites: number }[] = [
  { topic: "Misterios del océano profundo", block: 2, defect: "REPITE", expectWrites: 2,
    openings: ["A 11 kilómetros de profundidad la presión aplasta cualquier submarino común.", "El batiscafo Trieste llegó al fondo en 1960 con una ventana agrietada.",
      "REPITE la presión es enorme y el fondo es profundo como ya dijimos antes.", "Los peces caracol viven a 8000 metros con huesos casi sin calcio.", "El fondo marino sigue menos cartografiado que la superficie de Marte."] },
  { topic: "La caída del Imperio romano", block: 3, defect: "SIN-FUENTE", expectWrites: 3,
    openings: ["En 476 un general depuso al último emperador de Occidente sin una sola batalla.", "Roma llevaba siglos dividida en dos mitades con capitales distintas.",
      "La inflación del siglo III vació la moneda de plata casi por completo.", "SIN-FUENTE murieron exactamente tres millones de soldados en la última década.", "Oriente sobrevivió mil años más: la caída fue de una mitad, no del imperio."] },
  { topic: "Cómo funciona un agujero negro", block: 0, defect: "TARDE", expectWrites: 2,
    openings: ["TARDE antes de hablar de agujeros negros conviene repasar mucha historia previa.", "Un agujero negro es masa tan concentrada que ni la luz escapa de su horizonte.",
      "El horizonte de sucesos no es una superficie sólida sino un límite sin retorno.", "En 2019 se fotografió la sombra del agujero negro de la galaxia M87.", "Su tamaño depende de la masa: el Sol cabría en un horizonte de tres kilómetros."] },
  { topic: "Historia de la inteligencia artificial", block: 4, defect: "CIERRE", expectWrites: 1,
    openings: ["En 1956 diez investigadores prometieron resolver la inteligencia en un verano.", "Los primeros programas jugaban a las damas pero fallaban fuera del tablero.",
      "Dos inviernos de financiación casi acabaron con el campo en los setenta y ochenta.", "Las redes neuronales volvieron con más datos y chips gráficos baratos: eso resolvió el enigma.",
      "Lo que queda es una lección: las promesas rápidas fallaron, el trabajo paciente no. Cuéntanos qué te sorprendió."] },
];

for (const t of TOPICS) test(`tema «${t.topic}»: rechazo inicial → corrección automática dirigida → segunda evaluación → aprobado y listo para producción`, async () => {
  const draft = topicScript(t.topic, t.openings);
  const w = writer(draft, (prompt, cur) => {
    // The instruction must name the block (and, for reviewer findings, quote its passage).
    if (!prompt.includes(`Bloque ${t.block + 1}`)) return null;
    // Rome: the first fix is insufficient; only the escalated instruction makes the writer rewrite the passage.
    if (t.defect === "SIN-FUENTE" && !prompt.includes("LA CORRECCIÓN ANTERIOR NO LO RESOLVIÓ")) return null;
    return repairBlock(cur, t.block, t.defect);
  });
  const reviewSeen: DocumentaryScript[] = []; const drafts: DocumentaryDraft[] = []; let report!: EditorialReport;
  const beats = await generateDocumentaryScript({ researchPack: pack(t.topic), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO,
    parse: w.parse, review: async ({ prompt }) => { const s = JSON.parse(prompt).script; reviewSeen.push(s); const r = judge(s);
      if (t.defect === "CIERRE") { r.sections[4].function = "restatement"; r.ending.evidence = { ...r.sections[3] }; } return r; },
    onDraft: async d => { drafts.push(d); }, onEditorialApproved: r => { report = r; } });
  assert.equal(w.prompts.length, t.expectWrites, "writer calls");
  assert.equal(reviewSeen.length, t.expectWrites, "one review per draft, never more");
  assert.equal(report.corrected, t.expectWrites > 1); assert.equal(report.reviews.length, t.expectWrites);
  if (t.expectWrites > 1) {
    assert.match(w.prompts[1], /CORRECCIÓN OBLIGATORIA — corrección automática 1 de 2/);
    assert.match(w.prompts[1], /INSTRUCCIONES DE CORRECCIÓN/);
  }
  // Persisted state: every pass saved its draft and, when blocked, why.
  if (t.expectWrites > 1) assert.ok(drafts.some(d => d.issues?.length), "the rejected pass was saved with its reasons");
  assert.equal(drafts.at(-1)!.pass, t.expectWrites - 1);
  assert.equal(editorialApprovalError({ beats, editorial: report }), null, "reaches the audiovisual preflight gate");
});

test("objeción que persiste: se detiene tras las correcciones automáticas configuradas, sin bucles, con diagnóstico verificable", async () => {
  const draft = topicScript("La caída del Imperio romano", TOPICS[1].openings);
  const w = writer(draft, () => null); // the writer never fixes it
  const drafts: DocumentaryDraft[] = []; let reads = 0;
  const error = await generateDocumentaryScript({ researchPack: pack("Roma"), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO,
    parse: w.parse, review: async ({ prompt }) => { reads++; return judge(JSON.parse(prompt).script); }, onDraft: async d => { drafts.push(d); } }).catch(e => e);
  assert.ok(error instanceof EditorialQualityError);
  assert.equal(w.prompts.length, 3); assert.equal(reads, 3);
  assert.equal(error.correctionsUsed, 2); assert.equal(error.reviewerBlocking, 1);
  assert.match(w.prompts[2], /LA CORRECCIÓN ANTERIOR NO LO RESOLVIÓ/);
  assert.equal(drafts.at(-1)!.issues?.[0].source, "reviewer");
  assert.match(documentaryFormError(error, "abc12345"), /ya hizo 2 correcciones automáticas/);
  assert.equal(scriptFailureKind(error), "editorial");
});

test("límite de gasto: el presupuesto automático se acota a 1–3 y el total de pasadas nunca supera 1 + 3 + 2", async () => {
  assert.equal(autoCorrectionBudget(undefined), 2); assert.equal(autoCorrectionBudget("0"), 1);
  assert.equal(autoCorrectionBudget("9"), 3); assert.equal(autoCorrectionBudget("abc"), 2);
  const draft = topicScript("La caída del Imperio romano", TOPICS[1].openings);
  const w = writer(draft, () => null);
  await generateDocumentaryScript({ researchPack: pack("Roma"), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO, autoCorrections: 99, extraEditorialRounds: 9,
    parse: w.parse, review: async ({ prompt }) => judge(JSON.parse(prompt).script) }).catch(() => undefined);
  assert.equal(w.prompts.length, 6);
});

test("recuperación tras interrupción: al reanudar, cada paso ya pagado se reutiliza y ningún prompt llega dos veces al proveedor", async () => {
  const draft = topicScript("Misterios del océano profundo", TOPICS[0].openings);
  const paid = new Map<string, unknown>(); let providerCalls = 0, crashAfter = 3;
  // Same idea as the ledger: the provider is reached only for a prompt never answered before.
  const ledger = <T>(fn: (a: { system: string; prompt: string }) => Promise<T>) => async (a: { system: string; prompt: string }) => {
    const key = JSON.stringify(a);
    if (paid.has(key)) return structuredClone(paid.get(key)) as T;
    if (providerCalls === crashAfter) throw new Error("worker interrupted");
    providerCalls++; const out = await fn(a); paid.set(key, structuredClone(out)); return out;
  };
  const run = () => { const w = writer(draft, (prompt, cur) => prompt.includes("Bloque 3") ? repairBlock(cur, 2, "REPITE") : null);
    return generateDocumentaryScript({ researchPack: pack("Océano"), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO,
      parse: ledger(w.parse), review: ledger(async ({ prompt }) => judge(JSON.parse(prompt).script)) }); };
  await assert.rejects(run(), /worker interrupted/);
  assert.equal(providerCalls, 3, "write, review, correction were paid before the interruption");
  crashAfter = Infinity;
  const beats = await run();
  assert.equal(providerCalls, 4, "resume paid ONLY the missing second review");
  assert.equal(paid.size, 4); assert.ok(beats.length === 5);
});

test("error real del proveedor durante una corrección: es técnico (reintentable), no editorial, y el borrador con sus motivos queda guardado", async () => {
  const draft = topicScript("Misterios del océano profundo", TOPICS[0].openings); let n = 0; const drafts: DocumentaryDraft[] = [];
  const error = await generateDocumentaryScript({ researchPack: pack("Océano"), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO,
    parse: async () => { if (++n === 2) throw new Error("529 overloaded"); return structuredClone(draft); },
    review: async ({ prompt }) => judge(JSON.parse(prompt).script), onDraft: async d => { drafts.push(d); } }).catch(e => e);
  assert.equal(scriptFailureKind(error), "technical");
  assert.equal(drafts.at(-1)!.issues?.[0].source, "reviewer");
});

test("escritor y revisor reciben los MISMOS criterios de bloqueo (auto-v1)", async () => {
  const draft = topicScript("Cómo funciona un agujero negro", TOPICS[2].openings); let reviewerSystem = "";
  const w = writer(draft, (_p, cur) => repairBlock(cur, 0, "TARDE"));
  await generateDocumentaryScript({ researchPack: pack("Agujeros negros"), targetDurationSeconds: 180, mode: "curiosity_documentary", ...AUTO,
    parse: w.parse, review: async ({ system, prompt }) => { reviewerSystem = system; return judge(JSON.parse(prompt).script); } });
  assert.ok(w.systems[0].includes(EDITORIAL_RUBRIC)); assert.ok(reviewerSystem.includes(EDITORIAL_RUBRIC));
});

test("compatibilidad: un trabajo guardado sin auto-v1 envía exactamente los prompts anteriores (1 corrección, sin rúbrica ni instrucciones nuevas)", async () => {
  const draft = topicScript("Misterios del océano profundo", TOPICS[0].openings); let reviewerSystem = "";
  const w = writer(draft, () => null);
  await generateDocumentaryScript({ researchPack: pack("Océano"), targetDurationSeconds: 180, mode: "curiosity_documentary", editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    parse: w.parse, review: async ({ system, prompt }) => { reviewerSystem = system; return judge(JSON.parse(prompt).script); } }).catch(() => undefined);
  assert.equal(w.prompts.length, 2);
  assert.match(w.prompts[1], /CORRECCIÓN OBLIGATORIA — única revisión permitida, editorial y duración juntas\.\nEl borrador tiene/);
  assert.ok(!w.prompts[1].includes("INSTRUCCIONES DE CORRECCIÓN"));
  assert.ok(!w.systems[0].includes(EDITORIAL_RUBRIC)); assert.ok(reviewerSystem.startsWith(EDITORIAL_REVIEWER_SYSTEM)); assert.ok(!reviewerSystem.includes(EDITORIAL_RUBRIC));
});
