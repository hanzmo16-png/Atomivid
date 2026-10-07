/**
 * Where a committed paid result lives so a later attempt can reuse it with zero calls
 * (RB-03 re-pay). Objects go under `${requestId}/paid/<key>.<ext>` in the private "videos"
 * bucket next to a JSON sidecar with the metadata and the sha256 of the bytes.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PaidResultStore {
  putBytes(path: string, bytes: Buffer, contentType: string): Promise<void>;
  getBytes(path: string): Promise<Buffer | null>;
  putJson(path: string, value: unknown): Promise<void>;
  getJson<T>(path: string): Promise<T | null>;
}

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const paidResultPath = (requestId: string, key: string, ext: string) => `${requestId}/paid/${key}.${ext}`;
/** A result that was paid but could not be stored: loadable by nobody, so the gate refuses instead of re-paying. */
export const UNSTORED_REF = "unstored:";

export function supabaseResultStore(supabase: SupabaseClient, bucket = "videos"): PaidResultStore {
  const s = () => supabase.storage.from(bucket);
  return {
    async putBytes(path, bytes, contentType) {
      const { error } = await s().upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`No se pudo guardar el resultado pagado (${path}): ${error.message}`);
    },
    async getBytes(path) {
      const { data, error } = await s().download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async putJson(path, value) {
      const { error } = await s().upload(path, Buffer.from(JSON.stringify(value)), { contentType: "application/json", upsert: true });
      if (error) throw new Error(`No se pudo guardar el registro del resultado pagado (${path}): ${error.message}`);
    },
    async getJson<T>(path: string) {
      const { data, error } = await s().download(path);
      if (error || !data) return null;
      const text = await data.text();
      return text ? (JSON.parse(text) as T) : null;
    },
  };
}

export function memoryResultStore(): PaidResultStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async putBytes(path, bytes) { objects.set(path, Buffer.from(bytes)); },
    async getBytes(path) { const b = objects.get(path); return b ? Buffer.from(b) : null; },
    async putJson(path, value) { objects.set(path, Buffer.from(JSON.stringify(value))); },
    async getJson<T>(path: string) { const b = objects.get(path); return b ? (JSON.parse(b.toString("utf8")) as T) : null; },
  };
}
