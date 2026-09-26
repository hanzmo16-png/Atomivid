"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GeneratedScript } from "@/lib/providers/types";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Button, LinkButton } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";

export function ScriptReview({
  requestId,
  status,
  initialScript,
  errorMessage,
  usesRecording = false,
  diagnosticRetry = false,
  entitlementBlockedReason,
  animated = false,
}: {
  requestId: string;
  status: string;
  initialScript: GeneratedScript;
  errorMessage: string | null;
  usesRecording?: boolean;
  diagnosticRetry?: boolean;
  /** «Animación IA»: muestra y permite editar la acción visible de cada escena. */
  animated?: boolean;
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
}) {
  const router = useRouter();
  const [script, setScript] = useState(initialScript);
  const [dirty, setDirty] = useState(false);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [regeneratingAll, setRegeneratingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  const canGenerate = status === "script_ready" || diagnosticRetry;
  const editable = canGenerate && !usesRecording;
  const entitlementBlocked = Boolean(entitlementBlockedReason);

  function updateScene(index: number, field: "text" | "visualQuery" | "visibleAction" | "actionStart" | "actionEnd", value: string) {
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

  async function generateFinalVideo() {
    if (entitlementBlocked) return;
    setGenerating(true);
    setError(null);
    setNeedsSubscription(false);

    if (dirty) {
      const ok = await saveChanges();
      if (!ok) {
        setGenerating(false);
        return;
      }
    }

    try {
      const res = await fetch(`/api/generate/${requestId}/render`, { method: "POST" });
      const result = await safeParseJsonResponse(res);
      if (!result.ok) {
        if (result.status === 402) setNeedsSubscription(true);
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
      {!canGenerate && (
        <Alert tone={status === "failed" ? "danger" : "info"}>
          {status === "processing" &&
            "El video ya se está generando a partir de este guion. Esta vista es de solo lectura."}
          {status === "completed" && "Este guion ya generó un video. Puedes verlo en el historial."}
          {status === "failed" &&
            `La generación falló${errorMessage ? `: ${errorMessage}` : ""}. Vuelve al historial para reintentar.`}
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

      {usesRecording && <Alert tone="info">Se utilizará tu grabación completa. No se generará un guion ni otra voz. La duración se comprobará antes de solicitar el avatar.</Alert>}
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
            {animated && (
              <>
                <label htmlFor={`action-${i}`} className="mt-2 block text-xs text-ink-faint">
                  Acción visible de la animación (una sola, breve, en inglés)
                </label>
                <input
                  id={`action-${i}`}
                  value={scene.visibleAction ?? ""}
                  maxLength={160}
                  onChange={(e) => updateScene(i, "visibleAction", e.target.value)}
                  disabled={!editable}
                  placeholder="the keeper slams the iron door shut"
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
                />
                <label htmlFor={`action-start-${i}`} className="mt-2 block text-xs text-ink-faint">
                  Pose inicial, antes de la acción (opcional)
                </label>
                <input
                  id={`action-start-${i}`}
                  value={scene.actionStart ?? ""}
                  maxLength={160}
                  onChange={(e) => updateScene(i, "actionStart", e.target.value)}
                  disabled={!editable}
                  placeholder="the keeper stands with his back to the door"
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
                />
                <label htmlFor={`action-end-${i}`} className="mt-2 block text-xs text-ink-faint">
                  Estado final que se mantiene hasta el corte (opcional)
                </label>
                <input
                  id={`action-end-${i}`}
                  value={scene.actionEnd ?? ""}
                  maxLength={160}
                  onChange={(e) => updateScene(i, "actionEnd", e.target.value)}
                  disabled={!editable}
                  placeholder="the iron door stays fully shut"
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
                />
              </>
            )}
          </Card>
        ))}
      </div>}

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
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

      {canGenerate && (
        <div className="sticky bottom-4 mt-6 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-raised p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          {!usesRecording && <Button
            variant="secondary"
            onClick={saveChanges}
            disabled={!dirty || saving || generating || regeneratingAll}
            loading={saving}
          >
            {saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios pendientes"}
          </Button>}
          <Button
            onClick={generateFinalVideo}
            disabled={entitlementBlocked || generating || saving || regeneratingAll}
            loading={generating}
            title={entitlementBlocked ? entitlementBlockedReason : undefined}
          >
            {generating ? "Generando video…" : "Generar video final"}
          </Button>
        </div>
      )}

      {!canGenerate && (
        <div className="mt-6">
          <LinkButton href="/dashboard">Volver al historial</LinkButton>
        </div>
      )}
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
