import Link from "next/link";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey } from "@/lib/supabase/env";
import { RECOVERY_COOKIE, validRecoveryProof } from "@/lib/auth/recovery";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { resetPassword } from "./actions";
export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: { session } } = await supabase.auth.getSession();
  const valid = user && session && validRecoveryProof((await cookies()).get(RECOVERY_COOKIE)?.value, user.id, session.access_token, getSupabaseServiceRoleKey());
  return <main className="mx-auto max-w-md px-4 py-12"><Card className="space-y-5 p-6">
    <h1 className="text-2xl font-bold">Nueva contraseña</h1>
    {!valid ? <><Alert tone="warning">El enlace caducó, ya se usó o se abrió en otro navegador.</Alert><Link href="/forgot-password" className="block underline">Solicitar otro enlace</Link></> : <>
      <p>Usa entre 12 y 128 caracteres. El formulario vence en 15 minutos desde que abres el enlace. Después tendrás que iniciar sesión de nuevo.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <form action={resetPassword} className="space-y-4">
        <Field id="password" label="Nueva contraseña"><input id="password" name="password" className={INPUT_CLASS} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field>
        <Field id="confirmation" label="Repite la contraseña"><input id="confirmation" name="confirmation" className={INPUT_CLASS} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field>
        <AuthSubmit>Guardar nueva contraseña</AuthSubmit>
      </form>
    </>}
  </Card></main>;
}
