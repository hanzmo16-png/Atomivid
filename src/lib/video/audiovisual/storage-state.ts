/**
 * Estado durable en Supabase Storage para operaciones pagadas (registro de
 * gasto, marcadores de imagen generada, caché de voz). Regla central: si no
 * se puede CONFIRMAR el estado (error de red/permisos al leer), se detiene;
 * nunca se interpreta un error como «no existe», porque eso llevaría a pagar
 * otra vez algo que quizá ya se pagó.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** No se pudo confirmar el estado en Storage (lectura/listado fallido). Nunca se asume «no existe». */
export class StorageStateUnknownError extends Error {
  constructor(what: string, detail: string) {
    super(`No se pudo confirmar el estado de ${what} en Storage (${detail}). Se detiene para no repetir un gasto; reintenta más tarde.`);
    this.name = "StorageStateUnknownError";
  }
}

type StorageErrorLike = { message?: string; statusCode?: string | number; status?: number; error?: string } | null | undefined;

/** Solo un «no encontrado» explícito cuenta como ausencia; cualquier otro error es estado desconocido. */
export function isStorageNotFound(error: StorageErrorLike): boolean {
  if (!error) return false;
  const code = String(error.statusCode ?? error.status ?? "");
  return code === "404" || error.error === "not_found" || /not[ _-]?found|does not exist|no such key/i.test(error.message ?? "");
}

export type JsonState<T> = { kind: "missing" } | { kind: "found"; data: T };

export async function readJsonState<T>(supabase: SupabaseClient, bucket: string, path: string, what: string): Promise<JsonState<T>> {
  let result: { data: Blob | null; error: StorageErrorLike };
  try {
    result = (await supabase.storage.from(bucket).download(path)) as { data: Blob | null; error: StorageErrorLike };
  } catch (err) {
    throw new StorageStateUnknownError(what, err instanceof Error ? err.message : String(err));
  }
  if (result.error) {
    if (isStorageNotFound(result.error)) return { kind: "missing" };
    throw new StorageStateUnknownError(what, result.error.message ?? "error de Storage");
  }
  if (!result.data) throw new StorageStateUnknownError(what, "respuesta vacía");
  const text = await result.data.text();
  try {
    return { kind: "found", data: JSON.parse(text) as T };
  } catch {
    throw new StorageStateUnknownError(what, "JSON ilegible");
  }
}

/** Escritura con reintentos breves; lanza si al final no quedó guardada. */
export async function writeJsonState(supabase: SupabaseClient, bucket: string, path: string, value: unknown, attempts = 3): Promise<void> {
  await uploadWithRetry(supabase, bucket, path, Buffer.from(JSON.stringify(value, null, 2)), "application/json", attempts);
}

export async function uploadWithRetry(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
  attempts = 3,
  delayMs = Number(process.env.AUDIOVISUAL_STORAGE_RETRY_MS ?? 400),
): Promise<void> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType, upsert: true });
      if (!error) return;
      last = error.message;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
  }
  throw new Error(`No se pudo guardar "${path}" en Storage tras ${attempts} intentos: ${last}`);
}
