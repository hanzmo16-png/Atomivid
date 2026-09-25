/**
 * Registro durable, por SOLICITUD (no por intento), de los assets ya
 * resueltos para cada shot — el reintento de un render reutiliza lo ya
 * descargado/generado en vez de volver a pagarlo. Antes de esto los assets
 * se subían bajo `${requestId}/attempt-N/...`, así que cada intento
 * regeneraba todas las imágenes IA.
 *
 * Estados:
 * - COMPLETED: objeto subido — se reutiliza.
 * - STARTED: una llamada pagada empezó y no hay constancia de su
 *   resultado — costo incierto: NUNCA se regenera (el shot cae a fallback).
 * - FAILED_NO_CHARGE: el proveedor rechazó con costo conocido cero.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ShotAssetKind = "stock" | "ai_image" | "ai_video";

export type ShotAssetRecord = {
  shotId: string;
  kind: ShotAssetKind;
  status: "STARTED" | "COMPLETED" | "FAILED_NO_CHARGE";
  objectPath?: string;
  contentType?: string;
  mediaType?: "image" | "video";
  costUsd?: number;
  provider?: string;
  bytes?: number;
  updatedAtIso: string;
};

export interface ShotAssetStore {
  read(shotId: string, kind: ShotAssetKind): Promise<ShotAssetRecord | null>;
  write(record: ShotAssetRecord): Promise<void>;
  putObject(objectPath: string, buffer: Buffer, contentType: string): Promise<void>;
  signedUrl(objectPath: string): Promise<string>;
  objectPathFor(shotId: string, kind: ShotAssetKind, extension: string): string;
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;

export function supabaseShotAssetStore(supabase: SupabaseClient, requestId: string, bucket = "videos"): ShotAssetStore {
  const recordPath = (shotId: string, kind: ShotAssetKind) => `${requestId}/state/shots/${shotId}.${kind}.json`;
  return {
    async read(shotId, kind) {
      const { data, error } = await supabase.storage.from(bucket).download(recordPath(shotId, kind));
      if (error || !data) return null;
      const text = await data.text();
      return text ? (JSON.parse(text) as ShotAssetRecord) : null;
    },
    async write(record) {
      const path = recordPath(record.shotId, record.kind);
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, Buffer.from(JSON.stringify(record)), { contentType: "application/json", upsert: true });
      if (error) throw new Error(`No se pudo guardar el registro del shot ("${path}"): ${error.message}`);
    },
    async putObject(objectPath, buffer, contentType) {
      const { error } = await supabase.storage.from(bucket).upload(objectPath, buffer, { contentType, upsert: true });
      if (error) throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);
    },
    async signedUrl(objectPath) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
      if (error || !data) throw new Error(`No se pudo firmar la URL de ${objectPath}: ${error?.message ?? "desconocido"}`);
      return data.signedUrl;
    },
    objectPathFor(shotId, kind, extension) {
      return `${requestId}/assets/${shotId}.${kind}.${extension}`;
    },
  };
}

/** Implementación en memoria (pruebas / inyección de fallos). */
export function memoryShotAssetStore(opts: { failPutObject?: (path: string) => boolean } = {}) {
  const records = new Map<string, ShotAssetRecord>();
  const objects = new Map<string, Buffer>();
  const store: ShotAssetStore = {
    async read(shotId, kind) {
      const r = records.get(`${shotId}.${kind}`);
      return r ? { ...r } : null;
    },
    async write(record) {
      records.set(`${record.shotId}.${record.kind}`, { ...record });
    },
    async putObject(objectPath, buffer) {
      if (opts.failPutObject?.(objectPath)) throw new Error(`storage caído: ${objectPath}`);
      objects.set(objectPath, Buffer.from(buffer));
    },
    async signedUrl(objectPath) {
      if (!objects.has(objectPath)) throw new Error(`no existe ${objectPath}`);
      return `memory://${objectPath}`;
    },
    objectPathFor(shotId, kind, extension) {
      return `req/assets/${shotId}.${kind}.${extension}`;
    },
  };
  return { store, records, objects };
}
