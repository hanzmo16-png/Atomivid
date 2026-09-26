import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { RequestCard } from "@/components/video/RequestCard";
import { ResultView } from "@/components/video/ResultView";
import { ProductionProgressCard } from "@/components/video/ProductionProgressCard";
import { ConfigureProduction } from "@/app/dashboard/long-form/configure/[id]/ConfigureProduction";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, VISUAL_STRATEGIES, type ProductionPlan, type VisualStrategy } from "@/lib/video/long-form/production-plan";
import { documentary180sFixture } from "@/lib/video/long-form/test-fixtures";
import type { VideoRequestSummary } from "@/lib/video/request-view";

/**
 * QA visual de Long Form (móvil/escritorio) — solo `next dev`, datos
 * simulados, sin Supabase ni proveedores. Los planes salen del motor real
 * (computeProductionPlan) sobre el documental de prueba de 180 s.
 */
const NOW = new Date("2026-09-25T12:20:00Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function request(overrides: Partial<VideoRequestSummary>): VideoRequestSummary {
  return {
    id: "dev-lf",
    mode: "long_form",
    aspect_ratio: "16:9",
    topic: "El Canal de Panamá: la obra que cambió el comercio mundial",
    style: "Documental",
    duration_seconds: 180,
    language: "es",
    status: "processing",
    video_path: null,
    error_message: null,
    script_json: {},
    progress_stage: "voice",
    render_attempts: 1,
    render_started_at: iso(12 * 60_000),
    created_at: iso(20 * 60_000),
    long_form_confirmed_at: iso(13 * 60_000),
    ...overrides,
  };
}

const ASSETS = request({
  long_form_stage: "assets",
  long_form_progress: { stage: "assets", unitsCompleted: 17, unitsTotal: 45, unitLabel: "escenas", updatedAt: iso(20_000), stageStartedAt: iso(6 * 60_000) },
});
const LEGACY_FAILED = request({
  id: "dev-lf-legacy",
  status: "failed",
  long_form_confirmed_at: null,
  error_message: "Modo real de Long Form solicitado sin confirmación explícita. (Código: ab12cd34)",
});

export default function DevLongFormPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const script = documentary180sFixture();
  const plans = Object.fromEntries(
    VISUAL_STRATEGIES.map((strategy) => [
      strategy,
      computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true }),
    ]),
  ) as Record<VisualStrategy, ProductionPlan>;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-12 px-4 py-6">
      <h1 className="text-xl font-bold text-ink">Long Form — estados (solo desarrollo)</h1>

      <section id="configure">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Configurar producción</h2>
        <ConfigureProduction
          requestId="dev-lf"
          plans={plans}
          ownChannel
          defaultPackaging={{
            cover: { enabled: true, style: "impacto", title: "Cavar una *montaña*", kicker: "Canal de Panamá · 1881–1914" },
            thumbnail: { enabled: true, style: "alerta", title: "Cavar una *montaña*", kicker: "Canal de Panamá" },
          }}
        />
      </section>

      <section id="progress">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Progreso — en cola / narración / escenas / render</h2>
        <div className="space-y-4">
          <ProductionProgressCard longFormStage={null} longFormProgress={null} nowMs={NOW} />
          <ProductionProgressCard
            longFormStage="storyboard"
            longFormProgress={{ stage: "storyboard", unitsCompleted: 2, unitsTotal: 5, unitLabel: "narraciones", updatedAt: iso(5_000), stageStartedAt: iso(40_000) }}
            nowMs={NOW}
          />
          <ProductionProgressCard longFormStage="assets" longFormProgress={ASSETS.long_form_progress} nowMs={NOW} />
          <ProductionProgressCard
            longFormStage="rendering"
            longFormProgress={{ stage: "rendering", unitsCompleted: 2700, unitsTotal: 5460, unitLabel: "fotogramas", updatedAt: iso(10_000), stageStartedAt: iso(4 * 60_000) }}
            nowMs={NOW}
          />
        </div>
      </section>

      <section id="history">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Historial</h2>
        <div className="space-y-3">
          <RequestCard request={ASSETS} nowMs={NOW} />
          <RequestCard request={request({ status: "script_ready", long_form_confirmed_at: null, render_attempts: 0 })} nowMs={NOW} />
          <RequestCard request={LEGACY_FAILED} nowMs={NOW} />
          <RequestCard request={request({ status: "completed", video_path: "x.mp4" })} videoUrl="https://example.com/x.mp4" nowMs={NOW} />
        </div>
      </section>

      <section id="result">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Resultado — procesando / error</h2>
        <Card className="space-y-8 p-4">
          <ResultView request={ASSETS} nowMs={NOW} />
          <ResultView
            request={request({ status: "failed", error_message: "No se pudo completar este intento. (Código: 9f8e7d6c)" })}
            nowMs={NOW}
          />
        </Card>
      </section>
    </div>
  );
}
