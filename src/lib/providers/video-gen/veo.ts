import { MissingEnvVarError } from "@/lib/env-errors";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "../types";

/**
 * Adaptador REAL (P2A.5) para Google Veo 3.1 Fast vía la Gemini API —
 * primer proveedor de video-IA de ATOMIVID desbloqueado con contrato
 * implementado (no ya un skeleton contract_unverified como kling.ts).
 *
 * FUENTE DE LOS DATOS: P2A.5 usó una citación de Hans; en P2A.6 Hans
 * verificó DIRECTAMENTE la documentación oficial actual —
 *   https://ai.google.dev/gemini-api/docs/veo
 *   https://ai.google.dev/gemini-api/docs/pricing
 * Este entorno sigue sin poder leer ai.google.dev directamente
 * (EGRESS_BLOCKED, reconfirmado en P2A.6) — Claude implementa exactamente
 * lo que Hans confirmó campo por campo, sin re-verificación propia. Si
 * algo difiere de la doc en vivo en el futuro, corregir aquí, nunca
 * sobrescribir en silencio.
 *
 * Contrato confirmado por Hans (P2A.6):
 *   - Modelo API: "veo-3.1-fast-generate-preview".
 *   - REST base: https://generativelanguage.googleapis.com/v1beta
 *   - Submit: POST /models/veo-3.1-fast-generate-preview:predictLongRunning
 *   - Auth: header "x-goog-api-key".
 *   - Async: submit -> operation name -> GET operation -> done -> URI de
 *     video generado -> download.
 *   - image-to-video soportado; el parámetro `image` es un objeto Image,
 *     NO una URI arbitraria — el ejemplo oficial en JavaScript usa
 *     `imageBytes` (bytes en base64) + `mimeType`. Este adapter NUNCA
 *     envía `{ image: { uri } }` (P2A.5 lo hacía, corregido en P2A.6):
 *     descarga la imagen de referencia aprobada de ATOMIVID del lado del
 *     servidor, la convierte a base64, y construye el objeto Image
 *     documentado. La imagen NUNCA se expone al cliente ni la clave se usa
 *     fuera de este adapter server-side.
 *   - aspectRatios: 16:9, 9:16. resolutions: 720p/1080p/4k. 1080p -> 8s
 *     (única duración usada aquí). 24fps.
 *   - Audio: SIEMPRE generado, sin parámetro documentado para
 *     desactivarlo — nunca se inventa uno (ver GenerativeAsset.
 *     sourceHasGeneratedAudio, providers/types.ts).
 *   - Precio 1080p: $0.12/segundo -> 8s = $0.96/clip.
 *   - Descarga: response.generateVideoResponse.generatedSamples[0].video.uri.
 *
 * Se prefirió mantener REST (no el SDK oficial de Google) para esta
 * corrección: agregar una dependencia nueva (@google/genai o equivalente)
 * introduce su propia superficie de ambigüedad (nombres de método,
 * versión, compatibilidad con el runtime serverless de Vercel) sin
 * eliminar la necesidad de verificar el contrato subyacente — y el resto
 * de proveedores generativos de este repo (runway.ts, openai.ts) ya usan
 * REST puro sin SDK, así que esto mantiene el patrón establecido en vez de
 * introducir uno nuevo solo para Veo.
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

function sniffImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Descarga la imagen de referencia APROBADA de ATOMIVID (nunca una URL
 * arbitraria sin pasar por el gate de aprobación, ver
 * ai-video-benchmark-execution-gate.ts) del lado del servidor y la
 * convierte al objeto Image documentado por Google (`imageBytes` en
 * base64 + `mimeType`) — la Gemini API NO acepta una URI/referencia
 * externa arbitraria para image-to-video (corrección P2A.6, ver
 * comentario de cabecera). El tipo MIME se toma del header `content-type`
 * de la respuesta; si es genérico o falta, se detecta por firma de bytes
 * (PNG/JPEG/WebP) antes de asumir "image/png" como último recurso.
 */
async function fetchReferenceImageAsGeminiImageObject(referenceImageUrl: string): Promise<{ imageBytes: string; mimeType: string }> {
  let response: Response;
  try {
    response = await fetch(referenceImageUrl);
  } catch (err) {
    throw new GenerativeProviderError("Veo: fallo de red al leer la imagen de referencia aprobada", "veo", "invalid_request", err);
  }
  if (!response.ok) {
    throw new GenerativeProviderError(`No se pudo leer la imagen de referencia aprobada (HTTP ${response.status})`, "veo", "invalid_request");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new GenerativeProviderError("La imagen de referencia aprobada está vacía (0 bytes)", "veo", "invalid_request");
  }
  const headerMime = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mimeType = headerMime && headerMime.startsWith("image/") ? headerMime : (sniffImageMimeType(buffer) ?? "image/png");
  return { imageBytes: buffer.toString("base64"), mimeType };
}

/**
 * Mapea un `VideoGenerationRequest` normalizado (provider-agnóstico) al
 * payload de `predictLongRunning` — el negativePrompt NUNCA se envía como
 * campo API separado (no está confirmado que la Gemini API lo soporte
 * para video): se integra en el prompt principal como texto "Avoid: ...",
 * mismo patrón ya usado por runway.ts. `image` SIEMPRE es el objeto
 * documentado (`imageBytes`/`mimeType`, ver
 * fetchReferenceImageAsGeminiImageObject) — nunca una URI, corrección
 * P2A.6.
 */
async function buildRequestPayload(request: VideoGenerationRequest): Promise<Record<string, unknown>> {
  const prompt = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  const instance: Record<string, unknown> = { prompt };
  if (request.referenceImageUrl) {
    instance.image = await fetchReferenceImageAsGeminiImageObject(request.referenceImageUrl);
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
  const payload = await buildRequestPayload(request);
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
