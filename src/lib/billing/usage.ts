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
  video_duration_seconds: number | null;
  render_ms: number | null;
  storage_bytes: number;
  regenerations: number;
  estimated_cost_usd: number;
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
  video_duration_seconds: null,
  render_ms: null,
  storage_bytes: 0,
  regenerations: 0,
  estimated_cost_usd: 0,
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
  const estimated_cost_usd = estimateCostUsd(row);
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

/** Registra el uso de la etapa cara (voz/footage/música/render/storage). */
export async function recordVideoGeneration(
  service: SupabaseClient,
  requestId: string,
  usage: {
    voiceProvider: string;
    voiceCharacters: number;
    footageProvider: string;
    footageCount: number;
    musicProvider: string;
    videoDurationSeconds: number;
    renderMs: number;
    storageBytes: number;
  },
) {
  const row = await loadRow(service, requestId);

  row.voice_provider = usage.voiceProvider;
  row.voice_characters = usage.voiceCharacters;
  row.footage_provider = usage.footageProvider;
  row.footage_count = usage.footageCount;
  row.music_provider = usage.musicProvider;
  row.video_duration_seconds = usage.videoDurationSeconds;
  row.render_ms = usage.renderMs;
  row.storage_bytes = usage.storageBytes;

  await saveRow(service, row);
}
