/**
 * Owner-run, read-only check of the render worker's GitHub credential as ONE RUNNING DEPLOYMENT sees it.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=<from your own environment, never on the command line or in chat> \
 *     npx tsx scripts/ops/probe-worker-token.ts https://<deployment-host>
 *
 * It signs one POST to /api/internal/worker-auth, an isolated route that performs a single `GET /repos/{GH_WORKER_REPO}`
 * on api.github.com with GH_WORKER_TOKEN and nothing else (no database, no storage, no other provider, no
 * repository_dispatch: no render starts, nothing is spent). It prints only that answer: presence states, the HTTP
 * status, GitHub's token-expiration header, the permissions GitHub reports and the deployment's environment. Never a
 * key, a token or the repository name.
 *
 * Reading the answer (three separate facts):
 *   readAuth            accepted / refused_401 (expired, revoked or not the token) / forbidden_403 / not_found_404
 *                       (repo unreachable with this token or GH_WORKER_REPO wrong) / not_checked (configuration
 *                       incomplete) / unknown (transport error or unexpected status).
 *   dispatchPermission  always "unverified": POST /dispatches needs Contents: write (fine-grained) or `repo` (classic);
 *                       reportedPermissions.push is indicative only. Only a real dispatch, which starts a render, proves it.
 *   environment         the deployment that answered (preview or production). A Preview answer says nothing about
 *                       Production's variables.
 */
import { randomUUID } from "node:crypto";
import { WORKER_AUTH_PATH, workerAuthSignature } from "../../src/lib/ops/worker-auth";

async function main() {
  const base = process.argv[2];
  if (!base || !/^https:\/\/[^/\s?#]+$/.test(base)) {
    console.error("Uso: SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/ops/probe-worker-token.ts https://<host>   (solo el host, sin ruta ni barra final)");
    process.exit(2);
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key || key.length < 32) {
    console.error("Falta SUPABASE_SERVICE_ROLE_KEY en el entorno (nunca en la línea de comandos ni en el chat).");
    process.exit(2);
  }
  const nonce = randomUUID(), timestamp = String(Date.now());
  const res = await fetch(`${base}${WORKER_AUTH_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "x-probe-nonce": nonce, "x-probe-time": timestamp, "x-probe-signature": workerAuthSignature(key, nonce, timestamp) } });
  if (!res.ok) {
    console.log(JSON.stringify({ probe: "worker-auth", http: res.status, note: res.status === 401 ? "firma rechazada: la clave del entorno no es la de este despliegue" : "ruta no disponible en este despliegue (commit anterior a la sonda)" }));
    process.exit(1);
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
