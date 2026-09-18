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
 * guion/audio → video hablando). NO PRODUCTION-READY todavía, pero
 * corregido el 2026-09-17 contra hallazgos de documentación oficial reales
 * (WebSearch, citando directamente páginas de docs.d-id.com — el acceso
 * DIRECTO a docs.d-id.com/www.d-id.com sigue bloqueado por la política de
 * red de este entorno, confirmado de nuevo en este mismo intento: cualquier
 * subdominio de d-id.com da EGRESS_BLOCKED, no solo /docs). Los puntos
 * marcados "CONFIRMADO" abajo vienen de resultados de búsqueda que citan/
 * resumen directamente el contenido de la página oficial correspondiente —
 * no es lectura primaria directa, pero es una fuente bastante más fuerte
 * que la aproximación "mejor suposición razonable" usada en la versión
 * anterior de este archivo. Los puntos marcados "NO CONFIRMADO" siguen
 * siendo la mejor aproximación disponible, nada más.
 *
 * A diferencia de HeyGen (que "entrena" un avatar reutilizable en un paso
 * separado), D-ID no tiene ese concepto: cada "talk" recibe la foto fuente
 * directamente (`source_url`). Por eso createAvatar() aquí NO entrena
 * nada — solo sube la foto al endpoint de imágenes de D-ID y devuelve ese
 * identificador con estado "completed" de inmediato (sin fase de
 * entrenamiento asíncrona conocida).
 *
 * Hallazgos y correcciones de esta revisión (2026-09-17):
 * - **CONFIRMADO — autenticación, sin doble codificación**: docs.d-id.com/reference/basic-authentication
 *   dice explícitamente que la API key se entrega en Account Settings en
 *   formato TEXTO PLANO "API_USERNAME:API_PASSWORD" (NO ya en base64) y
 *   que el header debe ser
 *   `Authorization: Basic <base64(API_USERNAME:API_PASSWORD)>` — la
 *   aplicación DEBE codificar en base64 esa cadena UNA sola vez, ella
 *   misma; DID_API_KEY debe guardarse en texto plano tal cual la entrega
 *   D-ID, nunca pre-codificada, o `basicAuthHeader()` de abajo la
 *   codificaría dos veces y la autenticación fallaría. **Bug real
 *   corregido en la revisión anterior**: el archivo enviaba `Basic
 *   ${apiKey}` sin codificar en absoluto — nunca habría autenticado.
 * - **CONFIRMADO — subida de imagen**: docs.d-id.com/reference/upload-an-image
 *   documenta `POST /images` como `multipart/form-data` (NO un JSON con
 *   `source_url`), con el archivo en un campo de formulario, nombre de
 *   archivo opcional (máx. 50 caracteres, `a-zA-Z0-9._-`), y SOLO
 *   `image/jpeg`/`image/png` soportados (guardado 24-48h). La respuesta
 *   incluye `id` y `url`. **Bug real corregido aquí**: la versión anterior
 *   mandaba un body JSON `{ source_url: undefined }` con
 *   `Content-Type: <mimeType original>` — nunca habría funcionado contra
 *   un endpoint que espera multipart. Ahora también se rechazan mimeTypes
 *   distintos de jpeg/png ANTES de gastar la llamada.
 * - **CONFIRMADO — estados de talk**: docs.d-id.com/reference/gettalk usa
 *   "created" (encolado) → "started" (procesando) → "done" (completo) |
 *   "error"/"rejected" (fallido). `result_url` solo aparece cuando
 *   status="done".
 * - **CONFIRMADO, IMPORTANTE — el endpoint `DELETE /talks/{id}` NO es una
 *   cancelación ni un mecanismo de ahorro de costo**: docs.d-id.com/reference/deletetalk
 *   lo describe como "Delete Video by ID" — es decir, BORRA un video (lo
 *   quita de la lista de resultados), no lo cancela a mitad de proceso.
 *   No hay ninguna fuente que documente que borrar un talk en curso
 *   detenga su render o evite el cobro. `cancelVideo()` de abajo NUNCA
 *   debe presentarse ni interpretarse como "cancela y no cobra" — solo
 *   intenta el borrado best-effort y reporta honestamente si se confirmó
 *   o no, sin ninguna suposición sobre el efecto en la facturación.
 * - **CONFIRMADO — dos formas de guion, y ATOMIVID usa la primera**:
 *   `script.type` puede ser:
 *     (a) **"audio"** con `audio_url` — un archivo de audio YA GENERADO
 *         que ATOMIVID aloja (fuentes: "the script accepts plain text or
 *         an audio file you host"). **Este es el flujo real de
 *         ATOMIVID**: el guion ya se sintetiza con NUESTRO ElevenLabs
 *         (mismo proveedor de voz que el modo visual, para que la voz sea
 *         consistente en todos los videos) — D-ID NUNCA sintetiza nada,
 *         solo anima los labios contra el audio que le damos. NO necesita
 *         `voice_id` en absoluto.
 *     (b) **"text"** con `input` + `provider: { type: "elevenlabs",
 *         voice_id, voice_config?: { stability, similarity_boost } }`
 *         (fuentes secundarias que citan docs.d-id.com/reference/tts-elevenlabs)
 *         — D-ID sintetiza la voz POR SU CUENTA vía SU PROPIA integración
 *         con ElevenLabs (facturada aparte por D-ID, no por nosotros).
 *         Requiere `voice_id`, documentado como función de pago.
 *   `generateVideo()` usa (a) cuando `request.audioUrl` está presente
 *   (el caso normal en ATOMIVID) y cae a (b) con `request.voiceId`
 *   solo si NO hay `audioUrl` — nunca exige `voiceId` cuando ya hay un
 *   audio propio, y lanza `invalid_response` solo si NINGUNO de los dos
 *   está presente (ninguna fuente indica que D-ID sintetice sin ninguna
 *   entrada de voz).
 * - **NO CONFIRMADO** (sigue igual que antes, no se encontró evidencia
 *   documental directa): el payload EXACTO del webhook (se sigue asumiendo
 *   `{ id, status }`, análogo a la respuesta de `GET /talks/{id}`); un
 *   límite de caracteres del guion documentado (se mantiene un techo
 *   propio de 10000, defensa en profundidad, no un límite real de D-ID);
 *   la forma exacta del objeto de error en una respuesta fallida.
 * - **Precio**: varias fuentes de agregadores (no D-ID directamente)
 *   coinciden en ~$5.90/min para el plan API de pago por uso ≈ $0.0983/s —
 *   se usa como valor por defecto configurable, marcado explícitamente
 *   como NO verificado contra D-ID directamente (agregadores de terceros).
 * - **Consentimiento**: D-ID expone un objeto "Consent" propio (POST
 *   /consents) — sigue sin implementarse aquí (fuera de alcance, modo
 *   mock) — el consentimiento de producto de ATOMIVID
 *   (AvatarCreationRequest.consentGiven) sigue siendo la única
 *   verificación real, igual que con HeyGen.
 *
 * No activar AVATAR_PROVIDER="did" con una clave real en producción sin
 * una prueba real controlada y de bajo costo primero (ver
 * docs/AVATAR_MODE.md → sección de la próxima prueba pagada).
 */

const DID_API_BASE = process.env.DID_API_BASE || "https://api.d-id.com";
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]); // CONFIRMADO — docs.d-id.com/reference/upload-an-image.
const MAX_SCRIPT_CHARS = 10000; // NO es un límite documentado de D-ID — techo propio de defensa en profundidad.
const COST_USD_PER_SECOND = Number(process.env.DID_COST_USD_PER_SECOND || "0.0983"); // ~$5.90/min, fuentes de terceros (no D-ID directamente) — ver comentario de cabecera.
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

/** CONFIRMADO (docs.d-id.com/reference/basic-authentication): la API key es "usuario:contraseña" y hay que codificarla en base64 — nunca enviarla tal cual. */
function basicAuthHeader(): string {
  return `Basic ${Buffer.from(getApiKey(), "utf8").toString("base64")}`;
}

const circuitBreaker = new CircuitBreaker(3);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function didFetch(path: string, init: RequestInit & { jsonBody?: boolean } = {}): Promise<Response> {
  try {
    circuitBreaker.assertClosed();
  } catch (err) {
    throw new AvatarProviderError(err instanceof Error ? err.message : "Circuito abierto tras fallos consecutivos", "did", "circuit_open", err);
  }
  const { jsonBody = true, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${DID_API_BASE}${path}`, {
      ...rest,
      headers: {
        Authorization: basicAuthHeader(),
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers ?? {}),
      },
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
      // Incluye "error" y "rejected" (ambos confirmados como estados de
      // fallo) y cualquier valor no reconocido.
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
    // CONFIRMADO (docs.d-id.com/reference/upload-an-image): D-ID solo
    // acepta image/jpeg e image/png en este endpoint.
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(request.mimeType)) {
      throw new AvatarProviderError(`D-ID no soporta el tipo de imagen "${request.mimeType}" (solo image/jpeg e image/png)`, "did", "invalid_response");
    }

    // CONFIRMADO: POST /images es multipart/form-data con el archivo en un
    // campo de formulario — nunca JSON. La API global FormData/Blob de
    // Node soporta esto sin librerías adicionales.
    const response = await withFiniteRetry(() => {
      const form = new FormData();
      const extension = request.mimeType === "image/png" ? "png" : "jpg";
      form.append("image", new Blob([new Uint8Array(request.photoBuffer)], { type: request.mimeType }), `photo.${extension}`);
      return didFetch("/images", { method: "POST", body: form, jsonBody: false });
    }, 2);
    const json = (await response.json()) as { id?: string; url?: string };
    if (!json.id && !json.url) {
      throw new AvatarProviderError("D-ID no devolvió un identificador de imagen", "did", "invalid_response");
    }

    // D-ID no tiene una fase de "entrenamiento" asíncrona conocida para
    // este flujo (a diferencia de HeyGen) — el avatar queda listo apenas
    // se sube la foto.
    return { providerAvatarId: json.url ?? json.id!, status: "completed" };
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
    // Se necesita UNA de las dos entradas de voz — audioUrl (nuestro
    // propio audio ya sintetizado, el flujo real de ATOMIVID) o voiceId
    // (D-ID sintetiza por su cuenta) — ver comentario de cabecera. Nunca
    // se exige voiceId cuando ya hay audioUrl.
    if (!request.audioUrl && !request.voiceId) {
      throw new AvatarProviderError(
        "D-ID requiere audioUrl (audio ya sintetizado por ATOMIVID) o voiceId (D-ID sintetiza la voz él mismo vía ElevenLabs) — ninguno fue provisto",
        "did",
        "invalid_response",
      );
    }

    const estimatedSeconds = request.audioDurationSeconds ?? estimateSecondsAndCost(request.script).estimatedSeconds;
    const estimatedCost = estimatedSeconds * COST_USD_PER_SECOND;
    if (!Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0 || !Number.isFinite(estimatedCost) || estimatedCost < 0 || !Number.isFinite(request.maxCostUsd) || request.maxCostUsd < 0) {
      throw new AvatarProviderError("Duración o presupuesto inválido", "did", "budget_exceeded");
    }
    if (estimatedCost > request.maxCostUsd) {
      throw new AvatarProviderError(
        `Costo estimado ($${estimatedCost.toFixed(2)}) excede el máximo permitido ($${request.maxCostUsd})`,
        "did",
        "budget_exceeded",
      );
    }

    // A creation POST may have been accepted even when its response fails.
    // Never retry a billable creation automatically.
    const createResponse = await withFiniteRetry(
      () =>
        didFetch("/talks", {
          method: "POST",
          body: JSON.stringify({
            source_url: request.providerAvatarId,
            // audioUrl (nuestro audio ya sintetizado) tiene prioridad —
            // es el flujo real de ATOMIVID y evita que D-ID sintetice
            // (y facture) su propia llamada a ElevenLabs.
            script: request.audioUrl
              ? { type: "audio", audio_url: request.audioUrl }
              : { type: "text", input: request.script, provider: { type: "elevenlabs", voice_id: request.voiceId } },
            config: { result_format: "mp4" },
          }),
        }),
      0,
    );
    const createJson = (await createResponse.json()) as { id?: string };
    if (!createJson.id) {
      throw new AvatarProviderError("D-ID no devolvió id de talk", "did", "invalid_response");
    }

    await request.onJobCreated?.(createJson.id);

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
    // NO CONFIRMADO: no se encontró documentación de un endpoint DELETE
    // específico para /images (el confirmado es para /talks — ver
    // cancelVideo()). Se intenta best-effort y se reporta honestamente si
    // falla, nunca se finge éxito.
    try {
      await didFetch(`/images/${encodeURIComponent(providerAvatarId)}`, { method: "DELETE" });
      return { deleted: true };
    } catch (err) {
      return {
        deleted: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar el borrado en D-ID (endpoint no verificado para /images)",
      };
    }
  },

  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script">): number {
    return estimateSecondsAndCost(request.script).estimatedCost;
  },

  async cancelVideo(providerJobId: string): Promise<{ cancelled: boolean; reason?: string }> {
    // IMPORTANTE, ver comentario de cabecera: docs.d-id.com/reference/deletetalk
    // documenta `DELETE /talks/{id}` como "Delete Video by ID" — un
    // BORRADO, no una cancelación confirmada de un render en curso, y
    // NINGUNA fuente indica que evite el cobro. Este método NUNCA debe
    // interpretarse como "canceló y no se cobró" — solo intenta el
    // borrado y reporta honestamente si el proveedor lo confirmó (HTTP
    // 2xx) o no. El llamador no debe asumir ahorro de costo por esto.
    try {
      await didFetch(`/talks/${encodeURIComponent(providerJobId)}`, { method: "DELETE" });
      return { cancelled: true, reason: "D-ID confirmó el borrado del recurso — no hay evidencia documental de que esto detenga un render en curso ni evite el cobro." };
    } catch (err) {
      return {
        cancelled: false,
        reason: err instanceof Error ? err.message : "No se pudo confirmar el borrado en D-ID",
      };
    }
  },

  processWebhookPayload(payload: unknown): AvatarWebhookResult | null {
    // NO CONFIRMADO: la forma exacta del payload de webhook de D-ID no se
    // pudo confirmar contra la documentación oficial primaria — se asume
    // la misma forma que la respuesta de GET /talks/{id} (id + status), la
    // aproximación más plausible según las fuentes consultadas. Nunca
    // lanza ante un payload inesperado — devuelve null.
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    const id = p.id;
    if (typeof id !== "string") return null;

    // mapDidStatus cae a "failed" por defecto ante cualquier valor no
    // reconocido — aquí eso sería ambiguo (¿de verdad falló, o el status
    // vino vacío/desconocido?), así que solo se acepta un status presente
    // y explícitamente mapeable (los 5 estados confirmados de GET /talks/{id}
    // más "cancelled", que aplica al mismo recurso).
    const KNOWN_RAW_STATUSES = new Set(["created", "started", "done", "error", "rejected", "cancelled"]);
    if (typeof p.status !== "string" || !KNOWN_RAW_STATUSES.has(p.status)) return null;

    return { providerJobId: id, status: mapDidStatus(p.status) };
  },
};
