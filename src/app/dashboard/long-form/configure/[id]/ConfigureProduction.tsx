"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { LONG_FORM_DURATION_TOLERANCE } from "@/lib/video/long-form/duration-budget";
import type { LongFormPackaging } from "@/lib/video/long-form/packaging";
import { PackagingOptions } from "./PackagingOptions";
import type { StrategyPreflight, VisualCheck } from "@/lib/video/long-form/production-preflight";
import { rememberStartError } from "@/components/video/StartErrorNotice";

export type PreflightSummary = { modality: string; engine: string; requestedSeconds: number | null; voice: string; curationPath: string | null };

const VERDICT_CLASS: Record<string, string> = { Suficiente: "text-success", Insuficiente: "text-danger", "Sin verificar": "text-warning" };

/** What the user sees BEFORE starting; the same rules are enforced on the server (confirm + render). */
export function PreflightPanel({ summary, preflight, visual, visualBlockText, refresh }: { summary: PreflightSummary; preflight: StrategyPreflight; visual: VisualCheck; visualBlockText: string | null; refresh?: RefreshControl }) {
  return (
    <div className="mt-3 text-sm">
      <dl>
        <Row label="Modalidad" value={summary.modality} />
        <Row label="Motor" value={summary.engine} />
        {summary.requestedSeconds !== null && <Row label="Duración pedida" value={formatDuration(summary.requestedSeconds)} />}
        <Row label="Voz" value={summary.voice} />
        <Row label="Costo estimado" value={USD.format(preflight.estimatedUsd)} />
        <Row label="Límite autorizado por producción" value={USD.format(preflight.limitUsd)} />
      </dl>
      {!preflight.withinLimit && (
        <p className="mt-2 text-danger" role="alert">El costo estimado supera el límite autorizado. Elige una estrategia más económica.</p>
      )}
      <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-ink-muted">Capacidad de proveedores</h3>
      <ul className="mt-1 grid gap-1.5">
        {preflight.providers.map((p) => (
          <li key={p.provider} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-ink">{p.label}</span>
              <span className={`font-medium ${VERDICT_CLASS[p.verdict] ?? ""}`}>{p.verdict}</span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">{balanceProvenance(p)}</p>
            {p.refreshError && <p className="mt-1 text-xs text-danger">{p.refreshError}</p>}
            {p.action && <p className="mt-1 text-xs text-ink-muted">{p.action}</p>}
          </li>
        ))}
        {preflight.providers.length === 0 && !preflight.globalNote && <li className="text-xs text-ink-muted">Este plan no requiere proveedores de pago adicionales.</li>}
      </ul>
      {preflight.globalNote && <p className="mt-2 text-xs text-warning">{preflight.globalNote}</p>}
      {refresh && preflight.providers.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={refresh.onRefresh} loading={refresh.loading} disabled={refresh.cooldownSeconds > 0}>
            {refresh.cooldownSeconds > 0 ? `Actualizar disponibilidad (${refresh.cooldownSeconds} s)` : "Actualizar disponibilidad"}
          </Button>
          <span className="text-xs text-ink-muted">
            {refresh.checkedAt ? `Comprobado: ${formatWhen(refresh.checkedAt)}. ` : ""}Consulta el saldo al proveedor; no genera ni cobra nada. Un saldo consultado vale 5 minutos y se vuelve a comprobar al iniciar.
          </span>
          {refresh.error && <p role="alert" className="w-full text-xs text-danger">{refresh.error}</p>}
        </div>
      )}
      {visual.applies && (
        <>
          <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-ink-muted">Material visual verificado</h3>
          {visual.ready ? (
            <p className="mt-1 text-success">Listo: {visual.verifiedAssets} recurso(s) verificado(s); tarjetas de texto previstas dentro del límite.</p>
          ) : (
            <div className="mt-1 rounded-md border border-danger px-3 py-2" role="alert">
              <p className="text-danger">{visualBlockText}</p>
              {summary.curationPath
                ? <a className="mt-1 inline-block text-sm font-medium underline" href={summary.curationPath}>Abrir curaduría de recursos</a>
                : <p className="mt-1 text-xs text-ink-muted">Un curador autorizado debe aprobar el material antes de producir.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export type RefreshControl = { onRefresh: () => void; loading: boolean; cooldownSeconds: number; checkedAt: string | null; error: string | null };

const WHEN = new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" });
function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? WHEN.format(new Date(t)) : iso;
}

/** Where the balance came from and when: the user can tell a provider reading from a manual entry. */
export function balanceProvenance(p: StrategyPreflight["providers"][number]): string {
  if (!p.snapshotAt) return "Saldo: sin lecturas registradas.";
  const when = formatWhen(p.snapshotAt);
  if (p.source === "provider_api") return `Saldo consultado al proveedor el ${when} (vale 5 minutos).`;
  if (p.source === "manual_entry") return `Saldo registrado manualmente el ${when}; no se consulta al proveedor. Si recargaste, actualiza el registro.`;
  return `Saldo: ${p.sourceLabel ?? "origen desconocido"}, ${when}.`;
}

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
        {plan.requestedDurationSeconds !== undefined && <Row label="Duración pedida" value={formatDuration(plan.requestedDurationSeconds)} />}
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
      {plan.requestedDurationSeconds !== undefined &&
        Math.abs(plan.durationSeconds / plan.requestedDurationSeconds - 1) > LONG_FORM_DURATION_TOLERANCE && (
          <p className="mt-2 text-xs text-warning">
            La narración de este guion dura ~{formatDuration(plan.durationSeconds)}, distinto de los {formatDuration(plan.requestedDurationSeconds)} pedidos. El
            costo y el tiempo de producción corresponden a la duración estimada.
          </p>
        )}
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
export function ConfigureProduction({
  requestId,
  plans,
  preflight,
  visual,
  summary,
  visualBlockText = null,
  defaultPackaging,
  ownChannel = false,
}: {
  requestId: string;
  plans: Record<VisualStrategy, ProductionPlan>;
  preflight?: Record<VisualStrategy, StrategyPreflight>;
  visual?: VisualCheck;
  summary?: PreflightSummary;
  visualBlockText?: string | null;
  /** Presentación para YouTube inicial (activada por defecto solo en los canales propios). */
  defaultPackaging?: LongFormPackaging;
  ownChannel?: boolean;
}) {
  const router = useRouter();
  const [strategy, setStrategy] = useState<VisualStrategy>("balanced");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packaging, setPackaging] = useState<LongFormPackaging | undefined>(defaultPackaging);
  const [packagingValid, setPackagingValid] = useState(true);
  const onValidityChange = useCallback((valid: boolean) => setPackagingValid(valid), []);
  const [livePreflight, setLivePreflight] = useState(preflight);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));

  async function handleRefresh() {
    if (refreshing || cooldownSeconds > 0) return;
    setRefreshing(true);
    setRefreshError(null);
    const started = Date.now();
    setCooldownUntil(started + 60_000);
    setNowMs(started);
    try {
      const res = await fetch(`/api/generate/${requestId}/refresh-capacity`, { method: "POST" });
      const result = await safeParseJsonResponse<{ preflight: Record<VisualStrategy, StrategyPreflight>; checkedAt: string }>(res);
      if (!result.ok) throw new Error(result.error);
      setLivePreflight(result.data.preflight);
      setCheckedAt(result.data.checkedAt);
    } catch (err) {
      setRefreshError(`No se pudo actualizar la disponibilidad: ${classifyClientFetchError(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Known, certain refusals are shown here and enforced on the server; "Sin verificar" is checked at the click.
  const selectedPreflight = livePreflight?.[strategy];
  const blockedReason = !selectedPreflight ? null
    : !selectedPreflight.withinLimit ? "El costo estimado supera el límite autorizado."
    : visual && !visual.ready ? "Falta material visual verificado (ver Comprobación previa)."
    : selectedPreflight.providers.some((p) => p.verdict === "Insuficiente") ? "Un proveedor no tiene capacidad suficiente (ver Comprobación previa)."
    : null;

  async function handleConfirm() {
    // Synchronous guard: a second click before React re-renders sends nothing (the server stays the real guard).
    if (inFlight.current || loading || blockedReason) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    let confirmed = false;
    try {
      const confirmRes = await fetch(`/api/generate/${requestId}/confirm-production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packaging ? { strategy, packaging } : { strategy }),
      });
      const confirmResult = await safeParseJsonResponse(confirmRes);
      if (!confirmResult.ok) throw new Error(confirmResult.error);
      confirmed = true;

      const renderRes = await fetch(`/api/generate/${requestId}/render`, { method: "POST" });
      const renderResult = await safeParseJsonResponse(renderRes);
      if (!renderResult.ok) throw new Error(renderResult.error);

      router.push(`/dashboard/videos/${requestId}`);
    } catch (err) {
      const message = classifyClientFetchError(err);
      if (confirmed) {
        // The plan is confirmed, so this page now redirects to the video page: carry the reason there,
        // where "Iniciar producción" starts the same confirmed plan again (nothing was started or charged).
        rememberStartError(requestId, message);
        router.push(`/dashboard/videos/${requestId}`);
        return;
      }
      setError(message);
      setLoading(false);
      inFlight.current = false;
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

      {summary && selectedPreflight && visual && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-medium text-ink">Comprobación previa</h2>
          <PreflightPanel summary={summary} preflight={selectedPreflight} visual={visual} visualBlockText={visualBlockText}
            refresh={{ onRefresh: handleRefresh, loading: refreshing, cooldownSeconds, checkedAt, error: refreshError }} />
        </Card>
      )}

      {packaging && (
        <PackagingOptions value={packaging} onChange={setPackaging} onValidityChange={onValidityChange} disabled={loading} ownChannel={ownChannel} />
      )}

      <div className="mt-6 flex flex-col gap-2 pb-8 sm:items-start">
        <Button type="button" onClick={handleConfirm} loading={loading} disabled={!packagingValid || !!blockedReason} className="w-full sm:w-auto">
          {loading ? "Confirmando…" : "Confirmar y generar video"}
        </Button>
        <p className="text-xs text-ink-faint">Nada se genera ni se cobra hasta que confirmes.</p>
        {blockedReason && <p className="text-sm text-danger" role="alert">No se puede iniciar todavía: {blockedReason} Tu guion sigue guardado.</p>}
        {!packagingValid && (
          <p className="text-sm text-danger" role="alert">
            Corrige la portada o la miniatura (o desactívala) para continuar.
          </p>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
