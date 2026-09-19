import { MeasuredVideo } from "./MeasuredVideo";
import { isRenderStale } from "@/lib/video/render-guard";
import { renderFailureMessage } from "@/lib/video/job-error";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { RENDER_STAGE_LABEL, type RenderStage } from "@/lib/video/stages";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import { STATUS_LABEL, STATUS_TONE, type VideoRequestSummary } from "@/lib/video/request-view";
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
  const canRetry = !attemptsExhausted && request.mode !== "avatar";
  const detailHref = `/dashboard/videos/${request.id}`;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <Link href={detailHref} className="block truncate font-medium text-ink hover:text-accent">
            {request.topic}
          </Link>
          <p className="mt-1 text-sm text-ink-muted">
            {request.style} · Solicitada: {request.duration_seconds} s ·{" "}
            {new Date(request.created_at).toLocaleString("es-MX")}
          </p>
          {request.status === "failed" && request.error_message && (
            <p className="mt-2 max-w-md text-sm text-danger">{renderFailureMessage(request.error_message)}</p>
          )}
          {request.status === "processing" && !isStaleProcessing && request.progress_stage && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none" aria-hidden="true" />
              {RENDER_STAGE_LABEL[request.progress_stage as RenderStage] ?? request.progress_stage}…
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

          {request.status === "pending" && (
            <GenerateButton
              endpoint={`/api/generate/${request.id}/script`}
              label="Generar guion"
              redirectTo={`/dashboard/review/${request.id}`}
            />
          )}
          {request.status === "script_ready" && (
            <Link
              href={`/dashboard/review/${request.id}`}
              className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent-hover"
            >
              Revisar guion
            </Link>
          )}
          {request.status === "processing" && isStaleProcessing && canRetry && (
            <GenerateButton endpoint={`/api/generate/${request.id}/render`} label="Reintentar" />
          )}
          {request.status === "failed" && Boolean(request.script_json) && attemptsExhausted && (
            <p className="max-w-[220px] text-left text-xs text-ink-faint sm:text-right">
              Se alcanzó el máximo de intentos. Crea un video nuevo.
            </p>
          )}
          {request.status === "failed" &&
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
          <MeasuredVideo src={videoUrl} requested={request.duration_seconds} mode={request.mode} className="aspect-9/16 w-36 rounded-md bg-black" />
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
