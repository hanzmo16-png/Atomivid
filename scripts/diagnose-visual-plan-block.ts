/**
 * PREPARED, NOT RUN (chatgpt-11 C2). Read-only diagnosis of ONE saved visual-plan response:
 * job d07e0b1f-958a-4aaf-8ac8-21d683ef5837, ledger operation op_4fed2a0bd8c9992ca50ed56a84277ddd, block 5 (beat index 4).
 *
 * Before reading the object it checks, in order: no provider key in the environment; the exact job row;
 * the owner-scoped documentary project recomputed exactly as the worker does; the exact ledger row
 * (provider, method, COMMITTED, project, result reference). It then downloads that single object, keeps
 * its bytes in memory only, and prints a sanitized report: size/sha256, allow-listed shapes, issues and
 * anchor counts, plus whether the checkpoint narration is the one the response was planned against.
 * It never prints narration, scene text, unknown keys, owner ids, project ids or raw JSON; never calls a
 * provider; never writes rows or Storage; never reads other jobs, objects or the Bigfoot project.
 *
 * Running it needs an authorized read-only environment (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), which this
 * delivery does not grant or use.
 */
import { createHash } from "node:crypto";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { paidResultPath } from "../src/lib/paid-calls/result-store";
import { ScriptJobFieldsSchema } from "../src/lib/video/long-form/script-job-types";
import { EDITORIAL_VERSION } from "../src/lib/video/long-form/editorial";
import { RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { analyzeVisualPlan, validBeats, AnalyzerInputError } from "../src/lib/video/long-form/visual-plan-analysis";

export const TARGET = {
  jobId: "d07e0b1f-958a-4aaf-8ac8-21d683ef5837",
  operation: "op_4fed2a0bd8c9992ca50ed56a84277ddd",
  beatIndex: 4,
  expectedBytes: 4269,
} as const;

export type JobRow = { id: string; user_id: string; input: unknown; editorial_checkpoint: unknown };
export type LedgerRow = { idempotency_key: string; project_id: string; provider: string; method: string; status: string; result_ref: string | null; committed_usd: number | null; created_at: string };
/** The only three reads this diagnostic may perform. */
export type ReadPort = {
  job(id: string): Promise<JobRow | null>;
  ledgerRow(idempotencyKey: string): Promise<LedgerRow | null>;
  download(ref: string): Promise<Uint8Array | null>;
};

export class DiagnosticStop extends Error {
  constructor(readonly code: string) { super(`diagnostic stopped: ${code}`); this.name = "DiagnosticStop"; }
}

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RUNWAY_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"];

export async function diagnoseVisualPlanBlock(port: ReadPort, env: Record<string, string | undefined>) {
  if (PROVIDER_KEYS.some(k => env[k])) throw new DiagnosticStop("provider_key_present");

  const job = await port.job(TARGET.jobId);
  if (!job || job.id !== TARGET.jobId || typeof job.user_id !== "string" || !job.user_id) throw new DiagnosticStop("job_unavailable");
  const input = job.input as { fields?: unknown; creativeHistory?: unknown; referenceContract?: unknown } | null;
  if (!input || (input.referenceContract !== undefined && input.referenceContract !== "catalog-v1")) throw new DiagnosticStop("job_input_unsupported");
  const fields = ScriptJobFieldsSchema.safeParse(input.fields);
  if (!fields.success) throw new DiagnosticStop("job_input_unsupported");
  // Exactly the worker's scope input (script-jobs.ts runScriptJobStep).
  const { projectId } = documentarySupplyScope(job.user_id, { ...fields.data, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION,
    creativeHistory: input.creativeHistory, ...(input.referenceContract ? { referenceContract: input.referenceContract } : {}) }, false);

  const row = await port.ledgerRow(TARGET.operation);
  if (!row || row.idempotency_key !== TARGET.operation) throw new DiagnosticStop("ledger_row_unavailable");
  if (!row.project_id.startsWith(`documentary:${job.user_id}:`)) throw new DiagnosticStop("ledger_owner_mismatch");
  if (row.project_id !== projectId) throw new DiagnosticStop("ledger_scope_mismatch");
  if (row.provider !== "anthropic" || row.method !== "generate_script" || row.status !== "COMMITTED") throw new DiagnosticStop("ledger_row_not_committed_script");
  const ref = paidResultPath(projectId, TARGET.operation, "script.json");
  if (row.result_ref !== ref) throw new DiagnosticStop("ledger_reference_mismatch");

  const checkpoint = job.editorial_checkpoint as { script?: { beats?: unknown } } | null;
  let beats;
  try { beats = validBeats(checkpoint?.script?.beats); } catch { throw new DiagnosticStop("checkpoint_narration_invalid"); }
  if (beats.length <= TARGET.beatIndex) throw new DiagnosticStop("checkpoint_beat_missing");

  const bytes = await port.download(ref);
  if (!bytes) throw new DiagnosticStop("object_unavailable");
  const object = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sizeMatchesExpected: bytes.length === TARGET.expectedBytes };
  let stored: unknown;
  try { stored = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return { target: targetLabel(), checks: CHECKS, object, readable: false }; }
  const message = stored as { stop_reason?: unknown; content?: unknown; usage?: { output_tokens?: unknown } };
  const opts = { referenceContract: input.referenceContract === "catalog-v1" };
  try {
    const product = analyzeVisualPlan(stored, beats, TARGET.beatIndex, { ...opts, cinematic: false });
    const cinematic = analyzeVisualPlan(stored, beats, TARGET.beatIndex, { ...opts, cinematic: true });
    const resolved = product.anchors.filter(a => a.excerptId === "resolved").length;
    return {
      target: targetLabel(), checks: CHECKS, object, readable: true,
      response: { stopReason: typeof message.stop_reason === "string" && /^[a-z_]{1,20}$/.test(message.stop_reason) ? message.stop_reason : "other",
        contentBlocks: Array.isArray(message.content) ? message.content.length : 0,
        outputTokens: typeof message.usage?.output_tokens === "number" ? message.usage.output_tokens : null },
      ledger: { status: row.status, committedUsd: row.committed_usd, createdAt: row.created_at },
      // The response's excerptIds carry the narration revision and beat they were planned against.
      checkpointContext: resolved > 0 && product.unresolvedExcerptIds.otherRevision === 0 && product.unresolvedExcerptIds.otherBeat === 0
        ? "matches_response" : resolved > 0 ? "partially_matches_response" : "unconfirmed",
      // Which planning contract produced it is not stored on the row; both readings are reported.
      product, cinematic,
      newProviderCalls: 0, writes: 0,
    };
  } catch (error) {
    if (error instanceof AnalyzerInputError) throw new DiagnosticStop(error.code);
    throw error;
  }
}

const CHECKS = { job: "exact", owner: "matched", scope: "recomputed_exact", ledger: "committed_script_exact", reference: "exact" } as const;
const targetLabel = () => ({ job: TARGET.jobId, operation: TARGET.operation, block: TARGET.beatIndex + 1 });

type ReadOnlyClient = {
  from(table: string): { select(columns: string): { eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> } } };
  storage: { from(bucket: string): { download(path: string): PromiseLike<{ data: Blob | null; error: unknown }> } };
};
/** Read port over a Supabase client: select/eq/maybeSingle and one Storage download; nothing else is reachable. */
export function supabaseReadPort(db: ReadOnlyClient): ReadPort {
  return {
    async job(id) {
      const { data, error } = await db.from("documentary_script_jobs").select("id,user_id,input,editorial_checkpoint").eq("id", id).maybeSingle();
      return error ? null : data as JobRow | null;
    },
    async ledgerRow(key) {
      const { data, error } = await db.from("pi_paid_operations").select("idempotency_key,project_id,provider,method,status,result_ref,committed_usd,created_at").eq("idempotency_key", key).maybeSingle();
      return error ? null : data as LedgerRow | null;
    },
    async download(ref) {
      const { data, error } = await db.storage.from("videos").download(ref);
      return error || !data ? null : new Uint8Array(await data.arrayBuffer());
    },
  };
}

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new DiagnosticStop("read_environment_missing");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log(JSON.stringify(await diagnoseVisualPlanBlock(supabaseReadPort(db as unknown as ReadOnlyClient), process.env), null, 2));
}

if (process.argv[1]?.endsWith("diagnose-visual-plan-block.ts")) {
  main().catch(error => {
    console.error(JSON.stringify(error instanceof DiagnosticStop ? { stop: error.code } : { error: "internal" }));
    process.exitCode = 1;
  });
}
