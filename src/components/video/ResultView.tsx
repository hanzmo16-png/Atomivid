import { isRenderStale } from "@/lib/video/render-guard";
import { RequestActions } from "./RequestActions";
import { VideoPlayback } from "./VideoPlayback";
import { renderFailureMessage } from "@/lib/video/job-error";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { LinkButton } from "@/components/ui/Button";
import { RENDER_STAGE_LABEL, type RenderStage } from "@/lib/video/stages";
import {
  LANGUAGE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type VideoRequestSummary,
} from "@/lib/video/request-view";

/**
 * Contenido de la pantalla dedicada /dashboard/videos/[id] — puramente
 * presentacional (sin fetch de datos), para poder reutilizarla igual en
 * /dev/states con datos simulados. No inventa porcentajes: mientras
 * procesa muestra la etapa real (o un indicador indeterminado si no hay
 * etapa todavía) en vez de un número inexistente.
 */
export function ResultView({
  request,
  videoUrl,
  nowMs = 0,
}: {
  request: VideoRequestSummary;
  nowMs?: number;
  /** null si status=completed pero no se pudo firmar la URL (reportar el error, no ocultarlo). */
  videoUrl?: string | null;
}) {
  const stale = isRenderStale(request, nowMs);
  const meta = [
    request.mode === "avatar" ? "Avatar" : "Video normal",
    request.language && LANGUAGE_LABEL[request.language],
    `${request.duration_seconds}s`,
    new Date(request.created_at).toLocaleString("es-MX"),
  ].filter(Boolean);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-ink">{request.topic}</h1>
        <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>
          {STATUS_LABEL[request.status] ?? request.status}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{meta.join(" · ")}</p>

      <div className="mt-6">
        {(request.status === "pending" || request.status === "script_ready") && (
          <EmptyStage
            title="Todavía no se generó el video"
            body={request.mode === "avatar" ? "Tu grabación se conserva completa. La prueba privada requiere revisión antes de generar." : request.status === "pending" ? "Tu solicitud está guardada. Genera el guion para revisarlo antes de producir el video." : "Revisa el contenido antes de producir el video final."}
          />
        )}

        {request.status === "processing" && (
          <Card className="flex flex-col items-center gap-4 p-10 text-center">
            <span
              className="size-8 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-ink">
                {stale ? "La generación está tardando más de lo normal" : request.progress_stage
                  ? (RENDER_STAGE_LABEL[request.progress_stage as RenderStage] ??
                      "Procesando tu video") + "…"
                  : "Preparando tu video…"}
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                Esto puede tardar unos minutos. Puedes cerrar esta página — el progreso se
                guarda y lo verás reflejado aquí al volver.
              </p>
            </div>
          </Card>
        )}

        {request.status === "failed" && (
          <Alert tone="danger" role="alert">
            <p className="font-medium">No se pudo generar este video.</p>
            {request.error_message && <p className="mt-1">{renderFailureMessage(request.error_message)}</p>}
          </Alert>
        )}

        {request.status === "completed" && videoUrl && (
          <div className="flex flex-col items-center gap-4">
            <VideoPlayback src={videoUrl} />
            <a
              href={`/api/videos/${request.id}/download`}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:bg-accent-hover"
            >
              Descargar video
            </a>
          </div>
        )}
        {request.status === "completed" && !videoUrl && (
          <Alert tone="danger" role="alert">
            No se pudo generar el enlace de descarga. Recarga la página para intentarlo de
            nuevo.
          </Alert>
        )}
      </div>

      <div className="mt-4"><RequestActions request={request} nowMs={nowMs} /></div>
      <div className="mt-8 flex flex-wrap gap-3 border-t border-border pt-6">
        <LinkButton href="/dashboard" variant="secondary">
          Volver al historial
        </LinkButton>
        <LinkButton href="/dashboard/new">Crear otro video</LinkButton>
      </div>
    </div>
  );
}

function EmptyStage({ title, body }: { title: string; body: string }) {
  return (
    <Card className="p-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">{body}</p>
    </Card>
  );
}
