import { editorialBlockers, type EditorialReview } from "./editorial";

/** One concrete thing the writer must change: where (block + literal passage), why, and how. */
export type CorrectionInstruction = { key: string; source: "reviewer" | "structure" | "duration"; beat: number | null; passage: string | null; problem: string; repair: string };

const FALLBACK_RESTATEMENT_REPAIR = "Haz que este bloque aporte información nueva, una consecuencia o una contradicción respaldada; si solo resume lo anterior, intégralo en el bloque previo y usa esas palabras para avanzar la historia.";

/**
 * Turns every blocking reason of one pass into a targeted instruction. Reviewer reasons come from the SAME
 * editorialBlockers() that decides approval, so the writer is never asked to fix something that does not block,
 * and nothing that blocks is left without an instruction.
 */
export function correctionInstructions(input: { review: EditorialReview; localIssues: string[]; duration: { acceptable: boolean; words: number; minWords: number; maxWords: number } }): CorrectionInstruction[] {
  const { review } = input;
  const out: CorrectionInstruction[] = [];
  if (!review.firstAnswer.delivered) out.push({ key: "first-answer", source: "reviewer", beat: 0, passage: null,
    problem: `La primera respuesta llega tarde: ${review.firstAnswer.explanation}`,
    repair: "Entrega dentro de las primeras 150 palabras un dato, respuesta o contradicción concreta del material, sin aplazarla." });
  if (!review.ending.resolvesPromise) out.push({ key: "ending", source: "reviewer", beat: review.ending.evidence.beatIndex, passage: review.ending.evidence.quote,
    problem: `La promesa principal queda sin resolver: ${review.ending.explanation}`,
    repair: "Resuelve la pregunta central en la segunda mitad y antes del CTA; si la respuesta es desconocida, explica qué permiten concluir las pruebas." });
  review.findings.forEach((f, i) => {
    if (f.severity !== "blocking") return;
    const e = f.evidence[0];
    out.push({ key: `finding:${f.kind}:${e?.beatIndex ?? "x"}`, source: "reviewer", beat: e?.beatIndex ?? null, passage: e?.quote ?? null,
      problem: f.explanation, repair: f.repair || `Corrige la observación ${i + 1} sin inventar hechos.` });
  });
  // The restatement rule lives in editorialBlockers; mirror exactly the sections it blocks.
  const blocked = new Set(editorialBlockers(review).map(r => /^El bloque (\d+) repite sin avanzar:/.exec(r)?.[1]).filter(Boolean).map(Number));
  for (const s of review.sections) if (s.function === "restatement" && blocked.has(s.beatIndex + 1))
    out.push({ key: `restatement:${s.beatIndex}`, source: "reviewer", beat: s.beatIndex, passage: s.quote,
      problem: `El bloque ${s.beatIndex + 1} repite sin avanzar (según el revisor: ${s.contribution})`, repair: FALLBACK_RESTATEMENT_REPAIR });
  for (const text of input.localIssues) {
    const beat = /\(bloque (\d+)\)/.exec(text)?.[1];
    out.push({ key: `structure:${text.slice(0, 80)}`, source: "structure", beat: beat ? Number(beat) - 1 : null, passage: null, problem: text,
      repair: "Corrige exactamente este punto; las citas de creativeDirection deben copiar palabra por palabra la narración del bloque indicado." });
  }
  if (!input.duration.acceptable) out.push({ key: "duration", source: "duration", beat: null, passage: null,
    problem: `La narración tiene ${input.duration.words} palabras.`,
    repair: `Ajusta la narración total a ${input.duration.minWords}–${input.duration.maxWords} palabras, recortando o ampliando con contenido del material, nunca con relleno.` });
  return out;
}

/** Instructions whose cause was ALSO present in the previous pass: the last correction did not fix them. */
export function repeatedInstructions(current: CorrectionInstruction[], previous: CorrectionInstruction[] | null): Set<string> {
  if (!previous) return new Set();
  const before = new Set(previous.map(i => i.key));
  return new Set(current.filter(i => before.has(i.key)).map(i => i.key));
}

/** Correction block for the writer prompt: numbered, located, and escalated when an earlier correction failed. */
export function renderCorrectionInstructions(list: CorrectionInstruction[], repeated: Set<string>): string {
  const lines = list.map((i, n) => {
    const where = i.beat === null ? "Guion completo" : `Bloque ${i.beat + 1}`;
    const passage = i.passage ? ` — pasaje: «${i.passage}»` : "";
    const again = repeated.has(i.key) ? " [LA CORRECCIÓN ANTERIOR NO LO RESOLVIÓ: reescribe por completo ese pasaje en lugar de retocarlo]" : "";
    return `${n + 1}. ${where}${passage}\n   Problema: ${i.problem}\n   Corrección: ${i.repair}${again}`;
  });
  return `INSTRUCCIONES DE CORRECCIÓN (cada una indica dónde, qué falla y cómo arreglarlo):\n${lines.join("\n")}\n` +
    "Cambia lo necesario para resolver CADA instrucción y conserva sin cambios lo que no se menciona. No introduzcas hechos nuevos sin respaldo.";
}
