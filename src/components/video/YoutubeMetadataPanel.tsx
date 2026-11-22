"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { YoutubeMetadata } from "@/lib/delivery/youtube-package";

/**
 * T-VIDEO-GO-20261122: título, descripción y capítulos para pegar en YouTube Studio junto al MP4 ya descargado.
 * Solo muestra y copia texto derivado del documental terminado; no publica nada ni llama a ningún proveedor.
 */
export function YoutubeMetadataPanel({ metadata }: { metadata: YoutubeMetadata }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(`${key}:error`);
    }
  };
  const status = (key: string) =>
    copied === key ? "Copiado" : copied === `${key}:error` ? "No se pudo copiar: selecciónalo y cópialo a mano" : null;
  return (
    <Card className="mt-4 p-4" data-testid="youtube-metadata">
      <h2 className="text-base font-semibold text-ink">Datos para YouTube</h2>
      <p className="mt-1 text-sm text-ink-muted">Cópialos en YouTube Studio al subir el video. Atomicvid no publica nada por ti.</p>

      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="yt-title">Título</label>
      <input id="yt-title" readOnly value={metadata.title} className="mt-1 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-ink" />
      <div className="mt-2 flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => copy("title", metadata.title)}>Copiar título</Button>
        {status("title") && <span role="status" className="text-xs text-ink-muted">{status("title")}</span>}
      </div>

      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="yt-description">Descripción{metadata.chapters.length ? " (con capítulos)" : ""}</label>
      <textarea id="yt-description" readOnly rows={Math.min(14, 3 + metadata.description.split("\n").length)} value={metadata.description}
        className="mt-1 w-full rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-ink" />
      <div className="mt-2 flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => copy("description", metadata.description)}>Copiar descripción</Button>
        {status("description") && <span role="status" className="text-xs text-ink-muted">{status("description")}</span>}
      </div>
      {metadata.chapters.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">Sin capítulos: YouTube exige al menos 3 tramos de 10 s o más.</p>
      )}
      {metadata.tags.length > 0 && <p className="mt-3 text-xs text-ink-muted">Etiquetas sugeridas: {metadata.tags.join(", ")}</p>}
    </Card>
  );
}
