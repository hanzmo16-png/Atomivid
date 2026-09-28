import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "../types";
import { fetchFailureOutcome, httpStatusOutcome } from "../charge-outcome";

/** Official contract checked 2026-09-27:
 * https://docs.dev.runwayml.com/guides/using-the-api/
 * https://docs.dev.runwayml.com/assets/inputs/
 * https://docs.dev.runwayml.com/guides/pricing/
 * Fixed to Gen-4 Turbo: other models need their own validated pricing/contract.
 */
export const RUNWAY_MODEL = "gen4_turbo";
export const RUNWAY_COST_USD_PER_SECOND = 0.05;
const API_BASE = "https://api.dev.runwayml.com/v1";
const API_VERSION = "2024-11-06";
const POLL_TIMEOUT_MS = 180_000;
const RATIOS = { "16:9": "1280:720", "9:16": "720:1280" } as const;

function error(message: string, reason: GenerativeProviderError["reason"], jobId?: string) {
  return new GenerativeProviderError(message, "runway", reason, undefined, jobId, jobId ? "uncertain" : "not_sent");
}
function key() { return process.env.RUNWAY_API_KEY?.trim() || process.env.RUNWAYML_API_SECRET?.trim(); }
function headers() {
  if (!key()) throw error("Runway: falta configurar la clave de API", "not_configured");
  return { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", "X-Runway-Version": API_VERSION };
}
function validateCost(request: VideoGenerationRequest, jobId?: string): number {
  if (![5, 10].includes(request.durationSeconds)) throw error("Runway: elegir exactamente 5 o 10 segundos", "invalid_request", jobId);
  if (!RATIOS[request.aspectRatio]) throw error("Runway: relación de aspecto no válida", "invalid_request", jobId);
  const cost = request.durationSeconds * RUNWAY_COST_USD_PER_SECOND;
  if (!Number.isFinite(request.maxCostUsd) || request.maxCostUsd < cost) throw error("Runway: presupuesto insuficiente para el clip", "budget_exceeded", jobId);
  if (process.env.RUNWAY_MODEL && process.env.RUNWAY_MODEL !== RUNWAY_MODEL) throw error("Runway: este adaptador solo admite gen4_turbo", "invalid_request", jobId);
  return cost;
}

/** Pure preflight: no credentials, submission or network. */
export function buildRunwayPayload(request: VideoGenerationRequest) {
  validateCost(request);
  const reference = request.referenceImageUrl?.trim();
  if (!reference || !/^(https:\/\/|data:image\/(png|jpeg|webp);base64,|runway:\/\/)/.test(reference)) {
    throw error("Runway: se requiere una imagen de referencia HTTPS, data URI o runway URI", "invalid_request");
  }
  const promptText = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  if (!promptText.trim() || [...promptText].length > 1000) throw error("Runway: el prompt debe contener entre 1 y 1000 caracteres", "invalid_request");
  const seed = request.seed === undefined ? undefined : Number(request.seed);
  if (request.seed !== undefined && (!/^\d+$/.test(request.seed) || !Number.isInteger(seed) || seed! < 0 || seed! > 4294967295)) {
    throw error("Runway: semilla fuera de rango", "invalid_request");
  }
  return { model: RUNWAY_MODEL, promptImage: reference, promptText, ratio: RATIOS[request.aspectRatio], duration: request.durationSeconds,
    ...(request.seed === undefined ? {} : { seed }) };
}

function httpReason(status: number): GenerativeProviderError["reason"] {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_request";
  return "upstream_error";
}
async function createTask(request: VideoGenerationRequest): Promise<string> {
  const body = JSON.stringify(buildRunwayPayload(request));
  const requestHeaders = headers();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/image_to_video`, { method: "POST", headers: requestHeaders, body, signal: AbortSignal.timeout(30_000) });
  } catch (cause) {
    throw new GenerativeProviderError("Runway: fallo de conexión al enviar; no reenviar sin conciliación", "runway", "upstream_error", undefined, undefined, fetchFailureOutcome(cause));
  }
  if (!response.ok) throw new GenerativeProviderError(`Runway: envío rechazado con HTTP ${response.status}`, "runway", httpReason(response.status), undefined, undefined, httpStatusOutcome(response.status));
  const json = await response.json().catch(() => null) as { id?: unknown } | null;
  if (typeof json?.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(json.id)) {
    throw new GenerativeProviderError("Runway: respuesta de envío sin id válido; resultado incierto", "runway", "invalid_response", undefined, undefined, "uncertain");
  }
  return json.id;
}
async function finish(jobId: string, request: VideoGenerationRequest): Promise<GenerativeAsset> {
  const cost = validateCost(request, jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw error("Runway: identificador de tarea no válido", "invalid_request", jobId);
  let requestHeaders: ReturnType<typeof headers>;
  try { requestHeaders = headers(); } catch { throw error("Runway: falta configurar la clave para reanudar", "not_configured", jobId); }
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = 5_000;
  try {
    for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt++) {
      const response = await fetch(`${API_BASE}/tasks/${encodeURIComponent(jobId)}`, { headers: requestHeaders, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))) });
      if (!response.ok) throw error(`Runway: consulta respondió HTTP ${response.status}`, httpReason(response.status), jobId);
      const task = await response.json() as { status?: string; output?: unknown[]; failureCode?: string };
      if (task.status === "SUCCEEDED") {
        const outputUrl = task.output?.[0];
        if (typeof outputUrl !== "string" || !outputUrl.startsWith("https://")) throw error("Runway: tarea completada sin URL de video válida", "invalid_response", jobId);
        // Never forward API credentials to the media host, or log signed URLs.
        const video = await fetch(outputUrl, { signal: AbortSignal.timeout(60_000) });
        if (!video.ok) throw error("Runway: falló la descarga del clip", "download_failed", jobId);
        const buffer = Buffer.from(await video.arrayBuffer());
        if (!buffer.length) throw error("Runway: clip vacío", "download_failed", jobId);
        return { buffer, mimeType: "video/mp4", extension: "mp4", durationSeconds: request.durationSeconds,
          model: RUNWAY_MODEL, costUsd: cost, costBasis: "estimated", providerJobId: jobId, sourceHasGeneratedAudio: false };
      }
      if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "CANCELLED") {
        throw error("Runway: la tarea terminó sin video", task.failureCode?.toLowerCase().includes("safety") ? "moderation_rejected" : "upstream_error", jobId);
      }
      if (!["PENDING", "RUNNING", "THROTTLED"].includes(task.status ?? "")) throw error("Runway: estado de tarea desconocido", "invalid_response", jobId);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(delay, deadline - Date.now()))));
      delay = Math.min(15_000, delay * 1.5);
    }
    throw error("Runway: espera agotada; reanudar la misma tarea", "timeout", jobId);
  } catch (cause) {
    if (cause instanceof GenerativeProviderError) throw cause;
    throw error("Runway: consulta o descarga interrumpida; conservar la tarea", "upstream_error", jobId);
  }
}

export const runwayVideoProvider: VideoProvider = {
  name: "runway",
  capabilities: { id: "runway", models: [RUNWAY_MODEL], formats: ["video/mp4"], aspectRatios: ["9:16", "16:9"], timeoutMs: POLL_TIMEOUT_MS, maxRetries: 0 },
  isAvailable() { return Boolean(key()); },
  async generateVideo(request) {
    headers();
    const jobId = await createTask(request);
    // The operation already exists. A callback failure must not cause another POST.
    try { await request.onProviderJobAccepted?.(jobId); } catch { /* Continue retrieval; errors and result retain jobId. */ }
    return finish(jobId, request);
  },
  async resumeGeneration(jobId, request) { return finish(jobId, request); },
};
