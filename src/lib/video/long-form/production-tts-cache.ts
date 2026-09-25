/**
 * Persistencia/idempotencia POR BEAT de la síntesis de voz real
 * (ElevenLabs) para la producción REAL de VIDEO #001 vía GitHub Actions
 * — mismo diseño que tts-cache.ts (identidad determinística/STARTED/
 * COMPLETED/checksum), pero con Supabase Storage como backend en vez de
 * disco local: un runner de GitHub Actions es efímero (workspace nuevo
 * en cada ejecución), así que el caché en disco de tts-cache.ts solo
 * protege contra un crash DENTRO de una misma ejecución, nunca entre dos
 * ejecuciones separadas del workflow — el mismo problema ya resuelto
 * para las imágenes (ver visual-test-v2-storage.ts).
 *
 * Reutiliza sin cambios: computeTtsCacheKey / TtsCacheIdentity /
 * TtsUncertainCostStateError / TtsCostGuard (tts-cache.ts — puras, sin
 * I/O de disco esas piezas concretas) y synthesizeBeatNarration
 * (timeline.ts). tts-cache.ts en sí queda intacto — este es un módulo
 * nuevo y paralelo, no una modificación de aquel.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScriptLanguage, VoiceProvider, WordTiming } from "@/lib/providers/types";
import type { NarrativeBeat } from "./types";
import { synthesizeBeatNarration, type BeatNarrationResult } from "./timeline";
import { computeTtsCacheKey, TtsUncertainCostStateError, type TtsCacheIdentity } from "./tts-cache";
import { computeChecksumSha256, VISUAL_TEST_V2_STORAGE_BUCKET } from "./visual-test-v2-storage";

export { TtsUncertainCostStateError };

export type ProductionTtsCacheRecordStatus = "STARTED" | "COMPLETED";

export type ProductionTtsCacheRecord = {
  key: string;
  identity: TtsCacheIdentity;
  status: ProductionTtsCacheRecordStatus;
  audioPath?: string;
  audioChecksumSha256?: string;
  mimeType?: string;
  extension?: string;
  durationSeconds?: number;
  words?: WordTiming[];
  costUsd?: number;
  createdAtIso: string;
  updatedAtIso: string;
};

function recordPath(videoId: string, key: string): string {
  return `long-form/${videoId}/state/tts/${key}.json`;
}

function audioPathFor(videoId: string, key: string, extension: string): string {
  return `long-form/${videoId}/tts/${key}.${extension}`;
}

export async function readProductionTtsCacheRecord(
  supabase: SupabaseClient,
  bucket: string,
  videoId: string,
  key: string,
): Promise<ProductionTtsCacheRecord | undefined> {
  const { data, error } = await supabase.storage.from(bucket).download(recordPath(videoId, key));
  if (error || !data) return undefined;
  const text = await data.text();
  if (!text) return undefined;
  return JSON.parse(text) as ProductionTtsCacheRecord;
}

export async function writeProductionTtsCacheRecord(
  supabase: SupabaseClient,
  bucket: string,
  videoId: string,
  record: ProductionTtsCacheRecord,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(record, null, 2));
  const path = recordPath(videoId, record.key);
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType: "application/json", upsert: true });
  if (error) {
    throw new Error(`No se pudo guardar el registro TTS de producción en Storage ("${path}"): ${error.message}`);
  }
}

/** Descarga y valida el audio cacheado — devuelve el buffer solo si existe, no está vacío, y su checksum coincide; nunca confía ciegamente en un COMPLETED. */
export async function validateAndDownloadProductionCachedAudio(
  supabase: SupabaseClient,
  bucket: string,
  record: ProductionTtsCacheRecord,
): Promise<Buffer | undefined> {
  if (!record.audioPath || !record.audioChecksumSha256) return undefined;
  const { data, error } = await supabase.storage.from(bucket).download(record.audioPath);
  if (error || !data) return undefined;
  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.byteLength === 0) return undefined;
  if (computeChecksumSha256(buffer) !== record.audioChecksumSha256) return undefined;
  return buffer;
}

/**
 * Igual que TtsCostGuard (tts-cache.ts), pero permite que assertCanSpend/
 * recordSpend sean asíncronos — el cost guard de producción real lee y
 * escribe el ledger durable en Supabase Storage (I/O de red), a
 * diferencia del cost guard del CLI original que solo tocaba disco local
 * síncronamente. Una función síncrona (`(): void`) también calza aquí
 * (`void` es parte de la unión), así que esto es compatible hacia atrás.
 */
export type ProductionTtsCostGuard = {
  estimateCostUsd(text: string): number;
  assertCanSpend(amountUsd: number): Promise<void> | void;
  recordSpend(amountUsd: number, note: string): Promise<void> | void;
};

export type ProductionSynthesizeBeatCachedResult = BeatNarrationResult & { reused: boolean; costUsd: number };

function toRecordWordTimings(words: WordTiming[]): WordTiming[] {
  return words.map((w) => ({ text: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds }));
}

/**
 * Versión Supabase-backed de synthesizeBeatNarrationCached() (tts-cache.ts)
 * — mismo comportamiento observable (reuso si hay COMPLETED válido, STOP
 * si hay STARTED sin resolver, STARTED-antes/COMPLETED-después alrededor
 * de la llamada real), pero durable entre ejecuciones separadas de
 * GitHub Actions. El proveedor fixture nunca toca este caché (bypass
 * total, igual que tts-cache.ts).
 */
export async function synthesizeBeatNarrationProductionCached(
  supabase: SupabaseClient,
  voiceProvider: VoiceProvider,
  beat: Pick<NarrativeBeat, "id" | "narration">,
  language: ScriptLanguage,
  ctx: {
    videoId: string;
    bucket?: string;
    voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string };
    costGuard?: ProductionTtsCostGuard;
  },
): Promise<ProductionSynthesizeBeatCachedResult> {
  if (voiceProvider.name === "fixture") {
    const result = await synthesizeBeatNarration(voiceProvider, beat, language);
    return { ...result, reused: false, costUsd: 0 };
  }

  const bucket = ctx.bucket ?? VISUAL_TEST_V2_STORAGE_BUCKET;
  const identity: TtsCacheIdentity = {
    videoId: ctx.videoId,
    beatId: beat.id,
    text: beat.narration,
    voiceId: ctx.voiceIdentity.voiceId,
    modelId: ctx.voiceIdentity.modelId,
    voiceSettingsJson: ctx.voiceIdentity.voiceSettingsJson,
    language,
    providerName: voiceProvider.name,
  };
  const key = computeTtsCacheKey(identity);
  const existing = await readProductionTtsCacheRecord(supabase, bucket, ctx.videoId, key);

  if (existing?.status === "COMPLETED") {
    const audioBuffer = await validateAndDownloadProductionCachedAudio(supabase, bucket, existing);
    if (audioBuffer) {
      return {
        beatId: beat.id,
        audioBuffer,
        mimeType: existing.mimeType!,
        extension: existing.extension!,
        durationSeconds: existing.durationSeconds!,
        words: existing.words!,
        reused: true,
        costUsd: 0,
      };
    }
    // COMPLETED pero el archivo no valida (faltante/corrupto): cae a síntesis nueva y consciente abajo.
  }

  if (existing?.status === "STARTED") {
    throw new TtsUncertainCostStateError(beat.id, key);
  }

  const now = new Date().toISOString();
  const estimatedCostUsd = ctx.costGuard?.estimateCostUsd(beat.narration) ?? 0;
  if (ctx.costGuard) await ctx.costGuard.assertCanSpend(estimatedCostUsd);

  await writeProductionTtsCacheRecord(supabase, bucket, ctx.videoId, {
    key,
    identity,
    status: "STARTED",
    createdAtIso: now,
    updatedAtIso: now,
  });

  const result = await synthesizeBeatNarration(voiceProvider, beat, language);

  const path = audioPathFor(ctx.videoId, key, result.extension);
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, result.audioBuffer, { contentType: result.mimeType, upsert: true });
  if (uploadError) {
    throw new Error(`No se pudo subir el audio TTS de producción a Storage ("${path}"): ${uploadError.message}`);
  }
  const checksum = computeChecksumSha256(result.audioBuffer);

  await writeProductionTtsCacheRecord(supabase, bucket, ctx.videoId, {
    key,
    identity,
    status: "COMPLETED",
    audioPath: path,
    audioChecksumSha256: checksum,
    mimeType: result.mimeType,
    extension: result.extension,
    durationSeconds: result.durationSeconds,
    words: toRecordWordTimings(result.words),
    costUsd: estimatedCostUsd,
    createdAtIso: now,
    updatedAtIso: new Date().toISOString(),
  });

  if (ctx.costGuard) await ctx.costGuard.recordSpend(estimatedCostUsd, `TTS beat ${beat.id} (producción real)`);

  return { ...result, reused: false, costUsd: estimatedCostUsd };
}

/** Recuperación sin proveedores: el beat no tiene audio COMPLETED válido en el caché. */
export class TtsReplayCacheMissError extends Error {
  constructor(readonly beatId: string, readonly key: string, readonly reason: string) {
    super(`Recuperación abortada: la narración del beat ${beatId} no está en el caché durable (${reason}) — no se vuelve a sintetizar.`);
    this.name = "TtsReplayCacheMissError";
  }
}

/**
 * Solo LEE el caché durable (misma identidad/clave que
 * synthesizeBeatNarrationProductionCached): devuelve el audio COMPLETED
 * con checksum válido o lanza TtsReplayCacheMissError. Nunca llama al
 * proveedor de voz ni escribe registros — base de la recuperación con
 * CERO llamadas pagadas.
 */
export async function loadProductionCachedBeatNarration(
  supabase: SupabaseClient,
  voiceProviderName: string,
  beat: Pick<NarrativeBeat, "id" | "narration">,
  language: ScriptLanguage,
  ctx: { videoId: string; bucket?: string; voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string } },
): Promise<ProductionSynthesizeBeatCachedResult> {
  const bucket = ctx.bucket ?? VISUAL_TEST_V2_STORAGE_BUCKET;
  const identity: TtsCacheIdentity = {
    videoId: ctx.videoId,
    beatId: beat.id,
    text: beat.narration,
    voiceId: ctx.voiceIdentity.voiceId,
    modelId: ctx.voiceIdentity.modelId,
    voiceSettingsJson: ctx.voiceIdentity.voiceSettingsJson,
    language,
    providerName: voiceProviderName,
  };
  const key = computeTtsCacheKey(identity);
  const existing = await readProductionTtsCacheRecord(supabase, bucket, ctx.videoId, key);
  if (existing?.status !== "COMPLETED") throw new TtsReplayCacheMissError(beat.id, key, existing ? `estado ${existing.status}` : "sin registro");
  const audioBuffer = await validateAndDownloadProductionCachedAudio(supabase, bucket, existing);
  if (!audioBuffer) throw new TtsReplayCacheMissError(beat.id, key, "audio faltante o checksum inválido");
  return {
    beatId: beat.id,
    audioBuffer,
    mimeType: existing.mimeType!,
    extension: existing.extension!,
    durationSeconds: existing.durationSeconds!,
    words: existing.words!,
    reused: true,
    costUsd: 0,
  };
}
