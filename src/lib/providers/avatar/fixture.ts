import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AvatarCreationRequest,
  AvatarCreationResult,
  AvatarJobStatus,
  AvatarVideoProvider,
  AvatarVideoRequest,
  AvatarVideoResult,
  AvatarWebhookResult,
} from "../types";
import { AvatarProviderError } from "../types";

/**
 * MP4 vertical (9:16) real y válido, generado con ffmpeg (testsrc2 + tono
 * sine, sin ningún rostro real ni de stock) y con el texto "ATOMIVID -
 * VIDEO SIMULADO / Fixture de prueba - NO es un avatar real" incrustado
 * en el propio video — así cualquier evidencia (captura, MP4 descargado)
 * queda identificada como simulada aunque se comparta fuera de este
 * repositorio. Reemplaza el placeholder de texto plano anterior, que no
 * era un contenedor MP4 válido (ffmpeg fallaba con "moov atom not
 * found" al intentar masterizar el audio).
 */
let cachedPlaceholder: Buffer | null = null;
function loadSimulatedVideoBuffer(): Buffer {
  if (!cachedPlaceholder) {
    cachedPlaceholder = readFileSync(join(__dirname, "fixtures", "simulated-avatar-video.mp4"));
  }
  return cachedPlaceholder;
}

// Referencia solo para que la UI/pruebas puedan mostrar un número
// plausible en modo fixture — el fixture SIEMPRE cobra $0 de verdad
// (generateVideo() abajo), esto es puramente cosmético para no mostrar
// "$0.00" en una previsualización de costo mientras se prueba sin
// HEYGEN_API_KEY.
const FIXTURE_REFERENCE_COST_USD_PER_CHAR = 0.0002;

/**
 * Proveedor de avatar determinístico (sin red): simula el ciclo de vida
 * completo (crear avatar → listo de inmediato → generar video → listo de
 * inmediato) sin llamar a HeyGen ni a ningún otro servicio — sirve para
 * probar el resto del pipeline (consentimiento, costos, estados,
 * idempotencia) sin HEYGEN_API_KEY ni gasto real.
 */
let avatarCounter = 0;
let videoCounter = 0;

export const fixtureAvatarProvider: AvatarVideoProvider = {
  name: "fixture",
  capabilities: {
    id: "fixture",
    models: ["fixture-avatar"],
    formats: ["video/mp4"],
    aspectRatios: ["9:16"],
    timeoutMs: 0,
    maxRetries: 0,
  },
  isAvailable() {
    return true;
  },
  async createAvatar(request: AvatarCreationRequest): Promise<AvatarCreationResult> {
    if (!request.consentGiven) {
      throw new AvatarProviderError("Falta el consentimiento del propietario de la fotografía", "fixture", "consent_missing");
    }
    if (request.photoBuffer.byteLength === 0) {
      throw new AvatarProviderError("La fotografía está vacía", "fixture", "invalid_response");
    }
    avatarCounter += 1;
    return { providerAvatarId: `fixture-avatar-${avatarCounter}`, status: "completed" as AvatarJobStatus };
  },
  async checkAvatarStatus(): Promise<AvatarJobStatus> {
    return "completed";
  },
  async generateVideo(request: AvatarVideoRequest): Promise<AvatarVideoResult> {
    void request;
    videoCounter += 1;
    return {
      buffer: loadSimulatedVideoBuffer(),
      mimeType: "video/mp4",
      extension: "mp4",
      model: "fixture-avatar",
      costUsd: 0,
      providerJobId: `fixture-video-job-${videoCounter}`,
    };
  },
  async checkVideoStatus(): Promise<AvatarJobStatus> {
    return "completed";
  },
  async deleteAvatar(): Promise<{ deleted: boolean; reason?: string }> {
    return { deleted: true };
  },
  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script">): number {
    return Math.round(request.script.length * FIXTURE_REFERENCE_COST_USD_PER_CHAR * 100) / 100;
  },
  async cancelVideo(): Promise<{ cancelled: boolean; reason?: string }> {
    return { cancelled: true };
  },
  processWebhookPayload(payload: unknown): AvatarWebhookResult | null {
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    if (typeof p.providerJobId !== "string") return null;
    const rawStatus = p.status;
    const validStatuses: AvatarJobStatus[] = ["queued", "processing", "completed", "failed", "cancelled"];
    if (typeof rawStatus !== "string" || !validStatuses.includes(rawStatus as AvatarJobStatus)) return null;
    return { providerJobId: p.providerJobId, status: rawStatus as AvatarJobStatus };
  },
};
