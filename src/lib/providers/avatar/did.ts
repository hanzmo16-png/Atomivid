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
 * Adaptador para D-ID ("Creative Reality Studio" — talks API: foto única +
 * guion/audio → video hablando). NO PRODUCTION-READY — investigado por
 * WebSearch únicamente (docs.d-id.com está bloqueado en este entorno, ver
 * docs/AVATAR_MODE.md → "Comparación de proveedores"), nunca contra la
 * documentación oficial primaria. No activar AVATAR_PROVIDER="did" con una
 * clave real sin confirmar antes tú mismo contra https://docs.d-id.com.
 *
 * A diferencia de HeyGen (que "entrena" un avatar reutilizable en un paso
 * separado), D-ID no tiene ese concepto: cada "talk" recibe la foto fuente
 * directamente (`source_url`). Por eso createAvatar() aquí NO entrena
 * nada — solo sube la foto al endpoint de imágenes de D-ID (para obtener
 * una `source_url` propia del proveedor, más estable que firmar de nuevo
 * nuestra URL en cada video) y devuelve ese identificador con estado
 * "completed" de inmediato (sin fase de entrenamiento asíncrona conocida).
 *
 * Datos usados aquí, con su nivel de confianza (todo vía fuentes
 * secundarias que resumen/citan la documentación oficial — nunca lectura
 * directa):
 * - REST/JSON. Auth: header "Authorization: Basic <credencial>" — D-ID
 *   entrega la API key ya en formato "usuario:contraseña" o similar según
 *   varias fuentes; aquí se envía tal cual en Basic sin recodificar,
 *   UNVERIFICADO — confirmar el formato exacto antes de usar una clave real.
 * - Crear video: POST /talks con { source_url, script: { type: "text",
 *   input, provider: { type: "elevenlabs", voice_id } }, webhook,
 *   config: { result_format: "mp4" } } — UNVERIFICADO el nombre exacto de
 *   cada campo, pero varias fuentes coinciden en que D-ID soporta
 *   "provider": "elevenlabs" para el texto Y un `audio_url` alternativo
 *   para audio ya generado (esta segunda vía encajaría mejor con que
 *   ATOMIVID ya sintetiza con ElevenLabs antes de llegar aquí — no se usa
 *   todavía porque el contrato AvatarVideoRequest.script de ATOMIVID pasa
 *   texto, no audio ya sintetizado; migrar a audio_url quedaría para
 *   cuando se confirme el contrato real).
 * - Estado asíncrono: GET /talks/{id} — valores reportados por fuentes
 *   secundarias: "created", "started", "done", "error", "rejected".
 * - Webhook: campo "webhook" en la creación — payload no confirmado, se
 *   asume { id, status, result_url } por analogía con la respuesta de
 *   GET /talks/{id}.
 * - Consentimiento: D-ID expone un objeto "Consent" propio (POST
 *   /consents) — NO se implementa aquí todavía (fuera de alcance de este
 *   sprint, que se limita a modo mock) — el consentimiento de producto de
 *   ATOMIVID (AvatarCreationRequest.consentGiven) sigue siendo la única
 *   verificación real por ahora, igual que con HeyGen.
 * - Precio: cifras inconsistentes entre fuentes (~$5.90/mes por 10 min de
 *   plan API, o ~$5.90/min pay-as-you-go según otra fuente) — se usa aquí
 *   el punto medio más conservador de la segunda cifra (~$0.10/s) como
 *   placeholder configurable, NUNCA verificado — no calcular presupuestos
 *   reales sobre este número sin confirmarlo primero.
 */

const DID_API_BASE = process.env.DID_API_BASE || "https://api.d-id.com";
const MAX_SCRIPT_CHARS = 10000; // sin límite documentado confirmado — se usa un techo conservador de defensa en profundidad, mayor que el de HeyGen (D-ID no reportó un límite tan bajo en las fuentes consultadas).
const COST_USD_PER_SECOND = Number(process.env.DID_COST_USD_PER_SECOND || "0.1"); // UNVERIFICADO, ver comentario de cabecera.
const POLL_TIMEOUT_MS = Number(process.env.DID_POLL_TIMEOUT_MS || "300000");
const POLL_INITIAL_DELAY_MS = 3000;
const POLL_MAX_DELAY_MS = 20000;
const MAX_POLL_ATTEMPTS = Number(process.env.DID_MAX_POLL_ATTEMPTS || "30");
const RECOVERABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function getApiKey(): string {
  const key = process.env.DID_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("DID_API_KEY");
  return key;
}

const circuitBreaker = new CircuitBreaker(3);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function didFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    circuitBreaker.assertClosed();
  } catch (err) {
    throw new AvatarProviderError(err instanceof Error ? err.message : "Circuito abierto tras fallos consecutivos", "did", "circuit_open", err);
  }
  let response: Response;
  try {
    response = await fetch(`${DID_API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Basic ${getApiKey()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (err) {
    circuitBreaker.recordFailure();
    throw new AvatarProviderError("Error de red llamando a D-ID", "did", "upstream_error", err);
  }

  if (!response.ok) {
    if (RECOVERABLE_HTTP_STATUS.has(response.status)) {
      circuitBreaker.recordFailure();
    }
    throw new AvatarProviderError(`D-ID respondió HTTP ${response.status}`, "did", "upstream_error");
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

function mapDidStatus(raw: string | undefined): AvatarJobStatus {
  switch (raw) {
    case "created":
      return "queued";
    case "started":
      return "processing";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export const didAvatarProvider: AvatarVideoProvider = {
  name: "did",
  capabilities: {
    id: "did",
    models: ["talks-v1"],
    formats: ["video/mp4"],
    aspectRatios: ["9:16", "16:9"],
    timeoutMs: POLL_TIMEOUT_MS,
    maxRetries: 2,
  },
  isAvailable() {
    return Boolean(process.env.DID_API_KEY?.trim());
  },
  async createAvatar(request: AvatarCreationRequest): Promise<AvatarCreationResult> {
    if (!this.isAvailable()) {
      throw new AvatarProviderError("DID_API_KEY no está configurada", "did", "not_configured");
    }
    // Defensa en profundidad — el consentimiento ya se exige en la capa
    // de producto (dashboard/new), pero el proveedor NUNCA debe confiar
    // únicamente en el llamador.
    if (!request.consentGiven) {
      throw new AvatarProviderError("Falta el consentimiento del propietario de la fotografía", "did", "consent_missing");
    }
    if (request.photoBuffer.byteLength === 0) {
      throw new AvatarProviderError("La fotografía está vacía", "did", "invalid_response");
    }

    // UNVERIFICADO: se asume un endpoint de subida de imágenes
    // (POST /images) que devuelve una url propia de D-ID reutilizable como
    // source_url en /talks — mismo criterio de "mejor aproximación
    // razonable, no contrato confirmado" que heygen.ts.
    const response = await withFiniteRetry(
      () =>
        didFetch("/images", {
          method: "POST",
          body: JSON.stringify({ source_url: undefined }),
          headers: { "Content-Type": request.mimeType },
        }),
      2,
    );
    const json = (await response.json()) as { id?: string; url?: string };
    if (!json.id && !json.url) {
      throw new AvatarProviderError("D-ID no devolvió un identificador de imagen", "did", "invalid_response");
    }

    // D-ID no tiene una fase de "entrenamiento" asíncrona conocida para
    // este flujo (a diferencia de HeyGen) — el avatar queda listo apenas
    // se sube la foto.
    return { providerAvatarId: json.id ?? json.url!, status: "completed" };
  },

  async checkAvatarStatus(): Promise<AvatarJobStatus> {
    // No hay fase de entrenamiento que sondear (ver comentario de
    // createAvatar) — cualquier avatar creado con éxito ya está listo.
    return "completed";
  },

  async generateVideo(request: AvatarVideoRequest): Promise<AvatarVideoResult> {
    if (!this.isAvailable()) {
      throw new AvatarProviderError("DID_API_KEY no está configurada", "did", "not_configured");
    }
    if (request.script.length > MAX_SCRIPT_CHARS) {
      throw new AvatarProviderError(
        `El guion (${request.script.length} caracteres) excede el límite de seguridad de este adaptador (${MAX_SCRIPT_CHARS})`,
        "did",
        "invalid_response",
      );
    }

    const { estimatedSeconds, estimatedCost } = estimateSecondsAndCost(request.script);
    if (estimatedCost > request.maxCostUsd) {
      throw new AvatarProviderError(
        `Costo estimado ($${estimatedCost.toFixed(2)}) excede el máximo permitido ($${request.maxCostUsd})`,
        "did",
        "budget_exceeded",
      );
    }

    const createResponse = await withFiniteRetry(
      () =>
        didFetch("/talks", {
          method: "POST",
          body: JSON.stringify({
            source_url: request.providerAvatarId,
            script: {
              type: "text",
              input: request.script,
              provider: request.voiceId ? { type: "elevenlabs", voice_id: request.voiceId } : undefined,
            },
            config: { result_format: "mp4" },
          }),
        }),
      2,
    );
    const createJson = (await createResponse.json()) as { id?: string };
    if (!createJson.id) {
      throw new AvatarProviderError("D-ID no devolvió id de talk", "did", "invalid_response");
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let delay = POLL_INITIAL_DELAY_MS;
    let downloadUrl: string | undefined;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (Date.now() > deadline) {
        throw new AvatarProviderError(`Tiempo de espera agotado sondeando el talk de D-ID (${POLL_TIMEOUT_MS}ms)`, "did", "timeout");
      }
      const statusResponse = await didFetch(`/talks/${encodeURIComponent(createJson.id)}`, { method: "GET" });
      const statusJson = (await statusResponse.json()) as { status?: string; result_url?: string; error?: { description?: string } };
      const status = mapDidStatus(statusJson.status);

      // Nunca se loguea result_url (URL de descarga) junto al id del talk.
      if (status === "completed" && statusJson.result_url) {
        downloadUrl = statusJson.result_url;
        break;
      }
      if (status === "failed") {
        const description = statusJson.error?.description ?? "";
        const isModeration = description.toLowerCase().includes("moderat") || description.toLowerCase().includes("reject");
        throw new AvatarProviderError(`El talk de D-ID falló${description ? `: ${description}` : ""}`, "did", isModeration ? "moderation_rejected" : "upstream_error");
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS);
    }

    if (!downloadUrl) {
      throw new AvatarProviderError("Se agotaron los intentos de sondeo del talk de D-ID", "did", "timeout");
    }

    const videoRes = await fetch(downloadUrl);
    if (!videoRes.ok) {
      throw new AvatarProviderError(`No se pudo descargar el video de D-ID (HTTP ${videoRes.status})`, "did", "upstream_error");
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new AvatarProviderError("Video de D-ID descargado con tamaño 0 bytes", "did", "invalid_response");
    }

    return {
      buffer,
      mimeType: "video/mp4",
      extension: "mp4",
      width: 1080,
      height: 1920,
      durationSeconds: estimatedSeconds,
      model: "talks-v1",
      costUsd: estimatedCost,
      providerJobId: createJson.id,
    };
  },

  async checkVideoStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const response = await didFetch(`/talks/${encodeURIComponent(providerJobId)}`, { method: "GET" });
    const json = (await response.json()) as { status?: string };
    return mapDidStatus(json.status);
  },

  async deleteAvatar(providerAvatarId: string): Promise<{ deleted: boolean; reason?: string }> {
    try {
      await didFetch(`/images/${encodeURIComponent(providerAvatarId)}`, { method: "DELETE" });
      return { deleted: true };
    } catch (err) {
      // No se confirmó un endpoint DELETE documentado para /images — se
      // reporta honestamente, nunca se finge éxito (mismo criterio que
      // heygen.ts).
      return {
        deleted: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar el borrado en D-ID (endpoint no verificado)",
      };
    }
  },

  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script">): number {
    return estimateSecondsAndCost(request.script).estimatedCost;
  },

  async cancelVideo(providerJobId: string): Promise<{ cancelled: boolean; reason?: string }> {
    // UNVERIFICADO: no se confirmó un endpoint de cancelación documentado
    // para /talks — se intenta un DELETE best-effort (mismo criterio
    // honesto que deleteAvatar(), nunca finge éxito) hasta confirmarlo
    // contra la documentación oficial primaria.
    try {
      await didFetch(`/talks/${encodeURIComponent(providerJobId)}`, { method: "DELETE" });
      return { cancelled: true };
    } catch (err) {
      return {
        cancelled: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar la cancelación en D-ID (endpoint no verificado)",
      };
    }
  },

  processWebhookPayload(payload: unknown): AvatarWebhookResult | null {
    // UNVERIFICADO: la forma exacta del payload de webhook de D-ID no se
    // pudo confirmar contra la documentación oficial primaria (ver
    // comentario de cabecera) — se asume la misma forma que la respuesta
    // de GET /talks/{id} (id + status), la aproximación más plausible
    // según las fuentes consultadas. Nunca lanza ante un payload
    // inesperado — devuelve null.
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    const id = p.id;
    if (typeof id !== "string") return null;

    const status = mapDidStatus(typeof p.status === "string" ? p.status : undefined);
    // mapDidStatus cae a "failed" por defecto ante cualquier valor no
    // reconocido — aquí eso sería ambiguo (¿de verdad falló, o el status
    // vino vacío/desconocido?), así que solo se acepta un status presente
    // y explícitamente mapeable, igual de estricto que heygen.ts con sus
    // sufijos ".success"/".fail".
    const KNOWN_RAW_STATUSES = new Set(["created", "started", "done", "error", "rejected", "cancelled"]);
    if (typeof p.status !== "string" || !KNOWN_RAW_STATUSES.has(p.status)) return null;

    return { providerJobId: id, status };
  },
};
