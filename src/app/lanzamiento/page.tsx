import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/ui/AuthCard";
import { InterestForm } from "@/components/marketing/InterestForm";
import { precampaignDemoUrl } from "@/lib/marketing/precampaign";
import { joinPrecampaignLaunchList } from "./actions";

export const metadata: Metadata = {
  title: "Tus ideas merecen convertirse en videos · Atomivid",
  description: "Estamos preparando Atomivid. Apúntate para conocer el lanzamiento. Sin cobro y sin compromiso.",
  robots: { index: false },
};

/**
 * Precampaign interest page. Reuses the launch list of /avisame (same table and product) and the shared
 * InterestForm (email, explicit consent, honeypot, confirmation). It states no price, date or places, and it
 * is not linked from the landing: the campaign links it only once it has been reviewed in production.
 */
export default async function PrecampaignPage({ searchParams }: { searchParams: Promise<{ error?: string; registrado?: string }> }) {
  const { error, registrado } = await searchParams;
  const demo = precampaignDemoUrl(process.env);
  return (
    <AuthCard subtitle="Tus ideas merecen convertirse en videos">
      <div className="space-y-3 text-sm text-ink-muted">
        <p>
          Estamos preparando Atomivid para ayudarte a convertir tus ideas en contenido: desde el guion y la voz hasta
          las imágenes, los subtítulos y, si quieres, tu propio avatar.
        </p>
        {demo && (
          <figure className="space-y-1">
            <video src={demo} controls playsInline preload="metadata" className="w-full rounded-lg border border-border bg-black" />
            <figcaption className="text-xs text-ink-faint">Resultados de nuestras pruebas.</figcaption>
          </figure>
        )}
        <p>
          Todavía estamos afinando la experiencia. Si te apuntas, te escribiremos para contarte cuándo puedes probarlo.{" "}
          <strong className="text-ink">No hay cobro ni fecha comprometida</strong> y apuntarte no te da acceso inmediato.
        </p>
      </div>

      <InterestForm action={joinPrecampaignLaunchList} registrado={registrado} error={error} consent={<>
        Acepto que Atomivid me escriba sobre el lanzamiento. Puedo pedir que borren mi correo cuando quiera (ver{" "}
        <Link href="/privacy" className="text-accent hover:text-accent-hover">privacidad</Link>).
      </>} />

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/" className="font-medium text-accent hover:text-accent-hover">Volver al inicio</Link>
      </p>
    </AuthCard>
  );
}
