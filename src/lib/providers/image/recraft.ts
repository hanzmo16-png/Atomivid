import { GenerativeProviderError, type ImageGenerationRequest, type ImageProvider } from "../types";

/**
 * Recraft V4 Styles (text-to-image) via the fal.ai QUEUE API. Server/worker only: FAL_KEY is read from
 * process.env at call time, never exported, never logged, never part of an error message.
 *
 * Contract verified 2026-10-21 against the official pages (see docs/RECRAFT_FAL.md):
 * - https://fal.ai/models/recraft/v4/style/text-to-image/api — input: prompt (required), image_size
 *   (enum square_hd|square|portrait_4_3|portrait_16_9|landscape_4_3|landscape_16_9 or {width,height}), colors,
 *   background_color, enable_safety_checker, style_id, image_urls (1-10 PNG/JPG/WEBP style references),
 *   style_match (precise|flexible). Output: images[] (url, content_type, file_name, file_size) and style_id
 *   ("the custom style used or created for this generation").
 * - https://fal.ai/models/recraft/v4/style/text-to-image — price: USD 0.035 per image with a style_id; without
 *   style_id a style is created from image_urls for USD 0.005 extra and its style_id is returned.
 * - https://docs.fal.ai/model-apis/model-endpoints/queue — POST https://queue.fal.run/{model} with
 *   "Authorization: Key $FAL_KEY" returns request_id (+status_url/response_url); status at
 *   /{owner}/{app}/requests/{id}/status (IN_QUEUE|IN_PROGRESS|COMPLETED, error/error_type when failed); result at
 *   /{owner}/{app}/requests/{id}. Status/result URLs use ONLY owner/app ("recraft/v4"), never the full model path.
 *   Media URLs expire: we always download and store the bytes (visual-resource-resolver.ts).
 */

export const RECRAFT_MODEL = "recraft/v4/style/text-to-image";
const QUEUE_BASE = "https://queue.fal.run";
const APP_PATH = "recraft/v4";
export const RECRAFT_USD_PER_IMAGE = 0.035;
export const RECRAFT_USD_STYLE_CREATION = 0.005;
const MIN_DIMENSION = 512;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const STYLE_ID = /^[A-Za-z0-9-]{8,64}$/;
/**
 * Known identifiers that are NOT style ids. 01a15cd6-… is the fal request_id of a manual test (queue request id),
 * not a Recraft style: passing it as style_id would be refused by fal or, worse, paid for nothing.
 */
const KNOWN_NON_STYLE_IDS = new Set(["01a15cd6-f79f-77f1-8f4a-06d582611ae4"]);
export function isValidStyleId(v: unknown): v is string {
  return typeof v === "string" && STYLE_ID.test(v) && !KNOWN_NON_STYLE_IDS.has(v.toLowerCase());
}

type Env = Record<string, string | undefined>;
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const recraftTimeoutMs = (env: Env = process.env) => num(env.RECRAFT_TIMEOUT_MS, 180_000);
const pollIntervalMs = (env: Env = process.env) => num(env.RECRAFT_POLL_INTERVAL_MS, 2_000);
const httpTimeoutMs = (env: Env = process.env) => num(env.RECRAFT_HTTP_TIMEOUT_MS, 30_000);

/** Cost BEFORE submitting, from the published price list (no network). */
export function recraftEstimatedCostUsd(request: Pick<ImageGenerationRequest, "style">): number {
  return request.style?.styleId ? RECRAFT_USD_PER_IMAGE : RECRAFT_USD_PER_IMAGE + RECRAFT_USD_STYLE_CREATION;
}

function falKey(): string {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new GenerativeProviderError("FAL_KEY no está configurada en el worker: no se llamó a Recraft (fal.ai).", "recraft", "not_configured");
  return key;
}

export function recraftInput(request: ImageGenerationRequest): Record<string, unknown> {
  const style = request.style;
  const refs = style?.referenceImageUrls ?? [];
  if (!style?.styleId && (refs.length < 1 || refs.length > 10)) {
    throw new GenerativeProviderError("Recraft necesita un style_id o entre 1 y 10 imágenes de referencia elegidas para este video.", "recraft", "invalid_request");
  }
  const prompt = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  return {
    prompt,
    image_size: request.aspectRatio === "16:9" ? "landscape_16_9" : "portrait_16_9",
    enable_safety_checker: true,
    ...(style?.styleId ? { style_id: style.styleId } : { image_urls: refs }),
    ...(style?.match ? { style_match: style.match } : {}),
  };
}

async function falFetch(url: string, init: RequestInit, providerJobId?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  try {
    return await fetch(url, { ...init, headers: { Authorization: `Key ${falKey()}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: controller.signal });
  } catch (err) {
    if (err instanceof GenerativeProviderError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    // Submit: whether fal accepted is unknown (uncertain → ledger RECONCILIATION_REQUIRED, never resent).
    throw new GenerativeProviderError(aborted ? "Tiempo de espera agotado hablando con fal.ai" : "Error de red hablando con fal.ai", "recraft", aborted ? "timeout" : "upstream_error", err, providerJobId);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps an HTTP refusal. Never includes the body (it may echo the prompt); only a fixed category. */
async function httpError(res: Response, stage: string, providerJobId?: string): Promise<GenerativeProviderError> {
  let text = "";
  try { text = (await res.text()).toLowerCase(); } catch { /* ignore */ }
  const s = res.status;
  if (s === 402 || /insufficient|balance|credit|exhausted|payment/.test(text) && s < 500) {
    return new GenerativeProviderError(`fal.ai rechazó ${stage}: saldo/créditos insuficientes (HTTP ${s}). Recarga el saldo de fal.ai; no se generó ninguna imagen.`, "recraft", "quota_exceeded", undefined, providerJobId);
  }
  if (s === 401 || s === 403) return new GenerativeProviderError(`fal.ai rechazó la credencial FAL_KEY (HTTP ${s}) en ${stage}.`, "recraft", "authentication_error", undefined, providerJobId);
  if (s === 429) return new GenerativeProviderError(`fal.ai limitó la velocidad (HTTP 429) en ${stage}.`, "recraft", "rate_limited", undefined, providerJobId);
  if (s === 400 || s === 422) return new GenerativeProviderError(`fal.ai rechazó la solicitud como inválida (HTTP ${s}) en ${stage}.`, "recraft", "invalid_request", undefined, providerJobId);
  return new GenerativeProviderError(`fal.ai respondió HTTP ${s} en ${stage}.`, "recraft", "upstream_error", undefined, providerJobId);
}

/** Width/height from PNG, JPEG or WEBP headers; null if unreadable. */
export function imageDimensions(buf: Buffer): { width: number; height: number; type: string } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { type: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const b = buf.readUInt32LE(21); return { type: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

async function download(url: string, providerJobId: string): Promise<{ buffer: Buffer; mimeType: string; width: number; height: number }> {
  if (!/^https:\/\//.test(url)) throw new GenerativeProviderError("fal.ai devolvió una URL de imagen no HTTPS.", "recraft", "invalid_response", undefined, providerJobId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  let res: Response;
  try { res = await fetch(url, { signal: controller.signal }); }
  catch (err) { throw new GenerativeProviderError("No se pudo descargar la imagen de Recraft (red/tiempo).", "recraft", "download_failed", err, providerJobId); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new GenerativeProviderError(`No se pudo descargar la imagen de Recraft (HTTP ${res.status}).`, "recraft", "download_failed", undefined, providerJobId);
  const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) throw new GenerativeProviderError("La imagen de Recraft llegó vacía (0 bytes).", "recraft", "download_failed", undefined, providerJobId);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new GenerativeProviderError("La imagen de Recraft excede el tamaño máximo.", "recraft", "invalid_response", undefined, providerJobId);
  const dim = imageDimensions(buffer);
  if (!dim) throw new GenerativeProviderError("El archivo de Recraft no es PNG/JPEG/WEBP legible.", "recraft", "invalid_response", undefined, providerJobId);
  if (declared && ALLOWED_TYPES.has(declared) && declared !== dim.type) throw new GenerativeProviderError(`Recraft declaró ${declared} pero el contenido es ${dim.type}.`, "recraft", "invalid_response", undefined, providerJobId);
  if (declared && !ALLOWED_TYPES.has(declared) && declared !== "application/octet-stream") throw new GenerativeProviderError(`Tipo de contenido no permitido: ${declared}.`, "recraft", "invalid_response", undefined, providerJobId);
  if (dim.width < MIN_DIMENSION || dim.height < MIN_DIMENSION) throw new GenerativeProviderError(`Imagen de Recraft demasiado pequeña (${dim.width}x${dim.height}).`, "recraft", "invalid_response", undefined, providerJobId);
  return { buffer, mimeType: dim.type, width: dim.width, height: dim.height };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export const recraftImageProvider: ImageProvider = {
  name: "recraft",
  capabilities: {
    id: "recraft",
    models: [RECRAFT_MODEL],
    formats: ["image/webp", "image/png", "image/jpeg"],
    aspectRatios: ["portrait_16_9 (9:16)", "landscape_16_9 (16:9)"],
    timeoutMs: recraftTimeoutMs(),
    maxRetries: 0,
  },
  isAvailable() {
    return Boolean(process.env.FAL_KEY?.trim());
  },
  estimateCostUsd(request) {
    return recraftEstimatedCostUsd(request);
  },
  async submitImage(request) {
    const estimate = recraftEstimatedCostUsd(request);
    if (estimate > request.maxCostUsd + 1e-9) {
      throw new GenerativeProviderError(`Costo estimado de Recraft (USD ${estimate.toFixed(3)}) excede el máximo de esta escena (USD ${request.maxCostUsd.toFixed(3)}). No se envió nada.`, "recraft", "budget_exceeded");
    }
    const input = recraftInput(request);
    falKey();
    // X-Fal-No-Retry: fal must not silently re-run (and re-bill) a request we did not resend; our ledger owns retries.
    const res = await falFetch(`${QUEUE_BASE}/${RECRAFT_MODEL}`, { method: "POST", body: JSON.stringify(input), headers: { "X-Fal-No-Retry": "1" } });
    if (!res.ok) throw await httpError(res, "el envío");
    const json = (await res.json().catch(() => null)) as { request_id?: unknown } | null;
    const id = typeof json?.request_id === "string" ? json.request_id : "";
    if (!REQUEST_ID.test(id)) {
      // HTTP 200 without a usable id: fal may have accepted; outcome uncertain (never resent).
      throw new GenerativeProviderError("fal.ai aceptó el envío pero no devolvió un request_id válido.", "recraft", "invalid_response");
    }
    return { providerJobId: id };
  },
  async resumeImage(providerJobId, request) {
    if (!REQUEST_ID.test(providerJobId)) throw new GenerativeProviderError("request_id de fal.ai inválido.", "recraft", "invalid_request", undefined, providerJobId);
    const base = `${QUEUE_BASE}/${APP_PATH}/requests/${encodeURIComponent(providerJobId)}`;
    const deadline = Date.now() + recraftTimeoutMs();
    for (;;) {
      const st = await falFetch(`${base}/status`, { method: "GET" }, providerJobId);
      if (!st.ok) throw await httpError(st, "la consulta de estado", providerJobId);
      const s = (await st.json().catch(() => ({}))) as { status?: string; error?: string; error_type?: string };
      if (s.status === "COMPLETED") {
        if (s.error || s.error_type) {
          throw new GenerativeProviderError(`Recraft terminó con error (${String(s.error_type ?? "error").slice(0, 60)}). request_id ${providerJobId}.`, "recraft", "upstream_error", undefined, providerJobId);
        }
        break;
      }
      if (s.status !== "IN_QUEUE" && s.status !== "IN_PROGRESS") {
        throw new GenerativeProviderError(`Estado desconocido de fal.ai: ${String(s.status).slice(0, 30)}.`, "recraft", "invalid_response", undefined, providerJobId);
      }
      if (Date.now() + pollIntervalMs() > deadline) {
        // The request_id is in the ledger (PROVIDER_JOB_RECORDED): a later attempt resumes it, never resubmits.
        throw new GenerativeProviderError(`Recraft no terminó en ${Math.round(recraftTimeoutMs() / 1000)} s; request_id ${providerJobId} guardado para reanudar sin volver a cobrar.`, "recraft", "timeout", undefined, providerJobId);
      }
      await sleep(pollIntervalMs());
    }
    const r = await falFetch(base, { method: "GET" }, providerJobId);
    if (!r.ok) throw await httpError(r, "la lectura del resultado", providerJobId);
    const out = (await r.json().catch(() => null)) as { images?: Array<{ url?: string }>; style_id?: unknown } | null;
    const url = out?.images?.[0]?.url;
    if (!url) throw new GenerativeProviderError("Resultado de Recraft sin imágenes.", "recraft", "invalid_response", undefined, providerJobId);
    // fal's output schema lists `style_id` but does NOT mark it required (official API page, checked 2026-10-21). A
    // created style without a valid id is NOT an error here: the image is paid and usable, so it is returned (styleId
    // undefined) and stored; the CALLER applies the video's coherence policy (stop, or keep the same references) before
    // any other image. A malformed id or one equal to the request id is treated as absent, never adopted.
    let styleId: string | undefined = request.style?.styleId;
    if (!styleId) {
      const returned = typeof out?.style_id === "string" ? out.style_id.trim() : "";
      styleId = isValidStyleId(returned) && returned !== providerJobId ? returned : undefined;
    }
    const img = await download(url, providerJobId);
    return {
      buffer: img.buffer, mimeType: img.mimeType, extension: EXT[img.mimeType], width: img.width, height: img.height,
      model: RECRAFT_MODEL, costUsd: recraftEstimatedCostUsd(request), costBasis: "estimated", providerJobId, styleId,
    };
  },
  async generateImage(request) {
    const { providerJobId } = await this.submitImage!(request);
    return this.resumeImage!(providerJobId, request);
  },
};
