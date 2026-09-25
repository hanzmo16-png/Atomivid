"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import {
  VISUAL_STRATEGIES,
  VISUAL_STRATEGY_LABEL,
  VISUAL_STRATEGY_DESCRIPTION,
  type ProductionPlan,
  type VisualStrategy,
} from "@/lib/video/long-form/production-plan";

const USD_FORMATTER = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function PlanSummary({ plan }: { plan: ProductionPlan }) {
  const rows: Array<[string, string]> = [
    ["Duración estimada", `${Math.round(plan.durationSeconds / 60)} min (${plan.durationSeconds}s)`],
    ["Escenas totales", String(plan.shotCount)],
    ["Video de archivo", String(plan.stockVideoCount)],
    ["Imagen de archivo", String(plan.stockImageCount)],
    ["Imágenes generadas por IA", String(plan.aiImageCount)],
    ["Clips de video generados por IA", plan.aiVideoClipCount > 0 ? `${plan.aiVideoClipCount} (${plan.aiVideoSeconds.toFixed(1)}s)` : "0"],
    ["Mapas/diagramas/texto", String(plan.deterministicCount)],
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="text-right font-medium text-ink">{value}</dd>
        </div>
      ))}
      <div className="col-span-2 mt-2 border-t border-border pt-2" />
      <dt className="text-ink-muted">Costo estimado de producción</dt>
      <dd className="text-right font-medium text-ink">{USD_FORMATTER.format(plan.estimatedProviderCostUsd)}</dd>
      <dd className="col-span-2 text-xs text-ink-faint">
        Costo interno de proveedores — todavía no hay un sistema de créditos para clientes.
      </dd>
    </dl>
  );
}

/**
 * RC mission "LONG FORM RC FINAL HARDENING" sección 35/36 — este es el
 * ÚNICO botón capaz de arrancar producción audiovisual paga de Long Form.
 * Orquesta dos pasos server-side, cada uno con su propia guarda atómica
 * independiente (ver confirm-production/route.ts y render/route.ts):
 * primero confirma (fija long_form_confirmed_at), y solo si eso responde
 * 200 dispara el render — así un doble clic nunca produce dos
 * confirmaciones ni dos renders, sin duplicar la lógica CAS de render/route.ts
 * aquí.
 */
export function ConfigureProduction({
  requestId,
  plans,
}: {
  requestId: string;
  plans: Record<VisualStrategy, ProductionPlan>;
}) {
  const router = useRouter();
  const [strategy, setStrategy] = useState<VisualStrategy>("balanced");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const confirmRes = await fetch(`/api/generate/${requestId}/confirm-production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy }),
      });
      const confirmResult = await safeParseJsonResponse(confirmRes);
      if (!confirmResult.ok) throw new Error(confirmResult.error);

      const renderRes = await fetch(`/api/generate/${requestId}/render`, { method: "POST" });
      const renderResult = await safeParseJsonResponse(renderRes);
      if (!renderResult.ok) throw new Error(renderResult.error);

      router.push(`/dashboard/videos/${requestId}`);
    } catch (err) {
      setError(classifyClientFetchError(err));
      setLoading(false);
    }
  }

  return (
    <div className="mt-6">
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium text-ink">Estrategia visual</legend>
        {VISUAL_STRATEGIES.map((option) => (
          <label key={option} className="block cursor-pointer">
            <Card
              className={`p-4 transition-colors ${strategy === option ? "border-accent-border ring-1 ring-accent-border" : ""}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="strategy"
                  value={option}
                  checked={strategy === option}
                  onChange={() => setStrategy(option)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-ink">{VISUAL_STRATEGY_LABEL[option]}</p>
                  <p className="mt-0.5 text-sm text-ink-muted">{VISUAL_STRATEGY_DESCRIPTION[option]}</p>
                </div>
              </div>
            </Card>
          </label>
        ))}
      </fieldset>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-medium text-ink">Plan de producción</h2>
        <PlanSummary plan={plans[strategy]} />
      </Card>

      <div className="mt-6 flex flex-col items-start gap-2">
        <Button type="button" onClick={handleConfirm} loading={loading}>
          {loading ? "Confirmando…" : "Confirmar y generar video"}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
