import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { RENDER_STAGE_LABEL, type RenderStage } from "@/lib/video/stages";
import { GenerateButton } from "./GenerateButton";
import { AutoRefresh } from "./AutoRefresh";

type VideoRequest = {
  id: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  video_url: string | null;
  error_message: string | null;
  script_json: unknown;
  progress_stage: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  script_ready: "Guion listo",
  processing: "Generando",
  completed: "Listo",
  failed: "Error",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  script_ready: "bg-purple-100 text-purple-800",
  processing: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
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
      "id, topic, style, duration_seconds, status, video_url, error_message, script_json, progress_stage, created_at",
    )
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false })
    .returns<VideoRequest[]>();

  const { data: subscriptionData } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user?.id ?? "")
    .maybeSingle();

  const subscribed = isSubscriptionActive(
    (subscriptionData as { status: string } | null)?.status,
  );

  const hasProcessing = (requests ?? []).some((r) => r.status === "processing");

  return (
    <div>
      <AutoRefresh active={hasProcessing} />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tus videos</h1>
        <Link
          href="/dashboard/new"
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Nuevo video
        </Link>
      </div>

      {!subscribed && (
        <p className="mt-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Necesitas una suscripción activa para generar videos.{" "}
          <Link href="/dashboard/billing" className="font-medium underline">
            Suscribirme
          </Link>
        </p>
      )}

      {created && (
        <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Tu solicitud se guardó correctamente. Pulsa &quot;Generar
          guion&quot; para crear el guion — podrás revisarlo y editarlo antes
          de generar el video final.
        </p>
      )}

      {!requests || requests.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-gray-600">Todavía no has generado ningún video.</p>
          <Link
            href="/dashboard/new"
            className="mt-4 inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Crear tu primer video
          </Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {requests.map((req) => (
            <li
              key={req.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900">{req.topic}</p>
                  <p className="mt-1 text-sm text-gray-500">
                    {req.style} · {req.duration_seconds}s ·{" "}
                    {new Date(req.created_at).toLocaleString("es-MX")}
                  </p>
                  {req.status === "failed" && req.error_message && (
                    <p className="mt-2 max-w-md text-sm text-red-600">
                      {req.error_message}
                    </p>
                  )}
                  {req.status === "processing" && req.progress_stage && (
                    <p className="mt-2 text-sm text-gray-500">
                      {RENDER_STAGE_LABEL[req.progress_stage as RenderStage] ??
                        req.progress_stage}
                      …
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      STATUS_CLASS[req.status] ?? "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {STATUS_LABEL[req.status] ?? req.status}
                  </span>

                  {req.status === "pending" && (
                    <GenerateButton
                      endpoint={`/api/generate/${req.id}/script`}
                      label="Generar guion"
                      redirectTo={`/dashboard/review/${req.id}`}
                    />
                  )}
                  {req.status === "script_ready" && (
                    <Link
                      href={`/dashboard/review/${req.id}`}
                      className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700"
                    >
                      Revisar guion
                    </Link>
                  )}
                  {req.status === "failed" &&
                    (req.script_json ? (
                      <GenerateButton
                        endpoint={`/api/generate/${req.id}/render`}
                        label="Reintentar"
                      />
                    ) : (
                      <GenerateButton
                        endpoint={`/api/generate/${req.id}/script`}
                        label="Reintentar"
                        redirectTo={`/dashboard/review/${req.id}`}
                      />
                    ))}
                </div>
              </div>

              {req.status === "completed" && req.video_url && (
                <div className="mt-4 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                  <video
                    src={req.video_url}
                    controls
                    className="aspect-[9/16] w-40 rounded-lg bg-black"
                  />
                  <a
                    href={req.video_url}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-50"
                  >
                    Descargar video
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
