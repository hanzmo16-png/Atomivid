/**
 * Podcast Studio — recreaciones con Recraft (fal.ai) para el estudio. Reutiliza el proveedor de Reels/Long Form
 * (src/lib/providers/image/recraft.ts, cola de dos fases) y devuelve el `recreate(prompt, dest)` que el pipeline paga a
 * través del libro (`pay` → `paidOnce`: clave idempotente, reservado → liquidado / liberado / incierto).
 *
 * Contrato de cobro (sin doble cobro):
 * - Rechazo ANTES de que fal.ai acepte el trabajo (sin FAL_KEY, saldo, credencial, 429, solicitud inválida, presupuesto
 *   de la imagen) → ProviderRejectedError: el libro LIBERA la reserva a USD 0 y un reintento puede volver a pedirla.
 * - Cualquier fallo DESPUÉS de aceptado (sin request_id, estado desconocido, tiempo agotado, resultado inválido) → error
 *   normal: el libro queda INCIERTO y un reintento NO vuelve a pedir la imagen (se concilia antes).
 * Apagado por defecto: solo con PODCAST_STUDIO_RECRAFT=1 y FAL_KEY. No sustituye a otro proveedor.
 */
import { writeFile } from "node:fs/promises";
import { RECRAFT_USD_PER_IMAGE, recraftImageProvider } from "@/lib/providers/image/recraft";
import { GenerativeProviderError, type ImageGenerationRequest, type ImageProvider as GenerativeImageProvider } from "@/lib/providers/types";
import { ProviderRejectedError } from "./cost";
import type { ImageProvider } from "./pipeline";
export { studioRecraftEnabled } from "./studio";

/** Motivos que fal.ai devuelve antes de aceptar el trabajo (no hay cargo). */
const PRE_ACCEPT = new Set(["not_configured", "budget_exceeded", "quota_exceeded", "authentication_error", "rate_limited", "invalid_request", "moderation_rejected"]);

export function recraftRecreate(format: "16:9" | "9:16", provider: GenerativeImageProvider = recraftImageProvider): NonNullable<ImageProvider["recreate"]> {
  return async (prompt, dest) => {
    if (!provider.isAvailable() || !provider.submitImage || !provider.resumeImage) throw new ProviderRejectedError("Recraft no está configurado (FAL_KEY); no se generó ni cobró nada.");
    const request: ImageGenerationRequest = { prompt: prompt.slice(0, 900), aspectRatio: format, maxCostUsd: RECRAFT_USD_PER_IMAGE, disableRetries: true };
    let providerJobId: string;
    try {
      ({ providerJobId } = await provider.submitImage(request));
    } catch (e) {
      // Sin request_id válido tras un 200 es «aceptado quizá»: incierto. Los rechazos HTTP previos no cobran.
      if (e instanceof GenerativeProviderError && PRE_ACCEPT.has(e.reason) && !e.providerJobId) throw new ProviderRejectedError(e.message);
      throw e;
    }
    const asset = await provider.resumeImage(providerJobId, request); // tras aceptar: cualquier fallo queda incierto
    if (!asset.buffer?.length) throw new Error(`Recraft devolvió una imagen vacía (request_id ${providerJobId}).`);
    await writeFile(dest, asset.buffer);
    return { actualUsd: RECRAFT_USD_PER_IMAGE };
  };
}
