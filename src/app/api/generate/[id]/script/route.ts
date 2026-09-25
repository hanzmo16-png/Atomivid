import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateScriptForRequest } from "@/lib/video/generate-script";
import { assertCanGenerate } from "@/lib/billing/quota";
import { recordScriptCall } from "@/lib/billing/usage";
import { classifyScriptError, logScriptError } from "@/lib/video/script-error";
import { generateDiagnosticId } from "@/lib/video/render-error";
import { checkScriptQuality, ScriptQualityError } from "@/lib/video/script-quality";
import { targetWordsFor } from "@/lib/video/script-pacing";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";

// Sin esto, la función queda al límite por defecto de la plataforma (tan
// bajo como 10s en algunos planes de Vercel) — una llamada real a Claude
// para generar un guion completo, más los reintentos ante fallos
// transitorios (ver withRetry en providers/script/real.ts), puede
// superarlo. Cuando eso pasa, Vercel corta la función a medias: el cliente
// recibe un cuerpo vacío/truncado ("Unexpected end of JSON input" al
// intentar parsearlo) y la solicitud se queda sin marcar como fallida,
// visible en el historial como "Pendiente" para siempre. 60s da margen
// generoso para una llamada + reintentos sin ser excesivo.
export const maxDuration = 60;

type VideoRequestRow = {
  id: string;
  user_id: string;
  mode: string;
  recorded_audio_path: string | null;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  language: ScriptLanguage;
};

// Coincide con targetScenes en src/lib/ai/script.ts (máximo 10 para la
// duración más larga que ofrece la UI) con margen para ediciones manuales,
// sin dejarlo abierto a un guion arbitrariamente largo.
const MAX_SEGMENTS = 20;
const MAX_SCENE_TEXT_LENGTH = 800;
const MAX_VISUAL_QUERY_LENGTH = 200;

async function loadOwnedRequest(id: string, userId: string) {
  const service = createServiceClient();

  const { data: videoRequest, error } = await service
    .from("video_requests")
    .select("id, user_id, mode, topic, style, duration_seconds, status, language, recorded_audio_path")
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

  if (videoRequest.recorded_audio_path) return { service, videoRequest: null, response: NextResponse.json({ error: "Esta solicitud utiliza una grabación; no necesita guion generado." }, { status: 409 }) };
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

  // Red de seguridad: todo lo que sigue queda envuelto en un try/catch
  // único — cualquier fallo inesperado (no solo el del proveedor de
  // guion) debe devolver JSON válido, nunca un cuerpo vacío o una
  // excepción sin manejar que el cliente no pueda parsear.
  try {
    const { service, videoRequest, response } = await loadOwnedRequest(id, user.id);
    if (!videoRequest) return response!;

    // "script_ready" se permite además de "pending"/"failed" para poder
    // regenerar el guion completo (no solo escena por escena) cuando el
    // resultado ya guardado no es aceptable — p. ej. si vino de un
    // proveedor de respaldo o no pasó el control de calidad de abajo.
    // No se permite desde "processing"/"completed": eso sí requeriría una
    // solicitud nueva.
    if (
      videoRequest.status !== "pending" &&
      videoRequest.status !== "failed" &&
      videoRequest.status !== "script_ready"
    ) {
      return NextResponse.json(
        { error: `La solicitud ya está en estado "${videoRequest.status}"` },
        { status: 409 },
      );
    }

    const check = await assertCanGenerate(service, user.id, videoRequest.mode, user);
    if (!check.allowed) {
      return NextResponse.json({ error: check.reason }, { status: 402 });
    }

    let script: GeneratedScript;
    try {
      const result = await generateScriptForRequest({
        topic: videoRequest.topic,
        style: videoRequest.style,
        durationSeconds: videoRequest.duration_seconds,
        language: videoRequest.language,
      });

      const quality = checkScriptQuality(result.script, {
        topic: videoRequest.topic,
        targetWords: targetWordsFor(videoRequest.duration_seconds),
        providerName: result.providerName,
      });
      if (!quality.ok) {
        throw new ScriptQualityError(quality);
      }

      script = result.script;
    } catch (error) {
      const diagnosticId = generateDiagnosticId();
      logScriptError("POST /script", error, diagnosticId);
      const message = classifyScriptError(error, diagnosticId);

      // script_json se limpia explícitamente: si esto fue una regeneración
      // completa desde "script_ready" que falló, dejar el guion anterior
      // haría que el botón "Reintentar" del historial (RequestCard) lo
      // interprete como "el render falló, el guion sigue siendo válido" y
      // ofrezca reintentar el render en vez del guion — justo el guion que
      // acabamos de rechazar.
      const { error: updateError } = await service
        .from("video_requests")
        .update({ status: "failed", error_message: message, script_json: null })
        .eq("id", id);
      if (updateError) {
        console.warn(`No se pudo marcar como fallida la solicitud ${id}:`, updateError.code);
      }

      return NextResponse.json({ error: message }, { status: 500 });
    }

    const { error: updateError } = await service
      .from("video_requests")
      .update({ status: "script_ready", script_json: script, error_message: null })
      .eq("id", id);
    if (updateError) {
      console.warn(`No se pudo actualizar la solicitud ${id} a script_ready:`, updateError.code);
    }

    const inputChars = videoRequest.topic.length + videoRequest.style.length;
    const outputChars = JSON.stringify(script).length;
    await recordScriptCall(service, id, { inputChars, outputChars }).catch((err) => {
      console.warn(`No se pudo registrar el costo de guion de ${id}:`, err);
    });

    return NextResponse.json({ status: "script_ready", script });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logScriptError("POST /script (inesperado)", error, diagnosticId);
    return NextResponse.json({ error: classifyScriptError(error, diagnosticId) }, { status: 500 });
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
  // Topes defensivos: el guion editado alimenta directamente la síntesis
  // de voz (costo por carácter) y el render — sin límite, una edición
  // manual podría inflar el costo/duración muy por encima de lo que la
  // solicitud original pidió.
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json(
      { error: `El guion no puede tener más de ${MAX_SEGMENTS} escenas` },
      { status: 400 },
    );
  }
  for (const segment of body.segments) {
    if (typeof segment.text !== "string" || typeof segment.visualQuery !== "string") {
      return NextResponse.json({ error: "Guion inválido" }, { status: 400 });
    }
    if (segment.text.length > MAX_SCENE_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `El texto de una escena no puede superar ${MAX_SCENE_TEXT_LENGTH} caracteres` },
        { status: 400 },
      );
    }
    if (segment.visualQuery.length > MAX_VISUAL_QUERY_LENGTH) {
      return NextResponse.json(
        { error: `La búsqueda visual no puede superar ${MAX_VISUAL_QUERY_LENGTH} caracteres` },
        { status: 400 },
      );
    }
  }

  const service = createServiceClient();
  await service.from("video_requests").update({ script_json: body }).eq("id", id);

  return NextResponse.json({ status: "script_ready", script: body });
}
