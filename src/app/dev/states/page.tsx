import { notFound } from "next/navigation";
import { RequestCard } from "@/components/video/RequestCard";
import { ResultView } from "@/components/video/ResultView";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { ContentTypeStep } from "@/app/dashboard/new/ContentTypeStep";
import { noopAction } from "./noop-action";
import type { VideoRequestSummary } from "@/lib/video/request-view";

/**
 * Solo para QA visual local — nunca conecta con Supabase, nunca aparece en
 * producción ni en un build de Vercel (preview incluido: Next hace
 * `next build` con NODE_ENV=production en ambos casos, así que esta
 * condición basta para que la ruta ni siquiera exista fuera de
 * `next dev`). No hay parámetro público que la reactive — el único gate es
 * esta variable de entorno de build, no de runtime consultable desde el
 * cliente.
 */
const FIXTURE_TOPIC = "5 datos curiosos sobre el espacio que no sabías";

// Reloj fijo (no Date.now()) para que estos fixtures sean 100% deterministas
// y esta página no dependa de ninguna llamada impura evaluada en render.
const FIXTURE_NOW_MS = new Date("2026-01-01T12:00:00Z").getTime();

function makeRequest(overrides: Partial<VideoRequestSummary>): VideoRequestSummary {
  return {
    id: "fixture-id",
    topic: FIXTURE_TOPIC,
    style: "Curiosidades",
    duration_seconds: 30,
    language: "es",
    status: "pending",
    video_path: null,
    error_message: null,
    script_json: null,
    progress_stage: null,
    render_attempts: 0,
    render_started_at: null,
    created_at: new Date(FIXTURE_NOW_MS).toISOString(),
    ...overrides,
  };
}

const PENDING = makeRequest({ id: "fixture-pending", status: "pending" });
const PROCESSING = makeRequest({
  id: "fixture-processing",
  status: "processing",
  progress_stage: "footage",
  render_started_at: new Date(FIXTURE_NOW_MS - 60_000).toISOString(),
});
const COMPLETED = makeRequest({
  id: "fixture-completed",
  status: "completed",
  video_path: "fixture/final.mp4",
});
const FAILED = makeRequest({
  id: "fixture-failed",
  status: "failed",
  render_attempts: 3,
  script_json: {},
  error_message: "ElevenLabs respondió 500: error temporal del proveedor de voz.",
});
const LONG_TOPIC = makeRequest({
  id: "fixture-long-topic",
  status: "processing",
  progress_stage: "render",
  render_started_at: new Date(FIXTURE_NOW_MS - 60_000).toISOString(),
  topic:
    "Un tema deliberadamente muy largo para comprobar que el texto no desborda la tarjeta ni el layout en pantallas angostas, incluyendo móvil",
});
const LONG_FORM_PROCESSING = makeRequest({
  id: "fixture-long-form-processing",
  mode: "long_form",
  aspect_ratio: "16:9",
  status: "processing",
  progress_stage: "voice",
  long_form_stage: "ai_video",
  render_started_at: new Date(FIXTURE_NOW_MS - 60_000).toISOString(),
  topic: "Göbekli Tepe: el misterio de 11,000 años que cambió nuestra historia",
});
const LONG_FORM_COMPLETED = makeRequest({
  id: "fixture-long-form-completed",
  mode: "long_form",
  aspect_ratio: "16:9",
  status: "completed",
  video_path: "fixture/longform-final.mp4",
  topic: "Göbekli Tepe: el misterio de 11,000 años que cambió nuestra historia",
});

// video_path falso a propósito: esta ruta no llama a Storage, así que no
// hay una URL firmada real — es solo para comprobar dimensiones/recorte
// del reproductor, no reproducción real.
const FAKE_VIDEO_URL = "https://example.com/fixture-preview.mp4";

export default function DevStatesPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-16 p-6">
      <header>
        <h1 className="text-2xl font-bold text-ink">Estados visuales — solo desarrollo</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Datos simulados, sin ninguna conexión a Supabase. Esta ruta no existe en producción
          ni en un build de Vercel (solo bajo `next dev`). El botón de ayuda flotante (esquina
          inferior derecha) abre el mismo onboarding que ve un usuario en su primera visita al
          dashboard.
        </p>
      </header>

      <Onboarding />

      <Section title="Dashboard vacío">
        <EmptyState
          title="Todavía no has creado ningún contenido"
          description="Crea tu primera solicitud y podrás seguir su progreso desde aquí."
          action={<LinkButton href="/dashboard/new">Crear contenido</LinkButton>}
        />
      </Section>

      <Section title="Selector 'Nuevo video' — con acceso a Avatar y Long Form (cuenta beta)">
        <Card className="p-6">
          <ContentTypeStep
            createVideoRequestAction={noopAction}
            avatarModeEnabled
            existingAvatars={[]}
            avatarAccess
            longFormAccess
          />
        </Card>
      </Section>

      <Section title="Selector 'Nuevo video' — cuenta normal (sin Avatar/Long Form): va directo al formulario">
        <Card className="p-6">
          <ContentTypeStep
            createVideoRequestAction={noopAction}
            avatarModeEnabled={false}
            existingAvatars={[]}
            avatarAccess={false}
            longFormAccess={false}
          />
        </Card>
      </Section>

      <Section title="Solicitud pendiente">
        <RequestCard request={PENDING} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Solicitud procesando">
        <RequestCard request={PROCESSING} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Solicitud completada">
        <RequestCard request={COMPLETED} videoUrl={FAKE_VIDEO_URL} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Solicitud con error">
        <RequestCard request={FAILED} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Tema largo (prueba de desbordamiento)">
        <RequestCard request={LONG_TOPIC} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Long Form (16:9) — procesando">
        <RequestCard request={LONG_FORM_PROCESSING} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Long Form (16:9) — completado">
        <RequestCard request={LONG_FORM_COMPLETED} videoUrl={FAKE_VIDEO_URL} nowMs={FIXTURE_NOW_MS} />
      </Section>

      <Section title="Resultado dedicado — Long Form (16:9) completado">
        <div className="mx-auto max-w-md rounded-lg border border-border p-6">
          <ResultView request={LONG_FORM_COMPLETED} videoUrl={FAKE_VIDEO_URL} nowMs={FIXTURE_NOW_MS} />
        </div>
      </Section>

      <Section title="Resultado dedicado — completado">
        <div className="mx-auto max-w-md rounded-lg border border-border p-6">
          <ResultView request={COMPLETED} videoUrl={FAKE_VIDEO_URL} nowMs={FIXTURE_NOW_MS} />
        </div>
      </Section>

      <Section title="Resultado dedicado — procesando">
        <div className="mx-auto max-w-md rounded-lg border border-border p-6">
          <ResultView request={PROCESSING} nowMs={FIXTURE_NOW_MS} />
        </div>
      </Section>

      <Section title="Resultado dedicado — error">
        <div className="mx-auto max-w-md rounded-lg border border-border p-6">
          <ResultView request={FAILED} nowMs={FIXTURE_NOW_MS} />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-accent">{title}</h2>
      {children}
    </section>
  );
}
