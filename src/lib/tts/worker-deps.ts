/** Dependencias reales del worker de «Texto a voz» (servicio, proveedor de voz, ffmpeg, cuota, tiempo). */
import { createServiceClient } from "@/lib/supabase/service";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getVoiceCharacterQuota } from "@/lib/ai/voice";
import { concatToMp3, mixToMp3 } from "./concat";
import { DEFAULT_PROVIDER_RESERVE_CHARS } from "./limits";
import { runTtsJob } from "./run-tts-job";

/** Presupuesto por defecto: cabe en el paso de 15 min del tts.yml registrado hoy, con margen para unir y subir. */
export const DEFAULT_WORKER_BUDGET_SECONDS = 11 * 60;
/** Un video con render_started_at más antiguo que esto se considera atascado y no bloquea el piloto. */
const ACTIVE_VIDEO_WINDOW_MS = 6 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

export function runTtsJobWithDefaults(jobId: string, startedAtMs = Date.now()) {
  const service = createServiceClient();
  return runTtsJob(jobId, {
    service,
    voiceProvider: getVoiceProvider(),
    concat: concatToMp3,
    mix: mixToMp3,
    quota: getVoiceCharacterQuota,
    otherVoiceWork: async () => {
      const since = new Date(Date.now() - ACTIVE_VIDEO_WINDOW_MS).toISOString();
      const { data, error } = await service.from("video_requests").select("id").eq("status", "processing").gte("render_started_at", since);
      return error ? null : (data ?? []).length;
    },
    providerReserveChars: envInt("TTS_PROVIDER_RESERVE_CHARS", DEFAULT_PROVIDER_RESERVE_CHARS),
    deadlineMs: startedAtMs + envInt("TTS_WORKER_BUDGET_SECONDS", DEFAULT_WORKER_BUDGET_SECONDS) * 1000,
  });
}
