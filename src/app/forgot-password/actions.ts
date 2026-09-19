"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { RECOVERY_COOKIE, recoveryOrigin } from "@/lib/auth/recovery";

export async function requestPasswordReset(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect("/forgot-password?error=Escribe+un+correo+válido.");
  }
  const store = await cookies();
  // UX cooldown only; Supabase Auth supplies authoritative rate limits.
  if (store.get("atomivid-recovery-cooldown")) redirect("/forgot-password?sent=1");
  store.delete(RECOVERY_COOKIE);
  let failed = false;
  try {
    const origin = recoveryOrigin(process.env.VERCEL_ENV === "preview" && process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : process.env.NEXT_PUBLIC_SITE_URL);
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });
    // Never expose account existence or raw provider messages.
    failed = Boolean(error && (!error.status || error.status >= 500));
  } catch { failed = true; }
  if (failed) redirect("/forgot-password?error=No+se+pudo+solicitar+el+enlace.+Intenta+de+nuevo+más+tarde.");
  store.set("atomivid-recovery-cooldown", "1", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/forgot-password", maxAge: 60 });
  redirect("/forgot-password?sent=1");
}
