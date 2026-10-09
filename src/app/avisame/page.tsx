import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/ui/AuthCard";
import { InterestForm } from "@/components/marketing/InterestForm";
import { PLAN_CONFIGS } from "@/lib/billing/plans";
import { joinReelsLaunchList } from "./actions";

export const metadata: Metadata = {
  title: "Reels/Shorts — avísame cuando abran los pagos · Atomivid",
  description: "Apúntate para saber cuándo puedes contratar Atomivid para Reels y Shorts verticales. Sin cobro y sin compromiso.",
};

/** Launch list for Reels/Shorts while purchases are not open yet. Records an email with consent only. */
export default async function ReelsLaunchListPage({ searchParams }: { searchParams: Promise<{ error?: string; registrado?: string }> }) {
  const { error, registrado } = await searchParams;
  return (
    <AuthCard subtitle="Reels/Shorts · aviso de apertura">
      <div className="space-y-3 text-sm text-ink-muted">
        <p>
          Atomivid produce Reels/Shorts verticales (1080×1920) a partir de un tema: guion que revisas antes de producir,
          narración con IA, clips, música y subtítulos. Los planes empezarán en {PLAN_CONFIGS.starter.priceUsdPerMonth} USD al mes.
        </p>
        <p>
          Todavía no estamos aceptando pagos. Si te apuntas, te escribiremos cuando puedas contratar un plan.{" "}
          <strong className="text-ink">No hay cobro ni fecha comprometida.</strong>
        </p>
      </div>
      <InterestForm action={joinReelsLaunchList} registrado={registrado} error={error} consent={<>
        Acepto que Atomivid me escriba cuando abran los planes de Reels/Shorts. Puedo pedir que borren mi correo cuando
        quiera (ver <Link href="/privacy" className="text-accent hover:text-accent-hover">privacidad</Link>).
      </>} />
      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/" className="font-medium text-accent hover:text-accent-hover">Volver al inicio</Link>
      </p>
    </AuthCard>
  );
}
