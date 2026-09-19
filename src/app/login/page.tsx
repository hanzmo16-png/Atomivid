import Link from "next/link";
import { signIn } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { Logo } from "@/components/ui/Logo";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; redirectedFrom?: string }>;
}) {
  const { error, message, redirectedFrom } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Link href="/">
            <Logo />
          </Link>
          <p className="text-sm text-ink-muted">Inicia sesión en tu cuenta</p>
        </div>

        <div className="space-y-3">
          {message && <Alert tone="success">{message}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>

        <form action={signIn} className="mt-5 space-y-4">
          {redirectedFrom && <input type="hidden" name="redirectedFrom" value={redirectedFrom} />}
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
          <Field id="password" label="Contraseña">
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="current-password"
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
          </Field>
          <FormSubmitButton label="Iniciar sesión" pendingLabel="Iniciando sesión…" />
        </form>

        <p className="mt-6 text-center text-sm text-ink-muted">
          ¿No tienes cuenta?{" "}
          <Link href="/register" className="font-medium text-accent hover:text-accent-hover">
            Regístrate
          </Link>
        </p>
      </Card>
    </div>
  );
}
