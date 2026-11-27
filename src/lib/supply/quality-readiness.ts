/** Machine-only, amount-free projection. QA keeps its existing account permissions. */
import { bearer, GITHUB_OIDC_JWKS, verifyGithubOidc, type OidcPolicy } from "../orchestrator/github-oidc";
import { PRODUCT_PROVIDER_IMPACT, providerReadiness } from "../mystery-shopper/quality-loop/policy";
import type { readResourceSentinel } from "./sentinel-server";
export const SENTINEL_READINESS_AUDIENCE = "atomivid-sentinel-readiness";
export const SENTINEL_READINESS_POLICY: OidcPolicy = {
  repository: "hanzmo16-png/Atomivid", defaultBranch: "claude/atomivid-mvp-setup-0079jv",
  environment: "Preview", audience: SENTINEL_READINESS_AUDIENCE, workflows: ["mystery-shopper.yml"],
};
type Observation = Awaited<ReturnType<typeof readResourceSentinel>>;
export function qualityReadiness(data: Observation) {
  return { version: "resource-sentinel-readiness/1", observedAt: data.observedAt,
    products: Object.fromEntries(Object.keys(PRODUCT_PROVIDER_IMPACT).map(product => {
      const key = product as keyof typeof PRODUCT_PROVIDER_IMPACT;
      const ready = providerReadiness(key, data);
      return [product, { ready, reason: ready ? "VERIFIED_READINESS_ONLY" : "RESOURCE_OR_CROSS_PRODUCT_COVERAGE_UNVERIFIED" }];
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
  const verified = await verifyGithubOidc(jwt, SENTINEL_READINESS_POLICY,
    deps.jwks ?? (async () => (await fetch(GITHUB_OIDC_JWKS, { cache: "no-store", signal: AbortSignal.timeout(5000) })).json()), deps.nowS);
  if (!verified.ok) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try { return Response.json(qualityReadiness(await deps.read()), { headers }); }
  catch { return Response.json({ error: "observations unavailable" }, { status: 503, headers }); }
}
