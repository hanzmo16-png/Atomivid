import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateScriptForRequest } from "@/lib/video/generate";
import { assertCanGenerate } from "@/lib/billing/quota";
import type { GeneratedScript } from "@/lib/providers/types";

type VideoRequestRow = {
  id: string;
  user_id: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
};

async function loadOwnedRequest(id: string, userId: string) {
  const service = createServiceClient();

  const { data: videoRequest, error } = await service
    .from("video_requests")
    .select("id, user_id, topic, style, duration_seconds, status")
    .eq("id", id)
    .single<VideoRequestRow>();

  if (error || !videoRequest) {
    return { service, videoRequest: null, response: NextResponse.json(
      { error: "Solicitud no encontrada" },
      { status: 404 },
    ) };
  }

  if (videoRequest.user_id !== userId) {
    return { service, videoRequest: null, response: NextResponse.json(
      { error: "No autorizado" },
      { status: 403 },
    ) };
  }

  return { service, videoRequest, response: null };
}

// Genera (o regenera, si falló) el guion completo y lo deja listo para
// revisión — todavía no gasta en voz/footage/música/render.
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

  const { service, videoRequest, response } = await loadOwnedRequest(id, user.id);
  if (!videoRequest) return response!;

  if (videoRequest.status !== "pending" && videoRequest.status !== "failed") {
    return NextResponse.json(
      { error: `La solicitud ya está en estado "${videoRequest.status}"` },
      { status: 409 },
    );
  }

  const check = await assertCanGenerate(service, user.id);
  if (!check.allowed) {
    return NextResponse.json({ error: check.reason }, { status: 402 });
  }

  try {
    const script = await generateScriptForRequest({
      topic: videoRequest.topic,
      style: videoRequest.style,
      durationSeconds: videoRequest.duration_seconds,
    });

    await service
      .from("video_requests")
      .update({ status: "script_ready", script_json: script, error_message: null })
      .eq("id", id);

    return NextResponse.json({ status: "script_ready", script });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";

    await service
      .from("video_requests")
      .update({ status: "failed", error_message: message })
      .eq("id", id);

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Guarda ediciones manuales del guion (texto/búsqueda visual por escena)
// hechas por el usuario en la pantalla de revisión.
export async function PATCH(
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

  const { videoRequest, response } = await loadOwnedRequest(id, user.id);
  if (!videoRequest) return response!;

  if (videoRequest.status !== "script_ready") {
    return NextResponse.json(
      { error: `La solicitud está en estado "${videoRequest.status}", no se puede editar` },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as GeneratedScript | null;
  if (!body?.title || !Array.isArray(body.segments) || body.segments.length === 0) {
    return NextResponse.json({ error: "Guion inválido" }, { status: 400 });
  }
  for (const segment of body.segments) {
    if (typeof segment.text !== "string" || typeof segment.visualQuery !== "string") {
      return NextResponse.json({ error: "Guion inválido" }, { status: 400 });
    }
  }

  const service = createServiceClient();
  await service.from("video_requests").update({ script_json: body }).eq("id", id);

  return NextResponse.json({ status: "script_ready", script: body });
}
