import { MissingEnvVarError } from "@/lib/env-errors";
import { GenerativeProviderError, type GenerativeAsset, type ImageGenerationRequest, type ImageProvider } from "../types";

/**
 * Adaptador para la API de generación de imágenes de OpenAI. IMPORTANTE:
 * este entorno de desarrollo tiene bloqueado por política de red el acceso
 * a platform.openai.com (confirmado al intentar leer la documentación
 * oficial vía WebFetch) — el modelo, endpoint, tamaños y precio de abajo
 * están tomados de fuentes SECUNDARIAS (agregadores de precios, sep 2026),
 * NO verificados contra la documentación primaria de OpenAI. Todos son
 * configurables por variable de entorno precisamente por eso: no asumas
 * que siguen vigentes sin confirmarlos tú mismo contra
 * https://platform.openai.com/docs/guides/image-generation antes de
 * activar este proveedor con una clave real.
 *
 * OpenAI no tiene un tamaño 9:16 exacto documentado de forma confiable en
 * las fuentes disponibles — se pide el tamaño vertical más cercano
 * (portrait, configurable) y se deja que Remotion recorte de forma segura
 * al render (ver SceneMedia en remotion/VerticalReel.tsx), igual que ya
 * hace con fotos de stock que no vienen en 9:16 exacto.
 */

const OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";
// UNVERIFICADO contra doc oficial — fuente secundaria (ver comentario de arriba).
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const DEFAULT_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1536";
const DEFAULT_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
// UNVERIFICADO — fuente secundaria reporta ~$0.03-0.08/imagen según resolución/calidad.
const ESTIMATED_COST_USD = Number(process.env.OPENAI_IMAGE_ESTIMATED_COST_USD || "0.05");
const TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || "60000");
const MAX_RETRIES = Number(process.env.OPENAI_IMAGE_MAX_RETRIES || "1");

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("OPENAI_API_KEY");
  return key;
}

async function requestOnce(request: ImageGenerationRequest): Promise<GenerativeAsset> {
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
        size: DEFAULT_SIZE,
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
    throw new GenerativeProviderError(
      `OpenAI Images respondió HTTP ${response.status}`,
      "openai",
      "upstream_error",
    );
  }

  const json = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
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

  const [width, height] = DEFAULT_SIZE.split("x").map(Number);
  return {
    buffer,
    mimeType: "image/png",
    extension: "png",
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
    model: DEFAULT_MODEL,
    costUsd: ESTIMATED_COST_USD,
  };
}

export const openaiImageProvider: ImageProvider = {
  name: "openai",
  capabilities: {
    id: "openai",
    models: [DEFAULT_MODEL],
    formats: ["image/png"],
    aspectRatios: ["portrait (recortado a 9:16 en Remotion)"],
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
        if (err instanceof GenerativeProviderError && err.reason === "moderation_rejected") {
          throw err; // Nunca reintentar un rechazo de moderación.
        }
      }
    }
    throw lastError instanceof GenerativeProviderError
      ? lastError
      : new GenerativeProviderError("Fallo desconocido generando imagen con OpenAI", "openai", "upstream_error", lastError);
  },
};
