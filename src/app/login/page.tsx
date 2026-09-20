import Link from "next/link";
import { signIn } from "./actions";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { AuthCard } from "@/components/ui/AuthCard";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; redirectedFrom?: string }>;
}) {
  const { error, message, redirectedFrom } = await searchParams;

  return (
    <AuthCard subtitle="Inicia sesión en tu cuenta">
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
        <Button type="submit" className="w-full">
          Iniciar sesión
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        ¿No tienes cuenta?{" "}
        <Link href="/register" className="font-medium text-accent hover:text-accent-hover">
          Regístrate
        </Link>
      </p>
    </AuthCard>
  );
}
