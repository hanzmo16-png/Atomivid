import { MissingEnvVarError } from "@/lib/env-errors";
import { GenerativeProviderError, type GenerativeAsset, type ImageGenerationRequest, type ImageProvider } from "../types";

/**
 * Adaptador para la API de generación de imágenes de OpenAI.
 *
 * **Última re-verificación: 2026-09-17** (misma fecha que docs/AVATAR_MODE.md
 * — sesión de validación real de este proveedor). Este entorno sigue
 * teniendo bloqueado por política de red el acceso directo a
 * `platform.openai.com`/`developers.openai.com` (confirmado de nuevo con
 * WebFetch en esta misma sesión) — lo de abajo viene de WebSearch, cuyos
 * resultados citan/resumen páginas oficiales. A diferencia de la verificación
 * anterior (que citaba una sola fuente agregadora), esta vez varias fuentes
 * independientes — incluyendo un ejemplo de curl citado textualmente que
 * apunta a `api.openai.com` — convergen en los mismos valores, lo que da
 * más confianza aunque sigue sin ser lectura directa de la fuente primaria.
 *
 * CONFIRMADO (convergencia de varias fuentes independientes):
 * - Modelo: "gpt-image-2" es el nombre correcto y vigente — "gpt-image-1"
 *   (el que asumíamos antes de introducir esta variable) se anunció
 *   deprecado (retiro 2026-10-23), así que ya no debía usarse igualmente.
 * - Endpoint: sigue siendo `POST https://api.openai.com/v1/images/generations`
 *   (el nuevo dominio `developers.openai.com` es solo el sitio de docs, no
 *   un nuevo host de API).
 * - Auth: header `Authorization: Bearer <OPENAI_API_KEY>` (sin cambios).
 * - Parámetros de request confirmados por un ejemplo de curl citado
 *   textualmente: `model`, `prompt`, `size` (ancho x alto, p. ej.
 *   "1024x1024"), `n`, `quality` ("low"/"medium"/"high"). Los tres tamaños
 *   documentados de forma consistente son 1024x1024, 1024x1536 y
 *   1536x1024 — NO hay un tamaño 9:16 exacto (1080x1920) entre ellos.
 *   Algunas fuentes (mayormente revendedores/proxies de terceros, no
 *   OpenAI directamente) mencionan parámetros adicionales
 *   `aspect_ratio`/`resolution` con resoluciones arbitrarias — no se usan
 *   aquí porque no se pudo confirmar que sean parte de la API real de
 *   OpenAI (vs. una capa de normalización propia de esos terceros), y
 *   arriesgar un parámetro no confirmado en una llamada real de pago no es
 *   aceptable.
 * - Formato de respuesta: los modelos GPT Image siempre devuelven
 *   `b64_json` (nunca una URL temporal) — coherente con lo que ya
 *   implementaba este archivo antes de esta verificación.
 * - Precio: pasó a ser por TOKEN (no un precio plano por imagen):
 *   $5/1M tokens de texto de entrada, $10/1M tokens de imagen de entrada
 *   (imágenes de referencia — no se usan aquí), $40/1M tokens de imagen de
 *   SALIDA. La respuesta incluye un campo `usage` con el desglose — se
 *   usa para calcular el costo real de cada llamada (ver
 *   `computeUsageCostUsd` abajo) en vez de depender solo de la estimación
 *   estática previa a la llamada.
 *
 * NO CONFIRMADO (no se pudo verificar contra la fuente primaria):
 * - El nombre EXACTO de los campos dentro de `usage` (se asume
 *   `input_tokens`/`output_tokens`/`input_tokens_details.text_tokens` por
 *   ser la convención ya usada en otras APIs de OpenAI, pero el código
 *   maneja con seguridad el caso de que no vengan o tengan otro nombre —
 *   nunca lanza por eso, cae a la estimación estática).
 * - El código/forma EXACTA del error de moderación de gpt-image-2
 *   específicamente — se asume, como antes, HTTP 400 con "moderation" en
 *   el cuerpo (comportamiento histórico de la familia de modelos GPT
 *   Image), pero no se confirmó contra la fuente primaria.
 *
 * OpenAI no tiene un tamaño 9:16 exacto (1080x1920) documentado de forma
 * confiable — se pide "1024x1536" (2:3, el portrait más cercano
 * documentado) y Remotion lo escala/recorta de forma segura al render (ver
 * SceneMedia en remotion/VerticalReel.tsx): escalar por 1920/1536 = 1.25
 * (imagen → 1280x1920) y recortar 100px de cada lado para llegar a
 * 1080x1920 — mismo tratamiento que ya recibe cualquier foto de stock que
 * no viene en 9:16 exacto.
 */

const OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";
// Confirmado 2026-09-17 (ver comentario de cabecera) — "gpt-image-1" está deprecado (retiro 2026-10-23).
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
// Confirmado como uno de los 3 tamaños estándar documentados — el portrait más cercano a 9:16 (Shorts/Avatar).
const PORTRAIT_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1536";
// El landscape más cercano a 16:9 entre los 3 tamaños documentados (ver comentario de
// cabecera) — usado únicamente por Long Form (aspectRatio: "16:9", ver
// src/lib/video/long-form/). Nunca se lee para un pedido "9:16" (Shorts/Avatar
// siguen usando PORTRAIT_SIZE exactamente como antes de esta variable existir).
const LANDSCAPE_SIZE = process.env.OPENAI_IMAGE_SIZE_LANDSCAPE || "1536x1024";
const DEFAULT_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
// Estimación ESTÁTICA de respaldo (si la respuesta no trae `usage` legible) — fuente secundaria, no oficial.
const ESTIMATED_COST_USD = Number(process.env.OPENAI_IMAGE_ESTIMATED_COST_USD || "0.05");
const TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || "60000");
const MAX_RETRIES = Number(process.env.OPENAI_IMAGE_MAX_RETRIES || "1");

// Tarifas por token confirmadas (ver comentario de cabecera) — USD por token (no por millón, ya divididas).
const USD_PER_TEXT_INPUT_TOKEN = 5 / 1_000_000;
const USD_PER_IMAGE_INPUT_TOKEN = 10 / 1_000_000;
const USD_PER_IMAGE_OUTPUT_TOKEN = 40 / 1_000_000;

type OpenAiImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
};

/**
 * Costo real a partir de `usage` si la respuesta lo trae con una forma
 * reconocible — devuelve null (nunca lanza) si no, para que el llamador
 * caiga a la estimación estática sin romper la generación ya exitosa.
 */
function computeUsageCostUsd(usage: OpenAiImageUsage | undefined): number | null {
  if (!usage || typeof usage.output_tokens !== "number") return null;
  const textInputTokens = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageInputTokens = usage.input_tokens_details?.image_tokens ?? 0;
  const outputTokens = usage.output_tokens;
  return (
    textInputTokens * USD_PER_TEXT_INPUT_TOKEN +
    imageInputTokens * USD_PER_IMAGE_INPUT_TOKEN +
    outputTokens * USD_PER_IMAGE_OUTPUT_TOKEN
  );
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("OPENAI_API_KEY");
  return key;
}

function sizeFor(aspectRatio: ImageGenerationRequest["aspectRatio"]): string {
  return aspectRatio === "16:9" ? LANDSCAPE_SIZE : PORTRAIT_SIZE;
}

async function requestOnce(request: ImageGenerationRequest): Promise<GenerativeAsset> {
  const size = sizeFor(request.aspectRatio);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(OPENAI_IMAGES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt: request.negativePrompt
          ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}`
          : request.prompt,
        size,
        quality: DEFAULT_QUALITY,
        n: 1,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GenerativeProviderError(
        `Tiempo de espera agotado (${TIMEOUT_MS}ms) llamando a OpenAI Images`,
        "openai",
        "timeout",
        err,
      );
    }
    throw new GenerativeProviderError("Error de red llamando a OpenAI Images", "openai", "upstream_error", err);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 400 && (await response.clone().text()).toLowerCase().includes("moderation")) {
    throw new GenerativeProviderError("Prompt rechazado por moderación de OpenAI", "openai", "moderation_rejected");
  }
  if (!response.ok) {
    // Nunca se registra el body completo (podría reflejar el prompt con datos del usuario o detalles de la cuenta) — solo status.
    // Un status de error (4xx/5xx) en este punto significa que OpenAI NUNCA generó/cobró una imagen — seguro de reintentar.
    throw new GenerativeProviderError(
      `OpenAI Images respondió HTTP ${response.status}`,
      "openai",
      "upstream_error",
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: OpenAiImageUsage;
  };
  const item = json.data?.[0];
  if (!item) {
    throw new GenerativeProviderError("Respuesta de OpenAI Images sin datos de imagen", "openai", "invalid_response");
  }

  let buffer: Buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const imageRes = await fetch(item.url, { signal: controller.signal });
    if (!imageRes.ok) {
      throw new GenerativeProviderError(
        `No se pudo descargar la imagen generada (HTTP ${imageRes.status})`,
        "openai",
        "upstream_error",
      );
    }
    buffer = Buffer.from(await imageRes.arrayBuffer());
  } else {
    throw new GenerativeProviderError("Respuesta de OpenAI Images sin b64_json ni url", "openai", "invalid_response");
  }

  if (buffer.byteLength === 0) {
    throw new GenerativeProviderError("Imagen generada con tamaño 0 bytes", "openai", "invalid_response");
  }

  const [width, height] = size.split("x").map(Number);
  const usageCostUsd = computeUsageCostUsd(json.usage);
  if (usageCostUsd !== null) {
    // Evidencia de costo real por token — nunca se registra el prompt ni la clave, solo cifras.
    console.log(
      "[atomivid:openai-image] costo calculado desde usage",
      JSON.stringify({ usage: json.usage, usageCostUsd, staticEstimateUsd: ESTIMATED_COST_USD }),
    );
  }

  return {
    buffer,
    mimeType: "image/png",
    extension: "png",
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
    model: DEFAULT_MODEL,
    costUsd: usageCostUsd ?? ESTIMATED_COST_USD,
  };
}

export const openaiImageProvider: ImageProvider = {
  name: "openai",
  capabilities: {
    id: "openai",
    models: [DEFAULT_MODEL],
    formats: ["image/png"],
    aspectRatios: ["portrait 2:3 (recortado a 9:16 en Remotion)", "landscape 3:2 (usado tal cual en 16:9 por Long Form)"],
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  },
  isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  },
  async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
    if (!this.isAvailable()) {
      throw new GenerativeProviderError("OPENAI_API_KEY no está configurada", "openai", "not_configured");
    }
    if (ESTIMATED_COST_USD > request.maxCostUsd) {
      throw new GenerativeProviderError(
        `Costo estimado ($${ESTIMATED_COST_USD}) excede el máximo permitido para esta escena ($${request.maxCostUsd})`,
        "openai",
        "budget_exceeded",
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await requestOnce(request);
      } catch (err) {
        lastError = err;
        // Solo se reintenta automáticamente cuando estamos SEGUROS de que
        // OpenAI no llegó a generar (ni cobrar) nada: "upstream_error"
        // cubre tanto un fallo de red antes de recibir respuesta como un
        // status HTTP de error explícito (4xx/5xx) — en ambos casos no
        // hubo generación exitosa. Cualquier otro motivo se detiene aquí,
        // sin reintentar:
        //  - "timeout": abortamos del lado del cliente, pero no sabemos si
        //    OpenAI completó (y cobró) la generación del lado del servidor.
        //  - "invalid_response": la respuesta HTTP fue 200 OK (exitosa) —
        //    eso ya implica, casi siempre, que la generación se cobró —
        //    aunque el cuerpo viniera corrupto/vacío/sin imagen.
        //  - "moderation_rejected": nunca se reintenta (comportamiento previo).
        // Reintentar en cualquiera de esos casos arriesgaría un doble cobro
        // por la misma imagen.
        if (!(err instanceof GenerativeProviderError) || err.reason !== "upstream_error") {
          throw err;
        }
      }
    }
    throw lastError instanceof GenerativeProviderError
      ? lastError
      : new GenerativeProviderError("Fallo desconocido generando imagen con OpenAI", "openai", "upstream_error", lastError);
  },
};
