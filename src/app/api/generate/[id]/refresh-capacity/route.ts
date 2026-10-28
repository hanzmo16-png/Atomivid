import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { cinematicV6Enabled } from "@/lib/video/long-form/cinematic-v6-access";
import { lookupConfigurableRequest } from "@/lib/video/long-form/configure-lookup";
import { configurePlansWithMaterial, createMaterialSearchCache, materialCheckProviderWithDeadline, type MaterialPlanCheck } from "@/lib/video/long-form/material-plan";
import { VISUAL_STRATEGIES, type VisualStrategy } from "@/lib/video/long-form/production-plan";
import { strategyPreflight, type StrategyPreflight } from "@/lib/video/long-form/production-preflight";
import { budgetsForPlans, loadScriptSpentUsd } from "@/lib/video/long-form/worker-budget-preview";
import { refreshDemandedCapacity } from "@/lib/video/long-form/refresh-capacity";
import { jobSupplyDemands } from "@/lib/supply/job";
import { recraftAllowedFor } from "@/lib/video/recraft-access";

/** Las búsquedas gratuitas de material (material-plan.ts) tienen su propio plazo, por debajo de este. */
export const maxDuration = 120;

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
  // Same plans as the Configure page, with the same free material check (one search cache for every plan).
  const base = { script, topic: lookup.data.topic, durationSeconds: lookup.data.duration_seconds, cinematicV6: cinematicV6Enabled(user),
    footageProvider: materialCheckProviderWithDeadline(), searchCache: createMaterialSearchCache() };
  // Accounts that may choose Recraft also get the Recraft-priced plans re-checked (same as the Configure page).
  const [withMaterial, recraftWithMaterial] = await Promise.all([configurePlansWithMaterial(base),
    recraftAllowedFor(user) ? configurePlansWithMaterial({ ...base, imageProvider: "recraft" }) : Promise.resolve(null)]);
  const results = withMaterial.results;
  const recraftResults = recraftWithMaterial?.results ?? null;
  const service = createServiceClient();
  const all = [results, ...(recraftResults ? [recraftResults] : [])];
  const providers = [...new Set(all.flatMap((r) => VISUAL_STRATEGIES.flatMap((s) => jobSupplyDemands({ mode: "long_form", script_json: script, recorded_audio_path: null, long_form_production_plan: r[s].plan }, r[s].plan.providers.voice).map((d) => d.provider))))];
  const outcome = await refreshDemandedCapacity(service, providers);
  let scriptSpent: number | { error: string };
  try {
    scriptSpent = await loadScriptSpentUsd(service, id);
  } catch (error) {
    scriptSpent = { error: error instanceof Error ? error.message : "gasto del guion" };
  }
  const check = async (r: typeof results, material: Record<VisualStrategy, MaterialPlanCheck>) => {
    const budgets = await budgetsForPlans(service, Object.fromEntries(VISUAL_STRATEGIES.map((strategy) => [strategy, r[strategy].plan])), scriptSpent);
    return Object.fromEntries(await Promise.all(VISUAL_STRATEGIES.map(async (strategy) =>
      [strategy, await strategyPreflight(service, { strategy, plan: r[strategy].plan, scriptJson: script, refreshErrors: outcome.errors, workerBudget: budgets[strategy], material: material[strategy] })]))) as Record<VisualStrategy, StrategyPreflight>;
  };
  const [preflight, recraftPreflight] = await Promise.all([check(results, withMaterial.material),
    recraftResults && recraftWithMaterial ? check(recraftResults, recraftWithMaterial.material) : Promise.resolve(undefined)]);
  const planSet = (r: typeof results) => Object.fromEntries(VISUAL_STRATEGIES.map((s) => [s, r[s].plan]));
  return NextResponse.json({ preflight, ...(recraftPreflight ? { recraftPreflight } : {}),
    plans: planSet(results), ...(recraftResults ? { recraftPlans: planSet(recraftResults) } : {}), checkedAt: new Date().toISOString(), refreshed: outcome.refreshed, reused: outcome.reused, manual: outcome.manual });
}
