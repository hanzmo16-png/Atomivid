import Link from "next/link";
import { signUp } from "./actions";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { AuthCard } from "@/components/ui/AuthCard";
import { PLAN_CONFIGS } from "@/lib/billing/plans";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <AuthCard subtitle="Crea tu cuenta">
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
        <Button type="submit" className="w-full">
          Crear cuenta
        </Button>
        <p className="text-xs leading-relaxed text-ink-faint">
          Crear la cuenta no tiene costo. Para generar guiones y videos necesitas un plan de pago (desde {PLAN_CONFIGS.starter.priceUsdPerMonth} USD al mes);
          no hay prueba gratuita. Al crear tu cuenta aceptas los{" "}
          <Link href="/terms" className="text-accent hover:text-accent-hover">Términos</Link> y la{" "}
          <Link href="/privacy" className="text-accent hover:text-accent-hover">Política de privacidad</Link>.
        </p>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        ¿Ya tienes cuenta?{" "}
        <Link href="/login" className="font-medium text-accent hover:text-accent-hover">
          Inicia sesión
        </Link>
      </p>
    </AuthCard>
  );
}
