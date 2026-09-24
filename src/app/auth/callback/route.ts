import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";
import { safeRedirectTarget } from "@/lib/auth/errors";
import { createRecoveryProof, RECOVERY_COOKIE, RECOVERY_SECONDS } from "@/lib/auth/recovery";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRedirectTarget(searchParams.get("next")) ?? "/dashboard";
  const store = await cookies();
  // Nunca conserva una prueba de recuperación de una visita previa a este
  // mismo endpoint — cada intercambio de código decide desde cero.
  store.delete(RECOVERY_COOKIE);

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session && data.user) {
      // Solo un intercambio VERIFICADO de tipo "recovery" (el que produce
      // el enlace de resetPasswordForEmail) otorga permiso para cambiar la
      // contraseña — un simple "?next=/reset-password" en la URL, que
      // cualquiera podría escribir a mano, nunca lo otorga por sí solo.
      const redirectType = (data as unknown as { redirectType?: string }).redirectType;
      if (redirectType === "recovery") {
        const proof = createRecoveryProof(data.user.id, data.session.access_token, getSupabaseServiceRoleKey());
        store.set(RECOVERY_COOKIE, proof, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: RECOVERY_SECONDS,
        });
        return NextResponse.redirect(`${origin}/reset-password`);
      }
      return NextResponse.redirect(`${origin}${next === "/reset-password" ? "/dashboard" : next}`);
    }
  }

  return NextResponse.redirect(
    `${origin}${
      next === "/reset-password"
        ? "/forgot-password?error=El+enlace+caducó,+ya+se+usó+o+se+abrió+en+otro+navegador.+Solicita+otro."
        : "/login?error=No+se+pudo+confirmar+la+cuenta"
    }`,
  );
}
