"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { humanizeAuthError } from "@/lib/auth/errors";
import { createServiceClient } from "@/lib/supabase/service";
import { ATTRIBUTION_COOKIE, VISITOR_COOKIE, decodeAttribution, recordMarketingEvent } from "@/lib/marketing/events";

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const origin = (await headers()).get("origin");
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/register?error=${encodeURIComponent(humanizeAuthError(error.message))}`);
  }

  // A new account only: for an address that already exists Supabase answers with no identities.
  if (data.user && (data.user.identities?.length ?? 0) > 0) {
    const store = await cookies();
    await recordMarketingEvent(createServiceClient(), {
      event: "signup_completed", dedupeKey: `signup_completed:${data.user.id}`, userId: data.user.id,
      visitorId: store.get(VISITOR_COOKIE)?.value, attribution: decodeAttribution(store.get(ATTRIBUTION_COOKIE)?.value),
    });
  }

  redirect("/login?message=Revisa+tu+correo+para+confirmar+tu+cuenta");
}
