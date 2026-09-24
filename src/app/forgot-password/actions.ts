"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { RECOVERY_COOKIE } from "@/lib/auth/recovery";

const COOLDOWN_COOKIE = "atomivid-recovery-cooldown";
const COOLDOWN_SECONDS = 60;

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect("/forgot-password?error=Escribe+un+correo+válido.");
  }

  const store = await cookies();
  // Solo un cooldown de UX — Supabase Auth aplica su propio rate limit
  // real del lado del proveedor; esto evita el reenvío accidental de un
  // doble clic sin pretender ser la defensa principal.
  if (store.get(COOLDOWN_COOKIE)) {
    redirect("/forgot-password?error=No+se+ha+enviado+otro+enlace.+Espera+antes+de+solicitarlo+de+nuevo.");
  }
  store.delete(RECOVERY_COOKIE);

  const origin = (await headers()).get("origin");
  let failed = !origin;
  if (origin) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=/reset-password`,
      });
      // Nunca se distingue "cuenta inexistente" de "correo falló" en la
      // respuesta al usuario — el mensaje genérico (RECOVERY_MESSAGE) es
      // el mismo en ambos casos.
      failed = Boolean(error);
    } catch {
      failed = true;
    }
  }

  if (failed) {
    redirect("/forgot-password?error=No+se+pudo+enviar+el+enlace.+Intenta+de+nuevo+más+tarde.");
  }

  store.set(COOLDOWN_COOKIE, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/forgot-password",
    maxAge: COOLDOWN_SECONDS,
  });
  redirect("/forgot-password?sent=1");
}
