/** Machine-only, amount-free projection. QA keeps its existing account permissions. */
import { bearer, GITHUB_OIDC_JWKS, verifyGithubOidc, type OidcPolicy } from "../security/github-oidc";
import { PRODUCT_PROVIDER_IMPACT, providerReadiness } from "../mystery-shopper/quality-loop/policy";
import type { readResourceSentinel } from "./sentinel-server";
export const SENTINEL_READINESS_AUDIENCE = "atomivid-sentinel-readiness";
export const SENTINEL_READINESS_POLICY: OidcPolicy = {
  repository: "hanzmo16-png/Atomivid", defaultBranch: "claude/atomivid-mvp-setup-0079jv",
  environment: "Preview", audience: SENTINEL_READINESS_AUDIENCE, workflows: ["mystery-shopper.yml"],
};
/** Only the amount-free observer opts in. Drive and other callers keep strict branch checks.
 * Both values are Vercel's server deployment metadata, not caller-supplied claims/headers. */
export function sentinelReadinessPolicy(env: Record<string, string | undefined>): OidcPolicy {
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  return env.VERCEL_ENV === "production" && typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)
    ? { ...SENTINEL_READINESS_POLICY, detachedDeploymentSha: sha }
    : SENTINEL_READINESS_POLICY;
}
type Observation = Awaited<ReturnType<typeof readResourceSentinel>>;
/** Closed vocabulary only: never serialize provider names, amounts, IDs or upstream messages. */
function readinessBlockers(product: keyof typeof PRODUCT_PROVIDER_IMPACT, data: Observation): string[] {
  const blockers = new Set<string>();
  const accounts = data.sentinel?.accounts ?? [];
  for (const provider of PRODUCT_PROVIDER_IMPACT[product]) {
    const matches = accounts.filter(a => a.providers?.includes(provider));
    if (!matches.length) { blockers.add("OBSERVATION_MISSING"); continue; }
    // Readiness remains the existing predicate; diagnostics only describe its evidence.
    if (matches.some(a => a.operationalLevel === "GREEN" && a.balanceStatus === "REAL" && typeof a.free === "number" && Number.isFinite(a.free) && a.free > 0)) continue;
    for (const account of matches) {
      if (account.balanceStatus === "STALE") blockers.add("BALANCE_STALE");
      else if (account.balanceStatus === "ESTIMATED") blockers.add("BALANCE_ESTIMATED");
      else if (account.balanceStatus !== "REAL") blockers.add("BALANCE_UNKNOWN");
      if (typeof account.free !== "number" || !Number.isFinite(account.free)) blockers.add("FREE_CAPACITY_UNKNOWN");
      else if (account.free <= 0) blockers.add("FREE_CAPACITY_NOT_POSITIVE");
      if (account.auditStatus === "CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED") blockers.add("CROSS_PRODUCT_LEDGER_UNVERIFIED");
      if (account.operationalLevel !== "GREEN") blockers.add("ADMISSION_UNVERIFIED_OR_REFUSED");
    }
  }
  if (!data.sentinel?.resources?.some(r => r.resource === "workers" && r.state === "VERIFIED" && typeof r.used === "number" && Number.isSafeInteger(r.used) && r.used >= 0 && typeof r.limit === "number" && Number.isSafeInteger(r.limit) && r.limit > 0 && r.used < r.limit)) blockers.add("WORKER_CAPACITY_UNVERIFIED_OR_UNAVAILABLE");
  if ((product === "audio-podcast" || product === "video-podcast") && data.coverage?.workers === "video_requests only; excludes separate Audio/Podcast workers") blockers.add("WORKER_COVERAGE_UNVERIFIED");
  return [...blockers].sort();
}
export function qualityReadiness(data: Observation) {
  return { version: "resource-sentinel-readiness/1", observedAt: data.observedAt,
    products: Object.fromEntries(Object.keys(PRODUCT_PROVIDER_IMPACT).map(product => {
      const key = product as keyof typeof PRODUCT_PROVIDER_IMPACT;
      const ready = providerReadiness(key, data);
      return [product, { ready, reason: ready ? "VERIFIED_READINESS_ONLY" : "RESOURCE_OR_CROSS_PRODUCT_COVERAGE_UNVERIFIED",
        blockers: ready ? [] : readinessBlockers(key, data) }];
    })),
    // Observation does not reserve supply or authorize any generation.
    scope: "READ_ONLY_NOT_ATOMIC_ADMISSION",
  };
}
export async function qualityReadinessResponse(request: Request, deps: {
  read: () => Promise<Observation>;
  jwks?: Parameters<typeof verifyGithubOidc>[2]; nowS?: number;
}) {
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" };
  const jwt = bearer(request.headers.get("authorization"));
  if (!jwt) return Response.json({ error: "unauthenticated" }, { status: 401, headers });
  const verified = await verifyGithubOidc(jwt, sentinelReadinessPolicy(process.env),
    deps.jwks ?? (async () => (await fetch(GITHUB_OIDC_JWKS, { cache: "no-store", signal: AbortSignal.timeout(5000) })).json()), deps.nowS);
  if (!verified.ok) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try { return Response.json(qualityReadiness(await deps.read()), { headers }); }
  catch { return Response.json({ error: "observations unavailable" }, { status: 503, headers }); }
}
