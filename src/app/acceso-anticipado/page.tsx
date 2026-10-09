import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/ui/AuthCard";
import { InterestForm } from "@/components/marketing/InterestForm";
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

      <InterestForm action={joinDocumentariesEarlyAccess} registrado={registrado} error={error} consent={<>
        Acepto que Atomivid me escriba sobre el acceso anticipado a documentales. Puedo pedir que borren mi correo
        cuando quiera (ver <Link href="/privacy" className="text-accent hover:text-accent-hover">privacidad</Link>).
      </>} />

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/" className="font-medium text-accent hover:text-accent-hover">Volver al inicio</Link>
      </p>
    </AuthCard>
  );
}
