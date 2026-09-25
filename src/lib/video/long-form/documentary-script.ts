/**
 * Generador de guion documental REAL (Claude) — pieza del pipeline "real"
 * de Long Form. NO se invoca durante Fase A (ver scripts/produce-long-form-video.ts,
 * que solo usa buildFixtureScript() de fixture-pipeline.ts para validar el
 * pipeline). Esta función existe para que el código esté listo, pero
 * requiere explícitamente un research pack con fuentes verificadas — nunca
 * genera un guion factual a partir solo del conocimiento interno del
 * modelo, y nunca se ejecuta por accidente (mode.ts exige confirmación
 * explícita antes de que el orquestador pueda siquiera llegar a llamarla).
 *
 * Reutiliza el mismo cliente/patrón que src/lib/ai/script.ts (Shorts): SDK
 * de Anthropic, output estructurado con Zod, mismo criterio de "un solo
 * intento de corrección de longitud, nunca más". No es una copia de esa
 * función — el schema, el prompt y la exigencia de fuentes son propios de
 * Long Form (claims sourced/inference/unverified, sin eso Shorts no tiene
 * equivalente).
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MissingEnvVarError } from "@/lib/env-errors";
import { assertOriginalHook, usesBannedOpener } from "./originality";
import { BEAT_TYPES, type LongFormClaim, type LongFormMode, type LongFormSource, type NarrativeBeat } from "./types";
import { countWords, evaluateNarrationDuration, narrationWordBudget, type DurationEvaluation } from "./duration-budget";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new MissingEnvVarError("ANTHROPIC_API_KEY");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

// Mismo modelo económico que Shorts por defecto (ver SCRIPT_MODEL en
// ai/script.ts) — configurable aparte porque un documental de 8-10 min
// puede justificar un modelo distinto sin afectar el guion de Shorts.
const SCRIPT_MODEL =
  process.env.ANTHROPIC_LONG_FORM_SCRIPT_MODEL || process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";

export type ResearchPack = {
  topic: string;
  /** Fuentes verificadas por un humano ANTES de generar el guion — mismo tipo que ya usa fixture-pipeline.ts. */
  sources: LongFormSource[];
  /** Hechos ya extraídos y clasificados del research pack (opcional — el modelo puede derivar claims nuevas, siempre ligadas a estas fuentes). */
  claims?: LongFormClaim[];
  /** Preguntas o afirmaciones todavía debatidas académicamente — el guion debe presentarlas como abiertas, nunca como hecho zanjado. */
  openQuestions: string[];
};

const LANGUAGE_NAME: Record<"es" | "en", string> = { es: "español", en: "inglés (English)" };

const ClaimSchema = z.object({
  id: z.string().describe("Identificador corto y único de esta afirmación dentro del beat (p. ej. 'claim-1')."),
  text: z.string().describe("Afirmación factual concreta hecha en la narración."),
  support: z
    .enum(["sourced", "inference", "unverified"])
    .describe(
      "'sourced' SOLO si viene directo de una fuente del research pack (cita sourceIds). " +
        "'inference' si es una conclusión razonable a partir de fuentes, no un hecho textual. " +
        "'unverified' si no se pudo confirmar contra ninguna fuente dada — NUNCA marcar 'sourced' por defecto.",
    ),
  sourceIds: z.array(z.string()).describe("IDs de las fuentes del research pack que respaldan esta afirmación (vacío si support='unverified')."),
});

const VisualSchema = z.object({
  description: z
    .string()
    .describe(
      "EN INGLÉS, máximo ~15 palabras. Una escena concreta y filmable para este beat (sujeto + lugar + acción visible), apta para buscar " +
        "video de archivo o generar una imagen documental — nunca texto en pantalla, logos ni personas reales identificables. " +
        "Si hay acción, nómbrala con verbos concretos (p. ej. walking, building, digging, carrying, working, gathering, " +
        "crowd, procession, construction, moving through); si es estática, descríbela como tal (ruins, map, portrait...).",
    ),
  motion: z
    .boolean()
    .describe("true SOLO si la escena depende de una acción/movimiento visible (gente trabajando, barcos cruzando, multitudes caminando) que una imagen fija perdería."),
});

const BeatSchema = z.object({
  type: z.enum(BEAT_TYPES),
  purpose: z.string().describe("Qué logra este beat en el arco narrativo."),
  // P0 2026-09-25: antes decía "~150-250 palabras" fijo — con el mínimo de
  // 5 beats eso forzaba ≥ 750 palabras (~300 s) aunque se pidieran 180 s.
  // La longitud ahora sale del presupuesto de duración (ver prompt).
  narration: z.string().describe("Narración en voz alta de este beat — respeta EXACTAMENTE el presupuesto de palabras por beat del prompt."),
  claims: z.array(ClaimSchema).describe("Cada afirmación factual del beat, sin excepción — incluye las 'unverified'."),
  emotionalTone: z.string().optional(),
  visuals: z
    .array(VisualSchema)
    .min(2)
    .max(4)
    .describe("2-4 escenas visuales distintas que ilustran este beat, en el orden en que se narran."),
});

const DocumentaryScriptSchema = z.object({
  title: z.string(),
  workingTitleOptions: z.array(z.string()).min(1).max(3),
  hook: z.string(),
  beats: z.array(BeatSchema).min(5).max(10),
});

export type DocumentaryScript = z.infer<typeof DocumentaryScriptSchema>;

function buildSourcesBlock(sources: LongFormSource[]): string {
  return sources
    .map((s) => `[${s.id}] ${s.title} (${s.kind})${s.locator ? ` — ${s.locator}` : ""}${s.notes ? `\n    Nota: ${s.notes}` : ""}`)
    .join("\n");
}

function buildClaimsBlock(claims: LongFormClaim[] | undefined): string {
  if (!claims || claims.length === 0) return "(ninguna extraída todavía — deriva las claims tú mismo, siempre ligadas a una fuente de arriba)";
  return claims.map((c) => `- ${c.text} [${c.support}, fuentes: ${c.sourceIds.join(", ") || "ninguna"}]`).join("\n");
}

/**
 * Genera los beats narrativos de un documental REAL — requiere un research
 * pack con al menos una fuente verificada; lanza antes de llamar a Claude
 * si no lo hay (nunca produce contenido factual "de memoria").
 */
export class LongFormScriptDurationError extends Error {
  constructor(readonly evaluation: DurationEvaluation, readonly targetSeconds: number) {
    super(
      `El guion generado dura ~${Math.round(evaluation.estimatedSeconds)} s y la duración pedida es ${targetSeconds} s — ` +
        "fuera de la tolerancia aceptada incluso tras una corrección. Vuelve a intentarlo.",
    );
    this.name = "LongFormScriptDurationError";
  }
}

type ScriptParse = (args: { system: string; prompt: string }) => Promise<DocumentaryScript | null>;

export async function generateDocumentaryScript(input: {
  researchPack: ResearchPack;
  mode: LongFormMode;
  language?: "es" | "en";
  targetDurationSeconds: number;
  /** Solo pruebas: sustituye la llamada a Claude. */
  parse?: ScriptParse;
}): Promise<(Pick<NarrativeBeat, "type" | "purpose" | "narration" | "claims" | "emotionalTone"> & { visuals?: { description: string; motion: boolean }[] })[]> {
  if (input.researchPack.sources.length === 0) {
    throw new Error(
      "generateDocumentaryScript: el research pack no tiene fuentes. No se genera guion factual sin fuentes verificadas.",
    );
  }

  const language = input.language ?? "es";
  // Presupuesto de duración (duration-budget.ts): palabras totales y por
  // beat derivadas del ritmo REAL de la narración — no un rango fijo.
  const budget = narrationWordBudget(input.targetDurationSeconds);
  const targetBeats = budget.beats;

  const system =
    "Eres guionista documental faceless para YouTube. Escribes SIEMPRE a partir del research pack " +
    "que se te da — nunca inventas hechos ni completas huecos con tu propio conocimiento sin marcarlo " +
    "explícitamente como 'inference' o 'unverified'. Cada afirmación factual de cada beat debe " +
    "clasificarse honestamente: 'sourced' solo si el research pack la respalda directamente, " +
    "'inference' si es una conclusión razonable pero no textual, 'unverified' si no se pudo confirmar. " +
    "Las preguntas académicamente debatidas se presentan como abiertas, nunca como hecho zanjado. " +
    `Responde SIEMPRE en ${LANGUAGE_NAME[language]}.`;

  const prompt = `Tema: ${input.researchPack.topic}
Modo: ${input.mode}
Duración objetivo: ${input.targetDurationSeconds}s (~${targetBeats} beats)
Presupuesto de narración: ${budget.totalWords} palabras EN TOTAL (entre ${budget.minWords} y ${budget.maxWords}),
~${budget.wordsPerBeat} palabras por beat. La narración se lee a ~2.5 palabras por segundo: pasarse del
presupuesto alarga el video por encima de lo pedido.

FUENTES VERIFICADAS:
${buildSourcesBlock(input.researchPack.sources)}

HECHOS YA EXTRAÍDOS:
${buildClaimsBlock(input.researchPack.claims)}

PREGUNTAS ABIERTAS/DEBATIDAS (preséntalas como tales, nunca como hecho):
${input.researchPack.openQuestions.length > 0 ? input.researchPack.openQuestions.join("\n") : "(ninguna registrada)"}

Escribe el guion completo: título, hook, y ${targetBeats} beats con arco narrativo real
(hook → setup → discovery → escalation → twist/insight → payoff → next_curiosity).
Ningún saludo de canal, ninguna frase de apertura genérica.`;

  const parse: ScriptParse =
    input.parse ??
    (async (args) => {
      const response = await getClient().messages.parse({
        model: SCRIPT_MODEL,
        max_tokens: 8000,
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
        output_config: { format: zodOutputFormat(DocumentaryScriptSchema) },
      });
      return response.parsed_output ?? null;
    });

  let parsed = await parse({ system, prompt });
  if (!parsed) throw new Error("Claude no devolvió un guion documental válido");

  // Tolerancia de duración: fuera de ±15% → UNA corrección (mismo criterio
  // que Shorts: nunca más de un reintento); fuera de ±25% tras corregir →
  // no se acepta (un documental de 180 s no puede salir de 300 s).
  const wordsOf = (script: DocumentaryScript) => script.beats.reduce((sum, b) => sum + countWords(b.narration), 0);
  let evaluation = evaluateNarrationDuration(wordsOf(parsed), input.targetDurationSeconds);
  if (!evaluation.withinTolerance) {
    const correction = `${prompt}

CORRECCIÓN OBLIGATORIA: tu versión anterior tenía ${evaluation.words} palabras de narración (~${Math.round(evaluation.estimatedSeconds)} s).
Reescribe el guion completo con ${budget.totalWords} palabras en total (entre ${budget.minWords} y ${budget.maxWords}),
~${budget.wordsPerBeat} por beat, conservando las mismas afirmaciones verificadas.`;
    const corrected = await parse({ system, prompt: correction });
    if (corrected) {
      const correctedEval = evaluateNarrationDuration(wordsOf(corrected), input.targetDurationSeconds);
      if (Math.abs(correctedEval.ratio - 1) < Math.abs(evaluation.ratio - 1)) {
        parsed = corrected;
        evaluation = correctedEval;
      }
    }
    if (!evaluation.withinHardTolerance) throw new LongFormScriptDurationError(evaluation, input.targetDurationSeconds);
  }

  assertOriginalHook(parsed.hook);
  for (const beat of parsed.beats) {
    if (usesBannedOpener(beat.narration)) {
      throw new Error(`Beat "${beat.type}" usa un opener genérico prohibido — no se acepta el guion tal cual.`);
    }
  }

  return parsed.beats;
}
