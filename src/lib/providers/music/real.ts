import type { MusicProvider } from "../types";
import { MUSIC_MANIFEST } from "./manifest";

// Ni Pixabay Music ni Freesound ofrecen hoy una API pública lista para uso
// comercial sin pasos extra: la API pública de Pixabay (pixabay.com/api/docs)
// solo cubre imágenes y video, no audio; la API de Freesound es gratis pero
// su licencia limita el uso gratuito a fines no comerciales (uso comercial
// requiere contactarlos aparte). Por eso, en vez de una integración en vivo,
// este proveedor usa una pequeña playlist de pistas ya descargadas por el
// usuario bajo una licencia verificada (p. ej. Pixabay Music o Mixkit,
// ambas permiten uso comercial sin costo) y subidas a una URL propia — por
// ejemplo el bucket de Supabase Storage. Documentado en el README.
//
// Dos formas de configurarla, de la más a la menos completa:
// 1. MUSIC_MANIFEST (manifest.ts): registra fuente/autor/licencia por
//    pista y permite elegir por estilo de video.
// 2. MUSIC_TRACK_URLS (env var, lista separada por comas) o
//    MUSIC_TRACK_URL (una sola pista): más simple, sin estilos ni
//    metadata, para arrancar rápido.
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

function pickTrackUrl(style?: string): string {
  if (MUSIC_MANIFEST.length > 0) {
    const normalizedStyle = style?.trim().toLowerCase();
    const matching = normalizedStyle
      ? MUSIC_MANIFEST.filter((track) =>
          track.styleTags.some((tag) => tag.toLowerCase() === normalizedStyle),
        )
      : [];
    const pool = matching.length > 0 ? matching : MUSIC_MANIFEST;
    return pool[Math.floor(Math.random() * pool.length)].storageUrl;
  }

  const trackUrls = getConfiguredTrackUrls();
  if (trackUrls.length === 0) {
    throw new Error(
      "No hay música de fondo configurada (ni MUSIC_MANIFEST ni " +
        "MUSIC_TRACK_URL/MUSIC_TRACK_URLS). Define al menos una pista libre " +
        "de derechos, o usa MUSIC_PROVIDER=fixture para pruebas internas.",
    );
  }
  return trackUrls[Math.floor(Math.random() * trackUrls.length)];
}

export const customUrlMusicProvider: MusicProvider = {
  name: "custom-url",
  async getTrack(durationSeconds, style) {
    const trackUrl = pickTrackUrl(style);

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
