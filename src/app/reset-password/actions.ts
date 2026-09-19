"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";
import { passwordError, RECOVERY_COOKIE, validRecoveryProof } from "@/lib/auth/recovery";
export async function resetPassword(form: FormData) {
  const supabase = await createClient();
  const store = await cookies();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: { session } } = await supabase.auth.getSession();
  if (!user || !session || !validRecoveryProof(store.get(RECOVERY_COOKIE)?.value, user.id, session.access_token, getSupabaseServiceRoleKey())) {
    store.delete(RECOVERY_COOKIE);
    redirect("/forgot-password?error=El+enlace+caducó+o+ya+no+es+válido.+Solicita+otro.");
  }
  const password = String(form.get("password") ?? "");
  const error = passwordError(password, String(form.get("confirmation") ?? ""));
  if (error) redirect(`/reset-password?error=${encodeURIComponent(error)}`);
  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) redirect("/reset-password?error=No+se+pudo+cambiar+la+contraseña.+Usa+una+contraseña+nueva+y+segura,+o+solicita+otro+enlace.");
  store.delete(RECOVERY_COOKIE);
  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
  if (signOutError) {
    await supabase.auth.signOut({ scope: "local" });
    redirect("/login?message=Contraseña+actualizada.&error=No+se+pudo+confirmar+el+cierre+de+las+otras+sesiones.");
  }
  redirect("/login?message=Contraseña+actualizada.+Inicia+sesión+con+tu+nueva+contraseña.");
}
