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
import { isRenderStale } from "@/lib/video/render-guard";
import { loadAvatarRecoveries } from "@/lib/video/avatar/recovery";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import Link from "next/link";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; script_job?: string }>;
}) {
  const { created, script_job } = await searchParams;
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
  const firstName = user?.email?.split("@")[0];
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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-ink-muted">
            {firstName ? `Hola, ${firstName}` : "Tus videos"}
          </p>
          <h1 className="text-2xl font-bold text-ink">Tus videos</h1>
        </div>
        <LinkButton href="/dashboard/new" className="w-full sm:w-auto">
          Nuevo video
        </LinkButton>
      </div>

      <div className="mt-4 space-y-3">
        {internalOwner && (
          <Alert tone="info">
            Plan Propietario activo: producción al costo de proveedores, con los topes de gasto configurados.{" "}
            <Link href="/dashboard/billing" className="font-medium underline">
              Ver mi plan
            </Link>
          </Alert>
        )}
        {!subscribed && !internalOwner && (
          <Alert tone="info">
            Necesitas una suscripción activa para generar videos.{" "}
            <Link href="/dashboard/billing" className="font-medium underline">
              Suscribirme
            </Link>
          </Alert>
        )}

        {script_job && <Alert tone="info">La preparación está guardada. Puedes salir; el progreso aparecerá en tu historial.</Alert>}
        {created && (
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
            action={<LinkButton href="/dashboard/new">Crear contenido</LinkButton>}
          />
        </div>
      )) : (
        <ul className="mt-6 space-y-3">
          {historyState.requests.map((req) => (
            <li key={req.id}>
              <RequestCard
                request={req}
                videoUrl={req.video_path ? videoUrlByPath.get(req.video_path) : null}
                nowMs={nowMs}
                avatarRecovery={avatarRecoveries.get(req.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
