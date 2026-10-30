import { ScriptJobCard } from "@/components/video/ScriptJobCard";
import { scriptJobView, SCRIPT_JOB_COLUMNS, type ScriptJobSummary } from "@/lib/video/long-form/script-job-types";
import { reconcileStaleScriptJobs } from "@/lib/video/long-form/script-jobs";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import type { VideoRequestSummary } from "@/lib/video/request-view";
import { resolveHistoryViewState } from "@/lib/video/history-view";
import { AutoRefresh } from "./AutoRefresh";
import { RequestCard } from "@/components/video/RequestCard";
import { createServiceClient } from "@/lib/supabase/service";
import { isExhaustedStaleAttempt, isRenderStale } from "@/lib/video/render-guard";
import { closeExhaustedStaleAttempt } from "@/lib/video/exhausted-attempt";
import { EXHAUSTED_ATTEMPT_CLOSED } from "@/lib/video/start-outcome";
import { loadAvatarRecoveries } from "@/lib/video/avatar/recovery";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import Link from "next/link";
import { DraftKeyRotation } from "./DraftKeyRotation";
import { CreateHome } from "@/components/dashboard/simple-create/CreateHome";
import { createFormats, midFlow, splitHistory } from "@/components/dashboard/simple-create/home";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { studioFlagFor } from "@/lib/podcast/v3/studio";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; draft?: string; existing?: string; script_job?: string }>;
}) {
  const { created, draft, existing, script_job } = await searchParams;
  // Simple UX 1.0: la pantalla empieza por «¿Qué quieres crear hoy?»; si se vuelve aquí a mitad de un flujo (solicitud
  // recién creada, guion en preparación), el historial va primero para no esconder la acción pendiente.
  const mid = midFlow({ created, draft, existing, script_job });
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: requests, error: requestsError } = await supabase
    .from("video_requests")
    .select(
      "id, mode, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at, aspect_ratio, long_form_stage, long_form_progress, long_form_confirmed_at, recorded_audio_path, supply_wait_started_at, avatar_provider_video_job_id",
    )
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false })
    .returns<VideoRequestSummary[]>();

  if (user) await reconcileStaleScriptJobs(user.id).catch(() => {});
  // Intentos colgados sin intentos restantes: estado final aquí mismo (antes quedaban «processing» para siempre).
  for (const r of requests ?? []) {
    if (!isExhaustedStaleAttempt(r)) continue;
    const outcome = await closeExhaustedStaleAttempt(createServiceClient(), r).catch(() => "changed" as const);
    if (outcome === "closed") Object.assign(r, { status: "failed", progress_stage: null, error_message: EXHAUSTED_ATTEMPT_CLOSED });
  }
  const { data: scriptJobs, error: scriptJobsError } = await supabase.from("documentary_script_jobs")
    .select(SCRIPT_JOB_COLUMNS)
    .eq("user_id", user?.id ?? "").neq("status","completed").order("created_at",{ascending:false}).limit(30)
    .returns<ScriptJobSummary[]>();

  // QA blocker real (2026-09-25): un fallo de esta consulta (p. ej. una
  // migración aditiva todavía no aplicada en producción, como pasó con
  // aspect_ratio/long_form_stage) NUNCA debe tratarse igual que "cero
  // solicitudes" — eso le mintió a un usuario con una solicitud real recién
  // creada. resolveHistoryViewState() hace esa distinción obligatoria; ver
  // history-view.test.ts para la regresión exacta.
  const historyState = resolveHistoryViewState(requests, requestsError);
  if (requestsError) {
    const diagnosticId = randomUUID().split("-")[0];
    console.error(`[historial] [${diagnosticId}] no se pudo cargar video_requests:`, requestsError);
  }

  // Las URLs de reproducción/descarga se firman aquí, después de que la
  // consulta de arriba ya filtró por RLS a las solicitudes del usuario
  // actual — nunca se firma un objeto sin haber confirmado antes que la
  // fila pertenece a quien está viendo el historial.
  const completedRequests = (requests ?? []).filter(
    (r) => r.status === "completed" && r.video_path,
  );
  const signedUrls = await Promise.all(
    completedRequests.map((r) => getSignedVideoUrl(r.video_path!, r.mode === "long_form" ? 6 * 3600 : 3600)),
  );
  const videoUrlByPath = new Map(
    completedRequests.map((r, i) => [r.video_path!, signedUrls[i]]),
  );

  const { data: subscriptionData } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user?.id ?? "")
    .maybeSingle();

  const subscribed = isSubscriptionActive(
    (subscriptionData as { status: string } | null)?.status,
  );

  const hasProcessing = (requests ?? []).some((r) => r.status === "processing");
  const internalOwner = isInternalProductionOwner(user);
  const formats = createFormats({ podcast: canAccessLongFormBeta(user) && studioFlagFor(user).enabled, youtube: canAccessLongFormBeta(user) });
  // Server Component: se evalúa una sola vez por request en el servidor
  // (no hay re-render en el cliente que pueda desincronizarse), así que
  // Date.now() aquí es seguro pese a la regla de pureza de React.
  /* eslint-disable-next-line react-hooks/purity -- ver comentario arriba */
  const nowMs = Date.now();
  // Avatar recovery is decided from each request's real state + its paid ledger (rows above already
  // passed the owner filter), with the same rule the render route enforces.
  const avatarRecoveries = await loadAvatarRecoveries(createServiceClient(), (requests ?? [])
    .filter((r) => r.mode === "avatar" && (r.status === "failed" || (r.status === "processing" && isRenderStale(r, nowMs))))
    .map((r) => ({ id: r.id, status: r.status, render_attempts: r.render_attempts, avatar_provider_video_job_id: r.avatar_provider_video_job_id ?? null, video_path: r.video_path })));

  return (
    <div>
      <AutoRefresh active={hasProcessing || (scriptJobs ?? []).some(job => scriptJobView(job, nowMs).refresh)} />

      {!mid && (
        <div id="crear" className="scroll-mt-20">
          <CreateHome formats={formats} subscriptionNeeded={!subscribed && !internalOwner} />
        </div>
      )}

      <h2 id="proyectos" className={`${mid ? "" : "mt-12 "}text-xl font-semibold text-ink`}>Mis proyectos</h2>
      {mid && <p className="mt-1 text-sm"><Link href="/dashboard#crear" className="text-accent underline">Crear algo nuevo</Link></p>}

      <div className="mt-4 space-y-3">
        {/* En la portada este aviso va junto a «Continuar»; aquí solo a mitad de un flujo. */}
        {mid && !subscribed && !internalOwner && (
          <Alert tone="info">
            Necesitas una suscripción activa para generar videos.{" "}
            <Link href="/dashboard/billing" className="font-medium underline">
              Suscribirme
            </Link>
          </Alert>
        )}

        {script_job && <Alert tone="info">La preparación está guardada. Puedes salir; el progreso aparecerá en tu historial.</Alert>}
        {created && <DraftKeyRotation draft={draft} />}
        {created && existing && (
          <Alert tone="info">
            Ya tenías una solicitud con exactamente estos datos, así que no se creó otra ni se cobró nada nuevo. Si quieres
            otro video igual, marca «Crear otro video igual» en el formulario.
          </Alert>
        )}
        {created && !existing && (
          <Alert tone="success">
            Tu solicitud se guardó correctamente. Pulsa &quot;Generar guion&quot; para
            crear el guion — podrás revisarlo y editarlo antes de generar el video final.
          </Alert>
        )}
      </div>

      {scriptJobsError && <Alert tone="danger">No se pudo consultar la preparación de guiones. No crees otra solicitud: vuelve a cargar el historial.</Alert>}
      {(scriptJobs ?? []).length > 0 && <ul className="mt-6 space-y-3">{scriptJobs!.map(job => <li key={job.id}><ScriptJobCard job={job} nowMs={nowMs}/></li>)}</ul>}
      {historyState.kind === "error" ? (
        <div className="mt-4">
          <Alert tone="danger" role="alert">
            No se pudo cargar tu historial. Si acabas de crear una solicitud, no se perdió —
            recarga la página en un momento. Si el problema sigue, contacta al soporte.
          </Alert>
        </div>
      ) : historyState.kind === "empty" ? ((scriptJobs?.length || scriptJobsError) ? null : (
        <div className="mt-10">
          <EmptyState
            icon={
              <svg width="22" height="22" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
              </svg>
            }
            title="Todavía no has creado ningún contenido"
            description="Crea tu primera solicitud y podrás seguir su progreso desde aquí."
            action={<LinkButton href="/dashboard#crear">Crear contenido</LinkButton>}
          />
        </div>
      )) : (() => {
        const { visible, old } = splitHistory(historyState.requests, nowMs);
        const card = (req: (typeof visible)[number]) => (
          <li key={req.id}>
            <RequestCard request={req} videoUrl={req.video_path ? videoUrlByPath.get(req.video_path) : null} nowMs={nowMs} avatarRecovery={avatarRecoveries.get(req.id)} />
          </li>
        );
        return (<>
          {visible.length > 0 && <ul className="mt-6 space-y-3">{visible.map(card)}</ul>}
          {old.length > 0 && (
            <details className="mt-6 rounded-lg border border-border p-3" data-testid="proyectos-antiguos">
              <summary className="cursor-pointer text-sm font-medium text-ink-muted">Proyectos antiguos sin terminar ({old.length})</summary>
              <p className="mt-2 text-xs text-ink-muted">Pruebas y producciones que no terminaron hace más de 7 días. No se borró nada.</p>
              <ul className="mt-3 space-y-3">{old.map(card)}</ul>
            </details>
          )}
        </>);
      })()}
    </div>
  );
}
