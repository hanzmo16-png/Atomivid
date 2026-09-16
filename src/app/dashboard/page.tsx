import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { RENDER_STAGE_LABEL, type RenderStage } from "@/lib/video/stages";
import { MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "@/lib/video/limits";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import { GenerateButton } from "./GenerateButton";
import { AutoRefresh } from "./AutoRefresh";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";

type VideoRequest = {
  id: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  video_path: string | null;
  error_message: string | null;
  script_json: unknown;
  progress_stage: string | null;
  render_attempts: number;
  render_started_at: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  script_ready: "Guion listo",
  processing: "Generando",
  completed: "Listo",
  failed: "Error",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  script_ready: "accent",
  processing: "info",
  completed: "success",
  failed: "danger",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const { created } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: requests } = await supabase
    .from("video_requests")
    .select(
      "id, topic, style, duration_seconds, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at",
    )
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false })
    .returns<VideoRequest[]>();

  // Las URLs de reproducción/descarga se firman aquí, después de que la
  // consulta de arriba ya filtró por RLS a las solicitudes del usuario
  // actual — nunca se firma un objeto sin haber confirmado antes que la
  // fila pertenece a quien está viendo el historial.
  const completedRequests = (requests ?? []).filter(
    (r) => r.status === "completed" && r.video_path,
  );
  const signedUrls = await Promise.all(
    completedRequests.map((r) => getSignedVideoUrl(r.video_path!)),
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
  const firstName = user?.email?.split("@")[0];

  return (
    <div>
      <AutoRefresh active={hasProcessing} />

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
        {!subscribed && (
          <Alert tone="info">
            Necesitas una suscripción activa para generar videos.{" "}
            <Link href="/dashboard/billing" className="font-medium underline">
              Suscribirme
            </Link>
          </Alert>
        )}

        {created && (
          <Alert tone="success">
            Tu solicitud se guardó correctamente. Pulsa &quot;Generar guion&quot; para
            crear el guion — podrás revisarlo y editarlo antes de generar el video final.
          </Alert>
        )}
      </div>

      {!requests || requests.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            icon={
              <svg width="22" height="22" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
              </svg>
            }
            title="Todavía no has generado ningún video"
            description="Crea tu primera solicitud — describe un tema y en minutos tendrás un video vertical listo para descargar."
            action={<LinkButton href="/dashboard/new">Crear tu primer video</LinkButton>}
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {requests.map((req) => {
            // Este es un Server Component: se evalúa una sola vez por
            // request en el servidor (no hay re-render en el cliente que
            // pueda desincronizarse), así que Date.now() aquí es seguro
            // pese a la regla de pureza de React.
            /* eslint-disable-next-line react-hooks/purity -- ver comentario arriba */
            const nowMs = Date.now();
            const isStaleProcessing =
              req.status === "processing" &&
              req.render_started_at !== null &&
              nowMs - new Date(req.render_started_at).getTime() > RENDER_TIMEOUT_MS;
            const attemptsExhausted = req.render_attempts >= MAX_RENDER_ATTEMPTS;
            const videoUrl = req.video_path ? videoUrlByPath.get(req.video_path) : null;

            return (
              <Card key={req.id} className="p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{req.topic}</p>
                    <p className="mt-1 text-sm text-ink-muted">
                      {req.style} · {req.duration_seconds}s ·{" "}
                      {new Date(req.created_at).toLocaleString("es-MX")}
                    </p>
                    {req.status === "failed" && req.error_message && (
                      <p className="mt-2 max-w-md text-sm text-danger">{req.error_message}</p>
                    )}
                    {req.status === "processing" && !isStaleProcessing && req.progress_stage && (
                      <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted">
                        <span
                          className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
                          aria-hidden="true"
                        />
                        {RENDER_STAGE_LABEL[req.progress_stage as RenderStage] ??
                          req.progress_stage}
                        …
                      </p>
                    )}
                    {req.status === "processing" && isStaleProcessing && (
                      <p className="mt-2 max-w-md text-sm text-warning">
                        Esto está tardando más de lo normal.{" "}
                        {attemptsExhausted
                          ? "Se alcanzó el máximo de intentos para este video."
                          : "Puedes reintentar."}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Badge tone={STATUS_TONE[req.status] ?? "neutral"}>
                      {STATUS_LABEL[req.status] ?? req.status}
                    </Badge>

                    {req.status === "pending" && (
                      <GenerateButton
                        endpoint={`/api/generate/${req.id}/script`}
                        label="Generar guion"
                        redirectTo={`/dashboard/review/${req.id}`}
                      />
                    )}
                    {req.status === "script_ready" && (
                      <LinkButton href={`/dashboard/review/${req.id}`} size="sm">
                        Revisar guion
                      </LinkButton>
                    )}
                    {req.status === "processing" && isStaleProcessing && !attemptsExhausted && (
                      <GenerateButton endpoint={`/api/generate/${req.id}/render`} label="Reintentar" />
                    )}
                    {req.status === "failed" && Boolean(req.script_json) && attemptsExhausted && (
                      <p className="max-w-[220px] text-right text-xs text-ink-faint">
                        Se alcanzó el máximo de intentos. Crea un video nuevo.
                      </p>
                    )}
                    {req.status === "failed" &&
                      (req.script_json ? (
                        !attemptsExhausted && (
                          <GenerateButton endpoint={`/api/generate/${req.id}/render`} label="Reintentar" />
                        )
                      ) : (
                        <GenerateButton
                          endpoint={`/api/generate/${req.id}/script`}
                          label="Reintentar"
                          redirectTo={`/dashboard/review/${req.id}`}
                        />
                      ))}
                  </div>
                </div>

                {req.status === "completed" && videoUrl && (
                  <div className="mt-4 flex flex-col items-start gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
                    <video
                      src={videoUrl}
                      controls
                      preload="metadata"
                      className="aspect-9/16 w-36 rounded-md bg-black"
                    >
                      Tu navegador no puede reproducir este video.
                    </video>
                    <a
                      href={videoUrl}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-accent-border hover:bg-surface-raised"
                    >
                      Descargar video
                    </a>
                  </div>
                )}
                {req.status === "completed" && !videoUrl && (
                  <p className="mt-4 border-t border-border pt-4 text-sm text-danger">
                    No se pudo generar el enlace del video. Intenta recargar la página.
                  </p>
                )}
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
