import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { paidResultPath } from "../src/lib/paid-calls/result-store";
import { EDITORIAL_VERSION } from "../src/lib/video/long-form/editorial";
import { RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { narrationCatalog } from "../src/lib/video/long-form/narration-catalog";
import { diagnoseVisualPlanBlock, supabaseReadPort, DiagnosticStop, TARGET, type ReadPort, type JobRow, type LedgerRow } from "./diagnose-visual-plan-block";

// Synthetic fixtures only (no real job, owner, narration or object). SECRET must never reach the report.
const owner = "00000000-0000-4000-8000-000000000001";
const fields = { topic: "SECRET synthetic topic", durationMinutes: "5", sources: "", openQuestions: "", language: "es" as const };
const input = { fields, creativeHistory: [], recoverLegacyOperator: false, referenceContract: "catalog-v1" as const };
const beats = Array.from({ length: 7 }, (_, i) => ({ narration: `SECRET beat ${i} one two three four five six seven eight nine ten eleven twelve thirteen.` }));
const projectId = documentarySupplyScope(owner, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: [], referenceContract: "catalog-v1" }, false).projectId;
const ref = paidResultPath(projectId, TARGET.operation, "script.json");
const ids = narrationCatalog(beats).filter(e => e.beatIndex === TARGET.beatIndex).map(e => e.id);
const plan = { visuals: [{ description: "SECRET", motion: true, subject: "s", excerptId: ids[0] }, { excerptId: ids[1], motion: null, SECRET_KEY: "SECRET" }] };
const objectBytes = new TextEncoder().encode(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(plan) }], usage: { output_tokens: 321 } }));

function fixture(over: { job?: Partial<JobRow> | null; row?: Partial<LedgerRow> | null } = {}) {
  const calls: string[] = [];
  const job: JobRow | null = over.job === null ? null : { id: TARGET.jobId, user_id: owner, input, editorial_checkpoint: { version: 1, status: "unapproved", script: { beats } }, ...over.job };
  const row: LedgerRow | null = over.row === null ? null : { idempotency_key: TARGET.operation, project_id: projectId, provider: "anthropic", method: "generate_script", status: "COMMITTED", result_ref: ref, committed_usd: 0.0253, created_at: "2026-10-14T14:07:27.768Z", ...over.row };
  const port: ReadPort = {
    async job(id) { calls.push(`job:${id}`); return job; },
    async ledgerRow(key) { calls.push(`ledger:${key}`); return row; },
    async download(path) { calls.push(`download:${path}`); return objectBytes; },
  };
  return { calls, port };
}
const stop = (code: string) => (e: unknown) => e instanceof DiagnosticStop && e.code === code;
const noSecret = (x: unknown) => assert(!JSON.stringify(x).includes("SECRET") && !JSON.stringify(x).includes(owner), "report must not carry content or owner ids");

test("exact job, owner, scope, ledger row and reference: one download, sanitized report, input bytes untouched", async () => {
  const { calls, port } = fixture();
  const before = createHash("sha256").update(objectBytes).digest("hex");
  const report = await diagnoseVisualPlanBlock(port, {});
  assert.deepEqual(calls, [`job:${TARGET.jobId}`, `ledger:${TARGET.operation}`, `download:${ref}`]);
  assert.equal(createHash("sha256").update(objectBytes).digest("hex"), before);
  assert(report.readable && "product" in report);
  assert.equal(report.object.bytes, objectBytes.length);
  assert.equal(report.object.sha256, before);
  assert.equal(report.checkpointContext, "matches_response");
  assert.equal(report.product!.schema, "invalid");
  assert.deepEqual(report.product!.invalidScenes, [1]);
  assert.equal(report.target.block, 5);
  assert.deepEqual([report.newProviderCalls, report.writes], [0, 0]);
  noSecret(report);
});

test("stops BEFORE downloading when anything does not match exactly", async () => {
  const cases: Array<[Parameters<typeof fixture>[0], string]> = [
    [{ job: null }, "job_unavailable"],
    [{ job: { id: "other" } }, "job_unavailable"],
    [{ job: { input: { ...input, referenceContract: "v9" } } }, "job_input_unsupported"],
    [{ job: { input: { ...input, fields: { ...fields, topic: "x" } } } }, "job_input_unsupported"],
    [{ row: null }, "ledger_row_unavailable"],
    [{ row: { project_id: "documentary:someone-else:abc" } }, "ledger_owner_mismatch"],
    [{ row: { project_id: `documentary:${owner}:0000000000000000` } }, "ledger_scope_mismatch"],
    [{ row: { status: "SUBMITTED" } }, "ledger_row_not_committed_script"],
    [{ row: { provider: "openai" } }, "ledger_row_not_committed_script"],
    [{ row: { result_ref: `${projectId}/paid/op_other.script.json` } }, "ledger_reference_mismatch"],
    [{ job: { editorial_checkpoint: null } }, "checkpoint_narration_invalid"],
    [{ job: { editorial_checkpoint: { script: { beats: beats.slice(0, 4) } } } }, "checkpoint_beat_missing"],
  ];
  for (const [over, code] of cases) {
    const { calls, port } = fixture(over);
    await assert.rejects(diagnoseVisualPlanBlock(port, {}), stop(code), code);
    assert(!calls.some(c => c.startsWith("download:")), `${code}: no object read`);
  }
});

test("refuses to start with a provider key in the environment (no read at all)", async () => {
  const { calls, port } = fixture();
  await assert.rejects(diagnoseVisualPlanBlock(port, { ANTHROPIC_API_KEY: "x" }), stop("provider_key_present"));
  assert.deepEqual(calls, []);
});

// The fake client exposes only select/eq/maybeSingle and storage download: any other call would throw a TypeError.
test("Supabase read port only selects, filters by exact id and downloads one object from videos", async () => {
  const used: string[] = [];
  const db = {
    from(table: string) {
      return { select(cols: string) {
        return { eq(col: string, value: string) {
          used.push(`${table}.select(${cols}).eq(${col})`);
          return { maybeSingle: async () => ({ data: table === "documentary_script_jobs" ? { id: value } : { idempotency_key: value }, error: null }) };
        } };
      } };
    },
    storage: { from(bucket: string) { return { async download(path: string) { used.push(`storage.${bucket}.download(${path === ref})`); return { data: new Blob([objectBytes]), error: null }; } }; } },
  };
  const port = supabaseReadPort(db);
  await port.job(TARGET.jobId); await port.ledgerRow(TARGET.operation);
  assert.equal((await port.download(ref))!.length, objectBytes.length);
  assert.deepEqual(used, [
    "documentary_script_jobs.select(id,user_id,input,editorial_checkpoint).eq(id)",
    "pi_paid_operations.select(idempotency_key,project_id,provider,method,status,result_ref,committed_usd,created_at).eq(idempotency_key)",
    "storage.videos.download(true)",
  ]);
});
