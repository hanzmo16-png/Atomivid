"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { getVoiceCharacterQuota } from "@/lib/ai/voice";
import { dispatchTtsJob } from "@/lib/tts/dispatch";
import { resolveTtsLimits } from "@/lib/tts/limits";
import { createTtsRequest, requestTtsMix, retryTtsRequest } from "@/lib/tts/requests";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!getFeatureFlags().textToSpeechEnabled) redirect("/dashboard");
  return user;
}

export async function createTextToSpeech(formData: FormData) {
  const user = await requireUser();
  const flags = getFeatureFlags();
  const general = { maxCharsPerPiece: flags.ttsMaxCharsPerPiece, maxCharsPerUserMonth: flags.ttsMaxCharsPerUserMonth };
  const limits = resolveTtsLimits(user, general);
  const result = await createTtsRequest({
    service: createServiceClient(),
    userId: user.id,
    form: {
      title: formData.get("title"),
      script: formData.get("script"),
      language: formData.get("language"),
      voice: formData.get("voice_choice"),
      clientRequestId: formData.get("client_request_id"),
      music: formData.get("music"),
    },
    limits,
    generalMaxCharsPerPiece: general.maxCharsPerPiece,
    musicEnabled: flags.ttsMusicEnabled,
    providerQuota: limits.kind === "long_pilot" ? getVoiceCharacterQuota : undefined,
    dispatch: dispatchTtsJob,
  });
  if (!result.ok) redirect(`/dashboard/tts?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/dashboard/tts");
  redirect(`/dashboard/tts?job=${result.jobId}`);
}

export async function retryTextToSpeech(formData: FormData) {
  const user = await requireUser();
  const result = await retryTtsRequest({ service: createServiceClient(), userId: user.id, jobId: formData.get("job_id"), dispatch: dispatchTtsJob });
  if (!result.ok) redirect(`/dashboard/tts?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/dashboard/tts");
  redirect("/dashboard/tts");
}

/** Preparar, reintentar o cambiar la versión con música (usa la narración guardada; no vuelve a generar la voz). */
export async function mixTextToSpeech(formData: FormData) {
  const user = await requireUser();
  if (!getFeatureFlags().ttsMusicEnabled) redirect("/dashboard/tts");
  const result = await requestTtsMix({ service: createServiceClient(), userId: user.id, jobId: formData.get("job_id"), music: formData.get("music"), dispatch: dispatchTtsJob });
  if (!result.ok) redirect(`/dashboard/tts?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/dashboard/tts");
  redirect("/dashboard/tts");
}
