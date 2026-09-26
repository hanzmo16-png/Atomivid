"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { AudiovisualSelector } from "@/components/video/AudiovisualSelector";
import type { AudiovisualSelection } from "@/lib/video/audiovisual/catalog";

type Issue = { area: string; code: string; message: string; recovery: string };

/**
 * Dirección audiovisual del Reel en la revisión del guion: resumen de lo
 * que se va a producir con ESTE guion, problemas detectados antes de gastar
 * (música o imágenes no disponibles) y la opción de cambiarla.
 */
export function DirectionPanel({
  requestId,
  style,
  selection,
  summary,
  issues,
  editable,
}: {
  requestId: string;
  style: string;
  selection: AudiovisualSelection;
  summary: string;
  issues: Issue[];
  editable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/generate/${requestId}/direction`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: data.get("av_profile"), intent: data.get("av_intent"), music: data.get("av_music"), pace: data.get("av_pace") }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "No se pudo guardar la dirección.");
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la dirección.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-md border border-border bg-surface-raised p-4" aria-labelledby="direction-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="direction-heading" className="text-sm font-medium text-ink">
          Dirección audiovisual
        </h2>
        {editable && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="text-sm font-medium text-accent hover:underline">
            Cambiar
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink" data-testid="direction-summary">
        {summary}
      </p>
      {issues.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-sm" role="alert">
          {issues.map((i) => (
            <li key={i.code} className="text-warning">
              {i.message} <span className="text-ink-muted">{i.recovery}</span>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form onSubmit={save} className="mt-4 space-y-3">
          <AudiovisualSelector style={style} initial={selection} disabled={saving} />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Guardando…" : "Guardar dirección"}
            </Button>
            <button type="button" onClick={() => setEditing(false)} className="text-sm text-ink-muted hover:text-ink">
              Cancelar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
