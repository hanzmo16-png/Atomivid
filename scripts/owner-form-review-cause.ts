/** Private response analysis; logs only the authorized status and categorical technical cause. */
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseResultStore } from "../src/lib/paid-calls/result-store";
import { VisualVerdictSchema } from "../src/lib/video/visual-intent";
const request = "34bc43f3-a53d-4daa-b8fa-bef3f1544b04";
async function main() {
  const service = createServiceClient();
  for (const key of ["op_4fc34fd2dce2a934b1501e074620652d", "op_9dd941e5dcc6feb9dbee3d11a745fb17"]) {
    const op = await service.from("pi_paid_operations").select("project_id,method,status").eq("idempotency_key", key).single();
    if (op.error || op.data.project_id !== request || op.data.method !== "visual_relevance_review" || op.data.status !== "RECONCILIATION_REQUIRED") throw Error("CAUSE_SCOPE_BLOCKED");
    const body = await supabaseResultStore(service).getJson<{ status?: string; incomplete_details?: { reason?: string }; output?: { content?: { type?: string; text?: string }[] }[] }>(`${request}/paid/${key}.json.provider-response.json`);
    if (body?.status !== "incomplete" || body.incomplete_details?.reason !== "max_output_tokens") throw Error("CAUSE_UNAVAILABLE");
    const value = (body.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("");
    let cause = "empty_output";
    if (value.length) {
      cause = value.trim() ? "partial_json" : "whitespace_only";
      try { cause = VisualVerdictSchema.safeParse(JSON.parse(value)).success ? "complete_verdict" : "invalid_verdict"; } catch { /* Retain categorical cause only. */ }
    }
    console.log(JSON.stringify({ responseStatus: "incomplete", incompleteReason: `max_output_tokens:${cause}` }));
  }
}
main().catch(() => { console.error("CAUSE_BLOCKED_NO_MUTATION"); process.exitCode = 1; });
