import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getRenderWorker } from "@/lib/worker";
import { getVoiceProvider } from "@/lib/providers/voice";
import { jobSupplyDemands, JobEnvelopeMismatchError } from "@/lib/supply/job";
import { ensureJobSupplyReady, START_SUPPLY_UNAVAILABLE } from "@/lib/supply/readiness";
import { supplyGuardRequired } from "@/lib/supply/server";
import { providerCheck } from "@/lib/video/long-form/production-preflight";
import { resumeSupplyRequest } from "@/lib/supply/queue";
import { RESUME_MESSAGE } from "@/lib/supply/resume-messages";
import { generateDiagnosticId, logRenderError } from "@/lib/video/render-error";

export const runtime = "nodejs";
export const maxDuration = 60;


/**
 * Owner-initiated resume of a production that the worker parked waiting for provider capacity.
 * Same attempt and envelope as before (resumeSupplyRequest): no new attempt, quota or permission.
 * Before reserving, the job's own providers are re-read from their billing endpoints (no charge).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  // Ownership through the user's own session (RLS + explicit filter): someone else's id is "not found".
  const { data: owned, error: ownedError } = await supabase.from("video_requests")
    .select("id,mode,render_attempts,script_json,recorded_audio_path,long_form_production_plan,status,progress_stage,supply_wait_started_at")
    .eq("id", id).eq("user_id", user.id).maybeSingle();
  if (ownedError) return NextResponse.json({ error: "No se pudo leer la solicitud. Recarga la página." }, { status: 503 });
  if (!owned) return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
  if (owned.status !== "processing" || owned.progress_stage !== "queued" || !owned.supply_wait_started_at) {
    return NextResponse.json({ error: RESUME_MESSAGE.not_waiting }, { status: 409 });
  }

  try {
    const service = createServiceClient();
    const worker = getRenderWorker();
    if (supplyGuardRequired()) {
      const demands = jobSupplyDemands(owned as never, getVoiceProvider().name);
      const readiness = await ensureJobSupplyReady(service, demands, { refresh: true });
      if (!readiness.ready) {
        const failing = readiness.providers.find((r) => !r.ok);
        const action = failing ? providerCheck(failing, demands.find((d) => d.provider === failing.provider)?.unit ?? "usd").action : null;
        return NextResponse.json({ error: action ? `${START_SUPPLY_UNAVAILABLE} ${action}` : START_SUPPLY_UNAVAILABLE }, { status: 503, headers: { "Retry-After": "300" } });
      }
    }
    const outcome = await resumeSupplyRequest(service, id, user.id, (input) => worker.trigger(input));
    if (outcome === "dispatched") return NextResponse.json({ ok: true, message: RESUME_MESSAGE.dispatched });
    const status = outcome === "supply_unavailable" ? 503 : 409;
    return NextResponse.json({ error: RESUME_MESSAGE[outcome] }, { status });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /resume", error, diagnosticId);
    if (error instanceof JobEnvelopeMismatchError) return NextResponse.json({ error: `${error.customerMessage} (Código: ${diagnosticId})` }, { status: 409 });
    return NextResponse.json({ error: `No se pudo reanudar la producción. Tu avance está guardado. (Código: ${diagnosticId})` }, { status: 500 });
  }
}
