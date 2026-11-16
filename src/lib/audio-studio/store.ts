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
  upload(path: string, body: string | Blob, opts: { contentType: string; upsert: boolean; cacheControl?: string }): Promise<{ error: { message: string; statusCode?: string | number } | null }>;
};

export class StoreError extends Error { constructor(m: string) { super(m); this.name = "StoreError"; } }

const notFound = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === "404" || /not.?found|does not exist|object not found/i.test(e.message ?? ""));
const conflict = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === "409" || /already exists|duplicate/i.test(e.message ?? ""));

export function storageStore(bucket: StorageApi): ProjectStore {
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
      const ids = (data ?? []).map((o) => o.name.replace(/\.json$/, "")).filter(isUuid);
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
  };
}

/** Almacén en memoria para pruebas y para el arnés local. */
export function memoryStore(): ProjectStore & { paths(): string[] } {
  const m = new Map<string, string>();
  return {
    paths: () => [...m.keys()],
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
