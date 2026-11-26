import { NextResponse } from "next/server";
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { materializeSeed } from "@/lib/audio-studio/service";
import { scriptAction } from "@/lib/audio-studio/script-service";
import { AUDIO_SCRIPT_PROJECT_PREFIX, scriptAiAvailability } from "@/lib/audio-studio/script-llm";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
/** Un paso = una llamada a la IA (escaleta o un bloque de ~10 min, 40–120 s): cabe holgadamente. */
export const maxDuration = 300;

const notJson = (r: Request) => !(r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

/**
 * Guion con IA: { action: "iniciar", revision } | { action: "paso", jobId } | { action: "cancelar" }.
 * El navegador pide los pasos uno a uno; el progreso se guarda en el proyecto entre pasos.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (notJson(request)) return NextResponse.json({ error: "Se esperaba JSON." }, { status: 415 });
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const { id } = await params;
  const text = await request.text().catch(() => "");
  if (text.length > 4_000) return NextResponse.json({ error: "Solicitud demasiado grande." }, { status: 413 });
  let b: unknown = null;
  try { b = JSON.parse(text); } catch { b = null; }
  const d = studioDeps(user);
  // El episodio inicial aún virtual se guarda antes de una acción explícita (una vez).
  if (!(await materializeSeed(d, user.id, id, { owner: user.owner }).then(() => true, () => false))) {
    return NextResponse.json({ error: "No se pudo guardar el episodio. Inténtalo de nuevo; no se cobró nada." }, { status: 503 });
  }
  const ai = scriptAiAvailability(user.id);
  const service = ai.mode === "real" ? createServiceClient() : null;
  const out = await scriptAction({
    ...d, ai,
    scriptSpend: service ? async () => {
      const { data, error } = await service.from("pi_paid_operations").select("reserved_usd, committed_usd").like("project_id", `${AUDIO_SCRIPT_PROJECT_PREFIX}${user.id}:%`)
        .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()).in("status", ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "COMMITTED"]);
      if (error || !Array.isArray(data)) throw new Error("ledger");
      return data.reduce((n, o) => n + Math.max(Number(o.reserved_usd) || 0, Number(o.committed_usd) || 0), 0);
    } : undefined,
    supplyPolicy: service ? async () => {
      const { data } = await service.from("pi_supply_policies").select("max_daily_calls,timezone,daily_cap_usd,monthly_cap_usd").eq("provider", "anthropic").maybeSingle();
      return data ? { maxDailyCalls: Number(data.max_daily_calls), timezone: String(data.timezone), dailyCapUsd: Number(data.daily_cap_usd), monthlyCapUsd: Number(data.monthly_cap_usd) } : null;
    } : undefined,
  }, user.id, id, b);
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}
