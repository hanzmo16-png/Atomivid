import Link from "next/link";
import { signUp } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { Logo } from "@/components/ui/Logo";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Link href="/">
            <Logo />
          </Link>
          <p className="text-sm text-ink-muted">Crea tu cuenta</p>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <form action={signUp} className="mt-5 space-y-4">
          <Field id="email" label="Correo electrónico">
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={INPUT_CLASS}
              placeholder="tu@correo.com"
            />
          </Field>
          <Field id="password" label="Contraseña" hint="Mínimo 6 caracteres.">
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
          </Field>
          <FormSubmitButton label="Crear cuenta" pendingLabel="Creando cuenta…" />
        </form>

        <p className="mt-6 text-center text-sm text-ink-muted">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className="font-medium text-accent hover:text-accent-hover">
            Inicia sesión
          </Link>
        </p>
      </Card>
    </div>
  );
}
