import type {
  AvatarCreationRequest,
  AvatarCreationResult,
  AvatarJobStatus,
  AvatarVideoProvider,
  AvatarVideoRequest,
  AvatarVideoResult,
} from "../types";
import { AvatarProviderError } from "../types";

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
    videoCounter += 1;
    const placeholder = Buffer.from(
      `atomivid-fixture-avatar-video:${request.providerAvatarId}:${request.script.slice(0, 40)}`,
      "utf8",
    );
    return {
      buffer: placeholder,
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
};
