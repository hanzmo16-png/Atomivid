/**
 * Guards on the GitHub side before any secret is written or a paid call is made (pure; the scripts fetch the data):
 *  - the "orchestrator" environment must exist and be restricted to the default branch, either by a custom
 *    deployment-branch policy listing ONLY that branch ("protected branches" is refused: it may cover others). Without that, a workflow
 *    pushed on any branch could declare the environment and read its secrets: the refresh token is never stored in
 *    an unprotected environment and the dedicated OpenAI key is never used from one.
 *  - the fine-grained token that writes secrets must expire, at most MAX_WRITER_TOKEN_DAYS ahead (GitHub reports it
 *    in the `github-authentication-token-expiration` response header; a token without expiry has no header).
 * Required reviewers are reported (recommended) but not required.
 */
export const MAX_WRITER_TOKEN_DAYS = 30;

export type EnvironmentInfo = {
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
  protection_rules?: { type?: string }[];
};
export type BranchPolicy = { name?: string; type?: string };

export type Guard = { ok: true; reviewers: boolean } | { ok: false; reason: string };

export function environmentGuard(env: EnvironmentInfo | null, policies: BranchPolicy[] | null, defaultBranch: string): Guard {
  if (!env) return { ok: false, reason: "no existe el entorno «orchestrator» (Settings → Environments)" };
  const reviewers = (env.protection_rules ?? []).some((r) => r.type === "required_reviewers");
  const p = env.deployment_branch_policy;
  if (!p) return { ok: false, reason: "el entorno «orchestrator» no limita las ramas: cualquier rama podría leer sus secretos. Limítalo a la rama por defecto" };
  // "Protected branches" could include other protected branches: only an explicit list naming the default branch counts.
  if (p.protected_branches) return { ok: false, reason: "el entorno «orchestrator» usa «Protected branches»: cámbialo a «Selected branches» con solo la rama por defecto" };
  if (!p.custom_branch_policies) return { ok: false, reason: "el entorno «orchestrator» no tiene una política de ramas válida" };
  if (!policies || policies.length === 0) return { ok: false, reason: "la política de ramas del entorno «orchestrator» está vacía" };
  const onlyDefault = policies.every((x) => (x.type ?? "branch") === "branch" && x.name === defaultBranch);
  return onlyDefault ? { ok: true, reviewers } : { ok: false, reason: `el entorno «orchestrator» permite otras ramas además de «${defaultBranch}»` };
}

/** GitHub formats it like "2026-10-17 12:00:00 UTC" or "2026-10-17 12:00:00 -0500". */
export function parseTokenExpiration(header: string | null | undefined): number | null {
  if (!header) return null;
  const m = header.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!m) return null;
  const zone = m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isFinite(t) ? t : null;
}

export function writerTokenGuard(header: string | null | undefined, now = Date.now(), oauthScopes?: string | null): { ok: true; daysLeft: number } | { ok: false; reason: string } {
  // A classic token answers with X-OAuth-Scopes (and can also carry an expiration): only fine-grained tokens, scoped to
  // this repository and to the "Environments" permission (the only one GitHub requires for environment secrets).
  if (oauthScopes != null) return { ok: false, reason: "ORCH_SECRETS_WRITER_TOKEN es un token clásico: usa uno de grano fino limitado a este repositorio" };
  const t = parseTokenExpiration(header);
  if (t == null) return { ok: false, reason: "el token ORCH_SECRETS_WRITER_TOKEN no tiene caducidad (o no es un token de grano fino): crea uno que caduque en 7 días" };
  const days = (t - now) / 86_400_000;
  if (days <= 0) return { ok: false, reason: "el token ORCH_SECRETS_WRITER_TOKEN ya caducó" };
  if (days > MAX_WRITER_TOKEN_DAYS) return { ok: false, reason: `el token ORCH_SECRETS_WRITER_TOKEN caduca dentro de más de ${MAX_WRITER_TOKEN_DAYS} días: usa uno de 7 días` };
  return { ok: true, daysLeft: Math.floor(days) };
}
