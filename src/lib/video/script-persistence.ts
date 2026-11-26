import { isDeepStrictEqual } from "node:util";
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
    // A documentary JSON filter can exceed the gateway URL limit (>50 KB in the real QA case).
    // Read the current body, compare it exactly, then CAS on PostgreSQL's row transaction version.
    // xmin changes on EVERY update (unlike an optional application timestamp). No migration/RPC needed.
    const snapshot = await service.from("video_requests").select("id,script_json,xmin")
      .eq("id", expected.id).eq("user_id", expected.user_id)
      .eq("status", expected.status).eq("render_attempts", expected.render_attempts).maybeSingle();
    if (snapshot.error) throw new ScriptPersistenceError(500);
    if (!snapshot.data || !isDeepStrictEqual(snapshot.data.script_json, expected.script_json))
      throw new ScriptPersistenceError(409);
    const revision = String((snapshot.data as unknown as { xmin?: unknown }).xmin ?? "");
    if (!/^[1-9][0-9]{0,9}$/.test(revision) || Number(revision) > 4294967295)
      throw new ScriptPersistenceError(500); // version unavailable: never fall back to an unfenced write
    const query = service.from("video_requests").update(patch)
      .eq("id", expected.id).eq("user_id", expected.user_id)
      .eq("status", expected.status).eq("render_attempts", expected.render_attempts).eq("xmin", revision);
    const { data, error } = await query.select("id");
    if (error) throw new ScriptPersistenceError(500);
    if (data?.length !== 1) throw new ScriptPersistenceError(409);
  } catch (error) {
    if (error instanceof ScriptPersistenceError) throw error;
    throw new ScriptPersistenceError(500);
  }
}
