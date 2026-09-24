import Link from "next/link";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";
import { RECOVERY_COOKIE, validRecoveryProof } from "@/lib/auth/recovery";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { AuthCard } from "@/components/ui/AuthCard";
import { resetPassword } from "./actions";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const proof = (await cookies()).get(RECOVERY_COOKIE)?.value;
  const valid =
    user && session && validRecoveryProof(proof, user.id, session.access_token, getSupabaseServiceRoleKey());

  return (
    <AuthCard subtitle="Crea una contraseña nueva">
      {!valid ? (
        <>
          <Alert tone="warning">El enlace caducó, ya se usó, o se abrió en otro navegador.</Alert>
          <p className="mt-6 text-center text-sm text-ink-muted">
            <Link href="/forgot-password" className="font-medium text-accent hover:text-accent-hover">
              Solicitar otro enlace
            </Link>
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-muted">
            Usa entre 12 y 128 caracteres. Este formulario vence 15 minutos después de abrir el
            enlace — después tendrás que iniciar sesión de nuevo con tu contraseña anterior o
            solicitar otro enlace.
          </p>
          {error && (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
          <form action={resetPassword} className="mt-5 space-y-4">
            <Field id="password" label="Nueva contraseña">
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                className={INPUT_CLASS}
                placeholder="••••••••••••"
              />
            </Field>
            <Field id="confirmation" label="Repite la contraseña">
              <input
                id="confirmation"
                name="confirmation"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                className={INPUT_CLASS}
                placeholder="••••••••••••"
              />
            </Field>
            <Button type="submit" className="w-full">
              Guardar nueva contraseña
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
