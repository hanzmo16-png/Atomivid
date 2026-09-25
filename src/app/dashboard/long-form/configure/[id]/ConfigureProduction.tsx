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
} from "@/lib/video/long-form/production-plan-types";

const USD = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} min ${s.toString().padStart(2, "0")} s` : `${s} s`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}

export function PlanSummary({ plan }: { plan: ProductionPlan }) {
  return (
    <div className="mt-3 text-sm">
      <dl>
        <Row label="Estrategia" value={VISUAL_STRATEGY_LABEL[plan.strategy]} />
        <Row label="Duración estimada" value={`~${formatDuration(plan.durationSeconds)}`} />
        <Row label="Escenas" value={String(plan.shotCount)} />
        <Row label="Video e imagen de archivo" value={String(plan.stockVideoCount + plan.stockImageCount)} />
        <Row label="Imágenes generadas por IA" value={String(plan.aiImageCount)} />
        <Row label="Clips de video IA" value={String(plan.aiVideoClipCount)} />
        <Row label="Segundos de video IA" value={plan.aiVideoClipCount > 0 ? `${Math.round(plan.aiVideoSeconds)} s` : "0 s"} />
        <Row label="Tarjetas de texto" value={String(plan.deterministicCount)} />
      </dl>
      <dl className="mt-3 rounded-md bg-surface-raised px-3 py-2">
        {plan.estimatedVoiceCostUsd !== undefined && <Row label="Narración" value={USD.format(plan.estimatedVoiceCostUsd)} />}
        {plan.estimatedImageCostUsd !== undefined && <Row label="Imágenes IA" value={USD.format(plan.estimatedImageCostUsd)} />}
        {plan.estimatedAiVideoCostUsd !== undefined && <Row label="Video IA" value={USD.format(plan.estimatedAiVideoCostUsd)} />}
        <Row label="Costo estimado de producción" value={USD.format(plan.estimatedProviderCostUsd)} />
      </dl>
      <p className="mt-2 text-xs text-ink-faint">
        Estimación de costo de proveedores (no incluye el guion ya generado). Todavía no hay un sistema de créditos: no se
        descuenta ningún saldo. La producción nunca supera las cantidades de este plan.
      </p>
      {plan.strategy === "cinematic" && plan.aiVideoAvailable === false && (
        <p className="mt-2 text-xs text-warning">El video generado por IA no está habilitado todavía: este plan usa imágenes IA en su lugar.</p>
      )}
    </div>
  );
}

/**
 * ÚNICO botón capaz de iniciar producción audiovisual paga de Long Form:
 * primero confirma (fija el plan de forma atómica) y solo si eso responde
 * 200 dispara el render. Deshabilitado mientras trabaja — y aunque llegaran
 * dos clics, el servidor confirma y encola una sola producción.
 */
export function ConfigureProduction({ requestId, plans }: { requestId: string; plans: Record<VisualStrategy, ProductionPlan> }) {
  const router = useRouter();
  const [strategy, setStrategy] = useState<VisualStrategy>("balanced");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (loading) return;
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
      router.refresh();
    }
  }

  return (
    <div className="mt-6">
      <fieldset className="grid gap-3" disabled={loading}>
        <legend className="mb-1 text-sm font-medium text-ink">Estrategia visual</legend>
        {VISUAL_STRATEGIES.map((option) => {
          const plan = plans[option];
          const selected = strategy === option;
          return (
            <label key={option} className="block cursor-pointer">
              <Card className={`p-4 transition-colors ${selected ? "border-accent-border ring-1 ring-accent-border" : ""}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="strategy"
                    value={option}
                    checked={selected}
                    onChange={() => setStrategy(option)}
                    className="mt-1 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="font-medium text-ink">{VISUAL_STRATEGY_LABEL[option]}</p>
                      <p className="text-sm tabular-nums text-ink-muted">~{USD.format(plan.estimatedProviderCostUsd)}</p>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-muted">{VISUAL_STRATEGY_DESCRIPTION[option]}</p>
                  </div>
                </div>
              </Card>
            </label>
          );
        })}
      </fieldset>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-medium text-ink">Plan de producción</h2>
        <PlanSummary plan={plans[strategy]} />
      </Card>

      <div className="mt-6 flex flex-col gap-2 pb-8 sm:items-start">
        <Button type="button" onClick={handleConfirm} loading={loading} className="w-full sm:w-auto">
          {loading ? "Confirmando…" : "Confirmar y generar video"}
        </Button>
        <p className="text-xs text-ink-faint">Nada se genera ni se cobra hasta que confirmes.</p>
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
