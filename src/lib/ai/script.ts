import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MissingEnvVarError } from "@/lib/env-errors";
import { targetWordsFor } from "@/lib/video/script-pacing";
import { fetchFailureOutcome, httpStatusOutcome, type ChargeOutcome } from "@/lib/providers/charge-outcome";
import type { ScriptCallMeta, ScriptCallRunner } from "@/lib/providers/types";

// Instanciado de forma perezosa, mismo patrón que getStripe() en
// src/lib/stripe/client.ts: así ANTHROPIC_API_KEY se valida explícitamente
// en cada uso (con un error tipado y con el nombre exacto de la variable)
// en vez de dejar que el SDK falle más tarde con un mensaje genérico.
let cachedClient: Anthropic | null = null;

/**
 * `maxRetries: 0`: el SDK reintenta por defecto (2 veces) conexiones caídas,
 * 408/409/429 y 5xx POR DENTRO, sin que el llamador lo vea. Cada llamada
 * real debe pasar por callScriptModel (diagnóstico y registro de gasto), así
 * que la política de reintentos vive allí y solo repite lo que no pudo
 * cobrarse.
 */
export function createScriptClient(apiKey: string, fetchImpl?: typeof fetch): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new MissingEnvVarError("ANTHROPIC_API_KEY");
    }
    cachedClient = createScriptClient(apiKey);
  }
  return cachedClient;
}

/** Solo pruebas: cliente con fetch simulado (null restaura el real). */
export function setScriptClientForTests(client: Anthropic | null): void {
  cachedClient = client;
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
        visibleAction: z
          .string()
          .optional()
          .describe(
            "UNA acción visible concreta de la escena, en inglés (sujeto + verbo + objeto, máx. 12 palabras), " +
              "que se pueda mostrar completa en un solo plano continuo de 2 a 5 segundos, sin cortes ni cambio de lugar " +
              "(p. ej. 'the keeper slams the iron door shut'). Se usa solo si el video se anima.",
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

export const SCRIPT_MAX_TOKENS = 2000;
export const SCENE_MAX_TOKENS = 500;

/**
 * Diagnóstico SEGURO de una llamada: estado, tipos de bloque y tokens.
 * Nunca incluye el texto devuelto, el razonamiento interno, el prompt ni
 * claves — solo metadatos para entender un fallo sin exponer contenido.
 */
export type ScriptCallDiagnostics = {
  operation: ScriptCallMeta["operation"];
  call: number;
  lengthAttempt: number;
  model: string;
  /** Identificador del mensaje del proveedor (para cruzarlo con su consola de uso). */
  messageId?: string;
  stopReason: string | null;
  /** Tipos de bloque de la respuesta, en orden (p. ej. ["text"]); nunca su contenido. */
  blockTypes: string[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null } | null;
  /** Caracteres del primer bloque de texto (0 si no hay). */
  textChars: number;
  parse: "ok" | "no_text_block" | "invalid_json" | "schema_mismatch";
  /** Rutas de los campos que no cumplen el esquema (sin valores). */
  schemaIssues?: string[];
  words?: number;
};

/** La llamada se hizo (y se cobró según `usage`), pero la respuesta no es un guion utilizable. No se repite sola. */
export class ScriptOutputError extends Error {
  constructor(what: string, public readonly diagnostics: ScriptCallDiagnostics) {
    super(
      `Claude no devolvió ${what} válido (${diagnostics.parse}; stop_reason: ${diagnostics.stopReason ?? "desconocido"}; bloques: ${diagnostics.blockTypes.join(",") || "ninguno"}). ` +
        "La llamada ya se hizo y puede haberse cobrado; no se repite automáticamente.",
    );
    this.name = "ScriptOutputError";
  }
}

/**
 * ¿Pudo cobrarse una llamada fallida a Claude? Misma regla que el resto de
 * proveedores (providers/charge-outcome.ts): costo cero solo con evidencia.
 */
export function scriptCallFailureOutcome(err: unknown): ChargeOutcome {
  if (err instanceof MissingEnvVarError) return "not_sent";
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) return "uncertain";
  if (err instanceof Anthropic.APIConnectionError) return fetchFailureOutcome(err.cause ?? err);
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return httpStatusOutcome(err.status);
  return "uncertain";
}

/**
 * Reintento automático SOLO cuando la llamada no pudo cobrarse y repetir
 * tiene sentido: la solicitud no salió (red antes del envío) o el
 * proveedor la rechazó por límite de velocidad (429). Nunca ante una
 * respuesta recibida (un guion vacío o mal formado ya se procesó), un 5xx,
 * un timeout o una conexión cortada en vuelo.
 */
function isRetryableScriptFailure(err: unknown): boolean {
  if (err instanceof MissingEnvVarError) return false;
  if (err instanceof Anthropic.APIError && err.status === 429) return true;
  return scriptCallFailureOutcome(err) === "not_sent";
}

const RETRY_DELAYS_MS = [500, 1500];
const retryDelayMs = (index: number): number | undefined => {
  const fixed = process.env.SCRIPT_RETRY_DELAY_MS;
  const base = RETRY_DELAYS_MS[index];
  return base === undefined ? undefined : fixed !== undefined ? Number(fixed) : base;
};

const directCall: ScriptCallRunner = (_meta, call) => call();

function diagnose<T>(message: Anthropic.Message, schema: z.ZodType<T>, meta: ScriptCallMeta): { diagnostics: ScriptCallDiagnostics; value?: T } {
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const u = message.usage;
  const diagnostics: ScriptCallDiagnostics = {
    operation: meta.operation,
    call: meta.call,
    lengthAttempt: meta.lengthAttempt,
    model: message.model ?? meta.model,
    messageId: message.id,
    stopReason: message.stop_reason ?? null,
    blockTypes: message.content.map((b) => b.type),
    usage: u
      ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? null, cache_read_input_tokens: u.cache_read_input_tokens ?? null }
      : null,
    textChars: text?.text.length ?? 0,
    parse: "ok",
  };
  if (!text) return { diagnostics: { ...diagnostics, parse: "no_text_block" } };
  let json: unknown;
  try {
    json = JSON.parse(text.text);
  } catch {
    return { diagnostics: { ...diagnostics, parse: "invalid_json" } };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { diagnostics: { ...diagnostics, parse: "schema_mismatch", schemaIssues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(raíz)") } };
  }
  return { diagnostics, value: parsed.data };
}

function logCall(entry: Record<string, unknown>): void {
  console.log("[atomivid:script-call]", JSON.stringify(entry));
}

/**
 * UNA llamada lógica al modelo: cada llamada real (incluido cada reintento
 * permitido) pasa por `runCall` y deja una línea de diagnóstico.
 */
async function callScriptModel<T>({
  operation,
  lengthAttempt,
  counter,
  system,
  content,
  maxTokens,
  schema,
  runCall = directCall,
}: {
  operation: ScriptCallMeta["operation"];
  lengthAttempt: number;
  counter: { n: number };
  system: string;
  content: string;
  maxTokens: number;
  schema: z.ZodType<T>;
  runCall?: ScriptCallRunner;
}): Promise<{ value: T; diagnostics: ScriptCallDiagnostics }> {
  const format = zodOutputFormat(schema as never);
  for (let retry = 0; ; retry++) {
    const meta: ScriptCallMeta = { operation, call: ++counter.n, lengthAttempt, model: SCRIPT_MODEL, maxTokens, promptChars: system.length + content.length };
    let message: Anthropic.Message;
    try {
      message = await runCall(meta, () =>
        getClient().messages.create({
          model: SCRIPT_MODEL,
          max_tokens: maxTokens,
          // Sonnet 5 activa razonamiento por defecto; puede agotar todo el
          // límite antes del JSON. Estos guiones cortos necesitan texto directo.
          thinking: { type: "disabled" },
          system,
          messages: [{ role: "user", content }],
          output_config: { format: { type: "json_schema", schema: format.schema } },
        }),
      );
    } catch (err) {
      const outcome = scriptCallFailureOutcome(err);
      const delay = isRetryableScriptFailure(err) ? retryDelayMs(retry) : undefined;
      logCall({
        operation,
        call: meta.call,
        lengthAttempt,
        model: SCRIPT_MODEL,
        failed: err instanceof Error ? err.name : "desconocido",
        status: err instanceof Anthropic.APIError ? (err.status ?? null) : null,
        chargeOutcome: outcome,
        willRetry: delay !== undefined,
      });
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    const { diagnostics, value } = diagnose(message, schema, meta);
    logCall(diagnostics);
    if (value === undefined) throw new ScriptOutputError(operation === "scene" ? "una escena" : "un guion", diagnostics);
    return { value, diagnostics };
  }
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
// totales) no siempre basta — subido a 3 intentos totales. Cada corrección
// es OTRA llamada real (se registra y diagnostica en callScriptModel). Sigue
// acotado para no comprometer el límite de 60s de la ruta (ver maxDuration
// en app/api/generate/[id]/script/route.ts). Si el último intento sigue
// fuera de rango, se devuelve tal cual — checkScriptQuality en la ruta
// sigue siendo quien decide si se acepta o no, esto solo reduce cuántas
// veces llega a rechazarlo.
export const MAX_LENGTH_ATTEMPTS = 3;

export async function generateScript({
  topic,
  style,
  durationSeconds,
  language = "es",
  guidance,
  runCall,
}: {
  topic: string;
  style: string;
  durationSeconds: number;
  /** Idioma elegido por el usuario — no se infiere del texto del tema. */
  language?: "es" | "en";
  /** Intención narrativa de la dirección audiovisual; sustituye el tono «motivacional» fijo. */
  guidance?: string;
  /** Envoltorio de cada llamada real (registro de gasto de las muestras). */
  runCall?: ScriptCallRunner;
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
- ${guidance ? "Narración natural, sin frases de relleno ni acotaciones/emojis/marcas de tiempo." : "Narración natural y motivacional, sin frases de relleno ni acotaciones/emojis/marcas de tiempo."}
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
- "visibleAction": UNA acción visible concreta en inglés (sujeto + verbo + objeto, máx. 12 palabras) que se pueda mostrar completa en un plano continuo de 2 a 5 segundos.

La suma de las palabras de todos los "text" debe quedar entre ${minWords} y ${maxWords} palabras, con objetivo ${targetWords}. Cuenta las palabras antes de devolver el guion.${guidance ? `

${guidance} El "energy" de cada escena debe reflejar esa intención (p. ej. en suspenso: escenas de espera en "low" y la revelación en "high").` : ""}`;

  let lastScript: VideoScript | null = null;
  let lastWordCount = 0;
  // Cuenta TODAS las llamadas reales de esta generación (correcciones de longitud y reintentos).
  const counter = { n: 0 };

  for (let attempt = 1; attempt <= MAX_LENGTH_ATTEMPTS; attempt++) {
    const isRetry: boolean = attempt > 1;
    const direction: "reduciendo" | "ampliando" = lastWordCount > maxWords ? "reduciendo" : "ampliando";
    const content: string = !isRetry
      ? basePrompt
      : `${basePrompt}

El siguiente borrador tiene ${lastWordCount} palabras narradas, contadas por el servidor. Edita ESTE borrador, conservando sus escenas y conceptos visuales. No escribas una historia nueva. Debes ${direction === "reduciendo" ? "eliminar" : "añadir"} aproximadamente ${Math.abs(lastWordCount - targetWords)} palabras entre sus campos "text", para llegar a ${targetWords} (rango aceptado: ${minWords}-${maxWords}). Mantén frases completas, el sentido y la intención. Ajusta emphasisWords si cambias esas palabras. Cuenta solo las palabras de "text", separadas por espacios; no cuentes título ni metadatos.

Borrador a editar:
${JSON.stringify(lastScript)}`;

    const { value: parsed } = await callScriptModel({
      operation: "script",
      lengthAttempt: attempt,
      counter,
      system,
      content,
      maxTokens: SCRIPT_MAX_TOKENS,
      schema: ScriptSchema,
      runCall,
    });

    lastScript = parsed;
    lastWordCount = countScriptWords(parsed);
    logCall({ operation: "script", call: counter.n, lengthAttempt: attempt, words: lastWordCount, targetRange: [minWords, maxWords] });
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
  guidance,
  runCall,
}: {
  topic: string;
  style: string;
  script: VideoScript;
  sceneIndex: number;
  guidance?: string;
  runCall?: ScriptCallRunner;
}): Promise<VideoScriptScene> {
  const current = script.segments[sceneIndex];
  if (!current) {
    throw new Error(`No existe la escena ${sceneIndex}`);
  }

  const previous = script.segments[sceneIndex - 1]?.text;
  const next = script.segments[sceneIndex + 1]?.text;
  const targetWords = current.text.split(/\s+/).filter(Boolean).length;

  const system =
    "Eres guionista de reels 'faceless' para redes sociales. Reescribes " +
    "UNA SOLA escena de un guion ya existente, manteniendo el mismo " +
    "idioma, tono y continuidad con las escenas vecinas. No repitas la " +
    "versión anterior — dala un giro distinto (otro ángulo, otro dato, " +
    "otra forma de decirlo) mientras encaja en el mismo lugar del guion.";
  const content = `Guion completo — tema: "${topic}", estilo/tono: "${style}".${guidance ? `\n${guidance}` : ""}

${previous ? `Escena anterior: "${previous}"\n` : ""}Escena actual (a reescribir): "${current.text}"
${next ? `Escena siguiente: "${next}"\n` : ""}
Reescribe SOLO la escena actual. Da:
- "text": nueva narración (~${targetWords} palabras, sin emojis ni acotaciones).
- "visualQuery": el concepto visual principal (2-4 palabras en inglés) — igual a visualConcepts[0].
- "visualConcepts": 2-3 interpretaciones visuales DISTINTAS de la idea de la escena (nunca sinónimos de la misma imagen) — interpreta el significado, no traduzcas la frase literalmente a palabras clave. ${AVOID_STOCK_TEXT_CLICHES}
- "excludedTerms": opcional, palabras en inglés a evitar en el material visual.
- "energy": "low"/"medium"/"high" según el ritmo de esta escena.
- "emphasisWords": 1-3 palabras EXACTAS del nuevo "text" que merecen destacarse visualmente.
- "visibleAction": UNA acción visible concreta en inglés (sujeto + verbo + objeto, máx. 12 palabras) que se pueda mostrar completa en un plano continuo de 2 a 5 segundos.`;

  const { value } = await callScriptModel({
    operation: "scene",
    lengthAttempt: 1,
    counter: { n: 0 },
    system,
    content,
    maxTokens: SCENE_MAX_TOKENS,
    schema: SceneSchema,
    runCall,
  });
  return value;
}
