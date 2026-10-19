"use client";

import { ProductionReadinessNotice } from "@/components/video/ProductionReadinessNotice";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GeneratedScript } from "@/lib/providers/types";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Button, LinkButton } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { avatarDurationError, estimateAvatarNarrationSeconds } from "@/lib/video/avatar/duration";

export function ScriptReview({
  requestId,
  status,
  initialScript,
  errorMessage,
  usesRecording = false,
  diagnosticRetry = false,
  reelRetryEligible = false,
  entitlementBlockedReason,
  recovery,
  maxAvatarDurationSeconds,
  recordingDurationSeconds,
  directorMaterialOffer,
}: {
  requestId: string;
  status: string;
  initialScript: GeneratedScript;
  errorMessage: string | null;
  usesRecording?: boolean;
  diagnosticRetry?: boolean;
  /** Owner-confirmed retry starts on the review page, never directly from the history card. */
  reelRetryEligible?: boolean;
  maxAvatarDurationSeconds?: number;
  recordingDurationSeconds?: number;
  /**
   * QA blocker real (2026-09-25): "Generar video final" quedaba
   * visualmente habilitado para avatar aunque el plan del usuario no
   * incluyera avatar — el POST fallaba recién al pulsar. Cuando viene
   * definido (comprobado server-side en page.tsx, avatarEntitlementPreview),
   * el botón se deshabilita y muestra este motivo de antemano en vez de
   * dejar que el usuario descubra el bloqueo después de esperar el envío.
   * Nunca es la fuente de verdad que impide generar — esa sigue siendo
   * assertCanGenerate en render/route.ts, server-side, no bypasseable
   * desde aquí.
   */
  entitlementBlockedReason?: string;
  /**
   * Failed avatar only, decided server-side from the request + its paid ledger (decideAvatarRecovery):
   * either the safe action offered right here (retry / recover the job HeyGen already accepted), or why
   * it is not offered. The render route enforces the same rule.
   */
  recovery?: { kind: "action"; label: string; note: string } | { kind: "blocked"; message: string };
  /** Anexo C1 (owner tests with the Director only): ceiling of new Director material to approve for this video. */
  directorMaterialOffer?: { simulatedUsd: number; maxUsd: number };
}) {
  const router = useRouter();
  const [script, setScript] = useState(initialScript);
  // Anexo C1: the simulated need, rounded up to cents, as the suggested ceiling (the owner can change it, or 0).
  const [materialUsd, setMaterialUsd] = useState(() => directorMaterialOffer ? (Math.ceil(directorMaterialOffer.simulatedUsd * 100 - 1e-6) / 100).toFixed(2) : "0");
  const [dirty, setDirty] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState(errorMessage);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const activeSceneProgressRef = useRef<HTMLDivElement>(null);
  // The last scene can sit under the sticky action footer. Center the active progress indicator
  // as soon as a scene request starts so mobile users see it without manual scrolling.
  useEffect(() => {
    if (savingIndex !== null) activeSceneProgressRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [savingIndex]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [regeneratingAll, setRegeneratingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);
  // Control de costos (2026-10-18): the real script needs a higher provider ceiling than the one estimated
  // before it. Nothing started; the script is kept. The customer accepts the new ceiling explicitly.
  const [costChange, setCostChange] = useState<{ beforeUsd: number; afterUsd: number } | null>(null);

  const recoveryAction = status === "failed" && recovery?.kind === "action" ? recovery : null;
  const canGenerate = status === "script_ready" || diagnosticRetry || recoveryAction !== null || reelRetryEligible;
  // A recovery reuses exactly what was approved: no edits (they would change paid inputs).
  const editable = canGenerate && !usesRecording && !recoveryAction && !reelRetryEligible;
  const entitlementBlocked = Boolean(entitlementBlockedReason);
  const durationBlockedReason = maxAvatarDurationSeconds === undefined ? null : avatarDurationError(
    usesRecording ? (recordingDurationSeconds ?? Number.NaN) : estimateAvatarNarrationSeconds(script.segments.map(scene => scene.text).join(" ")),
    maxAvatarDurationSeconds,
  );

  function updateScene(index: number, field: "text" | "visualQuery", value: string) {
    setScript((prev) => ({
      ...prev,
      segments: prev.segments.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    }));
    setDirty(true);
  }

  async function saveChanges(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/generate/${requestId}/script`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(script),
      });
      const result = await safeParseJsonResponse(res);
      if (!result.ok) throw new Error(result.error);
      setDirty(false);
      setRecoveryNotice(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function regenerateScene(index: number) {
    setSavingIndex(index);
    setError(null);
    try {
      const res = await fetch(`/api/generate/${requestId}/script/regenerate-scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneIndex: index }),
      });
      const result = await safeParseJsonResponse<{ script: GeneratedScript }>(res);
      if (!result.ok) throw new Error(result.error);
      setScript(result.data.script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSavingIndex(null);
    }
  }

  /**
   * Regenera el guion completo (título + todas las escenas) desde cero —
   * no escena por escena. Reemplaza cualquier edición manual sin guardar,
   * así que pide confirmación antes de descartarla.
   */
  async function regenerateFullScript() {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Esto reemplaza el guion completo (todas las escenas). ¿Continuar?")
    ) {
      return;
    }

    setRegeneratingAll(true);
    setError(null);
    try {
      const res = await fetch(`/api/generate/${requestId}/script`, { method: "POST" });
      const result = await safeParseJsonResponse<{ script: GeneratedScript }>(res);
      if (!result.ok) throw new Error(result.error);
      setScript(result.data.script);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setRegeneratingAll(false);
    }
  }

  async function generateFinalVideo(acceptedCeilingUsd?: number) {
    const material = directorMaterialOffer ? Number(materialUsd || "0") : 0;
    if (entitlementBlocked || durationBlockedReason) return;
    setGenerating(true);
    setError(null);
    setNeedsSubscription(false);
    setCostChange(null);

    if (dirty) {
      const ok = await saveChanges();
      if (!ok) {
        setGenerating(false);
        return;
      }
    }

    try {
      const body = { ...(acceptedCeilingUsd ? { acceptedCeilingUsd } : {}), ...(material > 0 ? { directorMaterialUsd: material } : {}) };
      const res = await fetch(`/api/generate/${requestId}/render`, Object.keys(body).length
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method: "POST" });
      const result = await safeParseJsonResponse(res);
      if (!result.ok) {
        if (result.status === 402) setNeedsSubscription(true);
        const change = (result.body as { costChange?: { beforeUsd?: unknown; afterUsd?: unknown } } | undefined)?.costChange;
        if (result.status === 409 && change && typeof change.beforeUsd === "number" && typeof change.afterUsd === "number") {
          setCostChange({ beforeUsd: change.beforeUsd, afterUsd: change.afterUsd });
          setGenerating(false);
          return;
        }
        throw new Error(result.error);
      }
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
      setGenerating(false);
    }
  }

  return (
    <div className="mt-6">
      {status === "script_ready" && !usesRecording && <ProductionReadinessNotice requestId={requestId} />}
      {status === "script_ready" && recoveryNotice && (
        <Alert tone="info">{recoveryNotice} Puedes ajustar el texto aquí y guardar los cambios antes de producirlo de nuevo.</Alert>
      )}
      {!canGenerate && (
        <Alert tone={status === "failed" ? "danger" : "info"}>
          {status === "processing" &&
            "El video ya se está generando a partir de este guion. Esta vista es de solo lectura."}
          {status === "completed" && "Este guion ya generó un video. Puedes verlo en el historial."}
          {status === "failed" &&
            `La generación falló${errorMessage ? `: ${errorMessage}` : ""}. ${recovery?.kind === "blocked" ? recovery.message : "Vuelve al historial para reintentar."}`}
        </Alert>
      )}

      {reelRetryEligible && (
        <Alert tone="warning">
          {errorMessage ? `El intento anterior terminó con error: ${errorMessage}. ` : ""}
          El reintento no se inicia desde el historial. Comprueba el tope de material nuevo del Director
          y confírmalo aquí antes de iniciar. Las imágenes ya guardadas se intentarán reutilizar;
          cualquier material adicional fuera del tope confirmado debe detenerse antes de llamar al proveedor.
          Para proteger lo ya pagado, el guion de este intento es de solo lectura.
        </Alert>
      )}
      {recoveryAction && (
        <Alert tone="danger">
          {`La generación falló${errorMessage ? `: ${errorMessage}` : ""}.`} {recoveryAction.note}
        </Alert>
      )}

      {editable && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-ink-muted">
            ¿El guion no cumple lo que esperabas? Puedes regenerarlo completo.
          </p>
          <button
            type="button"
            onClick={regenerateFullScript}
            disabled={saving || generating || regeneratingAll || savingIndex !== null}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-hover disabled:opacity-50"
          >
            <RefreshIcon spinning={regeneratingAll} />
            {regeneratingAll ? "Regenerando guion…" : "Regenerar guion completo"}
          </button>
        </div>
      )}
      {regeneratingAll && <PendingOperationProgress label="Regenerando guion completo" />}

      {usesRecording && <Alert tone="info">Se utilizará tu grabación completa. No se generará un guion ni otra voz. La duración se comprobará antes de solicitar el avatar.</Alert>}
      {canGenerate && durationBlockedReason && <Alert tone="warning">{durationBlockedReason}</Alert>}
      {!usesRecording && <div className="mt-4 space-y-4">
        {script.segments.map((scene, i) => (
          <Card key={i} className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Escena {i + 1}
                </span>
              </span>
              {editable && (
                <button
                  type="button"
                  onClick={() => regenerateScene(i)}
                  disabled={savingIndex !== null || saving || generating || regeneratingAll}
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-50"
                >
                  <RefreshIcon spinning={savingIndex === i} />
                  {savingIndex === i ? "Regenerando…" : "Regenerar esta escena"}
                </button>
              )}
            </div>
            {savingIndex === i && (
              <div ref={activeSceneProgressRef} className="scroll-mb-44">
                <PendingOperationProgress label={`Regenerando escena ${i + 1}`} />
              </div>
            )}

            <textarea
              value={scene.text}
              onChange={(e) => updateScene(i, "text", e.target.value)}
              disabled={!editable}
              rows={3}
              aria-label={`Narración de la escena ${i + 1}`}
              className="w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
            />
            <label htmlFor={`visual-${i}`} className="mt-2 block text-xs text-ink-faint">
              Búsqueda visual (imagen de apoyo)
            </label>
            <input
              id={`visual-${i}`}
              value={scene.visualQuery}
              onChange={(e) => updateScene(i, "visualQuery", e.target.value)}
              disabled={!editable}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </Card>
        ))}
      </div>}

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {costChange && (
        <div className="mt-4" data-testid="cost-change">
          <Alert tone="warning">
            <p className="font-medium">El video con tu guion final necesita un techo de proveedores mayor.</p>
            <p className="mt-1">Antes del guion: hasta USD {costChange.beforeUsd.toFixed(2)}. Con tu guion: hasta USD {costChange.afterUsd.toFixed(2)}.
              Son techos conservadores, no el precio exacto. No se inició nada ni se cobró; tu guion se conserva.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" onClick={() => generateFinalVideo(costChange.afterUsd)} disabled={generating}>
                Aceptar hasta USD {costChange.afterUsd.toFixed(2)} y generar
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCostChange(null)} disabled={generating}>Revisar el guion</Button>
            </div>
          </Alert>
        </div>
      )}
      {needsSubscription && (
        <p className="mt-2 text-sm">
          <Link href="/dashboard/billing" className="font-medium text-accent hover:text-accent-hover">
            Ver planes
          </Link>
        </p>
      )}

      {canGenerate && entitlementBlocked && (
        <div className="mt-4">
          <Alert tone="warning">{entitlementBlockedReason}</Alert>
          <p className="mt-2 text-sm">
            <Link href="/dashboard/billing" className="font-medium text-accent hover:text-accent-hover">
              Ver planes
            </Link>
          </p>
        </div>
      )}

      {canGenerate && directorMaterialOffer && (
        <div className="mt-6 rounded-md border border-border-strong bg-surface-raised p-4 text-sm" data-testid="director-material">
          <label htmlFor="director-material-usd" className="font-medium text-ink">Tope aprobado para material nuevo del Director en este video (USD)</label>
          <input id="director-material-usd" type="number" inputMode="decimal" min={0} max={directorMaterialOffer.maxUsd} step={0.01}
            value={materialUsd} onChange={(e) => setMaterialUsd(e.target.value)} className="mt-2 w-32 rounded-md border border-border-strong bg-surface px-2 py-1 text-ink" />
          <ul className="mt-2 space-y-1 text-xs text-ink-muted">
            <li>Costo previsto (simulación, antes de la voz): hasta USD {directorMaterialOffer.simulatedUsd.toFixed(2)}. El real se calcula con la narración medida.</li>
            <li>Es un tope, no un objetivo: solo se paga la imagen de cada plano que no tenga material adecuado. Si el tope no alcanza, el Director se detiene antes de pagar y te dice cuánto falta; la voz se conserva.</li>
            <li>Solo para tus pruebas privadas (máximo USD {directorMaterialOffer.maxUsd.toFixed(2)}); no es la cuota de un plan comercial. 0 = sin material nuevo.</li>
          </ul>
        </div>
      )}

      {canGenerate && (
        <div className="sticky bottom-4 mt-6 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-raised p-4 shadow-lg sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          {!usesRecording && <Button
            variant="secondary"
            onClick={saveChanges}
            disabled={!dirty || saving || generating || regeneratingAll}
            loading={saving}
          >
            {saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios pendientes"}
          </Button>}
          <Button
            onClick={() => generateFinalVideo()}
            disabled={entitlementBlocked || Boolean(durationBlockedReason) || generating || saving || regeneratingAll}
            loading={generating}
            title={entitlementBlocked ? entitlementBlockedReason : durationBlockedReason ?? undefined}
          >
            {generating ? "Generando video…" : recoveryAction ? recoveryAction.label : "Generar video final"}
          </Button>
          {generating && <PendingOperationProgress label="Iniciando producción del video" />}
        </div>
      )}

      {!canGenerate && (
        <div className="mt-6">
      {status === "script_ready" && recoveryNotice && (
        <Alert tone="info">{recoveryNotice} Puedes ajustar el texto aquí y guardar los cambios antes de producirlo de nuevo.</Alert>
      )}
          <LinkButton href="/dashboard">Volver al historial</LinkButton>
        </div>
      )}
    </div>
  );
}

/** Shows feedback right next to the action the owner clicked; no invented numeric percentage. */
function PendingOperationProgress({ label }: { label: string }) {
  return (
    <div className="mt-2 w-full" role="status" aria-live="polite">
      <p className="mb-1.5 text-xs font-medium text-ink-muted">{label}…</p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuetext="Operación en curso, porcentaje no disponible"
        className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
      >
        <div className="h-full w-2/5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${spinning ? "animate-spin motion-reduce:animate-none" : ""}`}
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
