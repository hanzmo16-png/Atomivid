import { GenerativeProviderError, type ImageGenerationRequest, type ImageProvider } from "../types";
import { imageDimensions } from "./recraft";

/**
 * FLUX.1 [dev] (text-to-image) via the fal.ai QUEUE API — the second selectable image provider (Recraft stays the
 * first). Server/worker only: FAL_KEY is read from process.env at call time, never exported, logged or echoed.
 *
 * Contract verified 2026-11-13 against the official pages (docs/FLUX_FAL.md):
 * - https://fal.ai/models/fal-ai/flux/dev/api and its OpenAPI (fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev):
 *   input prompt (required), image_size (enum or {width,height}), num_inference_steps (1-50, default 28),
 *   guidance_scale (1-20, default 3.5), num_images (1-4), seed, enable_safety_checker (default true),
 *   output_format (jpeg|png), sync_mode, acceleration (none|regular|high). Output (all required): images[], timings,
 *   seed, has_nsfw_concepts[], prompt.
 * - https://fal.ai/models/fal-ai/flux/dev — price: "USD 0.025 per megapixel. Images are billed by rounding up to the
 *   nearest megapixel." We request 720×1280 (9:16) or 1280×720 (16:9) = 0.92 MP → billed as 1 MP → USD 0.025.
 * - Queue (https://docs.fal.ai/model-apis/model-endpoints/queue): POST https://queue.fal.run/fal-ai/flux/dev with
 *   "Authorization: Key $FAL_KEY" → request_id; status /fal-ai/flux/requests/{id}/status; result /fal-ai/flux/requests/{id}
 *   (owner/app only). Media URLs expire: the bytes are always downloaded and stored by the caller.
 */

export const FLUX_MODEL = "fal-ai/flux/dev";
const QUEUE_BASE = "https://queue.fal.run";
const APP_PATH = "fal-ai/flux";
export const FLUX_USD_PER_MEGAPIXEL = 0.025;
/** Exact pixel sizes we send (multiples of 16, ≤ 1 MP so each image is billed as exactly one megapixel). */
export const FLUX_SIZES = { "9:16": { width: 720, height: 1280 }, "16:9": { width: 1280, height: 720 } } as const;
const MIN_DIMENSION = 512;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PROMPT_CHARS = 2000;

type Env = Record<string, string | undefined>;
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const fluxTimeoutMs = (env: Env = process.env) => num(env.FLUX_TIMEOUT_MS, 180_000);
const pollIntervalMs = (env: Env = process.env) => num(env.FLUX_POLL_INTERVAL_MS, 2_000);
const httpTimeoutMs = (env: Env = process.env) => num(env.FLUX_HTTP_TIMEOUT_MS, 30_000);

/** Size for a request. Only the two production formats exist; anything else is refused before any call. */
export function fluxImageSize(aspectRatio: ImageGenerationRequest["aspectRatio"]): { width: number; height: number } {
  if (aspectRatio === "9:16" || aspectRatio === "16:9") return { ...FLUX_SIZES[aspectRatio] };
  throw new GenerativeProviderError(`FLUX solo admite 9:16 o 16:9 en ATOMIVID (pedido: ${String(aspectRatio).slice(0, 10)}).`, "flux", "invalid_request");
}

/** Published price, BEFORE submitting (no network): megapixels rounded UP × USD 0.025. */
export function fluxEstimatedCostUsd(request: Pick<ImageGenerationRequest, "aspectRatio">): number {
  const { width, height } = fluxImageSize(request.aspectRatio);
  return Math.round(Math.ceil((width * height) / 1_000_000) * FLUX_USD_PER_MEGAPIXEL * 10_000) / 10_000;
}

function falKey(): string {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new GenerativeProviderError("FAL_KEY no está configurada en el worker: no se llamó a FLUX (fal.ai).", "flux", "not_configured");
  return key;
}

/** Exact body sent to fal. One image, safety checker on, provider defaults for steps/guidance (documented). */
export function fluxInput(request: ImageGenerationRequest): Record<string, unknown> {
  const raw = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (!prompt) throw new GenerativeProviderError("FLUX necesita un prompt no vacío.", "flux", "invalid_request");
  if (prompt.length > MAX_PROMPT_CHARS) throw new GenerativeProviderError(`El prompt de FLUX supera ${MAX_PROMPT_CHARS} caracteres.`, "flux", "invalid_request");
  return {
    prompt,
    image_size: fluxImageSize(request.aspectRatio),
    num_images: 1,
    num_inference_steps: 28,
    guidance_scale: 3.5,
    enable_safety_checker: true,
    output_format: "jpeg",
  };
}

async function falFetch(url: string, init: RequestInit, providerJobId?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  try {
    return await fetch(url, { ...init, redirect: "error", headers: { Authorization: `Key ${falKey()}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: controller.signal });
  } catch (err) {
    if (err instanceof GenerativeProviderError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    // Submit: whether fal accepted is unknown (uncertain → ledger RECONCILIATION_REQUIRED, never resent).
    throw new GenerativeProviderError(aborted ? "Tiempo de espera agotado hablando con fal.ai" : "Error de red hablando con fal.ai", "flux", aborted ? "timeout" : "upstream_error", err, providerJobId);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps an HTTP refusal. Never includes the body (it may echo the prompt); only a fixed category. */
async function httpError(res: Response, stage: string, providerJobId?: string): Promise<GenerativeProviderError> {
  let text = "";
  try { text = (await res.text()).toLowerCase(); } catch { /* ignore */ }
  const s = res.status;
  if (s === 402 || (/insufficient|balance|credit|exhausted|payment/.test(text) && s < 500)) {
    return new GenerativeProviderError(`fal.ai rechazó ${stage}: saldo/créditos insuficientes (HTTP ${s}). Recarga el saldo de fal.ai; no se generó ninguna imagen.`, "flux", "quota_exceeded", undefined, providerJobId);
  }
  if (s === 401 || s === 403) return new GenerativeProviderError(`fal.ai rechazó la credencial FAL_KEY (HTTP ${s}) en ${stage}.`, "flux", "authentication_error", undefined, providerJobId);
  if (s === 429) return new GenerativeProviderError(`fal.ai limitó la velocidad (HTTP 429) en ${stage}.`, "flux", "rate_limited", undefined, providerJobId);
  if (s === 400 || s === 422) return new GenerativeProviderError(`fal.ai rechazó la solicitud como inválida (HTTP ${s}) en ${stage}.`, "flux", "invalid_request", undefined, providerJobId);
  return new GenerativeProviderError(`fal.ai respondió HTTP ${s} en ${stage}.`, "flux", "upstream_error", undefined, providerJobId);
}

async function download(url: string, providerJobId: string): Promise<{ buffer: Buffer; mimeType: string; width: number; height: number }> {
  if (!/^https:\/\//.test(url)) throw new GenerativeProviderError("fal.ai devolvió una URL de imagen no HTTPS.", "flux", "invalid_response", undefined, providerJobId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  let res: Response;
  try { res = await fetch(url, { signal: controller.signal }); }
  catch (err) { throw new GenerativeProviderError("No se pudo descargar la imagen de FLUX (red/tiempo).", "flux", "download_failed", err, providerJobId); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new GenerativeProviderError(`No se pudo descargar la imagen de FLUX (HTTP ${res.status}).`, "flux", "download_failed", undefined, providerJobId);
  const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) throw new GenerativeProviderError("La imagen de FLUX llegó vacía (0 bytes).", "flux", "download_failed", undefined, providerJobId);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new GenerativeProviderError("La imagen de FLUX excede el tamaño máximo.", "flux", "invalid_response", undefined, providerJobId);
  const dim = imageDimensions(buffer);
  if (!dim) throw new GenerativeProviderError("El archivo de FLUX no es PNG/JPEG/WEBP legible.", "flux", "invalid_response", undefined, providerJobId);
  if (declared && ALLOWED_TYPES.has(declared) && declared !== dim.type) throw new GenerativeProviderError(`FLUX declaró ${declared} pero el contenido es ${dim.type}.`, "flux", "invalid_response", undefined, providerJobId);
  if (declared && !ALLOWED_TYPES.has(declared) && declared !== "application/octet-stream") throw new GenerativeProviderError(`Tipo de contenido no permitido: ${declared}.`, "flux", "invalid_response", undefined, providerJobId);
  if (dim.width < MIN_DIMENSION || dim.height < MIN_DIMENSION) throw new GenerativeProviderError(`Imagen de FLUX demasiado pequeña (${dim.width}x${dim.height}).`, "flux", "invalid_response", undefined, providerJobId);
  return { buffer, mimeType: dim.type, width: dim.width, height: dim.height };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export const fluxImageProvider: ImageProvider = {
  name: "flux",
  capabilities: {
    id: "flux",
    models: [FLUX_MODEL],
    formats: ["image/jpeg", "image/png", "image/webp"],
    aspectRatios: ["720x1280 (9:16)", "1280x720 (16:9)"],
    timeoutMs: fluxTimeoutMs(),
    maxRetries: 0,
  },
  isAvailable() {
    return Boolean(process.env.FAL_KEY?.trim());
  },
  estimateCostUsd(request) {
    return fluxEstimatedCostUsd(request);
  },
  async submitImage(request) {
    const estimate = fluxEstimatedCostUsd(request);
    if (estimate > request.maxCostUsd + 1e-9) {
      throw new GenerativeProviderError(`Costo estimado de FLUX (USD ${estimate.toFixed(3)}) excede el máximo de esta imagen (USD ${request.maxCostUsd.toFixed(3)}). No se envió nada.`, "flux", "budget_exceeded");
    }
    const input = fluxInput(request);
    falKey();
    // X-Fal-No-Retry: fal must not silently re-run (and re-bill) a request we did not resend; our ledger owns retries.
    const res = await falFetch(`${QUEUE_BASE}/${FLUX_MODEL}`, { method: "POST", body: JSON.stringify(input), headers: { "X-Fal-No-Retry": "1" } });
    if (!res.ok) throw await httpError(res, "el envío");
    const json = (await res.json().catch(() => null)) as { request_id?: unknown } | null;
    const id = typeof json?.request_id === "string" ? json.request_id : "";
    if (!REQUEST_ID.test(id)) {
      // HTTP 200 without a usable id: fal may have accepted; outcome uncertain (never resent).
      throw new GenerativeProviderError("fal.ai aceptó el envío pero no devolvió un request_id válido.", "flux", "invalid_response");
    }
    return { providerJobId: id };
  },
  async resumeImage(providerJobId, request) {
    if (!REQUEST_ID.test(providerJobId)) throw new GenerativeProviderError("request_id de fal.ai inválido.", "flux", "invalid_request", undefined, providerJobId);
    const base = `${QUEUE_BASE}/${APP_PATH}/requests/${encodeURIComponent(providerJobId)}`;
    const deadline = Date.now() + fluxTimeoutMs();
    for (;;) {
      const st = await falFetch(`${base}/status`, { method: "GET" }, providerJobId);
      if (!st.ok) throw await httpError(st, "la consulta de estado", providerJobId);
      const s = (await st.json().catch(() => ({}))) as { status?: string; error?: string; error_type?: string };
      if (s.status === "COMPLETED") {
        if (s.error || s.error_type) {
          throw new GenerativeProviderError(`FLUX terminó con error (${String(s.error_type ?? "error").slice(0, 60)}). request_id ${providerJobId}.`, "flux", "upstream_error", undefined, providerJobId);
        }
        break;
      }
      if (s.status !== "IN_QUEUE" && s.status !== "IN_PROGRESS") {
        throw new GenerativeProviderError(`Estado desconocido de fal.ai: ${String(s.status).slice(0, 30)}.`, "flux", "invalid_response", undefined, providerJobId);
      }
      if (Date.now() + pollIntervalMs() > deadline) {
        // The request_id is in the ledger (PROVIDER_JOB_RECORDED): a later attempt resumes it, never resubmits.
        throw new GenerativeProviderError(`FLUX no terminó en ${Math.round(fluxTimeoutMs() / 1000)} s; request_id ${providerJobId} guardado para reanudar sin volver a cobrar.`, "flux", "timeout", undefined, providerJobId);
      }
      await sleep(pollIntervalMs());
    }
    const r = await falFetch(base, { method: "GET" }, providerJobId);
    if (!r.ok) throw await httpError(r, "la lectura del resultado", providerJobId);
    const out = (await r.json().catch(() => null)) as { images?: Array<{ url?: string }>; has_nsfw_concepts?: unknown } | null;
    const url = out?.images?.[0]?.url;
    if (!url) throw new GenerativeProviderError("Resultado de FLUX sin imágenes.", "flux", "invalid_response", undefined, providerJobId);
    // The safety checker replaces a flagged image with a blank one; it is (probably) billed, so it is NOT a zero-charge
    // refusal: billing-uncertain, never resent, never used.
    if (Array.isArray(out?.has_nsfw_concepts) && out!.has_nsfw_concepts[0] === true) {
      throw new GenerativeProviderError(`El filtro de seguridad de fal.ai marcó la imagen de FLUX (request_id ${providerJobId}); no se usa.`, "flux", "invalid_response", undefined, providerJobId);
    }
    const img = await download(url, providerJobId);
    return {
      buffer: img.buffer, mimeType: img.mimeType, extension: EXT[img.mimeType], width: img.width, height: img.height,
      model: FLUX_MODEL, costUsd: fluxEstimatedCostUsd(request), costBasis: "estimated", providerJobId,
    };
  },
  async generateImage(request) {
    const { providerJobId } = await this.submitImage!(request);
    return this.resumeImage!(providerJobId, request);
  },
};
