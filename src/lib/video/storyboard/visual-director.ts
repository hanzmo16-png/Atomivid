/**
 * "Visual Director": construye un storyboard semántico completo a partir
 * del guion COMPLETO (no escena por escena) usando Claude — mismo cliente
 * que src/lib/ai/script.ts (lazy init, error tipado si falta la clave).
 * Es una llamada ADICIONAL al proveedor de guion ya configurado, no un
 * proveedor nuevo — por eso vive detrás de VISUAL_DIRECTOR_ENABLED (ver
 * feature-flags.ts) en vez de activarse solo por tener ANTHROPIC_API_KEY.
 *
 * NO usa `messages.parse()` (a diferencia de script.ts): ese helper
 * intenta parsear el JSON internamente y lanza una excepción genérica
 * ("Failed to parse structured output as JSON: Unterminated string...")
 * sin exponer `stop_reason` — así, una respuesta CORTADA por límite de
 * tokens (el storyboard es mucho más verboso que el guion: ~30 campos por
 * escena) se ve indistinguible de un JSON genuinamente inválido. Se usa
 * `messages.create()` directamente para poder revisar `stop_reason` ANTES
 * de intentar parsear, y así distinguir truncamiento de un fallo de schema
 * real — cada caso dispara un reintento distinto (ver generateStoryboard).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MissingEnvVarError } from "@/lib/env-errors";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { StoryboardSchema, type Storyboard } from "./types";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new MissingEnvVarError("ANTHROPIC_API_KEY");
    }
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const VISUAL_DIRECTOR_MODEL = process.env.ANTHROPIC_VISUAL_DIRECTOR_MODEL || "claude-sonnet-5";
// Un storyboard completo (visualIdentity + ~30 campos por escena, en
// prosa) es mucho más largo que el guion — 8000 tokens se truncaba a
// mitad de una escena intermedia en pruebas reales (confirmado por
// stop_reason="max_tokens", no por un JSON genuinamente inválido).
// Configurable por si un guion con muchas escenas sigue sin alcanzar.
const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_VISUAL_DIRECTOR_MAX_TOKENS || "16000");
// Presupuesto extra para el ÚNICO reintento, si la causa fue truncamiento
// (no tiene sentido reintentar con el mismo límite que ya no alcanzó).
const MAX_OUTPUT_TOKENS_RETRY = MAX_OUTPUT_TOKENS + 8000;

const LANGUAGE_NAME: Record<ScriptLanguage, string> = { es: "español", en: "inglés" };

export class StoryboardGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoryboardGenerationError";
  }
}

function buildSystemPrompt(): string {
  return (
    "Eres el 'director creativo visual' de un estudio de video vertical para TikTok/Reels/Shorts. " +
    "Tu trabajo NO es traducir frases del guion a palabras clave de búsqueda — es interpretar el " +
    "SIGNIFICADO, la EMOCIÓN y la INTENCIÓN narrativa del guion completo (como una historia con arco, " +
    "no oraciones sueltas) y decidir, para cada escena, qué imagen humana y visible comunica esa idea " +
    "sin depender de metáforas confusas o interpretaciones literales erróneas. Ejemplo de error a evitar: " +
    "para 'la motivación desaparece cuando más la necesitas', NUNCA sugieras una persona inconsciente o " +
    "tirada en la calle (sugiere desmayo o violencia) — la interpretación correcta es una persona cansada " +
    "antes del amanecer que decide levantarse de todas formas. Mantén consistencia visual (personajes, " +
    "vestuario, paleta, iluminación, nivel de realismo) a lo largo de todas las escenas, como si fueran " +
    "tomas del mismo cortometraje. Sé conciso en cada campo de texto (una frase, no un párrafo) — el " +
    "storyboard completo debe caber holgadamente dentro del límite de tokens de salida."
  );
}

function buildUserPrompt(script: GeneratedScript, language: ScriptLanguage, note?: string): string {
  const scenesText = script.segments
    .map((s, i) => `Escena ${i}: "${s.text}"`)
    .join("\n");

  return `Analiza este guion completo (idioma de la narración: ${LANGUAGE_NAME[language]}) como una historia con arco narrativo, y produce un storyboard estructurado con una entrada por escena, EN EL MISMO ORDEN Y CANTIDAD que las escenas dadas (una escena de guion = una escena de storyboard, mismo "narrationText" exacto).

Guion completo:
${scenesText}

Para cada escena, sigue exactamente el contrato pedido (significado literal, subtexto emocional, objetivo narrativo, emoción dominante, sujeto, acción VISIBLE humana, entorno, momento del día, tipo de plano, movimiento de cámara, iluminación, paleta, estilo, prompt detallado, prompt negativo, consultas alternativas de stock, tipo de recurso recomendado, prioridad, confianza, motivo de selección, continuidad con la escena anterior/siguiente, costo máximo permitido, y una estrategia de fallback ordenada que SIEMPRE termine pudiendo caer a un motion graphic seguro).

La escena 0 debe reflejar un gancho visual fuerte (hookDescription) que funcione en los primeros 1-2 segundos. La última escena debe reflejar un cierre memorable (closingDescription) con un concepto visual que NO se haya usado antes en el guion.

IMPORTANTE: cada campo de texto debe ser UNA SOLA frase corta, no un párrafo — el JSON completo debe caber dentro del límite de tokens de salida sin cortarse a mitad de una escena.${note ? `\n\n${note}` : ""}`;
}

type ClaudeCallOutcome =
  | { status: "ok"; storyboard: Storyboard }
  | { status: "truncated" }
  | { status: "invalid_json"; message: string }
  | { status: "schema_invalid"; errors: string[] };

type ClaudeCallResult = { outcome: ClaudeCallOutcome; inputTokens: number; outputTokens: number };

const outputFormat = zodOutputFormat(StoryboardSchema);

async function callClaude(
  script: GeneratedScript,
  language: ScriptLanguage,
  maxTokens: number,
  note?: string,
): Promise<ClaudeCallResult> {
  const userPrompt = buildUserPrompt(script, language, note);

  // Llamada de bajo nivel (create, no parse) — necesitamos stop_reason
  // ANTES de intentar parsear el JSON (ver comentario del archivo).
  const response = await getClient().messages.create({
    model: VISUAL_DIRECTOR_MODEL,
    max_tokens: maxTokens,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: outputFormat },
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  // Trazabilidad de costo real (no estimado) de esta llamada — nunca se
  // loguea el contenido del prompt/respuesta, solo conteo de tokens y
  // metadata de control (stop_reason, si fue un reintento).
  console.log(
    "[atomivid:visual-director-usage]",
    JSON.stringify({ model: VISUAL_DIRECTOR_MODEL, inputTokens, outputTokens, stopReason: response.stop_reason, isRetry: Boolean(note), maxTokens }),
  );

  if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
    return { outcome: { status: "truncated" }, inputTokens, outputTokens };
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { outcome: { status: "invalid_json", message: "la respuesta no incluyó ningún bloque de texto" }, inputTokens, outputTokens };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    return {
      outcome: { status: "invalid_json", message: err instanceof Error ? err.message : String(err) },
      inputTokens,
      outputTokens,
    };
  }

  const result = StoryboardSchema.safeParse(parsed);
  if (!result.success) {
    return {
      outcome: {
        status: "schema_invalid",
        errors: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      inputTokens,
      outputTokens,
    };
  }

  return { outcome: { status: "ok", storyboard: result.data }, inputTokens, outputTokens };
}

/**
 * Genera el storyboard real vía Claude. Un solo reintento (nunca
 * infinitos) — con presupuesto de tokens AMPLIADO si la causa fue
 * truncamiento (MAX_OUTPUT_TOKENS_RETRY), o con el motivo exacto del
 * rechazo de schema si la causa fue otra. Nunca sustituye un fallo real
 * por datos simulados — si el reintento también falla, lanza un error
 * explícito que dice exactamente qué pasó (truncado / JSON inválido /
 * schema inválido), nunca un genérico ni un storyboard falso.
 */
export async function generateStoryboard(
  script: GeneratedScript,
  language: ScriptLanguage = "es",
): Promise<Storyboard> {
  const first = await callClaude(script, language, MAX_OUTPUT_TOKENS);
  if (first.outcome.status === "ok") return first.outcome.storyboard;

  let retryNote: string;
  let retryMaxTokens = MAX_OUTPUT_TOKENS_RETRY;
  switch (first.outcome.status) {
    case "truncated":
      retryNote =
        `Tu respuesta anterior se CORTÓ por límite de tokens antes de completarse (nunca llegó a cerrar el JSON). ` +
        `Sé más breve en cada campo de texto (una frase corta, no un párrafo) para que el storyboard completo quepa.`;
      break;
    case "invalid_json":
      retryNote = `Tu respuesta anterior no fue JSON válido (${first.outcome.message}). Devuelve el storyboard completo de nuevo, como JSON válido y bien formado.`;
      break;
    case "schema_invalid":
      retryNote = `Tu respuesta anterior no cumplió el schema exactamente. Corrige SOLO estos problemas y devuelve el storyboard completo de nuevo: ${first.outcome.errors.join("; ")}`;
      retryMaxTokens = MAX_OUTPUT_TOKENS; // No fue un problema de espacio — no hace falta más presupuesto.
      break;
  }

  const repaired = await callClaude(script, language, retryMaxTokens, retryNote);
  if (repaired.outcome.status === "ok") return repaired.outcome.storyboard;

  const describeFailure = (outcome: ClaudeCallOutcome): string => {
    switch (outcome.status) {
      case "truncated":
        return `la respuesta se cortó por límite de tokens (max_tokens=${retryMaxTokens}) — el guion podría ser demasiado largo para el presupuesto actual`;
      case "invalid_json":
        return `JSON inválido: ${outcome.message}`;
      case "schema_invalid":
        return `no cumple el schema: ${outcome.errors.join("; ")}`;
      case "ok":
        return "ok"; // inalcanzable aquí, TypeScript exhaustiveness.
    }
  };

  throw new StoryboardGenerationError(
    `Claude no devolvió un storyboard válido tras un intento de reparación. Primer intento: ${describeFailure(first.outcome)}. Reintento: ${describeFailure(repaired.outcome)}.`,
  );
}
