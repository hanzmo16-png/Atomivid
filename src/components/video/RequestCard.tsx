import { isRenderStale } from "@/lib/video/render-guard";
import { renderFailureMessage } from "@/lib/video/job-error";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ModeBadge } from "./ModeBadge";
import { RENDER_STAGE_LABEL, type RenderStage } from "@/lib/video/stages";
import { LONG_FORM_STAGE_LABEL, type LongFormStage } from "@/lib/video/long-form/stages";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import { STATUS_LABEL, STATUS_TONE, pendingRequestCta, type VideoRequestSummary } from "@/lib/video/request-view";
import { computeProductionProgress, isLongFormProgress, type ProgressStageKey } from "@/lib/video/long-form/progress";
import { GenerateButton } from "@/app/dashboard/GenerateButton";

/**
 * Tarjeta de una solicitud en el historial. Puramente presentacional —
 * recibe la fila y la URL firmada ya resueltas (ninguna llamada a
 * Supabase aquí), para poder reutilizarla tal cual en /dev/states con
 * datos simulados sin arriesgar que la vista real y la de desarrollo se
 * desincronicen.
 */
export function RequestCard({
  request,
  videoUrl,
  /** Reloj usado para "¿lleva colgada demasiado tiempo?" — siempre lo pasa
   * el caller (Date.now() no puede ser un default aquí: es una llamada
   * impura evaluada en cada render). En producción el caller pasa la hora
   * real; /dev/states inyecta una fija. */
  nowMs,
}: {
  request: VideoRequestSummary;
  videoUrl?: string | null;
  nowMs: number;
}) {
  const isStaleProcessing = isRenderStale(request, nowMs);
  const attemptsExhausted = request.render_attempts >= MAX_RENDER_ATTEMPTS;
  // Long Form solo puede reintentarse con un plan ya confirmado (render/route.ts
  // lo exige). Una solicitud anterior al plan de producción (p. ej. la
  // primera prueba real) no tiene confirmación y su guion ya no está en
  // "script_ready": ofrecer "Reintentar" ahí solo devolvería un error.
  const longFormUnconfirmed = request.mode === "long_form" && !request.long_form_confirmed_at;
  const canRetry = !attemptsExhausted && request.mode !== "avatar" && !longFormUnconfirmed;
  const detailHref = `/dashboard/videos/${request.id}`;
  const isLongForm = request.mode === "long_form";
  const isLandscape = request.aspect_ratio === "16:9";
  const stageLabel = isLongForm
    ? request.long_form_stage &&
      (LONG_FORM_STAGE_LABEL[request.long_form_stage as LongFormStage] ?? request.long_form_stage)
    : request.progress_stage &&
      (RENDER_STAGE_LABEL[request.progress_stage as RenderStage] ?? request.progress_stage);
  const longFormProgress =
    isLongForm && isLongFormProgress(request.long_form_progress) && request.long_form_progress.stage === request.long_form_stage
      ? request.long_form_progress
      : null;
  const longFormPercent =
    isLongForm && request.long_form_stage
      ? computeProductionProgress({
          stage: request.long_form_stage as ProgressStageKey,
          unitsCompleted: longFormProgress?.unitsCompleted ?? 0,
          unitsTotal: longFormProgress?.unitsTotal ?? 0,
        })
      : null;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href={detailHref} className="block truncate font-medium text-ink hover:text-accent">
              {request.topic}
            </Link>
            {(request.mode === "avatar" || isLongForm) && <ModeBadge mode={request.mode as "avatar" | "long_form"} />}
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {request.style} · {request.duration_seconds}s ·{" "}
            {new Date(request.created_at).toLocaleString("es-MX")}
          </p>
          {request.status === "failed" && request.error_message && (
            <p className="mt-2 max-w-md text-sm text-danger">{renderFailureMessage(request.error_message)}</p>
          )}
          {request.status === "processing" && !isStaleProcessing && stageLabel && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none" aria-hidden="true" />
              <span className="min-w-0">
                {stageLabel}…
                {longFormProgress && longFormProgress.unitsTotal > 0 && (
                  <span className="tabular-nums">
                    {" "}
                    ({longFormProgress.unitsCompleted}/{longFormProgress.unitsTotal} {longFormProgress.unitLabel})
                  </span>
                )}
                {longFormPercent !== null && <span className="tabular-nums"> · {longFormPercent}%</span>}
              </span>
            </p>
          )}
          {request.status === "processing" && isStaleProcessing && (
            <p className="mt-2 max-w-md text-sm text-warning">
              Esto está tardando más de lo normal.{" "}
              {request.mode === "avatar" ? "La prueba privada requiere revisión antes de otro intento." : attemptsExhausted
                ? "Se alcanzó el máximo de intentos para este video."
                : "El progreso quedó detenido. Puedes iniciar un nuevo intento desde aquí; no se reinicia automáticamente."}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>
            {STATUS_LABEL[request.status] ?? request.status}
          </Badge>

          {request.status === "pending" && <GenerateButton {...pendingRequestCta(request.id)} />}
          {request.status === "script_ready" &&
            (isLongForm ? (
              // RC mission "LONG FORM RC FINAL HARDENING": ya no dispara el
              // render directo — primero pasa por "Configurar producción"
              // (estrategia visual + costo estimado + confirmación
              // explícita, ver configure/[id]/page.tsx). El guion ya se
              // generó con fuentes verificadas al crear la solicitud, así
              // que Long Form sigue sin una pantalla de revisión por beats.
              <Link
                href={`/dashboard/long-form/configure/${request.id}`}
                className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-hover"
              >
                Configurar producción
              </Link>
            ) : (
              <Link
                href={`/dashboard/review/${request.id}`}
                className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-hover"
              >
                {/* Copy fix (RC QA 2026-09-25): un avatar con narración
                    propia/grabada o TTS-desde-texto (recorded_audio_path
                    presente) abre "Revisar grabación" (review/[id]/page.tsx),
                    no un guion editable — el CTA decía "Revisar guion" para
                    ambos casos por igual. */}
                {request.recorded_audio_path ? "Revisar grabación" : "Revisar guion"}
              </Link>
            ))}
          {request.status === "processing" && isStaleProcessing && canRetry && (
            <GenerateButton endpoint={`/api/generate/${request.id}/render`} label="Reintentar" />
          )}
          {request.status === "failed" && longFormUnconfirmed && (
            <p className="max-w-[220px] text-left text-xs text-ink-faint sm:text-right">
              Esta solicitud es anterior al plan de producción. Crea un documental nuevo para producirlo.
            </p>
          )}
          {request.status === "failed" && Boolean(request.script_json) && attemptsExhausted && (
            <p className="max-w-[220px] text-left text-xs text-ink-faint sm:text-right">
              Se alcanzó el máximo de intentos. Crea un video nuevo.
            </p>
          )}
          {request.status === "failed" &&
            !longFormUnconfirmed &&
            (request.script_json ? (
              canRetry && (
                <GenerateButton endpoint={`/api/generate/${request.id}/render`} label="Reintentar" />
              )
            ) : (
              <GenerateButton
                endpoint={`/api/generate/${request.id}/script`}
                label="Reintentar"
                redirectTo={`/dashboard/review/${request.id}`}
              />
            ))}
        </div>
      </div>

      {request.status === "completed" && videoUrl && (
        <div className="mt-4 flex flex-col items-start gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
          <video
            src={videoUrl}
            controls
            preload="metadata"
            className={
              isLandscape
                ? "aspect-16/9 w-64 rounded-lg border border-border-strong bg-black shadow-md"
                : "aspect-9/16 w-36 rounded-lg border border-border-strong bg-black shadow-md"
            }
          >
            Tu navegador no puede reproducir este video.
          </video>
          <div className="flex flex-col gap-2 sm:flex-row">
            <a
              href={videoUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-accent-border hover:bg-surface-raised"
            >
              Descargar video
            </a>
            <Link
              href={detailHref}
              className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Ver detalles
            </Link>
          </div>
        </div>
      )}
      {request.status === "completed" && !videoUrl && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-danger">
          No se pudo generar el enlace del video. Intenta recargar la página.
        </p>
      )}
    </Card>
  );
}
