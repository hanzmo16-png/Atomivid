/**
 * Plan del PRODUCTO (Configurar y Confirmar): un único punto que decide la versión.
 *   - Por defecto: v3, exactamente el plan que producción ejecuta hoy (sin preflight HERO de v4).
 *   - Cuenta con Cinematic V6 habilitado y guion que declara impacto en todas sus escenas: v6.
 *   - Cuenta habilitada cuyo guion no es v6 (guion anterior, impacto incompleto, contrato inválido): v3.
 * Ningún trabajo persistido cambia: el worker ejecuta el plan confirmado tal cual.
 */
import { computeProductionPlan, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { PRODUCT_DEFAULT_PLAN_VERSION } from "./production-plan-types";
import { sequencesFromScript } from "./script-sequences";
import type { VisualStrategy } from "./shots";

export type ProductPlanResult = { plan: ProductionPlan; engine: "cinematic-v6" | "default"; reason: string };

export function productPlan(input: {
  beats: (ProductionPlanBeatInput & { purpose?: string })[];
  topic: string;
  strategy: VisualStrategy;
  providers: Parameters<typeof computeProductionPlan>[0]["providers"];
  requestedDurationSeconds?: number;
  cinematicV6: boolean;
}): ProductPlanResult {
  const base = { beats: input.beats, topic: input.topic, strategy: input.strategy, providers: input.providers, requestedDurationSeconds: input.requestedDurationSeconds };
  if (input.cinematicV6) {
    const sequences = sequencesFromScript(input.beats);
    if (sequences) {
      try {
        return { plan: computeProductionPlan({ ...base, sequences }), engine: "cinematic-v6", reason: "guion con impacto narrativo declarado en todas sus escenas" };
      } catch (err) {
        return { plan: computeProductionPlan({ ...base, version: PRODUCT_DEFAULT_PLAN_VERSION }), engine: "default", reason: `contrato de secuencia inválido: ${err instanceof Error ? err.message.slice(0, 160) : "error"}` };
      }
    }
    return { plan: computeProductionPlan({ ...base, version: PRODUCT_DEFAULT_PLAN_VERSION }), engine: "default", reason: "el guion no declara impacto en todas sus escenas (guion anterior a V6)" };
  }
  return { plan: computeProductionPlan({ ...base, version: PRODUCT_DEFAULT_PLAN_VERSION }), engine: "default", reason: "Cinematic V6 no está habilitado para esta cuenta" };
}
