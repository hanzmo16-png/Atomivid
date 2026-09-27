/**
 * Supabase Storage simulado en memoria para pruebas (sin red), con
 * inyección de fallos por ruta: listados, lecturas y subidas que fallan,
 * para probar que un estado no confirmable detiene el gasto. Solo pruebas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type StorageFaults = {
  /** Subidas cuyo path coincide fallan N veces (Infinity = siempre). */
  upload?: { match: RegExp; times: number }[];
  list?: RegExp[];
  download?: RegExp[];
};

export function memoryStorage(faults: StorageFaults = {}) {
  const files = new Map<string, Buffer>();
  const uploadLog: string[] = [];
  const uploadFaults = (faults.upload ?? []).map((f) => ({ ...f }));
  const bucket = {
    async list(dir: string, opts?: { search?: string }) {
      if (faults.list?.some((r) => r.test(dir))) return { data: null, error: { message: "listado simulado caído" } };
      const prefix = `${dir}/`;
      const names = [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length))
        .filter((n) => !opts?.search || n.includes(opts.search));
      return { data: names.map((name) => ({ name })), error: null };
    },
    async upload(path: string, body: Buffer) {
      const fault = uploadFaults.find((f) => f.match.test(path) && f.times > 0);
      if (fault) {
        fault.times -= 1;
        return { error: { message: "subida simulada caída" } };
      }
      files.set(path, Buffer.from(body));
      uploadLog.push(path);
      return { error: null };
    },
    async download(path: string) {
      if (faults.download?.some((r) => r.test(path))) return { data: null, error: { message: "lectura simulada caída", statusCode: "500" } };
      const b = files.get(path);
      if (!b) return { data: null, error: { message: "Object not found", statusCode: "404" } };
      return { data: new Blob([new Uint8Array(b)]), error: null };
    },
    async remove(paths: string[]) {
      for (const p of paths) files.delete(p);
      return { data: [], error: null };
    },
    async createSignedUrl(path: string) {
      return { data: { signedUrl: `memory://${path}` }, error: null };
    },
  };
  const client = {
    storage: { from: () => bucket },
    from: () => ({ insert: async () => ({ error: null }), upsert: async () => ({ error: null }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  } as unknown as SupabaseClient;
  const json = <T>(path: string): T | undefined => (files.has(path) ? (JSON.parse(files.get(path)!.toString()) as T) : undefined);
  return { client, files, uploadLog, json };
}
