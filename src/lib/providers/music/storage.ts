import type { SupabaseClient } from "@supabase/supabase-js";
import { MusicObjectNotFoundError, MusicProviderError, MusicSigningError } from "./errors";

/**
 * Bucket privado dedicado a la biblioteca curada de música (distinto de
 * "videos", que es para archivos efímeros por solicitud — ver
 * src/lib/video/generate.ts). Debe crearse manualmente en el dashboard de
 * Supabase como privado, sin ninguna policy pública — un bucket privado
 * sin policies de select para anon/authenticated solo es legible con la
 * service role key, que es exactamente el acceso que necesita este código
 * (nunca se llama desde el navegador).
 */
export const MUSIC_LIBRARY_BUCKET = "music-library";

/** Tope pedido explícitamente: la URL firmada nunca vive más de 1 hora. */
export const MUSIC_LIBRARY_SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Limpia una ruta de objeto antes de usarla — quita barras iniciales
 * accidentales (p. ej. si alguien pega "/music-library/pixabay-x.mp3" en
 * vez de "pixabay-x.mp3": el nombre del bucket ya lo selecciona `.from()`,
 * no debe repetirse dentro de la ruta) y rechaza una ruta vacía.
 */
export function normalizeObjectPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (!trimmed) {
    throw new MusicProviderError("La ruta del objeto de música no puede estar vacía.");
  }
  return trimmed;
}

/**
 * Firma una URL de lectura temporal para un objeto del bucket privado de
 * la biblioteca de música — se genera bajo demanda, solo en este código de
 * servidor (nunca en el navegador), con la service role key que ya usa el
 * resto del pipeline (`createServiceClient()`). Mismo patrón que
 * `getSignedVideoUrl` para el bucket "videos"
 * (src/lib/storage/signed-url.ts), pero con un TTL fijo y corto en vez de
 * configurable, porque aquí no hay ningún caso de uso que necesite más de
 * la duración de un render.
 */
export async function signMusicLibraryUrl(
  service: SupabaseClient,
  objectPath: string,
): Promise<string> {
  const path = normalizeObjectPath(objectPath);

  const { data, error } = await service.storage
    .from(MUSIC_LIBRARY_BUCKET)
    .createSignedUrl(path, MUSIC_LIBRARY_SIGNED_URL_TTL_SECONDS);

  if (error) {
    // StorageApiError expone status/code (ver @supabase/storage-js); no
    // importamos esa clase directamente para no acoplarnos a su superficie
    // interna — se detecta de forma defensiva por duck-typing.
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    const isNotFound =
      status === 404 ||
      code === "NoSuchKey" ||
      code === "object_not_found" ||
      code === "not_found";

    if (isNotFound) {
      throw new MusicObjectNotFoundError(
        `No existe el objeto "${path}" en el bucket "${MUSIC_LIBRARY_BUCKET}": ${error.message}`,
      );
    }
    throw new MusicSigningError(`No se pudo firmar la URL de "${path}": ${error.message}`);
  }

  if (!data?.signedUrl) {
    throw new MusicSigningError(
      `Supabase no devolvió una URL firmada para "${path}" (respuesta vacía).`,
    );
  }

  return data.signedUrl;
}
