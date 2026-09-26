/** Dependencias reales del worker de «Texto a voz» (servicio, proveedor de voz, ffmpeg, cuota). */
import { createServiceClient } from "@/lib/supabase/service";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getVoiceCharacterQuota } from "@/lib/ai/voice";
import { concatToMp3 } from "./concat";
import { runTtsJob } from "./run-tts-job";

export function runTtsJobWithDefaults(jobId: string) {
  return runTtsJob(jobId, {
    service: createServiceClient(),
    voiceProvider: getVoiceProvider(),
    concat: concatToMp3,
    quota: getVoiceCharacterQuota,
  });
}
