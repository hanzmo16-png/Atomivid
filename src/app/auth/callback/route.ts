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
  store.delete(RECOVERY_COOKIE);
  function go(path: string) {
    const response = NextResponse.redirect(new URL(path, origin));
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session && data.user) {
      // Only a verified recovery exchange creates permission to reset.
      // A ?next=/reset-password URL alone never grants permission.
      if ("redirectType" in data && data.redirectType === "recovery") {
        const proof = createRecoveryProof(data.user.id, data.session.access_token, getSupabaseServiceRoleKey());
        store.set(RECOVERY_COOKIE, proof, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: RECOVERY_SECONDS });
        return go("/reset-password");
      }
      return go(next === "/reset-password" ? "/dashboard" : next);
    }
  }
  return go(next === "/reset-password"
    ? "/forgot-password?error=El+enlace+caducó,+ya+se+usó+o+se+abrió+en+otro+navegador.+Solicita+otro."
    : "/login?error=No+se+pudo+confirmar+la+cuenta");
}
