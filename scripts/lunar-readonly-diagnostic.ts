/** One-off incident reader. GET only; no provider credentials, raw output, or production writes. */
import { diagnoseVisualPlanBlock, TARGET, type ReadPort } from "./diagnose-visual-plan-block";
import type { VisualPlanAnalysis } from "../src/lib/video/long-form/visual-plan-analysis";

const ORIGIN = "https://msyxczcdjhbednmfzxqq.supabase.co";
const LIMIT = 2 * 1024 * 1024;

export async function boundedRead(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw Error("read_failed");
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body.cancel();
    throw Error("read_too_large");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("read_too_large");
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

export function readPort(url: string, key: string, get: typeof fetch = fetch): ReadPort {
  if (url !== ORIGIN || !key) throw Error("environment_mismatch");
  async function bytes(path: string, limit: number) {
    return boundedRead(await get(ORIGIN + path, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }), limit);
  }
  async function row(table: string, field: string, id: string, columns: string) {
    const query = new URLSearchParams({ select: columns, [field]: `eq.${id}`, limit: "2" });
    const data = JSON.parse(Buffer.from(await bytes(`/rest/v1/${table}?${query}`, LIMIT)).toString("utf8"));
    if (!Array.isArray(data) || data.length !== 1) throw Error("row_mismatch");
    return data[0];
  }
  let allowedRef: string | null = null;
  let gotJob = false;
  return {
    async job(id) {
      if (id !== TARGET.jobId || gotJob) throw Error("job_mismatch");
      const job = await row("documentary_script_jobs", "id", id, "id,user_id,status,error_code,input,editorial_checkpoint");
      if (job.id !== TARGET.jobId || job.status !== "failed" || job.error_code !== "d9d6cb8f") throw Error("job_changed");
      gotJob = true;
      return job;
    },
    async ledgerRow(id) {
      if (!gotJob || id !== TARGET.operation || allowedRef) throw Error("operation_mismatch");
      const ledger = await row("pi_paid_operations", "idempotency_key", id, "idempotency_key,project_id,provider,method,status,result_ref,committed_usd,created_at");
      if (ledger.idempotency_key !== TARGET.operation || typeof ledger.project_id !== "string" || !/^documentary:[0-9a-f-]{36}:65ed8bc495f890b9$/.test(ledger.project_id)) throw Error("scope_mismatch");
      allowedRef = `${ledger.project_id}/paid/${TARGET.operation}.script.json`;
      return ledger;
    },
    async download(ref) {
      if (!allowedRef || ref !== allowedRef) throw Error("object_mismatch");
      allowedRef = null;
      const data = await bytes(`/storage/v1/object/videos/${ref.split("/").map(encodeURIComponent).join("/")}`, TARGET.expectedBytes);
      if (data.length !== TARGET.expectedBytes) throw Error("object_changed");
      return data;
    },
  };
}

/** Only fixed labels, schema-owned paths/types and bounded counts reach public logs. */
export function publicAnalysis(a: VisualPlanAnalysis) {
  return {
    schema: a.schema, editorialApproval: "not_evaluated", issues: a.issues, shapes: a.shapes,
    scenes: a.scenes, invalidScenes: a.invalidScenes, invalidSceneCount: a.invalidSceneCount,
    anchors: a.anchors.map(({ scene, valid, excerptId, anchor }) => ({ scene, valid, excerptId, anchor })),
    omittedScenes: a.omittedScenes, unresolvedExcerptIds: a.unresolvedExcerptIds,
    duplicateAnchorCount: a.duplicateExcerptIds.length, pipelineAnchoring: a.pipelineAnchoring,
    catalogExcerpts: a.catalogExcerpts, coveredExcerpts: a.coveredExcerpts,
    uncoveredExcerptCount: a.uncoveredExcerptIds.length,
  };
}

async function main() {
  const result = await diagnoseVisualPlanBlock(readPort(process.env.SUPABASE_URL?.trim() ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""), process.env);
  if (!result.readable || !result.product || !result.cinematic) throw Error("unreadable");
  console.log("LUNAR_DIAGNOSTIC " + JSON.stringify({
    block: 5, scopeVerified: true, expectedSizeMatched: result.object.sizeMatchesExpected,
    product: publicAnalysis(result.product), cinematic: publicAnalysis(result.cinematic),
    newProviderCalls: 0, productionWrites: 0,
  }));
}

if (process.argv[1]?.endsWith("lunar-readonly-diagnostic.ts")) main().catch(() => {
  console.error("LUNAR_DIAGNOSTIC_STOPPED");
  process.exitCode = 1;
});
