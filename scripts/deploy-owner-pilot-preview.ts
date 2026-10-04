/** Deploy the exact trusted branch commit to the existing project's preview environment only.
 * Owner form QA: use the existing server deployment job when credential protection blocks browser controls.
 */
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { executePaidOperation } from "../src/lib/production-intelligence/ledger";
async function main() {
  const token = process.env.VERCEL_TOKEN, project = process.env.VERCEL_PROJECT_ID, team = process.env.VERCEL_TEAM_ID;
  const sha = process.env.GITHUB_SHA, branch = process.env.GITHUB_REF_NAME;
  if (!token || !project || !team || !sha || !/^[a-f0-9]{40}$/.test(sha) || branch !== "codex/vfx-sequence-compositor") throw new Error("PREVIEW_DEPLOY_CONFIGURATION_BLOCKED");
  const ledger = supabaseLedgerStore(createServiceClient());
  async function api(path: string, init?: RequestInit) {
    const response = await fetch(`https://api.vercel.com${path}?teamId=${encodeURIComponent(team!)}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`PREVIEW_DEPLOY_HTTP_${response.status}`);
    return response.json();
  }
  const config = await api(`/v9/projects/${project}`);
  if (config.id !== project || config.name !== "atomivid" || config.link?.type !== "github"
    || config.link.org !== "hanzmo16-png" || config.link.repo !== "Atomivid" || !config.link.repoId) throw new Error("PREVIEW_PROJECT_IDENTITY_BLOCKED");
  // Names and targets only (never values): page-initiated VFX execution needs these on preview.
  const envs = await api(`/v9/projects/${project}/env`) as { envs?: { key: string; target?: string[] | string }[] };
  const onPreview = (key: string) => (envs.envs ?? []).some(e => e.key === key && (Array.isArray(e.target) ? e.target : [e.target]).includes("preview"));
  console.log(JSON.stringify({ previewEnvPresent: Object.fromEntries(["GH_WORKER_TOKEN", "GH_WORKER_REPO", "GH_WORKER_REF", "VFX_EXECUTION_ENABLED", "VFX_DIRECTOR_ENABLED", "AVATAR_PREPARATION_OWNER_EMAIL", "VFX_DIRECTOR_OWNER_EMAIL"].map(k => [k, onPreview(k)])) }));
  const operationKey = "owner_pilot_preview_deploy:" + sha;
  // An independently submitted UI deployment needs explicit reconciliation.
  // An old reservation without a receipt must never cause another deployment.
  const existing = await ledger.get(operationKey);
  if (existing?.status === "RESERVED") throw new Error("PREVIEW_DEPLOY_RECONCILIATION_REQUIRED");
  const op = await executePaidOperation(ledger, { idempotencyKey: operationKey,
    projectId: "application-pilot-preview", shotId: "preview", provider: "internal", model: sha, method: "deploy_preview", attemptKind: "preview", reservedUsd: 0 }, {
    async submit() {
      const deployment = await api("/v13/deployments", { method: "POST", body: JSON.stringify({ name: config.name, project,
        gitSource: { type: "github", repoId: String(config.link.repoId), ref: branch, sha },
        meta: { ownerPilotPreview: "true", requestedCommit: sha } }) });
      if (!deployment.id || deployment.target === "production") throw new Error("PREVIEW_DEPLOY_IDENTITY_BLOCKED");
      return { providerJobId: deployment.id, submissionReceiptRef: JSON.stringify({ id: deployment.id, url: deployment.url, sha, target: deployment.target }) };
    },
    async poll(id) {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const deployment = await api(`/v13/deployments/${id}`);
        if (deployment.target === "production") throw new Error("PREVIEW_TARGET_BLOCKED");
        if (deployment.readyState === "READY") return { actualUsd: 0,
          resultRef: JSON.stringify({ id, url: deployment.url, sha, readyState: deployment.readyState, target: deployment.target }) };
        if (["ERROR", "CANCELED", "BLOCKED"].includes(deployment.readyState)) throw new Error("PREVIEW_BUILD_FAILED");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      // The recorded deployment id remains resumable; never submit another job.
      throw new Error("PREVIEW_BUILD_PENDING");
    },
  }, () => new Date().toISOString());
  console.log(JSON.stringify({ previewQueued: true, deploymentId: op.providerJobId }));
}
main().catch(() => { console.error("PREVIEW_DEPLOY_BLOCKED_PRIVATE_STATE_RETAINED"); process.exitCode = 1; });
