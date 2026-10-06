import { z } from "zod";
import { countWords, LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";

const brief = z.string().min(1).max(300);
export const NARRATIVE_DEVICES = ["in_medias_res", "contradiction", "mistake", "experiment", "myth_evidence",
  "timeline", "character_case", "disagreement", "sensory", "counterfactual", "observational", "clue_mystery", "thesis"] as const;
const passage = z.object({ beatIndex: z.number().int().min(0).max(9), quote: z.string().min(1).max(350) });
export const CreativeDirectionSchema = z.object({
  audience: brief, emotionalPromise: brief, beliefToChallenge: brief, finalFeeling: brief,
  angles: z.array(z.object({ premise: brief, device: z.enum(NARRATIVE_DEVICES), hook: brief, genericRisk: brief })).length(7),
  finalists: z.array(z.number().int().min(0).max(6)).length(3),
  chosenAngle: z.number().int().min(0).max(6),
  selectionReason: brief,
  cloneTest: z.object({ substitutedTopic: brief, whyThisStoryBreaks: brief }),
  avoidedPatterns: z.array(brief).max(3),
  signatureDetail: passage,
  shareableLine: passage,
  commentMoment: passage.nullable(),
  closingCta: passage.nullable(),
  protectInEdit: z.array(passage).length(3),
  weakness: brief,
  evidenceThatWouldHelp: brief,
});
export type CreativeDirection = z.infer<typeof CreativeDirectionSchema>;
export type CreativeHistoryEntry = { topic: string; opening: string; ending: string; device?: string; promise?: string; structure: string[] };
type Beat = { narration: string; purpose?: string; type?: string };

/** Structural/quote checks complement the critic's semantic judgment; no fabricated originality score. */
export function creativeDirectionIssues(value: unknown, beats: Beat[], history: CreativeHistoryEntry[] = [], historyCount = history.length): string[] {
  const result = CreativeDirectionSchema.safeParse(value);
  if (!result.success) return ["Completa la dirección creativa con siete ángulos breves y pasajes reales del guion."];
  const d = result.data, issues: string[] = [];
  if (new Set(d.finalists).size !== 3 || !d.finalists.includes(d.chosenAngle))
    issues.push("Descarta cuatro ángulos y selecciona uno de los tres finalistas distintos.");
  if (new Set(d.angles.map(a => a.device)).size < 4 || new Set(d.angles.map(a => a.premise.trim().toLowerCase())).size !== 7)
    issues.push("Los siete ángulos deben diferir de premisa y explorar al menos cuatro dispositivos narrativos.");
  const passages = [d.signatureDetail, d.shareableLine, ...d.protectInEdit, ...(d.commentMoment ? [d.commentMoment] : []), ...(d.closingCta ? [d.closingCta] : [])];
  if (passages.some(p => countWords(p.quote) < 3 || !beats[p.beatIndex]?.narration.includes(p.quote)))
    issues.push("Las marcas de edición, el detalle propio, la frase compartible y el cierre deben citar narración literal.");
  if (new Set(d.protectInEdit.map(p => `${p.beatIndex}:${p.quote}`)).size !== 3)
    issues.push("Selecciona tres momentos distintos que deben preservarse al editar.");
  if (d.closingCta && d.closingCta.beatIndex !== beats.length - 1)
    issues.push("El único CTA debe estar en el bloque de cierre.");
  if (historyCount > 0 && d.avoidedPatterns.length !== 3)
    issues.push("Declara tres patrones concretos que evitas del historial recibido.");
  if (historyCount === 0 && d.avoidedPatterns.length)
    issues.push("No inventes un historial de guiones: no se proporcionaron antecedentes.");
  const opening = beats[0]?.narration.trim().split(/\s+/).slice(0, 18).join(" ").toLowerCase();
  if (opening && history.some(h => h.opening.trim().split(/\s+/).slice(0, 18).join(" ").toLowerCase() === opening))
    issues.push("La apertura copia literalmente un guion reciente; cambia la situación y la promesa.");
  if (beats.some(b => /\[(?:verificar|verify|fact[- ]?check|dato pendiente)\]|FRASE COMPARTIBLE\s*:/i.test(b.narration)))
    issues.push("No envíes marcadores de verificación o instrucciones editoriales a la voz: resuelve, atribuye o retira ese pasaje.");
  return issues;
}

/** Estimates derived from actual draft word counts, not invented publication chapters. */
export function narrativeTiming(beats: Beat[]) {
  let start = 0;
  return beats.map((b, beatIndex) => {
    const end = start + countWords(b.narration) / LONG_FORM_NARRATION_WORDS_PER_SECOND;
    const row = { beatIndex, estimatedStartSeconds: Math.round(start), estimatedEndSeconds: Math.round(end) };
    start = end; return row;
  });
}

export const CREATIVE_WRITER_RULES = `DIRECCIÓN CREATIVA (creativeDirection, breve y fuera de la narración):
Define audiencia, promesa emocional, creencia a cuestionar y sensación final.
Propón SIETE ángulos realmente distintos: premisa, dispositivo, por qué engancha y riesgo de ser genérico. Explora al menos cuatro dispositivos.
Descarta cuatro, registra los índices desde cero de tres finalistas distintos y elige uno; justifica con claridad, especificidad y valor para el espectador, SIN puntuaciones de retención inventadas.
Haz el test del clon: sustituye el tema por otro y explica qué escena, causalidad o detalle dejaría de funcionar. No basta cambiar nombres y adjetivos.
Usa el historial recibido como memoria creativa, nunca como evidencia factual. Con historial, declara tres patrones concretos que evitas; sin él, avoidedPatterns debe ser [].
Rota el dispositivo respecto al anterior cuando aporte novedad; no sacrifiques claridad ni continuidad de una serie por una rotación arbitraria.
Primeros ~8 s: conflicto o imagen concreta; ~8–30 s: apuesta comprensible. Son objetivos de escritura, no tiempos de montaje garantizados.
Abre una pregunta menor y una central; responde pronto la menor y paga la central antes del CTA. No repitas preguntas para aplazar respuestas.
En formato largo busca una razón nueva para seguir cada ~60–90 s (consecuencia, ejemplo, contraste o revelación respaldada), sin exigir clips pagados ni giros falsos.
Escribe para el oído: respiración, variación de longitud y palabras naturales, sin muletillas de gurú. Documental faceless: narrador sin avatar, no monólogo a cámara.
Marca signatureDetail, UNA shareableLine y tres protectInEdit mediante citas literales de narración e índices de bloque.
Incluye como máximo UNA invitación a comentar, específica de lo aprendido, y UN CTA breve dentro del último bloque; usa null si no aportan. Nunca «comenta SÍ», palabras clave, chantaje o promesas falsas.
Los rótulos FRASE COMPARTIBLE, VOZ, VISUAL y [VERIFICAR] nunca se leen en la narración. No inventes anécdotas personales del creador.
Registra una debilidad y qué evidencia real ayudaría, sin formular preguntas al usuario ni simular disponer de esa evidencia.
Título y hook prometen solo lo que el guion entrega. No inventes minutos de capítulos; se calculan tras narración/montaje.
No hay una plantilla fija de capítulos: el orden causal elegido manda; las etiquetas técnicas de beats no obligan a una trama idéntica. Mantén cada campo del plan conciso.`;

export const CREATIVE_REVIEWER_RULES = `Revisa también creativeDirection contra la NARRACIÓN REAL, no contra lo que el escritor dice haber logrado.
Aplica el test del clon: ¿cambiando nombres funcionaría el mismo guion? Comprueba que signatureDetail sea específico del tema y aporte a la explicación.
Compara apertura, dispositivo, promesa, progresión y cierre con el historial recibido; no inventes antecedentes ni declares similitud solo porque vuelve un nombre.
Contrasta título y hook con lo entregado; señala promesas falsas como packaging_mismatch. No declares verificada una miniatura que no recibiste.
Comprueba que haya motivos nuevos para seguir, una frase memorable natural, como máximo un momento de comentarios y un CTA en el cierre. Engagement no equivale a pedir interacciones.
Detecta template_clone, engagement_bait y marcadores sin resolver; cita evidencia literal. El ritmo ~60–90 s es una guía, no una cuota automática.
La claridad oral importa; frases torpes son sugerencias salvo que impidan entender. No conviertas estos criterios en una fórmula fija ni predigas métricas de audiencia.`;
