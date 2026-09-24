import { MissingEnvVarError } from "@/lib/env-errors";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "../types";

/**
 * Adaptador REAL (P2A.5) para Google Veo 3.1 Fast vía la Gemini API —
 * primer proveedor de video-IA de ATOMIVID desbloqueado con contrato
 * implementado (no ya un skeleton contract_unverified como kling.ts).
 *
 * FUENTE DE LOS DATOS: citación directa de Hans (P2A.5) contra
 * documentación primaria —
 *   https://ai.google.dev/gemini-api/docs/veo
 *   https://ai.google.dev/gemini-api/docs/pricing
 * Este entorno TODAVÍA tiene bloqueado el acceso directo a ai.google.dev
 * (EGRESS_BLOCKED, confirmado de nuevo al intentar leerlo en P2A.5) — así
 * que Claude NO pudo re-verificar estos valores de forma independiente;
 * se implementan tal como Hans los confirmó, tratados como datos de
 * planeación/implementación fiables (a diferencia del rango UNVERIFICADO
 * de fuentes secundarias usado para Kling), pero si alguna vez difieren de
 * la doc en vivo, debe corregirse aquí, nunca sobrescribirse en silencio.
 *
 * Capacidades confirmadas por Hans:
 *   - Modelo API: "veo-3.1-fast-generate-preview".
 *   - text-to-video e image-to-video soportados; first/last frame y hasta
 *     3 reference images soportados por el contrato pero NO USADOS todavía
 *     (ATOMIVID solo necesita 1 imagen de referencia por ahora, ver
 *     ai-video-benchmark-v2-active.ts).
 *   - aspectRatios: 16:9, 9:16. resolutions: 720p/1080p/4k.
 *   - 1080p -> 8 segundos (única duración usada aquí). 24fps.
 *   - Audio: SIEMPRE generado, no hay parámetro documentado para
 *     desactivarlo — nunca se inventa uno (ver GenerativeAsset.
 *     sourceHasGeneratedAudio, providers/types.ts).
 *   - seed disponible, sin determinismo garantizado.
 *   - Precio 1080p: $0.12/segundo -> 8s = $0.96/clip.
 *   - Async: la solicitud devuelve una Operation que se sondea hasta
 *     done=true (patrón estándar de "long-running operations" de la
 *     Gemini API — predictLongRunning + GET del nombre de la operación).
 *
 * La forma EXACTA de los campos JSON de abajo (nombres de propiedad del
 * payload/respuesta) sigue el patrón públicamente documentado de la Gemini
 * API para operaciones de larga duración (mismo patrón que Imagen/Veo en
 * esa API) — no pudo confirmarse campo por campo contra la página en vivo
 * en este entorno. Un humano con acceso normal a internet debería
 * contrastar esto contra ai.google.dev antes de la primera llamada real
 * (ver informe final P2A.5, sección O).
 *
 * Ninguna llamada HTTP real ocurre en los tests de este archivo — todos
 * usan un fetch simulado (ver veo.test.ts), igual que openai.test.ts.
 */

export const VEO_MODEL = "veo-3.1-fast-generate-preview";
export const VEO_DEFAULT_COST_USD_PER_SECOND = 0.12;
/** 1080p soporta 8s según la citación de Hans — única duración usada por ATOMIVID hoy; otras resoluciones podrían permitir otras duraciones, no usadas aquí. */
export const VEO_DURATION_SECONDS_1080P = 8;
export const VEO_TARGET_RESOLUTION = "1080p";
export const VEO_ALLOWED_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const DEFAULT_POLL_TIMEOUT_MS = 240000;
const DEFAULT_MAX_POLL_ATTEMPTS = 30;
const POLL_INITIAL_DELAY_MS = 3000;
const POLL_MAX_DELAY_MS = 15000;

// Leídas en cada llamada (nunca constantes de módulo) — mismo motivo
// documentado en worker/index.ts: process.env puede diferir entre
// llamadas en pruebas, y una constante fijada al importar el módulo
// quedaría congelada con el valor de la primera vez que se cargó,
// ignorando cualquier override posterior (p. ej. en tests con timeout/
// max-attempts reducidos para no esperar minutos reales).
function getGeminiApiBase(): string {
  return process.env.VEO_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
}
/** Confirmado por Hans (P2A.5) contra ai.google.dev/gemini-api/docs/pricing para 1080p — ver comentario de cabecera. Override por env var para el mismo motivo que runway.ts. */
export function getVeoCostUsdPerSecond(): number {
  const raw = process.env.VEO_COST_USD_PER_SECOND;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : VEO_DEFAULT_COST_USD_PER_SECOND;
}
function getPollTimeoutMs(): number {
  const raw = process.env.VEO_POLL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_TIMEOUT_MS;
}
function getMaxPollAttempts(): number {
  const raw = process.env.VEO_MAX_POLL_ATTEMPTS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_POLL_ATTEMPTS;
}

function getApiKey(): string {
  const key = process.env.VEO_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("VEO_API_KEY");
  return key;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type GeminiOperation = {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string; mimeType?: string } }[];
    };
  };
};

/**
 * Clasifica un error HTTP/Operation de Google en un `reason` normalizado —
 * best-effort por sustring del mensaje, ya que la Gemini API no siempre
 * distingue quota/rate_limit a nivel de código HTTP (ambos suelen llegar
 * como 429/RESOURCE_EXHAUSTED). Nunca inventa un código que Google no
 * documente — todo lo no reconocible cae a "upstream_error".
 */
function classifyGoogleError(httpStatus: number | undefined, message: string | undefined): GenerativeProviderError["reason"] {
  const lower = (message ?? "").toLowerCase();
  if (httpStatus === 401 || httpStatus === 403 || lower.includes("unauthenticated") || lower.includes("permission")) {
    return "authentication_error";
  }
  if (lower.includes("safety") || lower.includes("blocked") || lower.includes("moderat")) {
    return "moderation_rejected";
  }
  if (httpStatus === 429 || lower.includes("resource_exhausted") || lower.includes("rate limit")) {
    return lower.includes("quota") ? "quota_exceeded" : "rate_limited";
  }
  if (httpStatus === 400 || lower.includes("invalid_argument")) {
    return "invalid_request";
  }
  return "upstream_error";
}

/**
 * Mapea un `VideoGenerationRequest` normalizado (provider-agnóstico) al
 * payload de `predictLongRunning` — el negativePrompt NUNCA se envía como
 * campo API separado (no está confirmado que la Gemini API lo soporte
 * para video, ver P2A.5 sección 13): se integra en el prompt principal
 * como texto "Avoid: ...", mismo patrón ya usado por runway.ts.
 */
function buildRequestPayload(request: VideoGenerationRequest): Record<string, unknown> {
  const prompt = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  const instance: Record<string, unknown> = { prompt };
  if (request.referenceImageUrl) {
    // Referencia por URI (no bytes inline) — evita tener que descargar la
    // imagen de referencia dos veces (una para Google, otra para nuestro
    // propio Storage); el contrato exacto de cómo la Gemini API acepta una
    // imagen por referencia (bytes base64 vs URI firmada) no se confirmó
    // en este entorno — ver comentario de cabecera.
    instance.image = { uri: request.referenceImageUrl };
  }
  const parameters: Record<string, unknown> = {
    aspectRatio: request.aspectRatio,
    resolution: VEO_TARGET_RESOLUTION,
    durationSeconds: request.durationSeconds,
  };
  if (request.seed) parameters.seed = request.seed;
  return { instances: [instance], parameters };
}

async function submitGeneration(request: VideoGenerationRequest): Promise<string> {
  const payload = buildRequestPayload(request);
  let response: Response;
  try {
    response = await fetch(`${getGeminiApiBase()}/models/${VEO_MODEL}:predictLongRunning`, {
      method: "POST",
      headers: {
        "x-goog-api-key": getApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new GenerativeProviderError("Veo: fallo de red al enviar la solicitud de generación", "veo", "upstream_error", err);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GenerativeProviderError(
      `Veo respondió HTTP ${response.status} al enviar la generación${body.error?.message ? `: ${body.error.message}` : ""}`,
      "veo",
      classifyGoogleError(response.status, body.error?.message),
    );
  }
  const json = (await response.json()) as GeminiOperation;
  if (!json.name) {
    throw new GenerativeProviderError("Veo no devolvió un nombre de operación", "veo", "invalid_response");
  }
  return json.name;
}

async function pollOperationOnce(operationName: string): Promise<GeminiOperation> {
  let response: Response;
  try {
    response = await fetch(`${getGeminiApiBase()}/${operationName}`, {
      headers: { "x-goog-api-key": getApiKey() },
    });
  } catch (err) {
    throw new GenerativeProviderError("Veo: fallo de red al consultar la operación", "veo", "upstream_error", err);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GenerativeProviderError(
      `Veo respondió HTTP ${response.status} al consultar la operación${body.error?.message ? `: ${body.error.message}` : ""}`,
      "veo",
      classifyGoogleError(response.status, body.error?.message),
    );
  }
  return (await response.json()) as GeminiOperation;
}

async function waitForCompletion(operationName: string): Promise<{ uri: string; mimeType: string }> {
  const pollTimeoutMs = getPollTimeoutMs();
  const maxPollAttempts = getMaxPollAttempts();
  const deadline = Date.now() + pollTimeoutMs;
  let delay = POLL_INITIAL_DELAY_MS;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (Date.now() > deadline) {
      throw new GenerativeProviderError(`Tiempo de espera agotado sondeando la operación de Veo (${pollTimeoutMs}ms)`, "veo", "timeout");
    }
    // Nunca se loguea la operación completa ni ninguna URI firmada — solo su estado, aquí y en cualquier console.log del llamador (mismo criterio que runway.ts).
    const operation = await pollOperationOnce(operationName);
    if (operation.error) {
      throw new GenerativeProviderError(
        `La operación de Veo falló: ${operation.error.message ?? "sin detalle"}`,
        "veo",
        classifyGoogleError(operation.error.code, operation.error.message),
      );
    }
    if (operation.done) {
      const sample = operation.response?.generateVideoResponse?.generatedSamples?.[0];
      const uri = sample?.video?.uri;
      if (!uri) {
        throw new GenerativeProviderError("Veo completó la operación pero no devolvió una URI de video", "veo", "invalid_response");
      }
      return { uri, mimeType: sample.video?.mimeType ?? "video/mp4" };
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS);
  }

  throw new GenerativeProviderError("Se agotaron los intentos de sondeo de la operación de Veo", "veo", "timeout");
}

async function downloadVideo(uri: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(uri, { headers: { "x-goog-api-key": getApiKey() } });
  } catch (err) {
    throw new GenerativeProviderError("Veo: fallo de red al descargar el video generado", "veo", "download_failed", err);
  }
  if (!response.ok) {
    throw new GenerativeProviderError(`No se pudo descargar el video de Veo (HTTP ${response.status})`, "veo", "download_failed");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new GenerativeProviderError("Video de Veo descargado con tamaño 0 bytes", "veo", "download_failed");
  }
  return buffer;
}

export const veoVideoProvider: VideoProvider = {
  name: "veo",
  capabilities: {
    id: "veo",
    models: [VEO_MODEL],
    formats: ["video/mp4"],
    aspectRatios: [...VEO_ALLOWED_ASPECT_RATIOS],
    timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    maxRetries: 0, // Una operación de Veo ya cuesta dinero al enviarse — nunca se reintenta automáticamente dentro del adapter (mismo criterio que runway.ts); el reintento vive en el llamador (ver ai-video-provider-comparison.ts, "1 reintento por resultado").
  },
  isAvailable() {
    return Boolean(process.env.VEO_API_KEY?.trim());
  },
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    if (!this.isAvailable()) {
      throw new GenerativeProviderError("VEO_API_KEY no está configurada", "veo", "not_configured");
    }
    // Primer uso real de ATOMIVID es image-to-video (P2A.5 sección 5) —
    // este adapter NUNCA cae a text-to-video automáticamente si falta la
    // imagen de referencia; el llamador (ai-video-provider-comparison.ts)
    // aplica además un gate explícito de aprobación humana ANTES de
    // siquiera llegar aquí (ver ai-video-benchmark-execution-gate.ts).
    if (!request.referenceImageUrl) {
      throw new GenerativeProviderError(
        "Veo: este adapter requiere referenceImageUrl (imagen de referencia aprobada, image-to-video) — nunca genera text-to-video automáticamente.",
        "veo",
        "invalid_request",
      );
    }

    const durationSeconds = VEO_DURATION_SECONDS_1080P;
    const estimatedCost = durationSeconds * getVeoCostUsdPerSecond();
    if (estimatedCost > request.maxCostUsd) {
      throw new GenerativeProviderError(
        `Costo estimado ($${estimatedCost}) excede el máximo permitido para este clip ($${request.maxCostUsd})`,
        "veo",
        "budget_exceeded",
      );
    }

    const operationName = await submitGeneration({ ...request, durationSeconds });
    const { uri, mimeType } = await waitForCompletion(operationName);
    const buffer = await downloadVideo(uri);

    return {
      buffer,
      mimeType,
      extension: "mp4",
      durationSeconds,
      model: VEO_MODEL,
      costUsd: estimatedCost,
      providerJobId: operationName,
      // Veo SIEMPRE genera audio nativo (confirmado por Hans) — nunca se
      // inventa un switch para apagarlo (P2A.5 sección 6); este flag deja
      // constancia para que el renderer/pipeline lo descarte/reemplace.
      sourceHasGeneratedAudio: true,
    };
  },
};
