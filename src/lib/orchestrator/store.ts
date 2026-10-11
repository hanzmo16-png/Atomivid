/**
 * Orchestrator state: processed deliveries (idempotency), task chains (attempts), the budget ledger and the audit
 * log. Its own store, never Atomivid's production tables:
 *  - MemoryStore: tests;
 *  - JsonFileStore: local runs / dry runs (atomic write via rename);
 *  - SupabaseStore: durable store for paid runs, in its own schema `orchestrator` (migration prepared in
 *    supabase/pending/, NOT applied: applying it needs Hans's approval).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditLogEntry, AuditUsage, AuditVerdict, ChainInfo } from "./types";

/** Per delivery version: "audited" = verdict persisted, files may be incomplete (replayed); "done" = finished. */
export type ProcessedRecord = {
  at: string; outcome: string; stage?: "audited" | "done"; taskId?: string; rootId?: string; attempt?: number;
  verdict?: AuditVerdict; usage?: AuditUsage; notified?: boolean;
};

export type LedgerEntry = { id: string; at: string; state: "reserved" | "settled" | "released"; reservedUsd: number; actualUsd: number; taskId: string; model: string };

export type OrchestratorState = {
  version: 1;
  killed: boolean;
  processed: Record<string, ProcessedRecord>;
  chains: Record<string, ChainInfo>;
  ledger: LedgerEntry[];
  audit: AuditLogEntry[];
};

export const emptyState = (): OrchestratorState => ({ version: 1, killed: false, processed: {}, chains: {}, ledger: [], audit: [] });

export interface OrchestratorStore {
  readonly durable: boolean;
  /** Runs `fn` on the current state and persists the result (single writer per run; the workflow has concurrency 1). */
  update<T>(fn: (s: OrchestratorState) => T): Promise<T>;
  read(): Promise<OrchestratorState>;
}

export class MemoryStore implements OrchestratorStore {
  readonly durable = false;
  constructor(public state: OrchestratorState = emptyState()) {}
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: OrchestratorState) => T) { const s = structuredClone(this.state); const out = fn(s); this.state = s; return out; }
}

export class JsonFileStore implements OrchestratorStore {
  readonly durable = false;
  constructor(private file: string) {}
  async read(): Promise<OrchestratorState> {
    try { return { ...emptyState(), ...(JSON.parse(await readFile(this.file, "utf8")) as OrchestratorState) }; } catch { return emptyState(); }
  }
  async update<T>(fn: (s: OrchestratorState) => T) {
    const s = await this.read();
    const out = fn(s);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2));
    await rename(tmp, this.file);
    return out;
  }
}

/**
 * Durable store on Supabase (table orchestrator.state, one row). Optimistic concurrency on `revision`: a concurrent
 * writer makes the update fail instead of silently overwriting the ledger.
 */
export class SupabaseStore implements OrchestratorStore {
  readonly durable = true;
  constructor(private client: { schema: (s: string) => { from: (t: string) => any } }) {} // eslint-disable-line @typescript-eslint/no-explicit-any
  private table() { return this.client.schema("orchestrator").from("state"); }
  async read(): Promise<OrchestratorState> {
    const { data, error } = await this.table().select("doc,revision").eq("id", 1).maybeSingle();
    if (error) throw new Error("ORCH_STORE_UNAVAILABLE");
    return data ? { ...emptyState(), ...(data.doc as OrchestratorState) } : emptyState();
  }
  async update<T>(fn: (s: OrchestratorState) => T) {
    const { data, error } = await this.table().select("doc,revision").eq("id", 1).maybeSingle();
    if (error) throw new Error("ORCH_STORE_UNAVAILABLE");
    const s = data ? { ...emptyState(), ...(data.doc as OrchestratorState) } : emptyState();
    const out = fn(s);
    const revision = (data?.revision ?? 0) as number;
    const res = data
      ? await this.table().update({ doc: s, revision: revision + 1, updated_at: new Date().toISOString() }).eq("id", 1).eq("revision", revision).select("id")
      : await this.table().insert({ id: 1, doc: s, revision: 1 }).select("id");
    if (res.error || (res.data?.length ?? 0) !== 1) throw new Error("ORCH_STORE_CONFLICT");
    return out;
  }
}

/** Keeps the audit log bounded (the newest entries win). */
export function appendAudit(s: OrchestratorState, entry: Omit<AuditLogEntry, "at">, now = new Date()) {
  s.audit.push({ at: now.toISOString(), ...entry });
  if (s.audit.length > 2000) s.audit.splice(0, s.audit.length - 2000);
}
