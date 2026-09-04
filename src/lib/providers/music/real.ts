import type { MusicProvider } from "../types";

// No hay un banco de música gratuito con API key configurada todavía
// (Pixabay Music/Freesound requieren cuenta + credenciales que no están
// disponibles en este entorno). Como alternativa "real" sin bloquear el
// pipeline: si defines MUSIC_TRACK_URL apuntando a una pista propia con
// licencia verificada (por ejemplo subida a tu bucket de Supabase Storage
// o cualquier URL pública), la usamos tal cual. Documentado en el README
// como pendiente de conectar un banco de música real.
export const customUrlMusicProvider: MusicProvider = {
  name: "custom-url",
  async getTrack(durationSeconds) {
    const trackUrl = process.env.MUSIC_TRACK_URL;
    if (!trackUrl) {
      throw new Error(
        "MUSIC_TRACK_URL no está configurada. Define MUSIC_TRACK_URL con una " +
          "pista de música libre de derechos, o usa MUSIC_PROVIDER=fixture.",
      );
    }

    const res = await fetch(trackUrl);
    if (!res.ok) {
      throw new Error(`No se pudo descargar la música de fondo: ${res.status}`);
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    const extension = contentType.includes("wav") ? "wav" : "mp3";

    return { audioBuffer, durationSeconds, mimeType: contentType, extension };
  },
};
