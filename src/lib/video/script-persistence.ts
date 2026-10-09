import type { createServiceClient } from "@/lib/supabase/service";

export class ScriptPersistenceError extends Error {
  constructor(public readonly status: 409 | 500) {
    super(status === 409
      ? "El video cambió mientras editabas. Actualiza la página antes de continuar."
      : "No se pudo guardar el guion. Conserva tus cambios y vuelve a intentar guardarlos.");
    this.name = "ScriptPersistenceError";
  }
}

/** A successful response requires a confirmed write, fenced against render and other edits. */
export async function persistScriptChange(
  service: ReturnType<typeof createServiceClient>,
  expected: { id: string; user_id: string; status: string; render_attempts: number; script_json: unknown },
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    let query = service.from("video_requests").update(patch)
      .eq("id", expected.id).eq("user_id", expected.user_id)
      .eq("status", expected.status).eq("render_attempts", expected.render_attempts);
    query = expected.script_json == null
      ? query.is("script_json", null)
      : query.eq("script_json", JSON.stringify(expected.script_json));
    const { data, error } = await query.select("id");
    if (error) throw new ScriptPersistenceError(500);
    if (data?.length !== 1) throw new ScriptPersistenceError(409);
  } catch (error) {
    if (error instanceof ScriptPersistenceError) throw error;
    throw new ScriptPersistenceError(500);
  }
}
