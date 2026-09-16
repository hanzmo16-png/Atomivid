import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getScriptProvider } from "@/lib/providers/script";
import { recordScriptCall } from "@/lib/billing/usage";
import { classifyScriptError, logScriptError } from "@/lib/video/script-error";
import { ScriptQualityError } from "@/lib/video/script-quality";
import type { GeneratedScript } from "@/lib/providers/types";

// Ver el mismo comentario en ../route.ts: sin esto, una llamada real a
// Claude para regenerar una escena puede superar el límite por defecto de
// la plataforma y la función se corta a medias, entregando un cuerpo
// vacío/truncado al cliente.
export const maxDuration = 60;

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

  // Misma red de seguridad que en ../route.ts: todo lo que sigue queda
  // envuelto en un único try/catch, para que cualquier fallo inesperado
  // devuelva JSON válido en vez de un cuerpo vacío.
  try {
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
    const current = videoRequest.script_json.segments[sceneIndex];
    if (!current) {
      return NextResponse.json({ error: "Esa escena no existe" }, { status: 400 });
    }

    let newScene;
    try {
      const scriptProvider = getScriptProvider();
      if (scriptProvider.name !== "anthropic") {
        // Mismo principio que en ../route.ts: nunca presentar contenido de
        // respaldo como si fuera el resultado real de una regeneración.
        throw new ScriptQualityError({
          ok: false,
          issue: "fallback_provider",
          detail: `El proveedor de guion usado fue "${scriptProvider.name}", no el proveedor de IA principal.`,
        });
      }

      newScene = await scriptProvider.regenerateScene({
        topic: videoRequest.topic,
        style: videoRequest.style,
        script: videoRequest.script_json,
        sceneIndex,
      });

      const otherVisualQueries = videoRequest.script_json.segments
        .filter((_, i) => i !== sceneIndex)
        .map((s) => s.visualQuery.trim().toLowerCase());
      if (otherVisualQueries.includes(newScene.visualQuery.trim().toLowerCase())) {
        throw new ScriptQualityError({
          ok: false,
          issue: "duplicate_visual_queries",
          detail: "La escena regenerada pide la misma búsqueda visual que otra escena.",
        });
      }
    } catch (err) {
      logScriptError("POST /script/regenerate-scene", err);
      return NextResponse.json({ error: classifyScriptError(err) }, { status: 500 });
    }

    const segments = [...videoRequest.script_json.segments];
    segments[sceneIndex] = newScene;
    const script: GeneratedScript = { ...videoRequest.script_json, segments };

    const { error: updateError } = await service
      .from("video_requests")
      .update({ script_json: script })
      .eq("id", id);
    if (updateError) {
      console.warn(`No se pudo guardar la escena regenerada de ${id}:`, updateError.code);
    }

    const inputChars = videoRequest.topic.length + videoRequest.style.length + current.text.length;
    const outputChars = newScene.text.length + newScene.visualQuery.length;
    await recordScriptCall(service, id, { inputChars, outputChars, isRegeneration: true }).catch(
      (err) => {
        console.warn(`No se pudo registrar el costo de regeneración de ${id}:`, err);
      },
    );

    return NextResponse.json({ scene: newScene, script });
  } catch (err) {
    logScriptError("POST /script/regenerate-scene (inesperado)", err);
    return NextResponse.json({ error: classifyScriptError(err) }, { status: 500 });
  }
}
