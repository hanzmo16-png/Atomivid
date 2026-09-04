import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getScriptProvider } from "@/lib/providers/script";
import type { GeneratedScript } from "@/lib/providers/types";

type VideoRequestRow = {
  id: string;
  user_id: string;
  topic: string;
  style: string;
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

  const body = (await request.json().catch(() => null)) as { sceneIndex?: number } | null;
  const sceneIndex = body?.sceneIndex;
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex inválido" }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: videoRequest, error } = await service
    .from("video_requests")
    .select("id, user_id, topic, style, status, script_json")
    .eq("id", id)
    .single<VideoRequestRow>();

  if (error || !videoRequest) {
    return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
  }
  if (videoRequest.user_id !== user.id) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }
  if (videoRequest.status !== "script_ready" || !videoRequest.script_json) {
    return NextResponse.json(
      { error: "El guion no está listo para editar" },
      { status: 409 },
    );
  }
  if (!videoRequest.script_json.segments[sceneIndex]) {
    return NextResponse.json({ error: "Esa escena no existe" }, { status: 400 });
  }

  try {
    const scriptProvider = getScriptProvider();
    const newScene = await scriptProvider.regenerateScene({
      topic: videoRequest.topic,
      style: videoRequest.style,
      script: videoRequest.script_json,
      sceneIndex,
    });

    const segments = [...videoRequest.script_json.segments];
    segments[sceneIndex] = newScene;
    const script: GeneratedScript = { ...videoRequest.script_json, segments };

    await service.from("video_requests").update({ script_json: script }).eq("id", id);

    return NextResponse.json({ scene: newScene, script });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
