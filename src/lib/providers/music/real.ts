import type { MusicProvider } from "../types";

// Ni Pixabay Music ni Freesound ofrecen hoy una API pública lista para uso
// comercial sin pasos extra: la API pública de Pixabay (pixabay.com/api/docs)
// solo cubre imágenes y video, no audio; la API de Freesound es gratis pero
// su licencia limita el uso gratuito a fines no comerciales (uso comercial
// requiere contactarlos aparte). Por eso, en vez de una integración en vivo,
// este proveedor usa una pequeña playlist de pistas ya descargadas por el
// usuario bajo una licencia verificada (p. ej. Pixabay Music o Mixkit,
// ambas permiten uso comercial sin costo) y subidas a una URL propia — por
// ejemplo el bucket de Supabase Storage. Define MUSIC_TRACK_URLS con una
// lista separada por comas para variar la pista entre videos, o
// MUSIC_TRACK_URL con una sola pista. Documentado en el README.
function getConfiguredTrackUrls(): string[] {
  const list = process.env.MUSIC_TRACK_URLS;
  if (list) {
    return list
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
  }
  const single = process.env.MUSIC_TRACK_URL;
  return single ? [single] : [];
}

export const customUrlMusicProvider: MusicProvider = {
  name: "custom-url",
  async getTrack(durationSeconds) {
    const trackUrls = getConfiguredTrackUrls();
    if (trackUrls.length === 0) {
      throw new Error(
        "MUSIC_TRACK_URL / MUSIC_TRACK_URLS no está configurada. Define al menos " +
          "una pista de música libre de derechos, o usa MUSIC_PROVIDER=fixture.",
      );
    }
    const trackUrl = trackUrls[Math.floor(Math.random() * trackUrls.length)];

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
