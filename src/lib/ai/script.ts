import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MissingEnvVarError } from "@/lib/env-errors";
import { targetWordsFor } from "@/lib/video/script-pacing";

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

// Enum de energía compartido con el resto del pipeline (montaje/ritmo) —
// ver SceneEnergy en src/lib/providers/types.ts.
const EnergySchema = z.enum(["low", "medium", "high"]);

// Causa raíz confirmada (usuario reportó "al final dice Jorri/Jorriah" —
// resultó ser la palabra "Hooray!" quemada en inglés dentro de un clip de
// stock de confeti que Pexels devolvió para el concepto visual de cierre):
// los bancos de stock llenan búsquedas de conceptos "resolución"/abstractos
// (celebración, éxito, ganador, aplausos) con plantillas genéricas que
// traen texto o gráficos ya superpuestos en inglés — no hay forma de
// filtrarlos después por API (ver footage-score.ts), así que hay que
// evitar pedirlos desde el guion.
const AVOID_STOCK_TEXT_CLICHES =
  "Nunca des como concepto visual clichés de banco de imágenes como " +
  "'celebration', 'success', 'winner', 'hooray', 'applause' o tarjetas/" +
  "diplomas/checkmarks — esas búsquedas casi siempre devuelven plantillas " +
  "de stock con texto o gráficos en inglés ya superpuestos en el clip, que " +
  "quedan quemados en el video final sin relación con el guion. Describe " +
  "en vez de eso una persona/objeto/acción concreta y real (ej. en vez de " +
  "'success', usa 'entrepreneur smiling at laptop screen' o 'hands shaking after a deal').";

const ScriptSchema = z.object({
  title: z.string().describe("Título corto y llamativo para el video"),
  segments: z
    .array(
      z.object({
        text: z.string().describe("Narración en voz alta para esta escena"),
        visualQuery: z
          .string()
          .describe(
            "2-4 palabras en inglés para buscar una foto de stock que ilustre esta escena — el concepto visual principal, igual a visualConcepts[0].",
          ),
        visualConcepts: z
          .array(z.string())
          .min(2)
          .max(3)
          .optional()
          .describe(
            "2-3 interpretaciones visuales DISTINTAS de la idea de esta escena, en inglés, cada una " +
              "'sujeto + acción/situación concreta' de 3-6 palabras — NUNCA sinónimos de la misma imagen. " +
              "Interpreta el SIGNIFICADO de la frase, no la traduzcas literalmente a palabras clave. " +
              "Ejemplo: para 'y ahí es donde la mayoría abandona sus sueños', NO uses variantes de 'dreams' " +
              "— usa: ['exhausted athlete stopping mid run', 'person quitting a workout', " +
              "'runner falling behind and giving up']. El primer elemento es el concepto principal " +
              "(debe coincidir con visualQuery). " +
              AVOID_STOCK_TEXT_CLICHES,
          ),
        excludedTerms: z
          .array(z.string())
          .optional()
          .describe(
            "Palabras en inglés que el material visual de esta escena NO debe mostrar (opcional) — p. ej. " +
              "para evitar un cliché visual específico o contenido que contradiga el tono.",
          ),
        energy: EnergySchema.optional().describe(
          "Energía/ritmo de esta escena para el montaje: 'high' para acción o urgencia (cortes más " +
            "rápidos), 'low' para reflexión o pausa, 'medium' para el resto.",
        ),
        emphasisWords: z
          .array(z.string())
          .optional()
          .describe(
            "1-3 palabras EXACTAS del texto de 'text' (en el mismo idioma de la narración) que deben " +
              "destacarse visualmente en los subtítulos — las más importantes/impactantes de la frase.",
          ),
      }),
    )
    .min(1)
    .describe("Escenas del video, en orden"),
});

export type VideoScript = z.infer<typeof ScriptSchema>;

const SceneSchema = ScriptSchema.shape.segments.element;
export type VideoScriptScene = z.infer<typeof SceneSchema>;

const LANGUAGE_NAME: Record<"es" | "en", string> = {
  es: "español",
  en: "inglés (English)",
};

function countScriptWords(script: Pick<VideoScript, "segments">): number {
  return script.segments.reduce(
    (sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}

// Un solo intento no siempre cae dentro del ±10% de tolerancia que exige
// checkScriptQuality (script-quality.ts), aunque el prompt ya dé el
// objetivo exacto de palabras — es una limitación conocida de pedirle a un
// LLM que cuente con precisión, más notoria en temas densos (varios
// conceptos a mencionar) para una duración corta. En vez de que ese guion
// mal dimensionado llegue tal cual al usuario (quien tendría que recortarlo
// a mano en la pantalla de revisión), se le da al modelo hasta 2 intentos
// adicionales mostrándole su propio conteo y en qué dirección ajustar.
// Confirmado en producción (2026-09-20) que 1 sola corrección (2 intentos
// totales) no siempre basta — subido a 3 intentos totales. Sigue acotado
// para no comprometer el límite de 60s de la ruta (ver maxDuration en
// app/api/generate/[id]/script/route.ts) ni multiplicar demasiado las
// llamadas cuando además se activa withRetry por fallos transitorios
// (providers/script/real.ts). Si el último intento sigue fuera de rango,
// se devuelve tal cual — checkScriptQuality en la ruta sigue siendo quien
// decide si se acepta o no, esto solo reduce cuántas veces llega a
// rechazarlo.
const MAX_LENGTH_ATTEMPTS = 3;

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
  const targetWords = targetWordsFor(durationSeconds);
  const targetScenes = Math.max(3, Math.min(10, Math.round(durationSeconds / 5)));
  const minWords = Math.ceil(targetWords * 0.9);
  const maxWords = Math.floor(targetWords * 1.1);

  const system =
    "Eres guionista de reels 'faceless' (sin rostro) para redes sociales, " +
    "en el estilo de canales virales de TikTok/Instagram Reels/YouTube " +
    "Shorts. Escribes narraciones dinámicas y naturales, con un arco " +
    "real: gancho fuerte en los primeros segundos, tensión o problema, " +
    "desarrollo, conclusión y un cierre memorable — nunca una lista de " +
    "frases sueltas que dicen lo mismo con otras palabras. El tema que " +
    "te da el usuario es el ASUNTO del video, no una frase que deba " +
    "aparecer copiada o casi copiada en la narración ('hoy hablamos de...', " +
    "'esto es sobre...' y variantes similares están prohibidas). Responde " +
    `SIEMPRE en ${LANGUAGE_NAME[language]}, sin importar en qué idioma ` +
    "esté escrito el tema que te da el usuario.";

  const basePrompt = `Escribe el guion de un reel faceless con un arco narrativo real: gancho → tensión/problema → desarrollo → conclusión → cierre.

Idioma de la narración: ${LANGUAGE_NAME[language]} (obligatorio, sin excepción).
Tema: ${topic}
Estilo/tono: ${style}
Duración objetivo: ${durationSeconds} segundos (~${targetWords} palabras narradas en total)
Número de escenas sugerido: ${targetScenes}

Reglas estrictas:
- Nunca copies el tema tal cual dentro de una frase de plantilla — el tema es el asunto del video, no texto literal a repetir en cada escena.
- Cada escena avanza el arco narrativo; no repitas la misma idea con otras palabras entre escenas.
- Narración natural y motivacional, sin frases de relleno ni acotaciones/emojis/marcas de tiempo.
- La escena de apertura necesita un gancho visual fuerte — no un plano contemplativo ni introducción lenta.
- La escena de cierre debe sentirse como una resolución, con conceptos visuales que NO se hayan usado antes en el guion. ${AVOID_STOCK_TEXT_CLICHES}

Para cada escena, interpreta el SIGNIFICADO de la narración, no la conviertas literalmente en palabras clave. Ejemplo: para "y ahí es donde la mayoría abandona sus sueños", NO busques variantes de "dreams" — interpreta la idea (alguien rindiéndose) y da conceptos como "exhausted athlete stopping mid run", "person quitting a workout", "runner falling behind and giving up".

Da, para cada escena:
- "text": el texto exacto que narrará la voz IA.
- "visualQuery": el concepto visual principal (2-4 palabras en inglés) — igual a visualConcepts[0].
- "visualConcepts": 2-3 interpretaciones visuales DISTINTAS de la misma idea (nunca sinónimos de la misma imagen — ángulos, sujetos o situaciones distintas que comunican lo mismo).
- "excludedTerms": opcional, palabras en inglés a evitar en el material visual de esta escena.
- "energy": "low"/"medium"/"high" según el ritmo narrativo de esa escena.
- "emphasisWords": 1-3 palabras EXACTAS de "text" (mismo idioma de la narración) que merecen destacarse visualmente.

La suma de las palabras de todos los "text" debe quedar entre ${minWords} y ${maxWords} palabras, con objetivo ${targetWords}. Cuenta las palabras antes de devolver el guion.`;

  let lastScript: VideoScript | null = null;
  let lastWordCount = 0;

  for (let attempt = 1; attempt <= MAX_LENGTH_ATTEMPTS; attempt++) {
    const isRetry: boolean = attempt > 1;
    const direction: "reduciendo" | "ampliando" = lastWordCount > maxWords ? "reduciendo" : "ampliando";
    const content: string = !isRetry
      ? basePrompt
      : `${basePrompt}

Tu intento anterior tuvo ${lastWordCount} palabras narradas en total, fuera del rango pedido (${minWords}-${maxWords}). Reescribe el guion completo — mismo tema, arco narrativo, idioma y estilo —, ${direction} el nivel de detalle de cada escena (sin relleno ni cortes artificiales) hasta que la suma de "text" caiga dentro del rango. Cuenta las palabras con cuidado antes de responder.`;

    const response = await getClient().messages.parse({
      model: SCRIPT_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content }],
      output_config: {
        format: zodOutputFormat(ScriptSchema),
      },
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("Claude no devolvió un guion válido");
    }

    lastScript = parsed;
    lastWordCount = countScriptWords(parsed);
    if (lastWordCount >= minWords && lastWordCount <= maxWords) {
      return parsed;
    }
  }

  // Tras MAX_LENGTH_ATTEMPTS sigue fuera de rango: se devuelve el último
  // intento tal cual — checkScriptQuality (llamado por la ruta) es quien
  // decide si se rechaza, igual que antes de este cambio.
  return lastScript!;
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
- "visualQuery": el concepto visual principal (2-4 palabras en inglés) — igual a visualConcepts[0].
- "visualConcepts": 2-3 interpretaciones visuales DISTINTAS de la idea de la escena (nunca sinónimos de la misma imagen) — interpreta el significado, no traduzcas la frase literalmente a palabras clave. ${AVOID_STOCK_TEXT_CLICHES}
- "excludedTerms": opcional, palabras en inglés a evitar en el material visual.
- "energy": "low"/"medium"/"high" según el ritmo de esta escena.
- "emphasisWords": 1-3 palabras EXACTAS del nuevo "text" que merecen destacarse visualmente.`,
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
