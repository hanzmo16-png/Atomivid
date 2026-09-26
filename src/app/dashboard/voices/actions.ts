"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { deleteProviderVoice } from "@/lib/ai/voice";
import { dispatchVoiceClone } from "@/lib/voices/dispatch";
import { createUserVoice, deleteUserVoice, retryUserVoice } from "@/lib/voices/requests";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!getFeatureFlags().myVoiceEnabled) redirect("/dashboard");
  return user;
}

const back = (error?: string) => redirect(error ? `/dashboard/voices?error=${encodeURIComponent(error)}` : "/dashboard/voices");

export async function createMyVoice(formData: FormData) {
  const user = await requireUser();
  const file = formData.get("sample");
  const result = await createUserVoice({
    service: createServiceClient(),
    userId: user.id,
    form: {
      name: formData.get("name"),
      consentOwnVoice: formData.get("consent_own_voice"),
      consentProcessing: formData.get("consent_processing"),
      keepSample: formData.get("keep_sample"),
      clientRequestId: formData.get("client_request_id"),
      clientSeconds: formData.get("client_seconds"),
      file: file instanceof File ? file : null,
    },
    maxVoicesPerUser: getFeatureFlags().maxUserVoicesPerUser,
    dispatch: dispatchVoiceClone,
  });
  revalidatePath("/dashboard/voices");
  back(result.ok ? undefined : result.error);
}

export async function retryMyVoice(formData: FormData) {
  const user = await requireUser();
  const result = await retryUserVoice({ service: createServiceClient(), userId: user.id, voiceId: formData.get("voice_id"), dispatch: dispatchVoiceClone });
  revalidatePath("/dashboard/voices");
  back(result.ok ? undefined : result.error);
}

export async function deleteMyVoice(formData: FormData) {
  const user = await requireUser();
  const result = await deleteUserVoice({ service: createServiceClient(), userId: user.id, voiceId: formData.get("voice_id"), deleteProviderVoice });
  revalidatePath("/dashboard/voices");
  back(result.ok ? undefined : result.error);
}
