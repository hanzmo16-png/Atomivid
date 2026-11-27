/** Shared RS256 GitHub Actions verifier. Callers supply their own pinned audience/workflow policy. No executor or paid paths. */
import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const SKEW_S = 60;

export type OidcPolicy = { repository: string; defaultBranch: string; environment: string; audience: string; workflows: readonly string[]; detachedDeploymentSha?: string };
export type OidcResult = { ok: true; workflow: string; runId: string } | { ok: false; reason: string };
type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string };

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

export async function verifyGithubOidc(jwt: string, policy: OidcPolicy, jwks: () => Promise<{ keys?: Jwk[] }>, nowS = Math.floor(Date.now() / 1000)): Promise<OidcResult> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "token mal formado" };
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return { ok: false, reason: "token mal formado" }; }
  // Only RS256: "none" and HMAC algorithms are refused before any key is looked up.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "algoritmo no admitido" };
  const key = ((await jwks().catch(() => ({ keys: [] }))).keys ?? []).find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!key) return { ok: false, reason: "clave de firma desconocida" };
  let valid = false;
  try { valid = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { valid = false; }
  if (!valid) return { ok: false, reason: "firma no válida" };

  if (claims.iss !== GITHUB_OIDC_ISSUER) return { ok: false, reason: "emisor no válido" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(policy.audience)) return { ok: false, reason: "audiencia no válida" };
  const exp = Number(claims.exp), nbf = Number(claims.nbf ?? claims.iat), iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp + SKEW_S < nowS) return { ok: false, reason: "token caducado" };
  if (!Number.isFinite(nbf) || nbf - SKEW_S > nowS || !Number.isFinite(iat) || iat - SKEW_S > nowS) return { ok: false, reason: "token aún no válido" };
  if (String(claims.repository ?? "").toLowerCase() !== policy.repository.toLowerCase()) return { ok: false, reason: "repositorio no permitido" };
  const ref = `refs/heads/${policy.defaultBranch}`;
  // Opt-in only: a deployment event can execute the exact deployed commit without a branch ref.
  // The caller must obtain this pin from trusted deployment configuration, never the request/JWT.
  // Apply the pin even when the token also carries the ordinary default-branch reference.
  const pinnedDeployment = claims.event_name === "deployment_status" && policy.detachedDeploymentSha !== undefined;
  const pin = policy.detachedDeploymentSha;
  if (pinnedDeployment && (typeof pin !== "string" || !/^[a-f0-9]{40}$/.test(pin) || claims.sha !== pin)) return { ok: false, reason: "commit de despliegue no permitido" };
  if (claims.ref !== ref && !(pinnedDeployment && (claims.ref === undefined || claims.ref === "" || claims.ref === pin))) return { ok: false, reason: "rama no permitida" };
  if (claims.environment !== policy.environment) return { ok: false, reason: "el job no corre en el entorno protegido" };
  if (claims.event_name === "pull_request" || claims.event_name === "pull_request_target") return { ok: false, reason: "evento no permitido" };
  // orchestrator.yml and drive-oauth.yml run ordinary jobs (steps, no `uses:` of a reusable workflow). GitHub's OIDC
  // reference: `workflow_ref` = "the ref path to the workflow" (<owner>/<repo>/.github/workflows/<file>@<ref>);
  // `job_workflow_ref` exists "for jobs using a reusable workflow". So the allowed file is checked on workflow_ref.
  // GitHub repository names are case-insensitive; Git file names and refs are not.
  const repositoryPrefix = `${policy.repository}/`;
  const canonicalWorkflowRef = (value: string) => value.slice(0, repositoryPrefix.length).toLowerCase() === repositoryPrefix.toLowerCase()
    ? repositoryPrefix + value.slice(repositoryPrefix.length) : value;
  const wr = typeof claims.workflow_ref === "string" ? canonicalWorkflowRef(claims.workflow_ref) : "";
  const workflow = policy.workflows.find((w) => {
    const prefix = `${policy.repository}/.github/workflows/${w}@`;
    return wr === `${prefix}${ref}` || (pinnedDeployment && wr === `${prefix}${pin}`);
  });
  if (!workflow) return { ok: false, reason: "workflow no permitido" };
  // No reusable workflows: if a job_workflow_ref is present it must be that same workflow. A job of an allowed workflow
  // that calls a reusable workflow (here or in another repository) runs code that is not one of the two files: refused.
  if (claims.job_workflow_ref !== undefined && (typeof claims.job_workflow_ref !== "string" || canonicalWorkflowRef(claims.job_workflow_ref) !== wr)) return { ok: false, reason: "workflow reutilizable no permitido" };
  return { ok: true, workflow, runId: String(claims.run_id ?? "") };
}

/** Bearer token from the Authorization header (nothing else is accepted). */
export const bearer = (h: string | null) => h?.match(/^Bearer ([A-Za-z0-9._-]{20,8192})$/)?.[1] ?? null;
