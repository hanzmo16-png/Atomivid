/**
 * Adaptador LedgerStore sobre Postgres local (arnés, NO producción). Replica supabase-ledger-store.ts:
 * mismo mapeo toRow/fromRow (Number() sobre numeric devuelto como string), mismo 23505→false y mismo CAS por status.
 * Diferencias documentadas en docs/harness/PG_ADAPTER_DIFF.md (submit simula submitWithSupply sin RPC de suministro).
 */
import { createRequire } from "node:module";
import type { LedgerStore, PaidOperation, PaidOpStatus } from "@/lib/production-intelligence/ledger";
import { PaidLedgerUnavailableError } from "@/lib/paid-calls/errors";

const req = createRequire(import.meta.url);
type PgClient = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>; end(): Promise<void>; connect(): Promise<void> };

export async function pgClient(url: string): Promise<PgClient> {
  const pg = req(process.env.HARNESS_PG_MODULE ?? "pg") as { Client: new (o: { connectionString: string }) => PgClient };
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

const COLS = "idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,provider_job_id,result_ref,updated_at";
function fromRow(r: Record<string, unknown>): PaidOperation {
  return {
    idempotencyKey: String(r.idempotency_key), projectId: String(r.project_id), shotId: String(r.shot_id), provider: String(r.provider),
    model: String(r.model), method: String(r.method), attemptKind: String(r.attempt_kind), reservedUsd: Number(r.reserved_usd),
    committedUsd: r.committed_usd === null ? null : Number(r.committed_usd), status: r.status as PaidOpStatus,
    providerJobId: (r.provider_job_id as string | null) ?? null, resultRef: (r.result_ref as string | null) ?? null,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export function pgLedgerStore(db: PgClient, opts: { withSubmit?: boolean } = {}): LedgerStore & { submits: number } {
  const store: LedgerStore & { submits: number } = {
    submits: 0,
    async get(key) {
      try { const { rows } = await db.query(`select ${COLS} from public.pi_paid_operations where idempotency_key=$1`, [key]); return rows[0] ? fromRow(rows[0]) : null; }
      catch (e) { throw new PaidLedgerUnavailableError(`read failed: ${(e as Error).message}`); }
    },
    async insert(op) {
      try {
        await db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,provider_job_id,result_ref,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [op.idempotencyKey, op.projectId, op.shotId, op.provider, op.model, op.method, op.attemptKind, op.reservedUsd, op.committedUsd, op.status, op.providerJobId, op.resultRef, op.updatedAt]);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") return false;
        throw new PaidLedgerUnavailableError(`insert failed (${(e as { code?: string }).code ?? "?"}): ${(e as Error).message}`);
      }
    },
    async update(key, expected, patch) {
      const sets: string[] = []; const vals: unknown[] = [];
      const map: [keyof PaidOperation, string][] = [["status", "status"], ["committedUsd", "committed_usd"], ["providerJobId", "provider_job_id"], ["resultRef", "result_ref"], ["updatedAt", "updated_at"]];
      for (const [k, col] of map) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`); }
      vals.push(key, expected);
      try { const r = await db.query(`update public.pi_paid_operations set ${sets.join(",")} where idempotency_key=$${vals.length - 1} and status=$${vals.length} returning idempotency_key`, vals); return r.rowCount === 1; }
      catch (e) { throw new PaidLedgerUnavailableError(`update failed (${(e as { code?: string }).code ?? "?"}): ${(e as Error).message}`); }
    },
  };
  if (opts.withSubmit !== false) store.submit = async (op, at) => { store.submits++; return store.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at }); };
  return store;
}
