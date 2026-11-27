/** OIDC is kept in the Node worker, never injected into the page or persisted in evidence. */
import { targetOrigin } from "../../../src/lib/mystery-shopper/quality-loop/policy";
const AUDIENCE = "atomivid-sentinel-readiness";
export async function readSentinelReadiness(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<{ status: number; data: unknown }> {
  const blocked = { status: 0, data: null };
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || env.AQL_FIXTURE === "1") return blocked;
  try {
    const origin = targetOrigin(env.MS_TARGET_URL || "https://atomivid.vercel.app");
    const oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    // Never forward the runner credential to an arbitrary token URL.
    if (oidc.protocol !== "https:" || !/^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(oidc.hostname) || oidc.username || oidc.password) return blocked;
    oidc.searchParams.set("audience", AUDIENCE);
    const token = await fetchImpl(oidc, { redirect: "error", headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    if (!token.ok) return blocked;
    const body = await token.json();
    if (typeof body.value !== "string" || !/^[A-Za-z0-9._-]{20,8192}$/.test(body.value)) return blocked;
    const result = await fetchImpl(`${origin}/api/mystery-shopper/resource-readiness`, { redirect: "error", cache: "no-store", headers: { authorization: `Bearer ${body.value}` }, signal: AbortSignal.timeout(15000) });
    return { status: result.status, data: result.ok ? await result.json() : null };
  } catch { return blocked; }
}
