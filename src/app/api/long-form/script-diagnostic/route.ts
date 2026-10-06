import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";

export const dynamic = "force-dynamic";

/** Owner-only metadata from the last operator script; no prompts, keys or signed URLs. */
export async function GET() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!isInternalProductionOwner(user)) return new Response(null, { status: 404 });
  const service = createServiceClient();
  const { data: op, error } = await service.from("pi_paid_operations")
    .select("result_ref,created_at,committed_usd")
    .eq("project_id", "operator-script").eq("provider", "anthropic")
    .eq("method", "generate_script").eq("status", "COMMITTED")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !op?.result_ref?.startsWith("operator-script/paid/")) return new Response(null, { status: 404 });
  const { data, error: readError } = await service.storage.from("videos").download(op.result_ref);
  if (readError || !data) return new Response(null, { status: 503 });
  const result = JSON.parse(await data.text());
  return Response.json({
    createdAt: op.created_at, costUsd: op.committed_usd,
    stopReason: result.stop_reason, usage: result.usage,
    parsed: Boolean(result.parsed_output),
    blocks: Array.isArray(result.content) ? result.content.map((b: { type: string; text?: string; thinking?: string }) => ({
      type: b.type, textCharacters: b.text?.length ?? 0, thinkingCharacters: b.thinking?.length ?? 0,
    })) : [],
  }, { headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
