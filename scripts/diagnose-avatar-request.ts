/**
 * Diagnóstico de SOLO LECTURA de una solicitud de avatar real que falló en
 * Production (QA real, 2026-09-25: "AVATAR REAL HEYGEN ATTEMPT FAILED").
 * NUNCA escribe en video_requests/avatars/generation_costs. La única
 * llamada de red permitida a HeyGen es un GET de solo lectura del estado
 * de un providerJobId YA EXISTENTE (checkVideoStatus) — nunca
 * createAvatar/generateVideo, nunca recoverVideo/descarga en esta pasada.
 *
 * Uso: [REQUEST_ID=<uuid>] npx tsx scripts/diagnose-avatar-request.ts
 * Sin REQUEST_ID: toma la solicitud avatar+failed más reciente.
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
    language: string | null;
    status: string;
    error_message: string | null;
    progress_stage: string | null;
    render_attempts: number;
    render_started_at: string | null;
    avatar_id: string | null;
    avatar_voice_id: string | null;
    avatar_provider_video_job_id: string | null;
    avatar_render_status: string | null;
    avatar_generation_started_at: string | null;
    avatar_narration_source: string | null;
    recorded_audio_path: string | null;
    video_path: string | null;
    created_at: string;
  };

  const COLUMNS =
    "id, user_id, mode, topic, style, duration_seconds, language, status, error_message, progress_stage, render_attempts, render_started_at, avatar_id, avatar_voice_id, avatar_provider_video_job_id, avatar_render_status, avatar_generation_started_at, avatar_narration_source, recorded_audio_path, video_path, created_at";

  let row: Row | null = null;
  if (requestId) {
    const { data, error } = await service.from("video_requests").select(COLUMNS).eq("id", requestId).maybeSingle<Row>();
    if (error) throw new Error(`request_read_failed: ${error.message}`);
    row = data;
  } else {
    const { data, error } = await service
      .from("video_requests")
      .select(COLUMNS)
      .eq("mode", "avatar")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`request_query_failed: ${error.message}`);
    row = (data as Row[] | null)?.[0] ?? null;
  }

  if (!row) {
    console.log(JSON.stringify({ found: false }, null, 2));
    return;
  }

  let avatarRow: { provider: string; status: string; provider_avatar_id: string | null; source_photo_path: string | null } | null = null;
  if (row.avatar_id) {
    const { data } = await service
      .from("avatars")
      .select("provider, status, provider_avatar_id, source_photo_path")
      .eq("id", row.avatar_id)
      .maybeSingle();
    avatarRow = data ?? null;
  }

  // Otros avatares del mismo usuario — para saber si ya existe uno
  // creado por el proveedor real (heygen) que pueda reusarse en una
  // solicitud futura, sin necesidad de subir la foto de nuevo.
  const { data: allAvatars } = await service
    .from("avatars")
    .select("id, provider, status, created_at")
    .eq("user_id", row.user_id)
    .order("created_at", { ascending: false });

  const { data: costRow } = await service
    .from("generation_costs")
    .select(
      "voice_provider, voice_characters, avatar_provider, avatar_provider_job_id, avatar_cost_usd, storage_bytes, render_ms",
    )
    .eq("request_id", row.id)
    .maybeSingle();

  let heygenStatus: string | null = null;
  let heygenStatusError: string | null = null;
  if (row.avatar_provider_video_job_id && (avatarRow?.provider ?? "heygen") === "heygen") {
    if (!process.env.HEYGEN_API_KEY?.trim()) {
      heygenStatusError = "HEYGEN_API_KEY no disponible en este runner — no se pudo consultar el estado real.";
    } else {
      try {
        const { heygenAvatarProvider } = await import("../src/lib/providers/avatar/heygen");
        // Lectura de solo estado — GET /v3/videos/{id}, nunca crea ni reintenta nada.
        heygenStatus = await heygenAvatarProvider.checkVideoStatus(row.avatar_provider_video_job_id);
      } catch (err) {
        heygenStatusError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Comprobación de configuración (QA real, 2026-09-25: "HEYGEN PROVIDER
  // CONFIG INCOMPLETE") — SOLO booleanos/nombres, nunca valores ni
  // llamadas de red. Dice exactamente qué falta EN ESTE RUNNER (el mismo
  // entorno donde corre generateAvatarVideo() de verdad, vía render.yml)
  // sin adivinar y sin exponer ningún secreto.
  const { getFeatureFlags } = await import("../src/lib/video/feature-flags");
  const { heygenAvatarProvider } = await import("../src/lib/providers/avatar/heygen");
  const { didAvatarProvider } = await import("../src/lib/providers/avatar/did");
  const flags = getFeatureFlags();
  const providerConfig = {
    avatar_provider_flag: flags.avatarProvider,
    heygen_api_key_present: heygenAvatarProvider.isAvailable(),
    did_api_key_present: didAvatarProvider.isAvailable(),
  };

  console.log(
    JSON.stringify(
      {
        found: true,
        request: row,
        avatar: avatarRow,
        user_avatars: allAvatars ?? [],
        generation_costs: costRow ?? null,
        provider_config: providerConfig,
        heygen_status_check: {
          attempted: Boolean(row.avatar_provider_video_job_id),
          status: heygenStatus,
          error: heygenStatusError,
        },
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
