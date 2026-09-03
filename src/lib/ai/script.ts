import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();

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

const WORDS_PER_SECOND = 2.6;

export async function generateScript({
  topic,
  style,
  durationSeconds,
}: {
  topic: string;
  style: string;
  durationSeconds: number;
}): Promise<VideoScript> {
  const targetWords = Math.round(durationSeconds * WORDS_PER_SECOND);
  const targetScenes = Math.max(3, Math.min(10, Math.round(durationSeconds / 5)));

  const response = await client.messages.parse({
    model: SCRIPT_MODEL,
    max_tokens: 2000,
    system:
      "Eres guionista de reels 'faceless' (sin rostro) para redes sociales, " +
      "en el estilo de canales virales de TikTok/Instagram Reels/YouTube " +
      "Shorts. Escribes narraciones dinámicas, con un gancho fuerte en los " +
      "primeros segundos, frases cortas y un cierre memorable. Respondes " +
      "siempre en el mismo idioma en el que el usuario describe el tema.",
    messages: [
      {
        role: "user",
        content: `Escribe el guion de un reel faceless.

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
