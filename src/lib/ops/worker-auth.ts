/**
 * Read-only check of the render worker's GitHub credential AS THE RUNNING DEPLOYMENT SEES IT, isolated from every
 * other diagnostic: this module touches no database, no storage and no provider other than one `GET /repos/{repo}`
 * on api.github.com with `GH_WORKER_TOKEN` (the same header the dispatch sends). It never creates a
 * `repository_dispatch`, so no render starts and nothing is spent.
 *
 * Three things are reported separately and must never be conflated:
 *   - `readAuth`: what GitHub answered to the read (accepted / refused_401 / forbidden_403 / not_found_404 / ...).
 *   - `dispatchPermission`: ALWAYS "unverified". `POST /dispatches` needs Contents: write (fine-grained) or `repo`
 *     (classic); a read, and even `reportedPermissions.push`, is only indicative. The only proof is a real dispatch.
 *   - the environment the route adds (Preview vs Production): a Preview answer describes that deployment only.
 * Never the token, never the repository name.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidOwnerRepo } from "@/lib/worker/github-repo";

export const WORKER_AUTH_PATH = "/api/internal/worker-auth";

/** HMAC bound to method and path, like the existing provider-config probe; the secret is the server's service key. */
export function workerAuthSignature(secret: string, nonce: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`atomivid-worker-auth-v1\nPOST\n${WORKER_AUTH_PATH}\n${nonce}\n${timestamp}`).digest("hex");
}

export function validWorkerAuthSignature(secret: string | undefined, nonce: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !/^[0-9a-f-]{36}$/i.test(nonce) || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(workerAuthSignature(secret, nonce, timestamp)));
}

export type Presence = "present" | "blank" | "missing";
export type ReadAuth = "accepted" | "refused_401" | "forbidden_403" | "not_found_404" | "not_checked" | "unknown";

export type WorkerAuthProbe = {
  configured: { token: Presence; repo: Presence | "invalid" };
  /** GitHub's answer to one GET /repos/{repo} with the token. */
  readAuth: ReadAuth;
  http: number | null;
  transportError: boolean;
  /** What GitHub reports for the token on the repository (indicative only; see dispatchPermission). */
  reportedPermissions: { admin: boolean | null; push: boolean | null; pull: boolean | null } | null;
  /** GitHub's `github-authentication-token-expiration` header, when the token expires. */
  tokenExpiresAt: string | null;
  /** Never verified here: only a real `POST /dispatches` (which starts a render) proves it. */
  dispatchPermission: "unverified";
  note: string;
};

const NOTE = "readAuth describes one GET on the repository; dispatch (POST /dispatches, Contents: write) is not verified by this probe.";

export async function workerAuthProbe(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<WorkerAuthProbe> {
  const presence = (v: string | undefined): Presence => (v === undefined ? "missing" : v.trim() ? "present" : "blank");
  const token = env.GH_WORKER_TOKEN?.trim(), repoRaw = env.GH_WORKER_REPO?.trim() ?? "";
  const repo: WorkerAuthProbe["configured"]["repo"] = presence(env.GH_WORKER_REPO) !== "present" ? presence(env.GH_WORKER_REPO) : isValidOwnerRepo(repoRaw) ? "present" : "invalid";
  const out: WorkerAuthProbe = { configured: { token: presence(env.GH_WORKER_TOKEN), repo }, readAuth: "not_checked", http: null, transportError: false,
    reportedPermissions: null, tokenExpiresAt: null, dispatchPermission: "unverified", note: NOTE };
  if (out.configured.token !== "present" || repo !== "present") return out;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repoRaw}`, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    out.http = r.status;
    out.tokenExpiresAt = r.headers.get("github-authentication-token-expiration");
    if (r.ok) {
      const p = ((await r.json().catch(() => null)) as { permissions?: { admin?: unknown; push?: unknown; pull?: unknown } } | null)?.permissions;
      const b = (x: unknown) => (typeof x === "boolean" ? x : null);
      out.reportedPermissions = p ? { admin: b(p.admin), push: b(p.push), pull: b(p.pull) } : null;
    }
    out.readAuth = r.status === 200 ? "accepted" : r.status === 401 ? "refused_401" : r.status === 403 ? "forbidden_403" : r.status === 404 ? "not_found_404" : "unknown";
  } catch { out.transportError = true; out.readAuth = "unknown"; }
  return out;
}
