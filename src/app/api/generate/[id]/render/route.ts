import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getRenderWorker } from "@/lib/worker";
import { assertCanGenerate } from "@/lib/billing/quota";
import { evaluateRenderStart } from "@/lib/video/render-guard";
import {
  classifyRenderError,
  generateDiagnosticId,
  logRenderError,
  RenderStageError,
} from "@/lib/video/render-error";
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

  // Red de seguridad: todo lo que sigue queda envuelto en un try/catch
  // único, mismo principio que en script/route.ts — cualquier fallo
  // inesperado (no solo el del worker) debe devolver JSON válido, nunca
  // un cuerpo vacío que el cliente no pueda parsear. Esto fue precisamente
  // lo que pasó en producción: un fallo al cargar el módulo del worker
  // (ver el comentario en src/lib/worker/inline.ts) ocurría fuera de
  // cualquier try/catch existente y tumbaba la función entera.
  try {
    const service = createServiceClient();

    // postgrest-js no atrapa un fallo de red/conexión propio — lo propaga
    // como excepción cruda en vez de devolverla en `error` (a diferencia de
    // un error HTTP normal de Postgrest, que sí llega como `{ error }`).
    // Sin este try/catch, esa excepción caía en el catch-all de abajo y se
    // clasificaba como el mismo mensaje genérico que cualquier otro fallo
    // — indistinguible de un problema del worker de GitHub Actions.
    let videoRequest: VideoRequestRow;
    try {
      const { data, error: fetchError } = await service
        .from("video_requests")
        .select("id, user_id, status, script_json, render_attempts, render_started_at")
        .eq("id", id)
        .single<VideoRequestRow>();

      if (fetchError || !data) {
        return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
      }
      videoRequest = data;
    } catch (error) {
      throw new RenderStageError("fetch_request", error);
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

    // Primera línea de defensa contra doble render (solicitud duplicada,
    // ya en proceso, colgada, o máximo de intentos alcanzado) — lógica
    // pura extraída a render-guard.ts para poder probarla sin Supabase.
    // La garantía real contra una carrera (doble clic, dos pestañas) es
    // el UPDATE condicional más abajo, que Postgres serializa por fila.
    const decision = evaluateRenderStart(videoRequest);
    if (!decision.allowed) {
      return NextResponse.json({ error: decision.error }, { status: decision.status });
    }

    let check: Awaited<ReturnType<typeof assertCanGenerate>>;
    try {
      check = await assertCanGenerate(service, user.id);
    } catch (error) {
      throw new RenderStageError("check_subscription", error);
    }
    if (!check.allowed) {
      return NextResponse.json({ error: check.reason }, { status: 402 });
    }

    const worker = getRenderWorker();

    // Guarda de concurrencia: la transición a "processing" solo aplica si
    // el estado sigue siendo el que acabamos de leer. Si otra request
    // ganó la carrera (doble clic, dos pestañas), `updated` viene vacío y
    // avisamos en vez de disparar un segundo render para el mismo video.
    // El propio await también puede lanzar (ver comentario en
    // fetch_request más arriba) — igual se etiqueta como "mark_processing"
    // para distinguirlo de un error devuelto normalmente en `updateError`.
    let updated: { id: string }[] | null;
    let updateError: { message: string; code?: string } | null;
    try {
      const result = await service
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
      updated = result.data;
      updateError = result.error;
    } catch (error) {
      throw new RenderStageError("mark_processing", error);
    }

    if (updateError) {
      const diagnosticId = generateDiagnosticId();
      logRenderError("POST /render (actualizar a processing)", updateError, diagnosticId);
      return NextResponse.json(
        { error: `No se pudo iniciar el render. (Código: ${diagnosticId})` },
        { status: 500 },
      );
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
      const diagnosticId = generateDiagnosticId();
      logRenderError(`POST /render (worker: ${worker.name})`, error, diagnosticId);
      const message = classifyRenderError(error, diagnosticId);

      // El mensaje ya clasificado del fallo del worker es lo único que
      // debe llegar al cliente — si esta actualización de estado (o la
      // propia llamada) falla también, se registra como un problema
      // aparte con el mismo diagnosticId, pero nunca debe reemplazar ni
      // perder el mensaje original ya calculado.
      try {
        const { error: failUpdateError } = await service
          .from("video_requests")
          .update({ status: "failed", error_message: message, progress_stage: null })
          .eq("id", id);
        if (failUpdateError) {
          logRenderError("POST /render (restaurar estado a failed)", failUpdateError, diagnosticId);
        }
      } catch (restoreError) {
        logRenderError(
          "POST /render (restaurar estado a failed, excepción)",
          restoreError,
          diagnosticId,
        );
      }

      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ status: "processing", worker: worker.name });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /render (inesperado)", error, diagnosticId);
    return NextResponse.json({ error: classifyRenderError(error, diagnosticId) }, { status: 500 });
  }
}
