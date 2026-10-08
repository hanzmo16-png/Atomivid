import { providerConfigReport, validProviderConfigSignature } from "@/lib/ops/provider-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ops probe (HMAC-signed like the documentary worker): presence/counts only, never a secret value. */
export async function POST(request: Request) {
  if (!validProviderConfigSignature(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(), request.headers.get("x-probe-nonce") ?? "", request.headers.get("x-probe-time"), request.headers.get("x-probe-signature")))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await providerConfigReport());
}
