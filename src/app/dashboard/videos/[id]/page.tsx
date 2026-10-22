import { StartErrorNotice, StartOutcomeProvider } from "@/components/video/StartErrorNotice";
import { describeStoredFailure } from "@/lib/video/job-error";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canonicalThumbnailPath } from "@/lib/video/long-form/packaging";
import { isProductionPlan } from "@/lib/video/long-form/production-plan-types";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import { selectIfOwned, type OwnedRequestRow } from "@/lib/video/access";
import { ResultView } from "@/components/video/ResultView";
import { createServiceClient } from "@/lib/supabase/service";
import { closeExhaustedStaleAttempt } from "@/lib/video/exhausted-attempt";
import { EXHAUSTED_ATTEMPT_CLOSED } from "@/lib/video/start-outcome";
import { loadAvatarRecovery } from "@/lib/video/avatar/recovery";
import { Alert } from "@/components/ui/Alert";
import { AutoRefresh } from "@/app/dashboard/AutoRefresh";
import { cinematicDirectorRenderEnabled } from "@/lib/video/director/flag";
import { loadDirectorApplied, loadDirectorRequested } from "@/lib/video/director-applied";
import { DirectorAppliedPanel } from "@/components/video/DirectorAppliedPanel";

export default async function VideoResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirectedFrom=${encodeURIComponent(`/dashboard/videos/${id}`)}`);
  }

  // Filtro explícito por user_id en la consulta (además de RLS) y una
  // segunda comprobación de propiedad antes de renderizar (selectIfOwned)
  // — nunca se confía solo en el id recibido por la URL. Cualquier
  // resultado que no pertenezca a este usuario se trata exactamente igual
  // que "no existe": notFound(), nunca un mensaje que confirme que la fila
  // sí existe pero es de otra persona.
  const { data, error } = await supabase
    .from("video_requests")
    .select(
      "id, mode, user_id, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at, aspect_ratio, long_form_stage, long_form_progress, long_form_production_plan, long_form_confirmed_at, recorded_audio_path, avatar_provider_video_job_id, supply_wait_started_at, supply_not_before",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<OwnedRequestRow & { long_form_production_plan: unknown }>();

  // Mismo blocker real del Historial (ver history-view.ts): un fallo de
  // consulta (p. ej. una migración aditiva todavía no aplicada) nunca debe
  // tratarse igual que "esta solicitud no existe o no es tuya" — eso
  // produciría un 404 engañoso para una solicitud real. Solo `!data` tras
  // una consulta SIN error significa genuinamente "no encontrado".
  if (error) {
    const diagnosticId = randomUUID().split("-")[0];
    console.error(`[historial:${id}] [${diagnosticId}] no se pudo cargar la solicitud:`, error);
    return (
      <div className="mx-auto max-w-md mt-4">
        <Alert tone="danger" role="alert">
          No se pudo cargar esta solicitud. Si acabas de crearla, no se perdió — recarga la
          página en un momento. Si el problema sigue, contacta al soporte.
        </Alert>
      </div>
    );
  }

  const request = selectIfOwned(data, user.id);
  if (!request) {
    notFound();
  }
  // Intento colgado sin intentos restantes: estado final aquí mismo (antes quedaba «processing» para siempre).
  if ((await closeExhaustedStaleAttempt(createServiceClient(), request).catch(() => "changed" as const)) === "closed") {
    Object.assign(request, { status: "failed", progress_stage: null, error_message: EXHAUSTED_ATTEMPT_CLOSED });
  }

  const videoUrl =
    request.status === "completed" && request.video_path
      // A documentary can be ~0.5 GB: give a slow phone time to watch or download it before the link expires.
      ? await getSignedVideoUrl(request.video_path, request.mode === "long_form" ? 6 * 3600 : 3600)
      : null;
  // Miniatura de YouTube de Long Form (opcional): solo existe si se pidió al confirmar la producción.
  const plan = data?.long_form_production_plan;
  const thumbnailRequested = request.mode === "long_form" && isProductionPlan(plan) && plan.version >= 3 && plan.packaging?.thumbnail?.enabled === true;
  const thumbnailUrl =
    thumbnailRequested && request.status === "completed" ? await getSignedVideoUrl(canonicalThumbnailPath(request.id)) : null;

  // Server Component evaluado una vez por request (mismo patrón que
  // dashboard/page.tsx). AutoRefresh vuelve a pedir ESTA página al backend
  // de Atomivid mientras siga "processing" — el progreso siempre sale de la
  // base de datos, nunca de estado del navegador.
  // eslint-disable-next-line react-hooks/purity -- ver comentario arriba
  const nowMs = Date.now();
  // Failed avatar: same server-side recovery rule as the history card and the render route.
  const avatarRecovery = request.mode === "avatar" && request.status === "failed"
    ? await loadAvatarRecovery(createServiceClient(), request.id, { status: request.status, render_attempts: request.render_attempts,
        avatar_provider_video_job_id: request.avatar_provider_video_job_id ?? null, video_path: request.video_path })
    : undefined;
  // Director (only with CINEMATIC_DIRECTOR_RENDER_ENABLED): which recipe was applied to each shot of this video.
  const directorRows = cinematicDirectorRenderEnabled() && request.status === "completed" && request.video_path && request.mode !== "long_form" && request.mode !== "avatar"
    ? await loadDirectorApplied(createServiceClient(), request.video_path)
    : null;
  // T-34 B3: a completed Reel that requested the Director but has no valid record for THIS attempt says so plainly.
  const directorRequested = request.status === "completed" && request.mode === "visual" && await loadDirectorRequested(supabase, request.id);
  return (
    <div className="mx-auto max-w-md">
      <AutoRefresh active={request.status === "processing"} />
      {/* One typed outcome for the notice and every start/retry action on this page. */}
      <StartOutcomeProvider requestId={request.id} status={request.status} attempts={request.render_attempts}>
        <StartErrorNotice retryAvailable={request.render_attempts < MAX_RENDER_ATTEMPTS}
          supportRequired={request.status === "failed" && Boolean(request.error_message) && describeStoredFailure(request.error_message!).action === "support"} />
        <ResultView request={request} videoUrl={videoUrl} thumbnailUrl={thumbnailUrl} thumbnailRequested={thumbnailRequested} nowMs={nowMs} avatarRecovery={avatarRecovery} />
      </StartOutcomeProvider>
      {directorRows && directorRows.length > 0 && <DirectorAppliedPanel rows={directorRows} />}
      {directorRequested && (!directorRows || directorRows.length === 0) && (
        <p role="status" className="my-4 rounded-lg border border-border bg-surface p-4 text-sm text-ink-muted" data-testid="director-no-evidence">
          Director solicitado, sin evidencia de aplicación en este video: no se encontró un registro válido del Director para este intento, así que no se muestra como aplicado. Si esperabas el Director, contacta a soporte con el código del video.
        </p>
      )}
    </div>
  );
}
