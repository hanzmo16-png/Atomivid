import { isRenderStale } from "./render-guard";
import { MAX_RENDER_ATTEMPTS } from "./limits";
import type { VideoRequestSummary } from "./request-view";

export type RequestAction = "review" | "script" | "retry" | "private-review" | "limit" | "access-review" | null;
export function requestAction(request: VideoRequestSummary, nowMs: number): RequestAction {
  if (request.status === "script_ready") return "review";
  const interrupted = request.status === "failed" || isRenderStale(request, nowMs);
  if (request.mode === "avatar") return interrupted || request.status === "pending" ? "private-review" : null;
  if (request.status === "failed" && /401|403|credential|api.?key|permis|not.configured/i.test(request.error_message ?? "")) return "access-review";
  if (request.status === "pending" || (request.status === "failed" && !request.script_json)) return "script";
  if (!interrupted) return null;
  return request.render_attempts >= MAX_RENDER_ATTEMPTS ? "limit" : "retry";
}
