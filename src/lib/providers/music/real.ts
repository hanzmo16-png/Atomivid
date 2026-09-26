import type { MusicProvider, MusicResult } from "../types";
import { createServiceClient } from "@/lib/supabase/service";
import { MUSIC_MANIFEST } from "./manifest";
import { inferTone } from "./tone";
import { selectMusicTrack, seededIndex } from "./select";
import { validateAudioBuffer } from "./validate";
import { signMusicLibraryUrl } from "./storage";
import {
  MusicDownloadError,
  MusicInvalidFileError,
  MusicNoCompatibleTrackError,
  MusicNoMatchError,
} from "./errors";
import { selectDirectedTracks } from "@/lib/video/audiovisual/music";
import type { MusicTrackEntry } from "./manifest";

// Ni Pixabay Music ni Freesound ofrecen hoy una API pública lista para uso
// comercial sin pasos extra: la API pública de Pixabay (pixabay.com/api/docs)
// solo cubre imágenes y video, no audio (su contenido musical SÍ tiene
// licencia comercial gratuita — Pixabay Content License — pero no hay
// endpoint para buscarlo/descargarlo por API); la API de Freesound es
// gratis pero su licencia limita el uso gratuito a fines no comerciales
// (uso comercial requiere contactarlos aparte). Por eso, en vez de una
// integración en vivo (que no existe), este proveedor usa una biblioteca
// curada manualmente por el usuario — pistas ya descargadas bajo una
// licencia verificada (Pixabay Music, Mixkit, etc., una por una, con su
// metadata registrada en manifest.ts). Ver README, "Música de fondo",
// para la investigación completa.
//
// Dos formas de configurarla, de la más a la menos completa:
// 1. MUSIC_MANIFEST (manifest.ts): registra procedencia/autor/licencia/
//    tono por pista, sube el archivo al bucket privado `music-library`
//    (ver storage.ts) y permite una selección inteligente (tone.ts +
//    select.ts) con la URL firmada bajo demanda en el servidor — nunca
//    una URL pública ni permanente.
// 2. MUSIC_TRACK_URLS (env var, lista separada por comas) o
//    MUSIC_TRACK_URL (una sola pista): modo "arranque rápido", con URLs
//    literales (públicas o ya firmadas por quien las configura) — sin
//    metadata ni tono, sin pasar por el bucket privado de la biblioteca.
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

async function downloadAndValidate(
  url: string,
  label: string,
): Promise<{ audioBuffer: Buffer; mimeType: string; extension: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "error de red desconocido";
    throw new MusicDownloadError(`No se pudo descargar "${label}": ${message}`);
  }
  if (!res.ok) {
    throw new MusicDownloadError(`No se pudo descargar "${label}": HTTP ${res.status}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  const validation = validateAudioBuffer(audioBuffer);
  if (!validation.valid) {
    throw new MusicInvalidFileError(`Archivo de "${label}" inválido: ${validation.reason}`);
  }

  const extension = validation.format;
  const contentType =
    res.headers.get("content-type") ??
    (extension === "wav" ? "audio/wav" : extension === "ogg" ? "audio/ogg" : "audio/mpeg");

  return { audioBuffer, mimeType: contentType, extension };
}

export const curatedLibraryMusicProvider: MusicProvider = {
  name: "curated-library",
  async getTrack({ durationSeconds, style, topic, scriptText, seed, direction }): Promise<MusicResult> {
    const selectionSeed = seed ?? `${style ?? ""}:${topic ?? ""}`;

    if (direction) return getDirectedTrack(direction, selectionSeed, durationSeconds);

    if (MUSIC_MANIFEST.length > 0) {
      const tones = inferTone({ style, topic, scriptText });
      const result = selectMusicTrack({ manifest: MUSIC_MANIFEST, tones, seed: selectionSeed });
      if (result.status === "empty") {
        throw new MusicNoMatchError();
      }

      const track = result.track;
      // La URL se firma bajo demanda, solo en este código de servidor, con
      // un TTL de máximo 1 hora — nunca se guarda ni se envía al navegador
      // una URL descargable permanente (ver storage.ts).
      const service = createServiceClient();
      const signedUrl = await signMusicLibraryUrl(service, track.storagePath);
      const { audioBuffer, mimeType, extension } = await downloadAndValidate(
        signedUrl,
        track.title,
      );

      return {
        audioBuffer,
        durationSeconds,
        mimeType,
        extension,
        track: {
          provider: track.provider,
          trackId: track.id,
          title: track.title,
          author: track.author,
          sourceUrl: track.sourceUrl,
          license: track.license,
          tones: track.tones,
        },
      };
    }

    // Modo "arranque rápido": lista plana de URLs sin metadata ni tono.
    const trackUrls = getConfiguredTrackUrls();
    if (trackUrls.length === 0) {
      throw new MusicNoMatchError(
        "No hay música de fondo configurada (ni MUSIC_MANIFEST ni " +
          "MUSIC_TRACK_URL/MUSIC_TRACK_URLS). Define al menos una pista libre " +
          "de derechos, o usa MUSIC_PROVIDER=fixture para pruebas internas.",
      );
    }
    const url = trackUrls[seededIndex(selectionSeed, trackUrls.length)];
    const { audioBuffer, mimeType, extension } = await downloadAndValidate(url, url);

    return { audioBuffer, durationSeconds, mimeType, extension };
  },
};

function trackMetadata(track: MusicTrackEntry): NonNullable<MusicResult["track"]> {
  return {
    provider: track.provider,
    trackId: track.id,
    title: track.title,
    author: track.author,
    sourceUrl: track.sourceUrl,
    license: track.license,
    tones: track.tones,
  };
}

/**
 * Modo dirigido: recorre SOLO pistas compatibles con la dirección (en el
 * orden determinístico de selectDirectedTracks). Si una falta en el bucket
 * o está corrupta, prueba la siguiente compatible; si ninguna sirve, lanza
 * MusicNoCompatibleTrackError con el detalle — nunca otra pista cualquiera.
 */
async function getDirectedTrack(
  direction: import("@/lib/video/audiovisual/catalog").MusicDirectionId,
  seed: string,
  durationSeconds: number,
): Promise<MusicResult> {
  const selection = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction, seed });
  if (selection.status === "no_compatible") throw new MusicNoCompatibleTrackError(selection.reason);
  const service = createServiceClient();
  const failures: string[] = [];
  for (const track of selection.candidates) {
    try {
      const signedUrl = await signMusicLibraryUrl(service, track.storagePath);
      const { audioBuffer, mimeType, extension } = await downloadAndValidate(signedUrl, track.title);
      return { audioBuffer, durationSeconds, mimeType, extension, track: trackMetadata(track) };
    } catch (err) {
      failures.push(`${track.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new MusicNoCompatibleTrackError(
    `Ninguna de las ${selection.candidates.length} pistas compatibles con «${direction}» está disponible (${failures.join("; ")}).`,
  );
}
