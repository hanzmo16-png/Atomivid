import { createClient } from "@/lib/supabase/server";
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import type { VideoRequestSummary } from "@/lib/video/request-view";
import { AutoRefresh } from "./AutoRefresh";
import { RequestCard } from "@/components/video/RequestCard";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import Link from "next/link";

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

  const { data: requests, error: requestsError } = await supabase
    .from("video_requests")
    .select(
      "id, mode, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at",
    )
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false })
    .returns<VideoRequestSummary[]>();

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

  const { data: subscriptionData, error: subscriptionError } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user?.id ?? "")
    .maybeSingle();

  const subscribed = isSubscriptionActive(
    (subscriptionData as { status: string } | null)?.status,
  );

  const hasProcessing = (requests ?? []).some((r) => r.status === "processing");
  const firstName = user?.email?.split("@")[0];
  // Server Component: se evalúa una sola vez por request en el servidor
  // (no hay re-render en el cliente que pueda desincronizarse), así que
  // Date.now() aquí es seguro pese a la regla de pureza de React.
  /* eslint-disable-next-line react-hooks/purity -- ver comentario arriba */
  const nowMs = Date.now();

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
        {!subscribed && !subscriptionError && (
          <Alert tone="info">
            Necesitas una suscripción activa para generar videos.{" "}
            <Link href="/dashboard/billing" className="font-medium underline">
              Suscribirme
            </Link>
          </Alert>
        )}

        {subscriptionError && <Alert tone="warning">No se pudo consultar tu suscripción. Recarga la página antes de generar.</Alert>}
        {created && (
          <Alert tone="success">
            Tu solicitud se guardó correctamente. Pulsa &quot;Generar guion&quot; para
            crear el guion — podrás revisarlo y editarlo antes de generar el video final.
          </Alert>
        )}
      </div>

      {requestsError ? <div className="mt-6"><Alert tone="danger">No se pudo cargar tu historial. Tus videos no se han borrado. Recarga la página para volver a consultar.</Alert></div> : !requests || requests.length === 0 ? (
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
          {requests.map((req) => (
            <li key={req.id}>
              <RequestCard
                request={req}
                videoUrl={req.video_path ? videoUrlByPath.get(req.video_path) : null}
                nowMs={nowMs}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
