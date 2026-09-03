import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type VideoRequest = {
  id: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  processing: "Generando",
  completed: "Listo",
  failed: "Error",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
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
    .select("id, topic, style, duration_seconds, status, created_at")
    .eq("user_id", user?.id ?? "")
    .order("created_at", { ascending: false })
    .returns<VideoRequest[]>();

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tus videos</h1>
        <Link
          href="/dashboard/new"
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Nuevo video
        </Link>
      </div>

      {created && (
        <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Tu solicitud se guardó correctamente. La generación automática
          llegará en la siguiente fase.
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
                </div>
                <span
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                    STATUS_CLASS[req.status] ?? "bg-gray-100 text-gray-800"
                  }`}
                >
                  {STATUS_LABEL[req.status] ?? req.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
