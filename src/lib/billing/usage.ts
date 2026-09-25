import type { SupabaseClient } from "@supabase/supabase-js";
import { estimateCostUsd, estimateTokensFromChars } from "./pricing";

/**
 * Registro de uso/costo por solicitud, en la tabla `generation_costs`
 * (migración 0008). No mide el gasto real de cada proveedor (ninguno lo
 * expone por request sin llamadas extra de facturación) — estima a partir
 * de lo que el pipeline ya sabe (caracteres enviados, duración, tiempo de
 * render) usando las tarifas configurables de `pricing.ts`. Suficiente
 * para comparar el costo relativo entre videos y detectar solicitudes
 * anormalmente caras, no para reconciliar con la factura exacta del
 * proveedor.
 */
type GenerationCostsRow = {
  request_id: string;
  script_calls: number;
  script_estimated_input_tokens: number;
  script_estimated_output_tokens: number;
  voice_provider: string | null;
  voice_characters: number;
  footage_provider: string | null;
  footage_count: number;
  music_provider: string | null;
  // Trazabilidad por video de qué pista sonó (migración 0009, aplicada y
  // verificada) — null cuando el video se generó sin música o con el
  // modo "arranque rápido" (MUSIC_TRACK_URLS, sin metadata de pista).
  music_track_id: string | null;
  music_track_title: string | null;
  music_track_author: string | null;
  music_track_license: string | null;
  music_track_source_url: string | null;
  /** Motivo del fallback cuando NO hubo música — null si sí hubo. */
  music_fallback_reason: string | null;
  video_duration_seconds: number | null;
  render_ms: number | null;
  storage_bytes: number;
  regenerations: number;
  estimated_cost_usd: number;
  // Capa creativa nueva (migración 0010, no aplicada todavía) — 0/null en
  // cualquier video que no usó imagen generada ni clips premium (el caso
  // normal hoy: solo Pexels/Pixabay).
  image_provider: string | null;
  image_generation_count: number;
  image_cost_usd: number;
  // Desglose adicional del planificador visual (migración 0012, no
  // aplicada todavía) — distingue "se consideró generar" de "se generó de
  // verdad" de "se reutilizó un archivo ya existente" (idempotencia).
  image_requested_count: number;
  image_reused_count: number;
  image_dry_run: boolean;
  image_model: string | null;
  image_size: string | null;
  premium_video_provider: string | null;
  premium_video_clip_count: number;
  premium_video_cost_usd: number;
  premium_video_fallback_reason: string | null;
  // Modo avatar (migración 0011, no aplicada todavía) — null/0 en
  // cualquier video del modo "visual" (el caso normal hoy).
  avatar_provider: string | null;
  avatar_provider_job_id: string | null;
  avatar_cost_usd: number;
};

const EMPTY_USAGE: Omit<GenerationCostsRow, "request_id"> = {
  script_calls: 0,
  script_estimated_input_tokens: 0,
  script_estimated_output_tokens: 0,
  voice_provider: null,
  voice_characters: 0,
  footage_provider: null,
  footage_count: 0,
  music_provider: null,
  music_track_id: null,
  music_track_title: null,
  music_track_author: null,
  music_track_license: null,
  music_track_source_url: null,
  music_fallback_reason: null,
  video_duration_seconds: null,
  render_ms: null,
  storage_bytes: 0,
  regenerations: 0,
  estimated_cost_usd: 0,
  image_provider: null,
  image_generation_count: 0,
  image_cost_usd: 0,
  image_requested_count: 0,
  image_reused_count: 0,
  image_dry_run: false,
  image_model: null,
  image_size: null,
  premium_video_provider: null,
  premium_video_clip_count: 0,
  premium_video_cost_usd: 0,
  premium_video_fallback_reason: null,
  avatar_provider: null,
  avatar_provider_job_id: null,
  avatar_cost_usd: 0,
};

async function loadRow(
  service: SupabaseClient,
  requestId: string,
): Promise<GenerationCostsRow> {
  const { data } = await service
    .from("generation_costs")
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle<GenerationCostsRow>();

  return data ?? { request_id: requestId, ...EMPTY_USAGE };
}

async function saveRow(service: SupabaseClient, row: GenerationCostsRow) {
  // has_music_track se deriva de music_provider en vez de guardarse como
  // columna aparte — "none" (fallback sin música) y null (todavía no se
  // llegó a la etapa de música) no deben sumar costo musical.
  const hasMusicTrack = Boolean(row.music_provider) && row.music_provider !== "none";
  const estimated_cost_usd = estimateCostUsd({ ...row, has_music_track: hasMusicTrack });
  await service
    .from("generation_costs")
    .upsert({ ...row, estimated_cost_usd, updated_at: new Date().toISOString() });
}

/**
 * Registra una llamada al modelo de lenguaje (guion inicial o regeneración
 * de una escena). `inputChars`/`outputChars` son del texto real enviado y
 * recibido — se estiman tokens a partir de ahí (ver nota en pricing.ts).
 */
export async function recordScriptCall(
  service: SupabaseClient,
  requestId: string,
  params: { inputChars: number; outputChars: number; isRegeneration?: boolean },
) {
  const row = await loadRow(service, requestId);
  const { inputTokens, outputTokens } = estimateTokensFromChars(
    params.inputChars,
    params.outputChars,
  );

  row.script_calls += 1;
  row.script_estimated_input_tokens += inputTokens;
  row.script_estimated_output_tokens += outputTokens;
  if (params.isRegeneration) row.regenerations += 1;

  await saveRow(service, row);
}

/**
 * Registra el costo de sintetizar la narración de un avatar a partir de
 * texto libre ("Voz IA desde texto") — se llama en el momento real de la
 * síntesis (dashboard/new/actions.ts), antes de que exista el resto del
 * pipeline de avatar para esa solicitud. pipeline.ts (avatar/pipeline.ts)
 * NUNCA vuelve a llamar a ElevenLabs para una solicitud con
 * recorded_audio_path ya presente (ver avatar_narration_source,
 * migración 0017) — esta es la única vez que este costo se registra,
 * exactamente igual que recordScriptCall para el guion.
 */
export async function recordAvatarNarrationTts(
  service: SupabaseClient,
  requestId: string,
  params: { voiceProvider: string; characters: number },
) {
  const row = await loadRow(service, requestId);
  row.voice_provider = params.voiceProvider;
  row.voice_characters += params.characters;
  await saveRow(service, row);
}

/** Registra el uso de la etapa cara (voz/footage/música/render/storage). */
export async function recordVideoGeneration(
  service: SupabaseClient,
  requestId: string,
  usage: {
    /**
     * Ausentes cuando el costo de voz ya se registró por separado ANTES de
     * esta llamada (avatar con narración "tts": recordAvatarNarrationTts ya
     * corrió en el momento real de la síntesis, en dashboard/new/actions.ts
     * — ver avatar/pipeline.ts) — omitirlos preserva ese valor en vez de
     * sobrescribirlo con "uploaded"/0, que perdería el proveedor y el
     * conteo de caracteres reales ya cobrados.
     */
    voiceProvider?: string;
    voiceCharacters?: number;
    footageProvider: string;
    footageCount: number;
    musicProvider: string;
    /** Metadata de la pista específica usada — ausente si no hubo música o si vino del modo "arranque rápido" sin manifest. */
    musicTrack?: {
      id: string;
      title: string;
      author: string;
      license: string;
      sourceUrl: string;
    } | null;
    /** Motivo del fallback cuando el video se generó sin música — null si sí hubo. */
    musicFallbackReason?: string | null;
    videoDurationSeconds: number;
    renderMs: number;
    storageBytes: number;
    /** Capa creativa nueva — ausente en el flujo actual (Pexels/Pixabay), no rompe nada si se omite. */
    creativeLayer?: {
      imageProvider?: string;
      imageGenerationCount?: number;
      imageCostUsd?: number;
      /** Escenas que el planificador visual decidió intentar generar (independientemente del resultado) — ver visual-resource-planner.ts. */
      imageRequestedCount?: number;
      /** De las anteriores, cuántas se resolvieron reutilizando un archivo ya generado (idempotencia) en vez de una llamada nueva. */
      imageReusedCount?: number;
      imageDryRun?: boolean;
      imageModel?: string;
      imageSize?: string;
      premiumVideoProvider?: string;
      premiumVideoClipCount?: number;
      premiumVideoCostUsd?: number;
      premiumVideoFallbackReason?: string | null;
      avatarProvider?: string;
      avatarProviderJobId?: string;
      avatarCostUsd?: number;
    };
  },
) {
  const row = await loadRow(service, requestId);

  if (usage.voiceProvider !== undefined) row.voice_provider = usage.voiceProvider;
  if (usage.voiceCharacters !== undefined) row.voice_characters = usage.voiceCharacters;
  row.footage_provider = usage.footageProvider;
  row.footage_count = usage.footageCount;
  row.music_provider = usage.musicProvider;
  row.music_track_id = usage.musicTrack?.id ?? null;
  row.music_track_title = usage.musicTrack?.title ?? null;
  row.music_track_author = usage.musicTrack?.author ?? null;
  row.music_track_license = usage.musicTrack?.license ?? null;
  row.music_track_source_url = usage.musicTrack?.sourceUrl ?? null;
  row.music_fallback_reason = usage.musicFallbackReason ?? null;
  row.video_duration_seconds = usage.videoDurationSeconds;
  row.render_ms = usage.renderMs;
  row.storage_bytes = usage.storageBytes;
  row.image_provider = usage.creativeLayer?.imageProvider ?? null;
  row.image_generation_count = usage.creativeLayer?.imageGenerationCount ?? 0;
  row.image_cost_usd = usage.creativeLayer?.imageCostUsd ?? 0;
  row.image_requested_count = usage.creativeLayer?.imageRequestedCount ?? 0;
  row.image_reused_count = usage.creativeLayer?.imageReusedCount ?? 0;
  row.image_dry_run = usage.creativeLayer?.imageDryRun ?? false;
  row.image_model = usage.creativeLayer?.imageModel ?? null;
  row.image_size = usage.creativeLayer?.imageSize ?? null;
  row.premium_video_provider = usage.creativeLayer?.premiumVideoProvider ?? null;
  row.premium_video_clip_count = usage.creativeLayer?.premiumVideoClipCount ?? 0;
  row.premium_video_cost_usd = usage.creativeLayer?.premiumVideoCostUsd ?? 0;
  row.premium_video_fallback_reason = usage.creativeLayer?.premiumVideoFallbackReason ?? null;
  row.avatar_provider = usage.creativeLayer?.avatarProvider ?? null;
  row.avatar_provider_job_id = usage.creativeLayer?.avatarProviderJobId ?? null;
  row.avatar_cost_usd = usage.creativeLayer?.avatarCostUsd ?? 0;

  await saveRow(service, row);
}
