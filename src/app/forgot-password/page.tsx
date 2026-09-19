import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { RECOVERY_MESSAGE } from "@/lib/auth/recovery";
import { requestPasswordReset } from "./actions";
export default async function ForgotPassword({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  return <main className="mx-auto max-w-md px-4 py-12"><Card className="space-y-5 p-6">
    <h1 className="text-2xl font-bold">Recuperar contraseña</h1>
    <p>Te enviaremos un enlace de un solo uso para recuperar tu cuenta de ATOMIVID.</p>
    {sent && <Alert tone="success">{RECOVERY_MESSAGE}</Alert>}
    {error && <Alert tone="danger">{error}</Alert>}
    <form action={requestPasswordReset} className="space-y-4">
      <Field id="email" label="Correo de tu cuenta"><input className={INPUT_CLASS} id="email" name="email" type="email" autoComplete="email" maxLength={254} required /></Field>
      <AuthSubmit>Enviar enlace de recuperación</AuthSubmit>
    </form>
    <p>Abre el correo en el mismo navegador donde lo solicitaste. El enlace caduca; si ya no funciona, solicita uno nuevo.</p>
    <Link className="block underline" href="/login">Volver a iniciar sesión</Link>
  </Card></main>;
}
