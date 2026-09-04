import { createServiceClient } from "@/lib/supabase/service";

const STORAGE_BUCKET = "videos";

/**
 * Firma una URL de lectura temporal para un objeto del bucket privado
 * "videos". Solo debe llamarse después de confirmar que el usuario actual
 * es dueño del request al que pertenece `path` (el bucket ya no es
 * público — ver migración 0006) — quien llama esta función es responsable
 * de esa validación de propiedad; aquí no se repite la consulta a
 * video_requests para no acoplar este helper a esa tabla.
 */
export async function getSignedVideoUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const service = createServiceClient();
  const { data, error } = await service.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data) return null;
  return data.signedUrl;
}
