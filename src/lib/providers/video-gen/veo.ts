import type { GenerativeAsset, VideoGenerationRequest, VideoProvider } from "../types";
import { GenerativeProviderError } from "../types";

/**
 * Adaptador para Google Veo 3.1 Fast (CONTROL del benchmark P2A —
 * image-to-video, 1080p).
 *
 * ESTADO: NO VERIFICADO contra documentación primaria. Este entorno tiene
 * bloqueado por política de red el acceso a ai.google.dev,
 * docs.cloud.google.com y en.wikipedia.org (los tres devolvieron
 * EGRESS_BLOCKED al intentar leerlos) — el mismo tipo de restricción ya
 * documentada para runwayml.com (P1) y kling.ai/klingai.com (P2A), aquí
 * confirmada como una restricción de red general de este entorno, no
 * específica de ningún proveedor. Fuentes secundarias (agregadores de
 * terceros, sep 2026) sugieren:
 *   - Duración: 8s (consistente en varias fuentes) — razonablemente
 *     probable pero NO confirmado contra doc primaria.
 *   - Resolución: 1080p disponible vía un parámetro "resolution" — mismo
 *     nivel de confianza, NO confirmado.
 *   - Precio: ~$0.15/s CON audio (8s ≈ $1.20/clip) — fuentes secundarias
 *     coinciden en esta cifra, pero sigue siendo secundaria, NO
 *     verificada contra ai.google.dev/cloud.google.com directamente.
 *   - Audio: las fuentes secundarias se CONTRADICEN sobre si el audio es
 *     desactivable (una dice "optional... bumps the per-second rate", otra
 *     lo describe como generación nativa sin mencionar un switch) — no se
 *     puede confirmar que exista un parámetro para apagarlo. Por
 *     instrucción explícita del usuario (P2A sección 7): "si genera audio
 *     obligatoriamente, no inventes un switch para apagarlo" — este
 *     adaptador NO expone ningún parámetro de audio; si el modelo genera
 *     audio nativo, ATOMIVID lo descarta/reemplaza en montaje, no aquí.
 *   - Auth/endpoint/modelo exacto: UNKNOWN — la Gemini API usa API keys
 *     simples y Vertex AI usa cuentas de servicio de GCP; cuál de las dos
 *     rutas corresponde a "Veo 3.1 Fast" no se pudo confirmar, ni el id de
 *     modelo API exacto (p. ej. si es "veo-3.1-fast" o algo con sufijo de
 *     versión, por convención de Veo 2 documentada en fuentes secundarias
 *     pero no confirmada para 3.1).
 *
 * Mismo criterio conservador que kling.ts: generateVideo() SIEMPRE lanza,
 * nunca intenta una llamada HTTP con un contrato adivinado, sin importar
 * las credenciales configuradas.
 */

// UNVERIFICADO — nombre de variable elegido por convención (estilo Gemini
// API key), nunca confirmado contra doc oficial cuál es la ruta de auth
// correcta (Gemini API vs Vertex AI/GCP service account).
function hasCredentials(): boolean {
  return Boolean(process.env.VEO_API_KEY?.trim());
}

export const VEO_MODEL_PLACEHOLDER = "UNKNOWN — no se confirmó el id de modelo API exacto para 'Veo 3.1 Fast'";

export const veoVideoProvider: VideoProvider = {
  name: "veo",
  capabilities: {
    id: "veo",
    models: [VEO_MODEL_PLACEHOLDER],
    formats: ["video/mp4"], // Razonablemente seguro pero no confirmado contra doc primaria.
    aspectRatios: ["16:9"], // Necesario para el benchmark P2A — no confirmado contra doc primaria.
    timeoutMs: 180000,
    maxRetries: 0,
  },
  isAvailable() {
    return hasCredentials();
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- firma exigida por VideoProvider; nunca se lee (ver comentario de cabecera: generateVideo() siempre lanza antes de tocar el request).
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    throw new GenerativeProviderError(
      "Veo: el endpoint/payload/autenticación de la API no está verificado contra documentación primaria en este " +
        "entorno (ai.google.dev/docs.cloud.google.com bloqueados por política de red) — nunca se intenta una " +
        "llamada HTTP con un contrato adivinado. Verificar contra la documentación oficial de Google antes de " +
        "implementar la llamada real.",
      "veo",
      "contract_unverified",
    );
  },
};
