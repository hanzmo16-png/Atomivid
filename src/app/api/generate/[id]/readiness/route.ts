import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { checkProductionForRequest, checkResponseBody } from "@/lib/supply/production-check";
import type { ScriptLanguage } from "@/lib/providers/types";
import { draftFit, hasRenderableScript, isOwnScriptDraft } from "@/lib/video/own-script";

export const dynamic = "force-dynamic";

/**
 * Control de costos (2026-10-18): read-only answer to «¿puedo hacer esta producción?» for the owner of
 * the request. It runs the same check the start endpoints run (plan, prices, Atomivid's provider
 * capacity) and NEVER reserves, generates or calls a generative provider. A stale balance of one of this
 * production's providers may be refreshed with the provider's billing GET (no generation), exactly as the
 * start endpoints do. Stage: before the script when there is none yet, otherwise before the render.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const service = createServiceClient();
  const { data: row, error } = await service.from("video_requests")
    .select("id, user_id, mode, topic, style, duration_seconds, language, status, recorded_audio_path, script_json, long_form_production_plan")
    .eq("id", id).maybeSingle<{ id: string; user_id: string; mode: string; topic: string; style: string; duration_seconds: number; language: ScriptLanguage;
      status: string; recorded_audio_path: string | null; script_json: unknown; long_form_production_plan: never }>();
  // Same answer for «missing» and «someone else's», so ids cannot be enumerated.
  if (error || !row || row.user_id !== user.id) return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
  // An own-script draft still needs its (paid) scene planning: it is «before the script», with its real fit.
  const stage = hasRenderableScript(row.script_json) || row.recorded_audio_path ? "before_render" as const : "before_script" as const;
  const draft = isOwnScriptDraft(row.script_json) ? row.script_json : null;
  const check = await checkProductionForRequest({ service, user, ownerId: user.id, stage, request: row, requestId: stage === "before_script" ? id : null,
    fit: draft ? draftFit(draft, row.duration_seconds, row.language) : null,
    // F40: the material ceiling typed in the review is checked here too (read-only); the render route re-checks it.
    directorMaterialUsd: materialFromQuery(request) });
  return NextResponse.json({ ...checkResponseBody(check), stage, status: row.status }, { headers: { "Cache-Control": "no-store" } });
}

/** ?materialUsd= from the review: finite, ≥ 0, capped at 4 decimals; anything else is ignored (0). */
function materialFromQuery(request: Request): number {
  const raw = new URL(request.url).searchParams.get("materialUsd");
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10_000) / 10_000 : 0;
}
