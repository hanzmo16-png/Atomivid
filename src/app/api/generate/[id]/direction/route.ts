import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { GeneratedScript } from "@/lib/providers/types";
import { parseSelection } from "@/lib/video/audiovisual/catalog";
import { resolveDirection } from "@/lib/video/audiovisual/direction";
import { loadAudiovisualState } from "@/lib/video/audiovisual/persistence";
import { evaluateDirectionReadiness } from "@/lib/video/audiovisual/readiness";

type Row = { id: string; user_id: string; mode: string; status: string; topic: string; style: string; script_json: GeneratedScript | null };

/**
 * Cambia la dirección audiovisual de un Reel antes de producirlo (o tras un
 * intento fallido): es la ruta de recuperación cuando falta música
 * compatible o un perfil ilustrado no está disponible. Guarda la nueva
 * selección e invalida la dirección resuelta; se vuelve a resolver y
 * comprobar al aprobar el guion. Nunca aplica a solicitudes antiguas sin
 * selección ni a Avatar/Long Form.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  try {
    const service = createServiceClient();
    const { data: row, error } = await service
      .from("video_requests")
      .select("id, user_id, mode, status, topic, style, script_json")
      .eq("id", id)
      .single<Row>();
    if (error || !row) return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
    if (row.user_id !== user.id) return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    if (row.mode !== "visual") return NextResponse.json({ error: "La dirección audiovisual solo aplica a Reels." }, { status: 409 });
    if (row.status !== "script_ready" && row.status !== "failed") {
      return NextResponse.json({ error: `No se puede cambiar la dirección con la solicitud en estado "${row.status}".` }, { status: 409 });
    }
    const state = await loadAudiovisualState(service, id);
    if (!state.available || !state.selection) {
      return NextResponse.json({ error: "Esta solicitud se creó sin dirección audiovisual." }, { status: 409 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseSelection({ profile: body?.profile, intent: body?.intent, music: body?.music, pace: body?.pace });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { error: updateError } = await service
      .from("video_requests")
      .update({ audiovisual_selection: parsed.selection, audiovisual_direction: null })
      .eq("id", id)
      .in("status", ["script_ready", "failed"]);
    if (updateError) return NextResponse.json({ error: "No se pudo guardar la dirección." }, { status: 500 });

    const scenes = row.script_json?.segments ?? [];
    const preview = resolveDirection({ selection: parsed.selection, style: row.style, topic: row.topic, scenes });
    const readiness = evaluateDirectionReadiness({ profile: preview.profile, music: preview.music.id, sceneCount: scenes.length });
    return NextResponse.json({ selection: parsed.selection, summary: preview.summary, issues: readiness.issues });
  } catch (err) {
    console.error("[atomivid:direction] PATCH", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "No se pudo guardar la dirección." }, { status: 500 });
  }
}
