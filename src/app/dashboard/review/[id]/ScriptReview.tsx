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
}: {
  requestId: string;
  status: string;
  initialScript: GeneratedScript;
  errorMessage: string | null;
}) {
  const router = useRouter();
  const [script, setScript] = useState(initialScript);
  const [dirty, setDirty] = useState(false);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  const editable = status === "script_ready";

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

  async function generateFinalVideo() {
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
      {!editable && (
        <Alert tone={status === "failed" ? "danger" : "info"}>
          {status === "processing" &&
            "El video ya se está generando a partir de este guion. Esta vista es de solo lectura."}
          {status === "completed" && "Este guion ya generó un video. Puedes verlo en el historial."}
          {status === "failed" &&
            `La generación falló${errorMessage ? `: ${errorMessage}` : ""}. Vuelve al historial para reintentar.`}
        </Alert>
      )}

      <div className="mt-4 space-y-4">
        {script.segments.map((scene, i) => (
          <Card key={i} className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Escena {i + 1}
              </span>
              {editable && (
                <button
                  type="button"
                  onClick={() => regenerateScene(i)}
                  disabled={savingIndex !== null || saving || generating}
                  className="text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-50"
                >
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
          </Card>
        ))}
      </div>

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

      {editable && (
        <div className="sticky bottom-4 mt-6 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-raised p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <Button variant="secondary" onClick={saveChanges} disabled={!dirty || saving || generating} loading={saving}>
            {saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios pendientes"}
          </Button>
          <Button onClick={generateFinalVideo} disabled={generating || saving} loading={generating}>
            {generating ? "Generando video…" : "Generar video final"}
          </Button>
        </div>
      )}

      {!editable && (
        <div className="mt-6">
          <LinkButton href="/dashboard">Volver al historial</LinkButton>
        </div>
      )}
    </div>
  );
}
