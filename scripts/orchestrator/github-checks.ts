/**
 * GitHub-side checks shared by the orchestrator scripts (see src/lib/orchestrator/github-env.ts for the rules).
 * Reads with the run's own token (GITHUB_TOKEN, `actions: read` or more); never prints a token.
 */
import { environmentGuard, writerTokenGuard, type BranchPolicy, type EnvironmentInfo, type Guard } from "../../src/lib/orchestrator/github-env";

const api = (path: string, token: string) => fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });

/** The "orchestrator" environment exists and only the default branch can use it. Unreadable → refused. */
export async function checkEnvironment(): Promise<Guard> {
  const token = process.env.GITHUB_TOKEN, branch = process.env.DEFAULT_BRANCH;
  if (!token || !branch || !process.env.GITHUB_REPOSITORY) return { ok: false, reason: "no se pudo verificar el entorno «orchestrator» (faltan datos de la ejecución)" };
  try {
    const res = await api("/environments/orchestrator", token);
    if (res.status === 404) return environmentGuard(null, null, branch);
    if (!res.ok) return { ok: false, reason: `no se pudo leer el entorno «orchestrator» (${res.status})` };
    const env = (await res.json()) as EnvironmentInfo;
    let policies: BranchPolicy[] | null = null;
    if (env.deployment_branch_policy?.custom_branch_policies) {
      const p = await api("/environments/orchestrator/deployment-branch-policies?per_page=100", token);
      if (!p.ok) return { ok: false, reason: `no se pudo leer la política de ramas del entorno (${p.status})` };
      policies = ((await p.json()) as { branch_policies?: BranchPolicy[] }).branch_policies ?? [];
    }
    return environmentGuard(env, policies, branch);
  } catch { return { ok: false, reason: "no se pudo verificar el entorno «orchestrator» (red)" }; }
}

/** The fine-grained token that writes secrets expires soon enough (header reported by GitHub for that token). */
export async function checkWriterToken(): Promise<{ ok: true; daysLeft: number } | { ok: false; reason: string }> {
  const token = process.env.GH_TOKEN;
  if (!token) return { ok: false, reason: "falta ORCH_SECRETS_WRITER_TOKEN" };
  try {
    const res = await api("", token);
    if (!res.ok) return { ok: false, reason: `el token ORCH_SECRETS_WRITER_TOKEN no puede leer este repositorio (${res.status})` };
    return writerTokenGuard(res.headers.get("github-authentication-token-expiration"), Date.now(), res.headers.get("x-oauth-scopes"));
  } catch { return { ok: false, reason: "no se pudo verificar el token ORCH_SECRETS_WRITER_TOKEN (red)" }; }
}
