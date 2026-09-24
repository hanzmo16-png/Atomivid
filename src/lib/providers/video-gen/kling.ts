import type { GenerativeAsset, VideoGenerationRequest, VideoProvider } from "../types";
import { GenerativeProviderError } from "../types";

/**
 * Adaptador para Kling AI (Kling 3.0, PRIMARY del benchmark P2A —
 * image-to-video, 1080p, preferentemente sin audio).
 *
 * ESTADO: NO VERIFICADO contra documentación primaria. Este entorno tiene
 * bloqueado por política de red el acceso a kling.ai, www.klingai.com y
 * klingapi.com (confirmado con WebFetch — EGRESS_BLOCKED en los tres, el
 * mismo bloqueo ya documentado para runwayml.com en P1/P2A, y confirmado
 * aquí como una restricción de red general de este entorno, no específica
 * de un proveedor — hasta en.wikipedia.org devolvió EGRESS_BLOCKED al
 * probarlo). Fuentes secundarias (agregadores de terceros, sep 2026)
 * sugieren:
 *   - Auth: JWT firmado (Access Key ID + Access Key Secret), no un bearer
 *     token simple como Runway — UNVERIFICADO.
 *   - Precio: entre $0.18 y $1.70 por clip de 5s según el modelo/tier —
 *     rango demasiado amplio para fijar un número, UNVERIFICADO.
 *   - Un identificador de modelo API exacto para "Kling 3.0" NO aparece
 *     de forma confiable en ninguna fuente secundaria consultada — los
 *     nombres de modelo documentados son "v1"/"v2"/"v2.1 Master"; "Kling
 *     3.0" puede ser demasiado reciente para reflejarse ahí. UNKNOWN.
 *
 * A diferencia de runway.ts (que SÍ intenta una llamada HTTP con un
 * endpoint/payload adivinado de fuentes secundarias, aceptado en una fase
 * anterior de este proyecto), este adaptador es DELIBERADAMENTE más
 * conservador: generateVideo() SIEMPRE lanza (nunca intenta una petición
 * HTTP con un contrato no verificado), sin importar si hay credenciales
 * configuradas — "si la documentación oficial disponible lo permite" (P2A
 * sección 1) no se cumple aquí todavía. Esto es intencional, no un bug:
 * revisar antes de "arreglarlo" añadiendo lógica de request real sin haber
 * confirmado el contrato contra docs.klingai.com o equivalente primario.
 */

// UNVERIFICADO — nombres de variable elegidos por convención (JWT de dos
// partes, típico de APIs chinas de esta familia), nunca confirmados contra
// doc oficial. Ningún valor real debe configurarse hasta verificar.
function hasCredentials(): boolean {
  return Boolean(process.env.KLING_ACCESS_KEY_ID?.trim() && process.env.KLING_ACCESS_KEY_SECRET?.trim());
}

/** UNVERIFICADO — placeholder, nunca usado por generateVideo() (que siempre lanza antes de llegar aquí). Documentado solo para que quede claro qué haría falta verificar. */
export const KLING_MODEL_PLACEHOLDER = "UNKNOWN — no se confirmó el id de modelo API exacto para 'Kling 3.0'";

export const klingVideoProvider: VideoProvider = {
  name: "kling",
  capabilities: {
    id: "kling",
    models: [KLING_MODEL_PLACEHOLDER],
    formats: ["video/mp4"], // Razonablemente seguro (formato estándar de la industria) pero no confirmado contra doc primaria.
    aspectRatios: ["16:9"], // Necesario para el benchmark P2A — no confirmado contra doc primaria.
    timeoutMs: 180000,
    maxRetries: 0,
  },
  isAvailable() {
    // Con o sin credenciales, generateVideo() nunca intenta una llamada
    // real (ver comentario de cabecera) — esto solo determina si
    // getVideoProvider() SIQUIERA lo considera un candidato, nunca si el
    // adaptador "funciona".
    return hasCredentials();
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- firma exigida por VideoProvider; nunca se lee (ver comentario de cabecera: generateVideo() siempre lanza antes de tocar el request).
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    throw new GenerativeProviderError(
      "Kling: el endpoint/payload/autenticación de la API no está verificado contra documentación primaria en este " +
        "entorno (kling.ai/www.klingai.com/klingapi.com bloqueados por política de red) — nunca se intenta una " +
        "llamada HTTP con un contrato adivinado. Verificar contra la documentación oficial de Kling antes de " +
        "implementar la llamada real.",
      "kling",
      "contract_unverified",
    );
  },
};
