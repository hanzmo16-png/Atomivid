/**
 * "Visual Director": construye un storyboard semántico completo a partir
 * del guion COMPLETO (no escena por escena) usando Claude — mismo cliente
 * y patrón que src/lib/ai/script.ts (lazy init, error tipado si falta la
 * clave, `messages.parse` con `zodOutputFormat` para salida validada en
 * origen). Es una llamada ADICIONAL al proveedor de guion ya configurado,
 * no un proveedor nuevo — por eso vive detrás de VISUAL_DIRECTOR_ENABLED
 * (ver feature-flags.ts) en vez de activarse solo por tener ANTHROPIC_API_KEY.
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
    "tomas del mismo cortometraje."
  );
}

function buildUserPrompt(script: GeneratedScript, language: ScriptLanguage): string {
  const scenesText = script.segments
    .map((s, i) => `Escena ${i}: "${s.text}"`)
    .join("\n");

  return `Analiza este guion completo (idioma de la narración: ${LANGUAGE_NAME[language]}) como una historia con arco narrativo, y produce un storyboard estructurado con una entrada por escena, EN EL MISMO ORDEN Y CANTIDAD que las escenas dadas (una escena de guion = una escena de storyboard, mismo "narrationText" exacto).

Guion completo:
${scenesText}

Para cada escena, sigue exactamente el contrato pedido (significado literal, subtexto emocional, objetivo narrativo, emoción dominante, sujeto, acción VISIBLE humana, entorno, momento del día, tipo de plano, movimiento de cámara, iluminación, paleta, estilo, prompt detallado, prompt negativo, consultas alternativas de stock, tipo de recurso recomendado, prioridad, confianza, motivo de selección, continuidad con la escena anterior/siguiente, costo máximo permitido, y una estrategia de fallback ordenada que SIEMPRE termine pudiendo caer a un motion graphic seguro).

La escena 0 debe reflejar un gancho visual fuerte (hookDescription) que funcione en los primeros 1-2 segundos. La última escena debe reflejar un cierre memorable (closingDescription) con un concepto visual que NO se haya usado antes en el guion.`;
}

type ClaudeCallResult = { parsed: unknown; inputTokens: number; outputTokens: number };

async function callClaude(
  script: GeneratedScript,
  language: ScriptLanguage,
  repairNote?: string,
): Promise<ClaudeCallResult> {
  const userPrompt = buildUserPrompt(script, language) + (repairNote ? `\n\n${repairNote}` : "");

  const response = await getClient().messages.parse({
    model: VISUAL_DIRECTOR_MODEL,
    max_tokens: 8000,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: zodOutputFormat(StoryboardSchema) },
  });

  // Trazabilidad de costo real (no estimado) de esta llamada — nunca se
  // loguea el contenido del prompt/respuesta, solo conteo de tokens.
  console.log(
    "[atomivid:visual-director-usage]",
    JSON.stringify({
      model: VISUAL_DIRECTOR_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      isRepair: Boolean(repairNote),
    }),
  );

  return {
    parsed: response.parsed_output,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

/**
 * Genera el storyboard real vía Claude. Un solo reintento de "reparación"
 * si la primera respuesta no valida contra el schema (nunca reintentos
 * infinitos) — le muestra a Claude el motivo exacto del rechazo y le pide
 * corregir solo eso, no regenerar todo desde cero.
 */
export async function generateStoryboard(
  script: GeneratedScript,
  language: ScriptLanguage = "es",
): Promise<Storyboard> {
  const first = await callClaude(script, language);
  const firstResult = StoryboardSchema.safeParse(first.parsed);
  if (firstResult.success) return firstResult.data;

  const errorSummary = firstResult.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  const repaired = await callClaude(
    script,
    language,
    `Tu respuesta anterior no cumplió el schema exactamente. Corrige SOLO estos problemas y devuelve el storyboard completo de nuevo: ${errorSummary}`,
  );
  const repairedResult = StoryboardSchema.safeParse(repaired.parsed);
  if (repairedResult.success) return repairedResult.data;

  throw new StoryboardGenerationError(
    `Claude no devolvió un storyboard válido tras un intento de reparación: ${repairedResult.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  );
}
