import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canCancelReel } from "@/lib/video/reel-cancel";
import { cancelReelAttempt } from "@/lib/video/reel-cancel-server";

/**
 * POST /api/generate/[id]/cancel — the owner cancels a queued or rendering visual Reel (END GAME C).
 * Never calls a provider and never charges: it only moves the SAME attempt processing → failed («retry»), so the
 * existing «Reintentar» path recovers it later. See src/lib/video/reel-cancel.ts for the rules.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  try {
    const service = createServiceClient();
    const { data: row, error } = await service.from("video_requests")
      .select("id, user_id, mode, status, render_attempts, progress_stage")
      .eq("id", id).eq("user_id", user.id).maybeSingle();
    if (error) return NextResponse.json({ error: "No se pudo leer la solicitud. No se canceló nada." }, { status: 503 });
    if (!row) return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
    if (!canCancelReel(row)) {
      return NextResponse.json({ error: "Esta producción ya no se puede cancelar (terminó, está subiendo el video o no es un Reel)." }, { status: 409 });
    }
    const outcome = await cancelReelAttempt(service, row);
    if (outcome === "cancelled") return NextResponse.json({ ok: true });
    return NextResponse.json({ error: "La producción cambió de etapa mientras cancelabas. Recarga la página y vuelve a intentarlo." }, { status: 409 });
  } catch {
    return NextResponse.json({ error: "No se pudo cancelar ahora. Recarga la página para ver el estado real." }, { status: 503 });
  }
}
