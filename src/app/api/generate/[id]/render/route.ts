import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateVideoFromScript } from "@/lib/video/generate";
import type { GeneratedScript } from "@/lib/providers/types";

// El render de video (Remotion + llamadas a APIs externas) puede tardar
// más que una función serverless típica. En Vercel esto requiere un plan
// que soporte funciones de larga duración (o, mejor aún, mover el render
// a un worker/cola dedicados — ver README, sección "Próximos pasos").
export const maxDuration = 300;

type VideoRequestRow = {
  id: string;
  user_id: string;
  status: string;
  script_json: GeneratedScript | null;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const service = createServiceClient();

  const { data: videoRequest, error: fetchError } = await service
    .from("video_requests")
    .select("id, user_id, status, script_json")
    .eq("id", id)
    .single<VideoRequestRow>();

  if (fetchError || !videoRequest) {
    return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
  }
  if (videoRequest.user_id !== user.id) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }
  if (!videoRequest.script_json) {
    return NextResponse.json(
      { error: "Todavía no hay un guion generado para esta solicitud" },
      { status: 409 },
    );
  }
  if (videoRequest.status !== "script_ready" && videoRequest.status !== "failed") {
    return NextResponse.json(
      { error: `La solicitud ya está en estado "${videoRequest.status}"` },
      { status: 409 },
    );
  }

  await service
    .from("video_requests")
    .update({ status: "processing", error_message: null, progress_stage: null })
    .eq("id", id);

  try {
    const { videoUrl } = await generateVideoFromScript({
      supabase: service,
      requestId: id,
      script: videoRequest.script_json,
      onProgress: async (stage) => {
        await service.from("video_requests").update({ progress_stage: stage }).eq("id", id);
      },
    });

    await service
      .from("video_requests")
      .update({ status: "completed", video_url: videoUrl, progress_stage: null })
      .eq("id", id);

    return NextResponse.json({ status: "completed", videoUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";

    await service
      .from("video_requests")
      .update({ status: "failed", error_message: message })
      .eq("id", id);

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
