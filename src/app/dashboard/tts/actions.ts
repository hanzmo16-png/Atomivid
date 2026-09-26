"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { dispatchTtsJob } from "@/lib/tts/dispatch";
import { createTtsRequest, retryTtsRequest } from "@/lib/tts/requests";

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
  const result = await createTtsRequest({
    service: createServiceClient(),
    userId: user.id,
    form: {
      title: formData.get("title"),
      script: formData.get("script"),
      language: formData.get("language"),
      voice: formData.get("voice_choice"),
      clientRequestId: formData.get("client_request_id"),
    },
    limits: { maxCharsPerPiece: flags.ttsMaxCharsPerPiece, maxCharsPerUserMonth: flags.ttsMaxCharsPerUserMonth },
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
