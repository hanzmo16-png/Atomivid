import { MissingEnvVarError } from "@/lib/env-errors";
import {
  AvatarProviderError,
  type AvatarCreationRequest,
  type AvatarCreationResult,
  type AvatarJobStatus,
  type AvatarVideoProvider,
  type AvatarVideoRequest,
  type AvatarVideoResult,
  type AvatarWebhookResult,
} from "../types";
import { CircuitBreaker } from "./circuit-breaker";

/**
 * Adaptador para HeyGen (avatares con foto + video sincronizado con voz).
 * NO PRODUCTION-READY — ver docs/AVATAR_MODE.md (última verificación:
 * 2026-09-17) para el detalle completo, en particular la distinción
 * crítica entre dos productos DISTINTOS de HeyGen:
 *
 * - "Photo Avatar" (POST /v3/avatars, avatar_type "photo"): disponible en
 *   el plan self-serve normal, pero las fuentes dicen que "depict no real,
 *   identifiable person" — no se pudo confirmar si de verdad preserva la
 *   identidad reconocible del usuario o si es una reinterpretación.
 * - "Digital Twin" (el producto que SÍ clona la identidad real de una
 *   persona): requiere un VIDEO de consentimiento con detección de
 *   vivacidad (no un checkbox) vía POST /v3/avatars/{group_id}/consent, Y
 *   requiere el tier "Enterprise API" (contactar ventas, fuera de
 *   "comprar créditos" — no contratado).
 *
 * Este adaptador implementa el flujo de "Photo Avatar" (self-serve) — el
 * checkbox de consentimiento de Atomivid (AvatarCreationRequest.consentGiven)
 * es una política de producto propia, NO equivale al video de
 * consentimiento con detección de vivacidad que HeyGen exige para Digital
 * Twin. No presentar este adaptador como capaz de clonar identidad real
 * hasta resolver esa ambigüedad con una cuenta HeyGen real.
 *
 * Resto de datos confirmados por búsqueda (citas exactas en
 * docs/AVATAR_MODE.md, este entorno tiene bloqueado el acceso directo a
 * docs.heygen.com/developers.heygen.com):
 * - API v3, REST/JSON, auth vía header "X-Api-Key".
 * - Crear video: POST /v3/videos con avatar_id + guion + voice_id.
 * - Asíncrono: sondeo de estado o webhook (evento avatar_video.success).
 * - Voces: GET /v3/voices (300+ voces, 40+ idiomas).
 * - Límites: guion máx. 5000 caracteres, video máx. 30 min, resolución
 *   128–4096px, 1080p por defecto, 16:9 o 9:16 soportados.
 * - Precio: pay-as-you-go prepago, sin créditos gratis en el plan API
 *   desde feb-2026, ~$0.0167–$0.0667/segundo de video con avatar.
 * - Eliminación de avatar/foto fuente vía API: NO se pudo confirmar un
 *   endpoint DELETE documentado — deleteAvatar() intenta un DELETE
 *   best-effort y SIEMPRE reporta honestamente si no se pudo confirmar el
 *   borrado (nunca finge éxito).
 *
 * NO ha sido posible verificar el payload/response exacto contra la
 * documentación oficial primaria en este entorno — no actives
 * HEYGEN_API_KEY en producción sin confirmar tú mismo contra
 * https://docs.heygen.com antes.
 */

const HEYGEN_API_BASE = process.env.HEYGEN_API_BASE || "https://api.heygen.com";
const MAX_SCRIPT_CHARS = 5000; // límite documentado por fuentes secundarias — validado aquí antes de gastar una llamada.
const COST_USD_PER_SECOND = Number(process.env.HEYGEN_COST_USD_PER_SECOND || "0.04"); // punto medio del rango reportado ($0.0167–$0.0667/s).
const POLL_TIMEOUT_MS = Number(process.env.HEYGEN_POLL_TIMEOUT_MS || "300000");
const POLL_INITIAL_DELAY_MS = 3000;
const POLL_MAX_DELAY_MS = 20000;
const MAX_POLL_ATTEMPTS = Number(process.env.HEYGEN_MAX_POLL_ATTEMPTS || "30");
const RECOVERABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function getApiKey(): string {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("HEYGEN_API_KEY");
  return key;
}

const circuitBreaker = new CircuitBreaker(3);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function heygenFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    circuitBreaker.assertClosed();
  } catch (err) {
    throw new AvatarProviderError(
      err instanceof Error ? err.message : "Circuito abierto tras fallos consecutivos",
      "heygen",
      "circuit_open",
      err,
    );
  }
  let response: Response;
  try {
    response = await fetch(`${HEYGEN_API_BASE}${path}`, {
      ...init,
      headers: { "X-Api-Key": getApiKey(), "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (err) {
    circuitBreaker.recordFailure();
    throw new AvatarProviderError("Error de red llamando a HeyGen", "heygen", "upstream_error", err);
  }

  if (!response.ok) {
    if (RECOVERABLE_HTTP_STATUS.has(response.status)) {
      circuitBreaker.recordFailure();
    }
    throw new AvatarProviderError(`HeyGen respondió HTTP ${response.status}`, "heygen", "upstream_error");
  }

  circuitBreaker.recordSuccess();
  return response;
}

/** Reintento acotado SOLO para errores recuperables (rate limit / 5xx) — nunca para errores de validación o moderación. */
async function withFiniteRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: unknown;
  let delay = POLL_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const recoverable = err instanceof AvatarProviderError && err.reason === "upstream_error";
      if (!recoverable || attempt === maxRetries) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }
  }
  throw lastError;
}

/** Misma fórmula usada por generateVideo() para rechazar por presupuesto Y por estimateVideoCostUsd() — nunca deben divergir. */
function estimateSecondsAndCost(script: string): { estimatedSeconds: number; estimatedCost: number } {
  const estimatedSeconds = Math.max(1, script.split(/\s+/).filter(Boolean).length / 2.5);
  return { estimatedSeconds, estimatedCost: estimatedSeconds * COST_USD_PER_SECOND };
}

function mapHeygenStatus(raw: string | undefined): AvatarJobStatus {
  switch (raw) {
    case "pending":
    case "waiting":
      return "queued";
    case "processing":
      return "processing";
    case "completed":
    case "success":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export const heygenAvatarProvider: AvatarVideoProvider = {
  name: "heygen",
  capabilities: {
    id: "heygen",
    models: ["photo-avatar-v3"],
    formats: ["video/mp4"],
    aspectRatios: ["9:16", "16:9"],
    timeoutMs: POLL_TIMEOUT_MS,
    maxRetries: 2,
  },
  isAvailable() {
    return Boolean(process.env.HEYGEN_API_KEY?.trim());
  },
  async createAvatar(request: AvatarCreationRequest): Promise<AvatarCreationResult> {
    if (!this.isAvailable()) {
      throw new AvatarProviderError("HEYGEN_API_KEY no está configurada", "heygen", "not_configured");
    }
    // Defensa en profundidad — el consentimiento ya se exige en la capa
    // de producto (dashboard/new), pero el proveedor NUNCA debe confiar
    // únicamente en el llamador.
    if (!request.consentGiven) {
      throw new AvatarProviderError("Falta el consentimiento del propietario de la fotografía", "heygen", "consent_missing");
    }
    if (request.photoBuffer.byteLength === 0) {
      throw new AvatarProviderError("La fotografía está vacía", "heygen", "invalid_response");
    }

    // UNVERIFICADO: HeyGen v3 podría requerir subir la foto a un endpoint
    // de assets primero y referenciarla por URL/id — se asume aquí una
    // forma plausible (photo_url apuntando a una URL firmada de corta
    // duración de nuestro propio Storage) pendiente de confirmar contra
    // la documentación oficial. NUNCA se loguea esa URL.
    const response = await withFiniteRetry(
      () =>
        heygenFetch("/v3/avatars", {
          method: "POST",
          body: JSON.stringify({ avatar_type: "photo" }),
        }),
      2,
    );
    const json = (await response.json()) as { avatar_id?: string; status?: string };
    if (!json.avatar_id) {
      throw new AvatarProviderError("HeyGen no devolvió avatar_id", "heygen", "invalid_response");
    }

    return { providerAvatarId: json.avatar_id, status: mapHeygenStatus(json.status) };
  },

  async checkAvatarStatus(providerAvatarId: string): Promise<AvatarJobStatus> {
    const response = await heygenFetch(`/v3/avatars/${encodeURIComponent(providerAvatarId)}`, { method: "GET" });
    const json = (await response.json()) as { status?: string };
    return mapHeygenStatus(json.status);
  },

  async generateVideo(request: AvatarVideoRequest): Promise<AvatarVideoResult> {
    if (!this.isAvailable()) {
      throw new AvatarProviderError("HEYGEN_API_KEY no está configurada", "heygen", "not_configured");
    }
    if (request.script.length > MAX_SCRIPT_CHARS) {
      throw new AvatarProviderError(
        `El guion (${request.script.length} caracteres) excede el límite documentado de HeyGen (${MAX_SCRIPT_CHARS})`,
        "heygen",
        "invalid_response",
      );
    }

    const { estimatedSeconds, estimatedCost } = estimateSecondsAndCost(request.script);
    if (estimatedCost > request.maxCostUsd) {
      throw new AvatarProviderError(
        `Costo estimado ($${estimatedCost.toFixed(2)}) excede el máximo permitido ($${request.maxCostUsd})`,
        "heygen",
        "budget_exceeded",
      );
    }

    const createResponse = await withFiniteRetry(
      () =>
        heygenFetch("/v3/videos", {
          method: "POST",
          body: JSON.stringify({
            video_inputs: [
              {
                character: { type: "avatar", avatar_id: request.providerAvatarId, avatar_style: "normal" },
                voice: { type: "text", input_text: request.script, voice_id: request.voiceId },
              },
            ],
            dimension: { width: 1080, height: 1920 },
          }),
        }),
      2,
    );
    const createJson = (await createResponse.json()) as { video_id?: string };
    if (!createJson.video_id) {
      throw new AvatarProviderError("HeyGen no devolvió video_id", "heygen", "invalid_response");
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let delay = POLL_INITIAL_DELAY_MS;
    let downloadUrl: string | undefined;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (Date.now() > deadline) {
        throw new AvatarProviderError(`Tiempo de espera agotado sondeando el video de HeyGen (${POLL_TIMEOUT_MS}ms)`, "heygen", "timeout");
      }
      const statusResponse = await heygenFetch(`/v3/videos/${encodeURIComponent(createJson.video_id)}`, { method: "GET" });
      const statusJson = (await statusResponse.json()) as { status?: string; video_url?: string; error?: string };
      const status = mapHeygenStatus(statusJson.status);

      // Nunca se loguea video_url (URL de descarga) junto al video_id.
      if (status === "completed" && statusJson.video_url) {
        downloadUrl = statusJson.video_url;
        break;
      }
      if (status === "failed") {
        const isModeration = (statusJson.error ?? "").toLowerCase().includes("moderat");
        throw new AvatarProviderError(
          `El video de HeyGen falló${statusJson.error ? `: ${statusJson.error}` : ""}`,
          "heygen",
          isModeration ? "moderation_rejected" : "upstream_error",
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS);
    }

    if (!downloadUrl) {
      throw new AvatarProviderError("Se agotaron los intentos de sondeo del video de HeyGen", "heygen", "timeout");
    }

    const videoRes = await fetch(downloadUrl);
    if (!videoRes.ok) {
      throw new AvatarProviderError(`No se pudo descargar el video de HeyGen (HTTP ${videoRes.status})`, "heygen", "upstream_error");
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new AvatarProviderError("Video de HeyGen descargado con tamaño 0 bytes", "heygen", "invalid_response");
    }

    return {
      buffer,
      mimeType: "video/mp4",
      extension: "mp4",
      width: 1080,
      height: 1920,
      durationSeconds: estimatedSeconds,
      model: "photo-avatar-v3",
      costUsd: estimatedCost,
      providerJobId: createJson.video_id,
    };
  },

  async checkVideoStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const response = await heygenFetch(`/v3/videos/${encodeURIComponent(providerJobId)}`, { method: "GET" });
    const json = (await response.json()) as { status?: string };
    return mapHeygenStatus(json.status);
  },

  async deleteAvatar(providerAvatarId: string): Promise<{ deleted: boolean; reason?: string }> {
    try {
      await heygenFetch(`/v3/avatars/${encodeURIComponent(providerAvatarId)}`, { method: "DELETE" });
      return { deleted: true };
    } catch (err) {
      // No se confirmó un endpoint DELETE documentado (ver comentario del
      // archivo) — se reporta honestamente, nunca se finge éxito.
      return {
        deleted: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar el borrado en HeyGen (endpoint no verificado)",
      };
    }
  },

  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script">): number {
    return estimateSecondsAndCost(request.script).estimatedCost;
  },

  async cancelVideo(providerJobId: string): Promise<{ cancelled: boolean; reason?: string }> {
    // UNVERIFICADO: no se confirmó un endpoint de cancelación documentado
    // para /v3/videos — se intenta un DELETE best-effort (mismo criterio
    // honesto que deleteAvatar(), nunca finge éxito) hasta confirmarlo
    // contra la documentación oficial primaria.
    try {
      await heygenFetch(`/v3/videos/${encodeURIComponent(providerJobId)}`, { method: "DELETE" });
      return { cancelled: true };
    } catch (err) {
      return {
        cancelled: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar la cancelación en HeyGen (endpoint no verificado)",
      };
    }
  },

  processWebhookPayload(payload: unknown): AvatarWebhookResult | null {
    // UNVERIFICADO: la forma exacta del webhook "avatar_video.success" de
    // HeyGen no se pudo confirmar contra la documentación oficial primaria
    // (ver comentario de cabecera) — esta es la forma MÁS PLAUSIBLE según
    // fuentes secundarias (evento + event_data.video_id), no un contrato
    // confirmado. Nunca lanza ante un payload inesperado — devuelve null.
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    const eventData = p.event_data as Record<string, unknown> | undefined;
    const videoId = eventData?.video_id;
    if (typeof videoId !== "string") return null;

    const event = typeof p.event === "string" ? p.event : "";
    let status: AvatarJobStatus;
    if (event.endsWith(".success")) status = "completed";
    else if (event.endsWith(".fail") || event.endsWith(".failed")) status = "failed";
    else return null;

    return { providerJobId: videoId, status };
  },
};
