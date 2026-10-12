"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { joinEarlyAccess } from "@/lib/marketing/early-access";
import { ATTRIBUTION_COOKIE, VISITOR_COOKIE, decodeAttribution, validVisitorId } from "@/lib/marketing/events";

/** Precampaign launch list: same "reels" list as /avisame (one row per email). Never charges, never grants access. */
export async function joinPrecampaignLaunchList(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const store = await cookies();
  const result = await joinEarlyAccess(createServiceClient(), "reels", {
    email: formData.get("email"), consent: formData.get("consent"), website: formData.get("website"),
  }, { userId: user?.id ?? null, visitorId: validVisitorId(store.get(VISITOR_COOKIE)?.value), attribution: decodeAttribution(store.get(ATTRIBUTION_COOKIE)?.value) });
  if (!result.ok) redirect(`/lanzamiento?error=${encodeURIComponent(result.error)}`);
  redirect(`/lanzamiento?registrado=${result.already ? "ya" : "1"}`);
}
