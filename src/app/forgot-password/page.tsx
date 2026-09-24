import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { AuthCard } from "@/components/ui/AuthCard";
import { RECOVERY_MESSAGE } from "@/lib/auth/recovery";
import { requestPasswordReset } from "./actions";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return (
    <AuthCard subtitle="Recupera el acceso a tu cuenta">
      <div className="space-y-3">
        {sent === "1" && !error && <Alert tone="success">{RECOVERY_MESSAGE}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      <p className="mt-3 text-sm text-ink-muted">
        Te enviaremos un enlace de un solo uso para crear una contraseña nueva.
      </p>

      <form action={requestPasswordReset} className="mt-5 space-y-4">
        <Field id="email" label="Correo de tu cuenta">
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            className={INPUT_CLASS}
            placeholder="tu@correo.com"
          />
        </Field>
        <Button type="submit" className="w-full">
          Enviar enlace de recuperación
        </Button>
      </form>

      <p className="mt-4 text-xs text-ink-faint">
        Abre el correo en el mismo navegador donde lo solicitaste. El enlace caduca; si ya no
        funciona, solicita uno nuevo.
      </p>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-medium text-accent hover:text-accent-hover">
          Volver a iniciar sesión
        </Link>
      </p>
    </AuthCard>
  );
}
