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
/** The row fields the owner-scoped signing needs; the lookup must already have filtered by the session user. */
export type OwnedVideoRow = { id: string; user_id: string; video_path: string | null };

/**
 * PI V2 B3 (RB-06): the only path the service role may sign for a customer page is one that
 * (a) belongs to a row owned by the session user and (b) lives under that row's own request
 * prefix `${id}/`. `video_path` is a client-writable column (migration 0001 insert policy has no
 * column restriction), so a row the user owns can still point at another tenant's object or at
 * an owner-only review object. Anything else returns null and nothing is signed.
 */
export function ownedVideoPath(row: OwnedVideoRow, sessionUserId: string): string | null {
  if (!sessionUserId || row.user_id !== sessionUserId) return null;
  const p = row.video_path;
  if (!p || !row.id) return null;
  const prefix = `${row.id}/`;
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  if (!rest || rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return p;
}

export async function getSignedVideoUrlForRequest(
  row: OwnedVideoRow,
  sessionUserId: string,
  sign: (path: string, expiresInSeconds?: number) => Promise<string | null> = getSignedVideoUrl,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const path = ownedVideoPath(row, sessionUserId);
  if (!path) return null;
  return sign(path, expiresInSeconds);
}

/**
 * Firma cruda por ruta: SOLO para rutas fijas gestionadas por el administrador (p. ej.
 * /dashboard/admin/p2b-veo). Las páginas de clientes usan getSignedVideoUrlForRequest.
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
