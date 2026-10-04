/** GitHub Actions entrypoint for page-initiated VFX execution (stage `vfx-director-execute`).
 * Input is only the dispatch key written ledger-first by the owner-authenticated API. Executors come
 * from execution-profiles.ts at this exact commit; nothing else is read from the request.
 *   VFX_DISPATCH_KEY=vfx_exec:<job>:r<rev>:n<seq>   → claim once, run one task, record outcome
 *   VFX_INSPECT_JOB=<job>                            → read-only diagnostics (no writes)
 */
import { ownedJob } from "../../src/lib/production-intelligence/vfx-director/jobs";
import { createServiceClient } from "../../src/lib/supabase/service";
import { supabaseResultStore } from "../../src/lib/paid-calls/result-store";
import { supabaseJobStore, supabaseDispatchLedger } from "../../src/lib/production-intelligence/vfx-director/store";
import { executionProfile, profileExecutors } from "../../src/lib/production-intelligence/vfx-director/execution-profiles";
import { runDispatch, inspectJob } from "../../src/lib/production-intelligence/vfx-director/execution-runner";
import { DISPATCH_METHOD } from "../../src/lib/production-intelligence/vfx-director/execution";

async function main() {
  if (process.env.VFX_DIRECTOR_ENABLED !== "1") throw new Error("VFX_DISABLED");
  const sb = createServiceClient(), jobs = supabaseJobStore(sb), ledger = supabaseDispatchLedger(sb), results = supabaseResultStore(sb);
  const inspect = process.env.VFX_INSPECT_JOB?.trim();
  if (inspect) {
    const row = await sb.from("vfx_director_jobs").select("owner_id").eq("id", inspect).maybeSingle();
    if (row.error || !row.data) throw new Error("VFX_JOB_NOT_FOUND");
    const report = await inspectJob({ jobs, profile: executionProfile }, inspect, row.data.owner_id);
    const dispatches = (await ledger.list(inspect)).filter(o => o.method === DISPATCH_METHOD).map(o => ({ key: o.idempotencyKey, status: o.status, runId: o.providerJobId, updatedAt: o.updatedAt }));
    console.log(JSON.stringify({ ...report, dispatches }, null, 2));
    return;
  }
  const key = process.env.VFX_DISPATCH_KEY?.trim() ?? "";
  const commit = process.env.GITHUB_SHA ?? "", ref = process.env.GITHUB_REF_NAME ?? "", runId = process.env.GITHUB_RUN_ID ?? "";
  if (!/^[a-f0-9]{40}$/.test(commit) || !ref || !/^\d+$/.test(runId)) throw new Error("VFX_RUNNER_IDENTITY_MISSING");
  const outcome = await runDispatch({ ledger, jobs, now: () => new Date(),
    owner: async id => { const r = await sb.auth.admin.getUserById(id); return r.error || !r.data.user ? null : r.data.user; },
    profile: executionProfile,
    build: (profile, currentJob) => profileExecutors(profile, { results, currentJob, sourceJob: async id => ownedJob(jobs, id, (await currentJob()).ownerId) }),
  }, key, { commit, ref, runId });
  console.log(JSON.stringify({ dispatch: key, outcome }));
  if (outcome.kind === "blocked_before_task" || outcome.kind === "task_failed" || outcome.kind === "reconciliation_failed") process.exitCode = 2;
}
main().catch(e => {
  console.error(e instanceof Error && /^[A-Z0-9_:]{3,120}$/.test(e.message) ? e.message : "VFX_EXECUTION_RUNNER_BLOCKED");
  process.exitCode = 1;
});
