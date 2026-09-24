import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import { selectIfOwned, type OwnedRequestRow } from "@/lib/video/access";
import { ResultView } from "@/components/video/ResultView";

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
  const { data } = await supabase
    .from("video_requests")
    .select(
      "id, mode, user_id, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at, aspect_ratio, long_form_stage",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<OwnedRequestRow>();

  const request = selectIfOwned(data, user.id);
  if (!request) {
    notFound();
  }

  const videoUrl =
    request.status === "completed" && request.video_path
      ? await getSignedVideoUrl(request.video_path)
      : null;

  return (
    <div className="mx-auto max-w-md">
      <ResultView request={request} videoUrl={videoUrl} />
    </div>
  );
}
