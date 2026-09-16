import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MissingEnvVarError } from "@/lib/env-errors";

// Instanciado de forma perezosa, mismo patrón que getStripe() en
// src/lib/stripe/client.ts: así ANTHROPIC_API_KEY se valida explícitamente
// en cada uso (con un error tipado y con el nombre exacto de la variable)
// en vez de dejar que el SDK falle más tarde con un mensaje genérico.
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

// Modelo económico: el guion es texto corto y no requiere razonamiento
// profundo, así que priorizamos costo por video sobre la máxima capacidad
// del modelo (ver notas de presupuesto del proyecto). Configurable por env.
const SCRIPT_MODEL = process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";

const ScriptSchema = z.object({
  title: z.string().describe("Título corto y llamativo para el video"),
  segments: z
    .array(
      z.object({
        text: z.string().describe("Narración en voz alta para esta escena"),
        visualQuery: z
          .string()
          .describe(
            "2-4 palabras en inglés para buscar una foto de stock que ilustre esta escena",
          ),
      }),
    )
    .min(1)
    .describe("Escenas del video, en orden"),
});

export type VideoScript = z.infer<typeof ScriptSchema>;

const SceneSchema = ScriptSchema.shape.segments.element;
export type VideoScriptScene = z.infer<typeof SceneSchema>;

const WORDS_PER_SECOND = 2.6;

const LANGUAGE_NAME: Record<"es" | "en", string> = {
  es: "español",
  en: "inglés (English)",
};

export async function generateScript({
  topic,
  style,
  durationSeconds,
  language = "es",
}: {
  topic: string;
  style: string;
  durationSeconds: number;
  /** Idioma elegido por el usuario — no se infiere del texto del tema. */
  language?: "es" | "en";
}): Promise<VideoScript> {
  const targetWords = Math.round(durationSeconds * WORDS_PER_SECOND);
  const targetScenes = Math.max(3, Math.min(10, Math.round(durationSeconds / 5)));

  const response = await getClient().messages.parse({
    model: SCRIPT_MODEL,
    max_tokens: 2000,
    system:
      "Eres guionista de reels 'faceless' (sin rostro) para redes sociales, " +
      "en el estilo de canales virales de TikTok/Instagram Reels/YouTube " +
      "Shorts. Escribes narraciones dinámicas, con un gancho fuerte en los " +
      `primeros segundos, frases cortas y un cierre memorable. Responde ` +
      `SIEMPRE en ${LANGUAGE_NAME[language]}, sin importar en qué idioma ` +
      "esté escrito el tema que te da el usuario.",
    messages: [
      {
        role: "user",
        content: `Escribe el guion de un reel faceless.

Idioma de la narración: ${LANGUAGE_NAME[language]} (obligatorio, sin excepción).
Tema: ${topic}
Estilo/tono: ${style}
Duración objetivo: ${durationSeconds} segundos (~${targetWords} palabras narradas en total)
Número de escenas sugerido: ${targetScenes}

Divide la narración en ${targetScenes} escenas cortas. Para cada escena da:
- "text": el texto exacto que narrará la voz IA (sin acotaciones, sin emojis, sin marcas de tiempo).
- "visualQuery": 2-4 palabras EN INGLÉS para buscar una foto de stock que ilustre esa escena (el concepto visual, no la frase narrada).

La suma de las palabras de todos los "text" debe acercarse a ${targetWords} palabras.`,
      },
    ],
    output_config: {
      format: zodOutputFormat(ScriptSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error("Claude no devolvió un guion válido");
  }

  return response.parsed_output;
}

export async function regenerateScene({
  topic,
  style,
  script,
  sceneIndex,
}: {
  topic: string;
  style: string;
  script: VideoScript;
  sceneIndex: number;
}): Promise<VideoScriptScene> {
  const current = script.segments[sceneIndex];
  if (!current) {
    throw new Error(`No existe la escena ${sceneIndex}`);
  }

  const previous = script.segments[sceneIndex - 1]?.text;
  const next = script.segments[sceneIndex + 1]?.text;
  const targetWords = current.text.split(/\s+/).filter(Boolean).length;

  const response = await getClient().messages.parse({
    model: SCRIPT_MODEL,
    max_tokens: 500,
    system:
      "Eres guionista de reels 'faceless' para redes sociales. Reescribes " +
      "UNA SOLA escena de un guion ya existente, manteniendo el mismo " +
      "idioma, tono y continuidad con las escenas vecinas. No repitas la " +
      "versión anterior — dala un giro distinto (otro ángulo, otro dato, " +
      "otra forma de decirlo) mientras encaja en el mismo lugar del guion.",
    messages: [
      {
        role: "user",
        content: `Guion completo — tema: "${topic}", estilo/tono: "${style}".

${previous ? `Escena anterior: "${previous}"\n` : ""}Escena actual (a reescribir): "${current.text}"
${next ? `Escena siguiente: "${next}"\n` : ""}
Reescribe SOLO la escena actual. Da:
- "text": nueva narración (~${targetWords} palabras, sin emojis ni acotaciones).
- "visualQuery": 2-4 palabras EN INGLÉS para buscar una foto de stock que la ilustre.`,
      },
    ],
    output_config: {
      format: zodOutputFormat(SceneSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error("Claude no devolvió una escena válida");
  }

  return response.parsed_output;
}
