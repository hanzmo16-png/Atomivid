/**
 * Diagnóstico de SOLO LECTURA de una solicitud Long Form ya en producción
 * de video real (QA real, 2026-09-25: "LONG FORM RC FINAL HARDENING" —
 * solicitud del Canal de Panamá). NUNCA escribe en video_requests/
 * generation_costs. NUNCA llama a ningún proveedor (Anthropic/ElevenLabs/
 * Veo/OpenAI/Pexels) — ni siquiera un GET de estado, a diferencia de
 * diagnose-avatar-request.ts (que sí consulta HeyGen). Esta pasada es
 * puramente de base de datos: la evidencia de qué providerJobId/operación
 * externa existe (si alguno) se lee de generation_costs/columnas ya
 * persistidas, nunca preguntando al proveedor directamente.
 *
 * Uso: [REQUEST_ID=<uuid>] npx tsx scripts/diagnose-long-form-production.ts
 * Sin REQUEST_ID: toma la solicitud long_form más reciente.
 */
export {};

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const requestId = process.env.REQUEST_ID;

  type Row = {
    id: string;
    user_id: string;
    mode: string;
    topic: string;
    style: string;
    duration_seconds: number;
    aspect_ratio: string;
    language: string | null;
    status: string;
    error_message: string | null;
    long_form_stage: string | null;
    progress_stage: string | null;
    render_attempts: number;
    render_started_at: string | null;
    script_json: unknown;
    video_path: string | null;
    created_at: string;
  };

  const COLUMNS =
    "id, user_id, mode, topic, style, duration_seconds, aspect_ratio, language, status, error_message, long_form_stage, progress_stage, render_attempts, render_started_at, script_json, video_path, created_at";

  let row: Row | null = null;
  if (requestId) {
    const { data, error } = await service.from("video_requests").select(COLUMNS).eq("id", requestId).maybeSingle<Row>();
    if (error) throw new Error(`request_read_failed: ${error.message}`);
    row = data;
  } else {
    const { data, error } = await service
      .from("video_requests")
      .select(COLUMNS)
      .eq("mode", "long_form")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`request_query_failed: ${error.message}`);
    row = (data as Row[] | null)?.[0] ?? null;
  }

  if (!row) {
    console.log(JSON.stringify({ found: false }, null, 2));
    return;
  }

  const script = row.script_json as { topic?: string; beats?: Array<{ narration?: string }> } | null;
  const scriptSummary = script
    ? {
        exists: true,
        beatCount: Array.isArray(script.beats) ? script.beats.length : 0,
        totalNarrationWords: Array.isArray(script.beats)
          ? script.beats.reduce((sum, b) => sum + (typeof b.narration === "string" ? b.narration.trim().split(/\s+/).filter(Boolean).length : 0), 0)
          : 0,
      }
    : { exists: false, beatCount: 0, totalNarrationWords: 0 };

  const { data: costRow } = await service
    .from("generation_costs")
    .select(
      "voice_provider, voice_characters, footage_provider, footage_count, music_provider, music_track_id, music_fallback_reason, video_duration_seconds, render_ms, storage_bytes, image_provider, image_generation_count, image_requested_count, image_reused_count, image_cost_usd, premium_video_provider, premium_video_clip_count, premium_video_cost_usd, premium_video_fallback_reason, estimated_cost_usd, updated_at",
    )
    .eq("request_id", row.id)
    .maybeSingle();

  const elapsedMinutes = row.render_started_at
    ? Math.round((Date.now() - new Date(row.render_started_at).getTime()) / 60000)
    : null;

  console.log(
    JSON.stringify(
      {
        found: true,
        request: {
          id: row.id,
          user_id: row.user_id,
          mode: row.mode,
          status: row.status,
          long_form_stage: row.long_form_stage,
          progress_stage: row.progress_stage,
          render_attempts: row.render_attempts,
          render_started_at: row.render_started_at,
          elapsed_minutes_since_render_started: elapsedMinutes,
          error_message: row.error_message,
          duration_seconds: row.duration_seconds,
          aspect_ratio: row.aspect_ratio,
          created_at: row.created_at,
          video_path: row.video_path,
        },
        script: scriptSummary,
        // storyboard/production-plan: NO existe ninguna columna dedicada
        // hoy (ver produce.ts) — el timeline/shots se calculan en memoria
        // durante el render y nunca se persisten. Se reporta explícito
        // para no fingir un dato que no existe.
        storyboard_persisted: false,
        production_plan_persisted: false,
        generation_costs: costRow ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("DIAGNOSE_FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
