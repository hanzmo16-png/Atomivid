import { generateToneWav } from "../wav";
import type { MusicProvider } from "../types";

// Proveedor determinístico (sin red): genera un "pad" suave (dos tonos
// superpuestos) en vez de música real con licencia — sirve para probar la
// mezcla de audio (narración + música de fondo) sin depender de un banco
// de música. Ver MusicProvider "custom" para conectar una pista real.
export const fixtureMusicProvider: MusicProvider = {
  name: "fixture",
  async getTrack(durationSeconds) {
    const base = generateToneWav({
      durationSeconds,
      frequencyHz: 130.81, // Do3
      amplitude: 0.05,
    });
    return {
      audioBuffer: base,
      durationSeconds,
      mimeType: "audio/wav",
      extension: "wav",
    };
  },
};
