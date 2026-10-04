/** GitHub transport for page-initiated VFX execution (server only). Token never leaves the server. */
import { EXECUTION_STAGE_INPUT, EXECUTION_WORKFLOW, type DispatchResult, type ExecutionConfig } from "./execution";

type Enabled = Extract<ExecutionConfig, { enabled: true }>;
const API = "https://api.github.com";
const headers = (c: Enabled) => ({ Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

/** 2xx accepted; 4xx refused (nothing queued); 5xx/network/timeout unknown (may have queued). */
export async function dispatchExecution(config: Enabled, key: string, fetcher: typeof fetch = fetch): Promise<DispatchResult> {
  let response: Response;
  try {
    response = await fetcher(`${API}/repos/${config.repo}/actions/workflows/${EXECUTION_WORKFLOW}/dispatches`, {
      method: "POST", headers: headers(config), signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ ref: config.ref, inputs: { stage: EXECUTION_STAGE_INPUT, v2_args: key } }),
    });
  } catch { return "uncertain"; }
  if (response.ok) return "accepted";
  return response.status >= 400 && response.status < 500 ? "rejected" : "uncertain";
}

/** Runs of this workflow whose title carries the dispatch key (run-name in the workflow). */
export async function executionRuns(config: Enabled, key: string, since: string, fetcher: typeof fetch = fetch) {
  const created = encodeURIComponent(`>=${new Date(Date.parse(since) - 60_000).toISOString()}`);
  const response = await fetcher(`${API}/repos/${config.repo}/actions/workflows/${EXECUTION_WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(config.ref)}&created=${created}&per_page=100`,
    { headers: headers(config), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("VFX_RUN_LOOKUP_FAILED");
  const body = await response.json() as { workflow_runs?: { id: number; status: string; conclusion: string | null; display_title?: string; name?: string }[] };
  return (body.workflow_runs ?? []).filter(r => (r.display_title ?? r.name ?? "").includes(key))
    .map(r => ({ id: String(r.id), status: r.status, conclusion: r.conclusion }));
}
