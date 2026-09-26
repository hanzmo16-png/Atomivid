/**
 * Base de datos en memoria para pruebas de «Texto a voz» y «Mi voz» (sin
 * red): cubre las cadenas de consulta que usan estos módulos (select/
 * insert/update con eq/gte/is/order/limit, maybeSingle/single) y la
 * restricción única (user_id, client_request_id) de tts_jobs. Storage es
 * el de memoria ya existente. Solo pruebas.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryStorage, type StorageFaults } from "@/lib/video/audiovisual/test-storage";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const UNIQUE: Record<string, string[][]> = { tts_jobs: [["user_id", "client_request_id"]], user_voices: [["provider_voice_id"]] };

export function memoryDb(seed: Record<string, Row[]> = {}, faults: StorageFaults = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const storage = memoryStorage(faults);
  const log: { table: string; op: string; values?: Row }[] = [];
  const rows = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  function query(table: string) {
    const filters: Filter[] = [];
    let op: { kind: "select" } | { kind: "update"; values: Row } | { kind: "insert"; values: Row } | { kind: "delete" } = { kind: "select" };
    let returning = false;

    const exec = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      const all = rows(table);
      if (op.kind === "insert") {
        const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), segments_done: 0, attempts: 0, ...op.values };
        for (const cols of UNIQUE[table] ?? []) {
          if (cols.every((c) => row[c] != null) && all.some((r) => cols.every((c) => r[c] === row[c]))) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
        }
        all.push(row);
        log.push({ table, op: "insert", values: row });
        return { data: [row], error: null };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") {
        for (const r of matched) Object.assign(r, op.values);
        log.push({ table, op: "update", values: op.values });
      }
      if (op.kind === "delete") {
        tables.set(table, all.filter((r) => !matched.includes(r)));
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    };

    const chain = {
      select: () => {
        if (op.kind !== "select") returning = true;
        return chain;
      },
      insert: (values: Row) => ((op = { kind: "insert", values }), chain),
      update: (values: Row) => ((op = { kind: "update", values }), chain),
      delete: () => ((op = { kind: "delete" }), chain),
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), chain),
      neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), chain),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), chain),
      gte: (col: string, val: string) => (filters.push((r) => String(r[col]) >= val), chain),
      is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), chain),
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const r = exec();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = exec();
        if (r.error) return { data: null, error: r.error };
        return r.data?.length ? { data: r.data[0], error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try {
          const r = exec();
          resolve({ data: op.kind === "select" || returning ? r.data : null, error: r.error });
        } catch (e) {
          reject(e);
        }
      },
    };
    return chain;
  }

  const client = { from: (t: string) => query(t), storage: storage.client.storage } as unknown as SupabaseClient;
  return { client, tables, rows, storage, log };
}
