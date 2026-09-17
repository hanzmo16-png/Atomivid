import type { GenerativeAsset, VideoGenerationRequest, VideoProvider } from "../types";

/**
 * "Clip premium" determinístico (sin red): un buffer de bytes fijo con
 * metadata de video plausible, sin contenido real reproducible — solo
 * sirve para ejercitar el flujo de selección/costo/fallback del Visual
 * Director en pruebas (nunca se decodifica ni se pasa a Remotion/ffprobe
 * en el modo fixture).
 */
export const fixtureVideoProvider: VideoProvider = {
  name: "fixture",
  capabilities: {
    id: "fixture",
    models: ["fixture-placeholder-clip"],
    formats: ["video/mp4"],
    aspectRatios: ["9:16"],
    timeoutMs: 0,
    maxRetries: 0,
  },
  isAvailable() {
    return true;
  },
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    const placeholder = Buffer.from(
      `atomivid-fixture-video-clip:${request.prompt.slice(0, 40)}:${request.durationSeconds}s`,
      "utf8",
    );
    return {
      buffer: placeholder,
      mimeType: "video/mp4",
      extension: "mp4",
      durationSeconds: request.durationSeconds,
      model: "fixture-placeholder-clip",
      costUsd: 0,
    };
  },
};
