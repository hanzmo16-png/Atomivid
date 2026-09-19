"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { humanizeAuthError, safeRedirectTarget } from "@/lib/auth/errors";

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTarget = safeRedirectTarget(formData.get("redirectedFrom")) ?? "/dashboard";

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(humanizeAuthError(error.message))}&redirectedFrom=${encodeURIComponent(redirectTarget)}`);
  }

  redirect(redirectTarget);
}
