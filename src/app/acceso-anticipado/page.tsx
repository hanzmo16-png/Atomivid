import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/ui/AuthCard";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { joinDocumentariesEarlyAccess } from "./actions";

export const metadata: Metadata = {
  title: "Documentales para YouTube — acceso anticipado · Atomivid",
  description: "Apúntate a la lista de acceso anticipado de documentales 16:9 para YouTube. Sin cobro y sin compromiso.",
};

/**
 * Interest list for documentaries (16:9, YouTube). Records an email with consent; it never charges and
 * never grants access. What the page states is what was verified in production on 2026-10-09.
 */
export default async function EarlyAccessPage({ searchParams }: { searchParams: Promise<{ error?: string; registrado?: string }> }) {
  const { error, registrado } = await searchParams;
  const done = registrado === "1" || registrado === "ya";
  return (
    <AuthCard subtitle="Documentales para YouTube · acceso anticipado">
      <div className="space-y-3 text-sm text-ink-muted">
        <p>
          Estamos probando la producción de documentales horizontales (16:9, 1080p) a partir de un tema: guion
          investigado, narración con IA, imágenes de archivo y montaje, con el costo estimado visible antes de producir.
        </p>
        <p>
          Por ahora está disponible solo para un grupo reducido. Si te apuntas, te escribiremos cuando abramos más
          lugares. <strong className="text-ink">No hay cobro, no hay fecha comprometida</strong> y apuntarte no te da acceso inmediato.
        </p>
      </div>

      {done ? (
        <div className="mt-5">
          <Alert tone="success" role="status">
            {registrado === "ya" ? "Este correo ya estaba en la lista. No tienes que hacer nada más." : "Tu solicitud quedó registrada. Te escribiremos cuando haya lugar."}
          </Alert>
        </div>
      ) : (
        <form action={joinDocumentariesEarlyAccess} className="mt-5 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field id="email" label="Correo electrónico">
            <input id="email" name="email" type="email" required autoComplete="email" className={INPUT_CLASS} placeholder="tu@correo.com" />
          </Field>
          {/* Honeypot: hidden from people and assistive tech; automated form fillers tend to complete it. */}
          <div className="hidden" aria-hidden="true">
            <label htmlFor="website">Sitio web</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-muted">
            <input type="checkbox" name="consent" required className="mt-1" />
            <span>
              Acepto que Atomivid me escriba sobre el acceso anticipado a documentales. Puedo pedir que borren mi correo
              cuando quiera (ver <Link href="/privacy" className="text-accent hover:text-accent-hover">privacidad</Link>).
            </span>
          </label>
          <Button type="submit" className="w-full">Apuntarme a la lista</Button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/" className="font-medium text-accent hover:text-accent-hover">Volver al inicio</Link>
      </p>
    </AuthCard>
  );
}
