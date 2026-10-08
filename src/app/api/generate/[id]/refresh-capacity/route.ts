import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { cinematicV6Enabled } from "@/lib/video/long-form/cinematic-v6-access";
import { lookupConfigurableRequest } from "@/lib/video/long-form/configure-lookup";
import { configurePlans } from "@/lib/video/long-form/product-plan";
import { VISUAL_STRATEGIES, type VisualStrategy } from "@/lib/video/long-form/production-plan";
import { strategyPreflight, type StrategyPreflight } from "@/lib/video/long-form/production-preflight";
import { refreshDemandedCapacity } from "@/lib/video/long-form/refresh-capacity";
import { jobSupplyDemands } from "@/lib/supply/job";

/**
 * "Actualizar disponibilidad" (Configurar): solo el dueño de la solicitud. Consulta el saldo (GET de
 * facturación) de los proveedores que ESTA producción necesita y devuelve la comprobación previa
 * recalculada. No genera, no reserva, no cobra. El inicio vuelve a comprobar en el servidor.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const lookup = await lookupConfigurableRequest(supabase, user, id, canAccessLongFormBeta(user));
  if (lookup.kind !== "ok") return NextResponse.json({ error: "Solicitud no disponible para configurar." }, { status: 404 });
  const script = lookup.data.script_json;
  const results = configurePlans({ script, topic: lookup.data.topic, durationSeconds: lookup.data.duration_seconds, cinematicV6: cinematicV6Enabled(user) });
  const service = createServiceClient();
  const providers = VISUAL_STRATEGIES.flatMap((s) => jobSupplyDemands({ mode: "long_form", script_json: script, recorded_audio_path: null, long_form_production_plan: results[s].plan }, results[s].plan.providers.voice).map((d) => d.provider));
  const outcome = await refreshDemandedCapacity(service, providers);
  const preflight = Object.fromEntries(await Promise.all(VISUAL_STRATEGIES.map(async (strategy) =>
    [strategy, await strategyPreflight(service, { strategy, plan: results[strategy].plan, scriptJson: script, refreshErrors: outcome.errors })]))) as Record<VisualStrategy, StrategyPreflight>;
  return NextResponse.json({ preflight, checkedAt: new Date().toISOString(), refreshed: outcome.refreshed, reused: outcome.reused, manual: outcome.manual });
}
