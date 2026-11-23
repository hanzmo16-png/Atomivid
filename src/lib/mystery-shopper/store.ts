/**
 * Historial local de informes. No escribe en Supabase ni en el ledger de producción.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunReport } from "./types";

const ID = /^[a-zA-Z0-9:_-]{8,120}$/;

export function assertRunId(id: string): void {
  if (!ID.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("Id de ejecución rechazado.");
  }
}

export type ReportStore = {
  get(id: string): Promise<RunReport | null>;
  put(report: RunReport): Promise<void>;
  list(): Promise<RunReport[]>;
};

export function memoryStore(seed: RunReport[] = []): ReportStore {
  const map = new Map(seed.map((r) => [r.idempotencyKey, r]));
  return {
    async get(id) { assertRunId(id); return map.get(id) ?? null; },
    async put(report) { assertRunId(report.idempotencyKey); map.set(report.idempotencyKey, report); },
    async list() { return [...map.values()]; },
  };
}

export function fileStore(dir: string): ReportStore {
  const root = path.resolve(dir);
  const fileOf = (id: string) => {
    assertRunId(id);
    const safe = id.replace(/:/g, "_");
    const full = path.resolve(root, `${safe}.json`);
    if (!full.startsWith(root + path.sep)) throw new Error("Ruta fuera del historial.");
    return full;
  };
  return {
    async get(id) {
      try { return JSON.parse(await readFile(fileOf(id), "utf8")) as RunReport; } catch { return null; }
    },
    async put(report) {
      await mkdir(root, { recursive: true });
      await writeFile(fileOf(report.idempotencyKey), JSON.stringify(report, null, 2), { mode: 0o600 });
    },
    async list() {
      try {
        const names = await readdir(root);
        const rows = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => {
          try { return JSON.parse(await readFile(path.join(root, n), "utf8")) as RunReport; } catch { return null; }
        }));
        return rows.filter((r): r is RunReport => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      } catch { return []; }
    },
  };
}

export async function startIdempotent(store: ReportStore, key: string, factory: () => Promise<RunReport>): Promise<{ report: RunReport; reused: boolean }> {
  assertRunId(key);
  const existing = await store.get(key);
  if (existing) return { report: existing, reused: true };
  const report = await factory();
  if (report.idempotencyKey !== key) throw new Error("La ejecución no coincide con su id.");
  const again = await store.get(key);
  if (again) return { report: again, reused: true };
  await store.put(report);
  return { report, reused: false };
}
