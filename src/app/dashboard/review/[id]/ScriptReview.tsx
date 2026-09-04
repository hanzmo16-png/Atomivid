"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GeneratedScript } from "@/lib/providers/types";

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
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudieron guardar los cambios");
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
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "No se pudo regenerar la escena");
      setScript(data.script);
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
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402) setNeedsSubscription(true);
        throw new Error(data?.error ?? "No se pudo generar el video");
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
        <p className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {status === "processing" &&
            "El video ya se está generando a partir de este guion. Esta vista es de solo lectura."}
          {status === "completed" &&
            "Este guion ya generó un video. Puedes verlo en el historial."}
          {status === "failed" &&
            `La generación falló${errorMessage ? `: ${errorMessage}` : ""}. Vuelve al historial para reintentar.`}
        </p>
      )}

      <div className="space-y-4">
        {script.segments.map((scene, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Escena {i + 1}
              </span>
              {editable && (
                <button
                  type="button"
                  onClick={() => regenerateScene(i)}
                  disabled={savingIndex !== null || saving || generating}
                  className="text-xs font-medium text-gray-900 underline disabled:opacity-50"
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
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
            <label className="mt-2 block text-xs text-gray-500">
              Búsqueda visual (imagen de apoyo)
            </label>
            <input
              value={scene.visualQuery}
              onChange={(e) => updateScene(i, "visualQuery", e.target.value)}
              disabled={!editable}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      {needsSubscription && (
        <p className="mt-2 text-sm">
          <Link href="/dashboard/billing" className="font-medium text-gray-900 underline">
            Ver planes
          </Link>
        </p>
      )}

      {editable && (
        <div className="sticky bottom-4 mt-6 flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={saveChanges}
            disabled={!dirty || saving || generating}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios pendientes"}
          </button>
          <button
            type="button"
            onClick={generateFinalVideo}
            disabled={generating || saving}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {generating ? "Generando video…" : "Generar video final"}
          </button>
        </div>
      )}

      {!editable && (
        <div className="mt-6">
          <Link
            href="/dashboard"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Volver al historial
          </Link>
        </div>
      )}
    </div>
  );
}
