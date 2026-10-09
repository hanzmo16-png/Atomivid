"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { joinEarlyAccess } from "@/lib/marketing/early-access";
import { ATTRIBUTION_COOKIE, VISITOR_COOKIE, decodeAttribution, validVisitorId } from "@/lib/marketing/events";

/** Documentaries early-access list. Never charges and never grants access: it only records interest. */
export async function joinDocumentariesEarlyAccess(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const store = await cookies();
  const result = await joinEarlyAccess(createServiceClient(), "documentales", {
    email: formData.get("email"), consent: formData.get("consent"), website: formData.get("website"),
  }, { userId: user?.id ?? null, visitorId: validVisitorId(store.get(VISITOR_COOKIE)?.value), attribution: decodeAttribution(store.get(ATTRIBUTION_COOKIE)?.value) });
  if (!result.ok) redirect(`/acceso-anticipado?error=${encodeURIComponent(result.error)}`);
  redirect(`/acceso-anticipado?registrado=${result.already ? "ya" : "1"}`);
}
