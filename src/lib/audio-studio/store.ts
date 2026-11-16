import { isUuid, parseStored, type AudioProject } from "./model";

/**
 * Persistencia de Audio Podcast Studio sin migraciones: un JSON por proyecto en el bucket privado existente,
 * bajo un prefijo propio del módulo. Ningún otro módulo lee ni escribe este prefijo, y el estudio nunca toca
 * objetos fuera de él. La ruta se construye solo con el id de la cuenta autenticada: una cuenta no puede leer
 * ni escribir proyectos de otra aunque conozca su id.
 */
export const AUDIO_STUDIO_BUCKET = "videos";
export const AUDIO_STUDIO_PREFIX = "audio-studio/v1";
export const MAX_PROJECTS = 200;

export function projectPath(ownerId: string, projectId: string): string {
  if (!isUuid(ownerId) || !isUuid(projectId)) throw new Error("Identificador no válido.");
  return `${AUDIO_STUDIO_PREFIX}/${ownerId}/${projectId}.json`;
}

/** Carpeta de archivos de un proyecto (voz en caché y MP3 terminados). */
export function projectDir(ownerId: string, projectId: string): string {
  if (!isUuid(ownerId) || !isUuid(projectId)) throw new Error("Identificador no válido.");
  return `${AUDIO_STUDIO_PREFIX}/${ownerId}/${projectId}`;
}
const BLOB = /^audio-studio\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(tts\/[0-9a-f]{64}\.mp3|audio\/[\w.-]+\.mp3)$/;
/** Solo rutas de archivos del módulo, siempre dentro de la carpeta del dueño y del proyecto. */
export function assertBlobPath(path: string, ownerId: string, projectId: string): string {
  if (!BLOB.test(path) || !path.startsWith(projectDir(ownerId, projectId) + "/")) throw new Error("Ruta de archivo no válida.");
  return path;
}

export interface BlobStore {
  hasBlob(path: string): Promise<boolean>;
  getBlob(path: string): Promise<Buffer | null>;
  putBlob(path: string, data: Buffer, contentType: string): Promise<void>;
  signedUrl(path: string, seconds: number, download?: string): Promise<string | null>;
}

export interface ProjectStore {
  list(ownerId: string): Promise<AudioProject[]>;
  get(ownerId: string, id: string): Promise<AudioProject | null>;
  /** Crea el proyecto solo si no existe. Devuelve false si ya existía (no lo sobrescribe). */
  create(p: AudioProject): Promise<boolean>;
  put(p: AudioProject): Promise<void>;
}

type StorageApi = {
  list(prefix: string, opts: { limit: number; sortBy?: { column: string; order: string } }): Promise<{ data: { name: string }[] | null; error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string; statusCode?: string | number } | null }>;
  upload(path: string, body: string | Blob | Buffer, opts: { contentType: string; upsert: boolean; cacheControl?: string }): Promise<{ error: { message: string; statusCode?: string | number } | null }>;
  createSignedUrl?(path: string, seconds: number, opts?: { download?: string | boolean }): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
};

export class StoreError extends Error { constructor(m: string) { super(m); this.name = "StoreError"; } }

const notFound = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === "404" || /not.?found|does not exist|object not found/i.test(e.message ?? ""));
const conflict = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === "409" || /already exists|duplicate/i.test(e.message ?? ""));

export function storageStore(bucket: StorageApi): ProjectStore & BlobStore {
  const read = async (ownerId: string, id: string) => {
    const { data, error } = await bucket.download(projectPath(ownerId, id));
    if (error) {
      if (notFound(error)) return null;
      console.error("[audio-studio] lectura de Storage falló", { status: error.statusCode ?? null, message: error.message?.slice(0, 200) });
      throw new StoreError("No se pudo leer el proyecto.");
    }
    if (!data) return null;
    let raw: unknown = null;
    try { raw = JSON.parse(await data.text()); } catch { return null; }
    return parseStored(raw, ownerId);
  };
  // Texto, no Blob: supabase-js envía un Blob como multipart; el JSON plano llega tal cual con su Content-Type.
  const body = (p: AudioProject) => JSON.stringify(p);
  return {
    async list(ownerId) {
      if (!isUuid(ownerId)) return [];
      const { data, error } = await bucket.list(`${AUDIO_STUDIO_PREFIX}/${ownerId}`, { limit: MAX_PROJECTS });
      if (error) throw new StoreError("No se pudo leer la biblioteca de audio.");
      // Solo «<id>.json»: la carpeta «<id>/» de cada proyecto (voz y MP3) no es un proyecto.
      const ids = (data ?? []).filter((o) => o.name.endsWith(".json")).map((o) => o.name.slice(0, -5)).filter(isUuid);
      const items = await Promise.all(ids.map((id) => read(ownerId, id).catch(() => null)));
      if (items.some((p) => !p)) console.error("[audio-studio] proyectos no legibles en la biblioteca", { listados: ids.length, legibles: items.filter(Boolean).length });
      return items.filter((p): p is AudioProject => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get: (ownerId, id) => (isUuid(ownerId) && isUuid(id) ? read(ownerId, id) : Promise.resolve(null)),
    async create(p) {
      const { error } = await bucket.upload(projectPath(p.ownerId, p.id), body(p), { contentType: "application/json", upsert: false, cacheControl: "0" });
      if (conflict(error)) return false;
      if (error) { console.error("[audio-studio] creación en Storage falló", { status: error.statusCode ?? null, message: error.message?.slice(0, 200) }); throw new StoreError("No se pudo guardar el proyecto."); }
      return true;
    },
    async put(p) {
      const { error } = await bucket.upload(projectPath(p.ownerId, p.id), body(p), { contentType: "application/json", upsert: true, cacheControl: "0" });
      if (error) throw new StoreError("No se pudo guardar el proyecto.");
    },
    async hasBlob(path) {
      const dir = path.slice(0, path.lastIndexOf("/")), name = path.slice(path.lastIndexOf("/") + 1);
      const { data, error } = await bucket.list(dir, { limit: 1000 });
      if (error) throw new StoreError("No se pudo consultar el almacenamiento.");
      return (data ?? []).some((o) => o.name === name);
    },
    async getBlob(path) {
      const { data, error } = await bucket.download(path);
      if (error) { if (notFound(error)) return null; throw new StoreError("No se pudo leer el audio."); }
      return data ? Buffer.from(await data.arrayBuffer()) : null;
    },
    async putBlob(path, data, contentType) {
      // Sin sobrescritura: la voz en caché y cada MP3 son inmutables (si ya existe, se conserva el original).
      const { error } = await bucket.upload(path, data, { contentType, upsert: false, cacheControl: "3600" });
      if (error && !conflict(error)) throw new StoreError("No se pudo guardar el audio.");
    },
    async signedUrl(path, seconds, download) {
      if (!bucket.createSignedUrl) return null;
      const { data } = await bucket.createSignedUrl(path, seconds, download ? { download } : undefined);
      return data?.signedUrl ?? null;
    },
  };
}

/** Almacén en memoria para pruebas y para el arnés local. */
export function memoryStore(): ProjectStore & BlobStore & { paths(): string[]; blobs: Map<string, Buffer> } {
  const m = new Map<string, string>();
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    paths: () => [...m.keys(), ...blobs.keys()],
    async hasBlob(path) { return blobs.has(path); },
    async getBlob(path) { return blobs.get(path) ?? null; },
    async putBlob(path, data) { if (!blobs.has(path)) blobs.set(path, data); },
    async signedUrl(path, seconds, download) { return blobs.has(path) ? `memory://${path}?s=${seconds}${download ? `&d=${download}` : ""}` : null; },
    async list(ownerId) {
      const prefix = `${AUDIO_STUDIO_PREFIX}/${ownerId}/`;
      return [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => parseStored(JSON.parse(v), ownerId))
        .filter((p): p is AudioProject => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(ownerId, id) {
      if (!isUuid(ownerId) || !isUuid(id)) return null;
      const v = m.get(projectPath(ownerId, id));
      return v ? parseStored(JSON.parse(v), ownerId) : null;
    },
    async create(p) {
      const k = projectPath(p.ownerId, p.id);
      if (m.has(k)) return false;
      m.set(k, JSON.stringify(p));
      return true;
    },
    async put(p) { m.set(projectPath(p.ownerId, p.id), JSON.stringify(p)); },
  };
}
