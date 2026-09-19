import type { SupabaseClient } from "@supabase/supabase-js";

export type AttemptToken = { requestId: string; userId: string; attempt: number };

/** All writes require the original owner, attempt and active state. */
export function attemptState(service: SupabaseClient, token: AttemptToken) {
  const update = (values: Record<string, unknown>) => service.from("video_requests").update(values)
    .eq("id", token.requestId).eq("user_id", token.userId).eq("status", "processing")
    .eq("render_attempts", token.attempt);
  return {
    update,
    async claim(stage: string | null) {
      if (stage !== null && stage !== "queued") return false;
      let query = update({ progress_stage: "voice" });
      query = stage === null ? query.is("progress_stage", null) : query.eq("progress_stage", "queued");
      const result = await query.select("id").maybeSingle();
      if (result.error) throw new Error("No se pudo reservar el trabajo de render.");
      return Boolean(result.data);
    },
  };
}
