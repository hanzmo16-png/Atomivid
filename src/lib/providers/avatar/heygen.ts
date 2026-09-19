import { AvatarProviderError, type AvatarVideoProvider, type AvatarVideoRequest, type AvatarVideoResult, type AvatarJobStatus } from "../types";

// Photo + recorded audio, verified against /v3/videos. No engine field:
// https://developers.heygen.com/audio-to-video
const BASE = "https://api.heygen.com";
const fail = (message: string, reason: AvatarProviderError["reason"] = "invalid_response") => new AvatarProviderError(message, "heygen", reason);
const safeToken = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(v) ? v : "unclassified";

async function api(path: string, init: RequestInit = {}) {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key) throw fail("HEYGEN_API_KEY no está configurada", "not_configured");
  let response: Response;
  try {
    response = await fetch(BASE + path, { ...init, redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "X-Api-Key": key, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers } });
  } catch { throw fail("Error de transporte de HeyGen; no se reintentó la creación.", "upstream_error"); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Free-form provider errors may echo private media URLs. Never log them publicly.
    const code = safeToken(body?.error?.code);
    const param = safeToken(body?.error?.param);
    const knownMessage = body?.error?.message === "Extra inputs are not permitted" ? ": Extra inputs are not permitted" : "";
    throw new AvatarProviderError(`HeyGen HTTP ${response.status}; code=${code}; param=${param}${knownMessage}`, "heygen", "upstream_error", { http: response.status, body });
  }
  if (!body?.data || typeof body.data !== "object") throw fail("HeyGen devolvió una respuesta sin data.");
  return body.data;
}

export function estimateHeygenCost(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw fail("Se requiere duración real del audio.");
  // Conservative cent rounding for the observed Avatar IV photo tariff.
  return Math.ceil(seconds * 0.0385 * 100) / 100;
}

export async function getHeygenWallet(): Promise<number> {
  const d = await api("/v3/users/me");
  const amount = d.wallet?.remaining_balance;
  if (d.wallet?.currency !== "usd" || typeof amount !== "number" || !Number.isFinite(amount)) throw fail("No se pudo verificar el saldo de HeyGen.");
  return amount;
}

async function upload(bytes: Buffer, mime: string, name: string): Promise<string> {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw fail("Archivo vacío o demasiado grande.");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  const data = await api("/v3/assets", { method: "POST", body: form });
  const id = data.asset_id ?? data.id;
  if (typeof id !== "string" || !id) throw fail("HeyGen no devolvió asset_id.");
  return id;
}

function httpsUrl(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
async function download(url: string): Promise<Buffer> {
  if (!httpsUrl(url)) throw fail("Se requiere una URL HTTPS.");
  let r: Response;
  try { r = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "error" }); }
  catch { throw fail("No se pudo descargar el archivo privado.", "upstream_error"); }
  if (!r.ok) throw fail(`Descarga HTTP ${r.status}`, "upstream_error");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw fail("Archivo descargado vacío.");
  return bytes;
}
function status(raw: unknown): AvatarJobStatus {
  if (raw === "waiting" || raw === "pending") return "queued";
  if (raw === "processing") return "processing";
  if (raw === "completed") return "completed";
  if (raw === "cancelled") return "cancelled";
  if (raw === "failed") return "failed";
  throw fail("Estado de HeyGen desconocido.");
}
async function result(id: string, data: Record<string, unknown>, duration?: number, cost = 0): Promise<AvatarVideoResult> {
  if (status(data.status) !== "completed" || typeof data.video_url !== "string") throw fail("El resultado todavía no está disponible.");
  return { buffer: await download(data.video_url), mimeType: "video/mp4", extension: "mp4", model: "avatar-iv-photo",
    durationSeconds: duration, costUsd: cost, providerJobId: id };
}

export const heygenAvatarProvider: AvatarVideoProvider = {
  name: "heygen",
  capabilities: { id: "heygen", models: ["avatar-iv-photo"], formats: ["video/mp4"], aspectRatios: ["9:16", "16:9"], timeoutMs: 600000, maxRetries: 0 },
  isAvailable: () => Boolean(process.env.HEYGEN_API_KEY?.trim()),
  async createAvatar(request) {
    if (!this.isAvailable()) throw fail("HEYGEN_API_KEY no está configurada", "not_configured");
    if (!request.consentGiven) throw fail("Falta el consentimiento del propietario.", "consent_missing");
    const id = await upload(request.photoBuffer, request.mimeType, request.mimeType === "image/png" ? "photo.png" : "photo.jpeg");
    return { providerAvatarId: `asset:${id}`, status: "completed" };
  },
  async checkAvatarStatus(id) {
    if (!id.startsWith("asset:")) throw fail("Se requiere un recurso de foto de HeyGen.");
    await api(`/v3/assets/${encodeURIComponent(id.slice(6))}`);
    return "completed";
  },
  async generateVideo(request) {
    const seconds = request.audioDurationSeconds!;
    const cost = estimateHeygenCost(seconds);
    if (!request.audioUrl || !httpsUrl(request.audioUrl)) throw fail("Se requiere el audio original; no se permite TTS de respaldo.");
    if (!Number.isFinite(request.maxCostUsd) || cost > request.maxCostUsd) throw fail("La estimación supera el presupuesto autorizado.", "budget_exceeded");
    const image = request.providerAvatarId.startsWith("asset:")
      ? { type: "asset_id", asset_id: request.providerAvatarId.slice(6) }
      : httpsUrl(request.providerAvatarId) ? { type: "url", url: request.providerAvatarId } : null;
    if (!image) throw fail("Se requiere la fotografía preparada.");
    // Use the same uploaded-audio shape as the successful sample. No TTS.
    const audioId = await upload(await download(request.audioUrl), "audio/wav", "recording.wav");
    const created = await api("/v3/videos", { method: "POST", body: JSON.stringify({ type: "image", image,
      audio_asset_id: audioId, aspect_ratio: "auto", resolution: "720p" }) });
    if (typeof created.video_id !== "string" || !created.video_id) throw fail("HeyGen no devolvió video_id; no vuelvas a generar.");
    await request.onJobCreated?.(created.video_id);
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const data = await api(`/v3/videos/${encodeURIComponent(created.video_id)}`);
      const state = status(data.status);
      if (state === "completed") return result(created.video_id, data, seconds, cost);
      if (state === "failed" || state === "cancelled") throw fail(`HeyGen generación ${state}; code=${safeToken(data.failure_code)}`, "upstream_error");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    throw fail("HeyGen sigue procesando; no se creó otro intento.", "timeout");
  },
  async recoverVideo(id) { return result(id, await api(`/v3/videos/${encodeURIComponent(id)}`)); },
  async checkVideoStatus(id) { return status((await api(`/v3/videos/${encodeURIComponent(id)}`)).status); },
  async deleteAvatar() { return { deleted: false, reason: "La limpieza de recursos requiere una operación separada." }; },
  async cancelVideo() { return { cancelled: false, reason: "No se ha confirmado una cancelación que evite el cobro." }; },
  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script" | "audioDurationSeconds">) { return estimateHeygenCost(request.audioDurationSeconds!); },
  processWebhookPayload() { return null; },
};
