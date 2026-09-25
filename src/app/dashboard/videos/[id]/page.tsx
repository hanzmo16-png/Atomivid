import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import { selectIfOwned, type OwnedRequestRow } from "@/lib/video/access";
import { ResultView } from "@/components/video/ResultView";
import { Alert } from "@/components/ui/Alert";
import { AutoRefresh } from "@/app/dashboard/AutoRefresh";

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
      "id, mode, user_id, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at, aspect_ratio, long_form_stage, long_form_progress",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<OwnedRequestRow>();

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

  const videoUrl =
    request.status === "completed" && request.video_path
      ? await getSignedVideoUrl(request.video_path)
      : null;

  // Server Component evaluado una vez por request (mismo patrón que
  // dashboard/page.tsx). AutoRefresh vuelve a pedir ESTA página al backend
  // de Atomivid mientras siga "processing" — el progreso siempre sale de la
  // base de datos, nunca de estado del navegador.
  // eslint-disable-next-line react-hooks/purity -- ver comentario arriba
  const nowMs = Date.now();
  return (
    <div className="mx-auto max-w-md">
      <AutoRefresh active={request.status === "processing"} />
      <ResultView request={request} videoUrl={videoUrl} nowMs={nowMs} />
    </div>
  );
}
