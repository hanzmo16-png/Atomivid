/**
 * Subida del MP4 final de Long Form: reanudable (protocolo TUS de Supabase
 * Storage, `/storage/v1/upload/resumable`, trozos de 6 MB — el tamaño que
 * exige Supabase) con reintentos acotados, y subida estándar como respaldo
 * si el endpoint reanudable no está disponible. Siempre sube el MISMO
 * archivo local: ningún reintento vuelve a renderizar ni llama a un
 * proveedor.
 *
 * Un rechazo por tamaño o de autenticación nunca se reintenta (no va a
 * cambiar); un error transitorio (5xx, 429, red, timeout) sí, reanudando
 * desde el último byte que Storage confirmó.
 */
import fs from "node:fs/promises";
import { classifyStorageError, type UploadFailureCategory } from "./output-policy";

export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

export class OutputUploadError extends Error {
  constructor(
    readonly category: UploadFailureCategory,
    readonly status: number | null,
    readonly detail: string,
    readonly attempts: number,
    readonly log: UploadAttemptLog[] = [],
  ) {
    super(`output_upload_${category}`);
    this.name = "OutputUploadError";
  }
}

export type UploadAttemptLog = { method: "resumable" | "standard"; attempt: number; ok: boolean; category?: UploadFailureCategory; status?: number | null; detail?: string; offset?: number };

export type OutputUploadDeps = {
  supabaseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Subida estándar (supabase-js `.upload(..., {upsert:true})`) — respaldo. */
  standardUpload: (objectPath: string, buffer: Buffer, contentType: string) => Promise<{ error: { message: string; status?: number | null } | null }>;
  maxAttempts?: number;
  backoffMs?: number;
  /** Solo pruebas: forzar el respaldo estándar. */
  disableResumable?: boolean;
  chunkBytes?: number;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

class TusHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: string,
  ) {
    super(`tus_http_${status ?? "network"}: ${body.slice(0, 300)}`);
  }
}

async function readChunk(handle: fs.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function tusRequest(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (err) {
    throw new TusHttpError(null, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
  return res;
}

/**
 * Sube `filePath` a `bucket/objectPath` (upsert). Devuelve la bitácora de
 * intentos (para el estado durable/admin). Lanza OutputUploadError con la
 * categoría final si no se pudo.
 */
export async function uploadOutputFile(
  input: { bucket: string; objectPath: string; filePath: string; contentType: string },
  deps: OutputUploadDeps,
): Promise<{ method: "resumable" | "standard"; attempts: UploadAttemptLog[] }> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? 4;
  const backoffMs = deps.backoffMs ?? 2000;
  const chunkBytes = deps.chunkBytes ?? TUS_CHUNK_BYTES;
  const size = (await fs.stat(input.filePath)).size;
  const log: UploadAttemptLog[] = [];
  const authHeaders = { authorization: `Bearer ${deps.serviceKey}`, apikey: deps.serviceKey };

  // --- Reanudable (TUS) ---
  let resumableUnavailable = Boolean(deps.disableResumable);
  if (!resumableUnavailable) {
    const endpoint = `${deps.supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`;
    let location: string | null = null;
    let offset = 0;
    const handle = await fs.open(input.filePath, "r");
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (!location) {
            const res = await tusRequest(f, endpoint, {
              method: "POST",
              headers: {
                ...authHeaders,
                "tus-resumable": "1.0.0",
                "upload-length": String(size),
                "x-upsert": "true",
                "upload-metadata": [
                  `bucketName ${b64(input.bucket)}`,
                  `objectName ${b64(input.objectPath)}`,
                  `contentType ${b64(input.contentType)}`,
                  `cacheControl ${b64("3600")}`,
                ].join(","),
              },
            });
            if (res.status !== 201) throw new TusHttpError(res.status, await res.text().catch(() => ""));
            const loc = res.headers.get("location");
            if (!loc) throw new TusHttpError(res.status, "sin cabecera Location");
            location = new URL(loc, endpoint).toString();
            offset = 0;
          } else {
            // Reanudar: preguntar a Storage cuántos bytes ya tiene.
            const head = await tusRequest(f, location, { method: "HEAD", headers: { ...authHeaders, "tus-resumable": "1.0.0" } });
            if (head.status === 404 || head.status === 410) {
              location = null;
              throw new TusHttpError(head.status, "sesión de subida expirada — se crea una nueva");
            }
            if (!head.ok) throw new TusHttpError(head.status, "");
            offset = Number(head.headers.get("upload-offset") ?? 0);
          }
          while (offset < size) {
            const chunk = await readChunk(handle, offset, Math.min(chunkBytes, size - offset));
            const res = await tusRequest(f, location, {
              method: "PATCH",
              headers: { ...authHeaders, "tus-resumable": "1.0.0", "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
              body: new Uint8Array(chunk),
            });
            if (res.status !== 204) throw new TusHttpError(res.status, await res.text().catch(() => ""));
            const next = Number(res.headers.get("upload-offset") ?? offset + chunk.byteLength);
            if (!(next > offset)) throw new TusHttpError(res.status, "Storage no avanzó el offset");
            offset = next;
          }
          log.push({ method: "resumable", attempt, ok: true, offset });
          return { method: "resumable", attempts: log };
        } catch (err) {
          const status = err instanceof TusHttpError ? err.status : null;
          const detail = err instanceof TusHttpError ? err.body : err instanceof Error ? err.message : String(err);
          const category = classifyStorageError({ status, message: detail });
          log.push({ method: "resumable", attempt, ok: false, category, status, detail: detail.slice(0, 300), offset });
          if (category === "size_rejected" || category === "auth") throw new OutputUploadError(category, status, detail, log.length, log);
          // El endpoint reanudable no existe/no acepta el protocolo → respaldo estándar.
          if (status === 404 && location === null && offset === 0 && attempt === 1) {
            resumableUnavailable = true;
            break;
          }
          if (category === "unknown" && status !== null && status >= 400 && status < 500 && status !== 404 && status !== 409 && status !== 410) {
            resumableUnavailable = true;
            break;
          }
          if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
        }
      }
    } finally {
      await handle.close();
    }
    if (!resumableUnavailable) {
      const last = log.at(-1);
      throw new OutputUploadError(last?.category ?? "unknown", last?.status ?? null, last?.detail ?? "", log.length, log);
    }
  }

  // --- Respaldo: subida estándar del mismo archivo, reintentos acotados ---
  const buffer = await fs.readFile(input.filePath);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let error: { message: string; status?: number | null } | null;
    try {
      ({ error } = await deps.standardUpload(input.objectPath, buffer, input.contentType));
    } catch (err) {
      error = { message: err instanceof Error ? `${err.name}: ${err.message}` : String(err), status: null };
    }
    if (!error) {
      log.push({ method: "standard", attempt, ok: true });
      return { method: "standard", attempts: log };
    }
    const category = classifyStorageError({ status: error.status ?? null, message: error.message });
    log.push({ method: "standard", attempt, ok: false, category, status: error.status ?? null, detail: error.message.slice(0, 300) });
    if (category === "size_rejected" || category === "auth") throw new OutputUploadError(category, error.status ?? null, error.message, log.length, log);
    if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
  }
  const last = log.at(-1);
  throw new OutputUploadError(last?.category ?? "unknown", last?.status ?? null, last?.detail ?? "", log.length, log);
}
