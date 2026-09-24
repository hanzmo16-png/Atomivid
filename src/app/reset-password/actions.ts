"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";
import { humanizeAuthError } from "@/lib/auth/errors";
import { passwordError, RECOVERY_COOKIE, validRecoveryProof } from "@/lib/auth/recovery";

export async function resetPassword(formData: FormData) {
  const supabase = await createClient();
  const store = await cookies();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const valid =
    user &&
    session &&
    validRecoveryProof(store.get(RECOVERY_COOKIE)?.value, user.id, session.access_token, getSupabaseServiceRoleKey());

  if (!valid) {
    store.delete(RECOVERY_COOKIE);
    redirect("/forgot-password?error=El+enlace+caducó+o+ya+no+es+válido.+Solicita+otro.");
  }

  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  const validationError = passwordError(password, confirmation);
  if (validationError) {
    redirect(`/reset-password?error=${encodeURIComponent(validationError)}`);
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    redirect(`/reset-password?error=${encodeURIComponent(humanizeAuthError(updateError.message))}`);
  }

  // La contraseña ya cambió — la prueba de recuperación de un solo uso no
  // debe servir dos veces, y CUALQUIER sesión abierta con la contraseña
  // anterior (este navegador u otro) se cierra, no solo la de este
  // proceso, para que un dispositivo ya comprometido pierda el acceso.
  store.delete(RECOVERY_COOKIE);
  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
  if (signOutError) {
    await supabase.auth.signOut({ scope: "local" });
    redirect(
      "/login?message=Contraseña+actualizada.&error=No+se+pudo+confirmar+el+cierre+de+las+demás+sesiones.",
    );
  }

  redirect("/login?message=Contraseña+actualizada.+Inicia+sesión+con+tu+nueva+contraseña.");
}
