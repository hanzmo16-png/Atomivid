import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getRenderWorker } from "@/lib/worker";
import { assertCanGenerate } from "@/lib/billing/quota";
import { MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "@/lib/video/limits";
import type { GeneratedScript } from "@/lib/providers/types";

// El worker por defecto (GitHub Actions) solo dispara un webhook y
// retorna — esta función ya no espera el render completo. maxDuration se
// mantiene alto solo como red de seguridad para el worker "inline"
// (fallback de desarrollo/sin credenciales), que sí corre el pipeline
// dentro de esta misma request.
export const maxDuration = 300;

type VideoRequestRow = {
  id: string;
  user_id: string;
  status: string;
  script_json: GeneratedScript | null;
  render_attempts: number;
  render_started_at: string | null;
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
    .select("id, user_id, status, script_json, render_attempts, render_started_at")
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

  // Un render "processing" que lleva más de RENDER_TIMEOUT_MS sin
  // resolverse se trata como colgado (el worker probablemente murió sin
  // poder reportarlo) — se permite reintentar en vez de bloquear para
  // siempre. Mientras no esté vencido, un segundo disparo se rechaza.
  const startedAt = videoRequest.render_started_at
    ? new Date(videoRequest.render_started_at).getTime()
    : null;
  const isStale =
    videoRequest.status === "processing" &&
    startedAt !== null &&
    Date.now() - startedAt > RENDER_TIMEOUT_MS;

  if (videoRequest.status === "processing" && !isStale) {
    return NextResponse.json({ error: "Este video ya se está generando." }, { status: 409 });
  }
  if (videoRequest.status !== "script_ready" && videoRequest.status !== "failed" && !isStale) {
    return NextResponse.json(
      { error: `La solicitud ya está en estado "${videoRequest.status}"` },
      { status: 409 },
    );
  }
  if (videoRequest.render_attempts >= MAX_RENDER_ATTEMPTS) {
    return NextResponse.json(
      {
        error: `Se alcanzó el máximo de ${MAX_RENDER_ATTEMPTS} intentos de render para este video. Crea una nueva solicitud desde "Nuevo video".`,
      },
      { status: 409 },
    );
  }

  const check = await assertCanGenerate(service, user.id);
  if (!check.allowed) {
    return NextResponse.json({ error: check.reason }, { status: 402 });
  }

  const worker = getRenderWorker();

  // Guarda de concurrencia: la transición a "processing" solo aplica si el
  // estado sigue siendo el que acabamos de leer. Si otra request ganó la
  // carrera (doble clic, dos pestañas), `updated` viene vacío y avisamos
  // en vez de disparar un segundo render para el mismo video.
  const { data: updated, error: updateError } = await service
    .from("video_requests")
    .update({
      status: "processing",
      error_message: null,
      progress_stage: "queued",
      render_started_at: new Date().toISOString(),
      render_attempts: videoRequest.render_attempts + 1,
      render_worker: worker.name,
    })
    .eq("id", id)
    .eq("status", videoRequest.status)
    .select("id");

  if (updateError) {
    return NextResponse.json({ error: "No se pudo iniciar el render" }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "El estado cambió justo antes de iniciar el render. Intenta de nuevo." },
      { status: 409 },
    );
  }

  try {
    await worker.trigger({ requestId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    await service
      .from("video_requests")
      .update({ status: "failed", error_message: message, progress_stage: null })
      .eq("id", id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ status: "processing", worker: worker.name });
}
