/** Deploy the exact trusted branch commit to the existing project's preview environment only. */
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
  const op = await executePaidOperation(ledger, { idempotencyKey: "owner_pilot_preview_deploy:" + sha,
    projectId: "application-pilot-preview", shotId: "preview", provider: "internal", model: sha, method: "deploy_preview", attemptKind: "preview", reservedUsd: 0 }, {
    async submit() {
      const deployment = await api("/v13/deployments", { method: "POST", body: JSON.stringify({ name: config.name, project,
        gitSource: { type: "github", repoId: String(config.link.repoId), ref: branch, sha },
        meta: { ownerPilotPreview: "true", requestedCommit: sha } }) });
      if (!deployment.id || deployment.target === "production") throw new Error("PREVIEW_DEPLOY_IDENTITY_BLOCKED");
      return { providerJobId: deployment.id, submissionReceiptRef: JSON.stringify({ id: deployment.id, url: deployment.url, sha, target: deployment.target }) };
    },
    async poll(id) {
      const deployment = await api(`/v13/deployments/${id}`);
      if (deployment.target === "production") throw new Error("PREVIEW_TARGET_BLOCKED");
      return { actualUsd: 0, resultRef: JSON.stringify({ id, url: deployment.url, sha, readyState: deployment.readyState, target: deployment.target }) };
    },
  }, () => new Date().toISOString());
  console.log(JSON.stringify({ previewQueued: true, deploymentId: op.providerJobId }));
}
main().catch(() => { console.error("PREVIEW_DEPLOY_BLOCKED_PRIVATE_STATE_RETAINED"); process.exitCode = 1; });
