import { validWorkerAuthSignature, workerAuthProbe } from "@/lib/ops/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Isolated, HMAC-signed probe of the worker's GitHub credential: one GET on api.github.com and nothing else (no
 * database, no storage, no other provider, no dispatch). The answer describes THIS deployment (`environment`),
 * never Production when called on a Preview. Values are never returned.
 */
export async function POST(request: Request) {
  if (!validWorkerAuthSignature(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(), request.headers.get("x-probe-nonce") ?? "", request.headers.get("x-probe-time"), request.headers.get("x-probe-signature")))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const githubWorker = await workerAuthProbe(process.env);
  return Response.json({ environment: { vercelEnv: process.env.VERCEL_ENV ?? null, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, scope: "this deployment only" }, githubWorker });
}
