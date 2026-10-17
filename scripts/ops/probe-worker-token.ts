/**
 * Owner-run, read-only check of the render worker's GitHub credential as the RUNNING deployment sees it.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=<from your own environment> npx tsx scripts/ops/probe-worker-token.ts https://<deployment-host>
 *
 * It signs one POST to /api/internal/provider-config (the existing HMAC-protected ops probe) and prints ONLY the
 * `githubWorker` section plus the deployment's environment and commit: presence states, the HTTP status of a single
 * `GET /repos/{GH_WORKER_REPO}` made by the deployment with GH_WORKER_TOKEN, GitHub's token-expiration header and the
 * repository permissions GitHub reports for that token. It never prints a key, a token or the repository name, and
 * it never creates a repository_dispatch: no render is started and nothing is spent.
 *
 * Reading the verdict:
 *   GO_READ        the token authenticates and can read the repository. Dispatch needs Contents: write; GitHub reports
 *                  that as permissions.push=true. Only a real POST /dispatches (which starts a render) proves it fully.
 *   NO_GO_401      GitHub refused the credential itself: expired, revoked or the configured value is not the token.
 *   NO_GO_403      recognised but not allowed on this repository (permissions / policy).
 *   NO_GO_404      the repository is not reachable with this token or GH_WORKER_REPO is wrong.
 *   NOT_CONFIGURED token or repository missing/blank/malformed in this deployment.
 *   UNKNOWN        transport error or an unexpected status.
 */
import { randomUUID } from "node:crypto";
import { PROVIDER_CONFIG_PATH, providerConfigSignature } from "../../src/lib/ops/provider-config";

async function main() {
  const base = process.argv[2];
  if (!base || !/^https:\/\/[^/\s]+$/.test(base)) {
    console.error("Uso: SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/ops/probe-worker-token.ts https://<host>   (sin ruta ni barra final)");
    process.exit(2);
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key || key.length < 32) {
    console.error("Falta SUPABASE_SERVICE_ROLE_KEY en el entorno (nunca en la línea de comandos).");
    process.exit(2);
  }
  const nonce = randomUUID(), timestamp = String(Date.now());
  const res = await fetch(`${base}${PROVIDER_CONFIG_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "x-probe-nonce": nonce, "x-probe-time": timestamp, "x-probe-signature": providerConfigSignature(key, nonce, timestamp) } });
  if (!res.ok) {
    console.log(JSON.stringify({ probe: "provider-config", http: res.status, note: res.status === 401 ? "firma rechazada: la clave del entorno no es la del despliegue" : "ruta no disponible en este despliegue (¿commit anterior?)" }));
    process.exit(1);
  }
  const report = (await res.json()) as { vercelEnv?: unknown; commit?: unknown; keys?: Record<string, unknown>; githubWorker?: unknown };
  const keys = report.keys ?? {};
  console.log(JSON.stringify({ deployment: { vercelEnv: report.vercelEnv ?? null, commit: report.commit ?? null },
    presence: { GH_WORKER_TOKEN: keys.GH_WORKER_TOKEN ?? null, GH_WORKER_REPO: keys.GH_WORKER_REPO ?? null },
    githubWorker: report.githubWorker ?? "no incluido (despliegue anterior a la sonda)" }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
