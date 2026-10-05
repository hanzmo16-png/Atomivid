/** Read-only reconciliation evidence: no provider HTTP, paid-row updates, or render retries. */
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseResultStore } from "../src/lib/paid-calls/result-store";
const REQUEST = "34bc43f3-a53d-4daa-b8fa-bef3f1544b04", KEY = "op_4fc34fd2dce2a934b1501e074620652d";
async function main() {
  const service = createServiceClient();
  const op = await service.from("pi_paid_operations").select("project_id,method,status,reserved_usd")
    .eq("idempotency_key", KEY).single();
  if (op.error || op.data.project_id !== REQUEST || op.data.method !== "visual_relevance_review"
    || op.data.status !== "RECONCILIATION_REQUIRED") throw new Error("READBACK_SCOPE_BLOCKED");
  const response = await supabaseResultStore(service).getJson<Record<string, unknown>>(`${REQUEST}/paid/${KEY}.json.provider-response.json`);
  if (!response) throw new Error("READBACK_RESPONSE_UNAVAILABLE");
  // No provider text, request content, IDs, images, usage/billing, or private artifacts.
  const status = ["completed", "incomplete", "failed"].includes(String(response.status)) ? response.status : "other";
  const reason = (response.incomplete_details as { reason?: unknown } | null)?.reason;
  console.log(JSON.stringify({ responseStatus: status, incompleteReason: reason === "max_output_tokens" ? "max_output_tokens" : "other" }));
}
main().catch(() => { console.error("READBACK_BLOCKED_NO_MUTATION"); process.exitCode = 1; });
