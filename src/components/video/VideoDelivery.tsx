"use client";
import { useState } from "react";
import { RefreshStatusButton } from "./RefreshStatusButton";

export function VideoDelivery({ videoUrl, downloadUrl, landscape, compact = false }: {
  videoUrl: string; downloadUrl?: string | null; landscape: boolean; compact?: boolean;
}) {
  const [metadata, setMetadata] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  return <div className="flex w-full flex-col items-start gap-3">
    <video src={videoUrl} controls playsInline preload="metadata" aria-label="Video terminado"
      onLoadedMetadata={(event) => {
        const v = event.currentTarget;
        setFailed(false);
        setMetadata(Number.isFinite(v.duration) ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null);
      }}
      onError={() => setFailed(true)}
      className={`${landscape ? (compact ? "aspect-video w-full max-w-sm" : "aspect-video w-full") : "aspect-9/16 w-full max-w-72"} rounded-lg border border-border-strong bg-black`}>
      Tu navegador no puede reproducir este video.
    </video>
    {metadata && <p className="text-sm text-ink-muted">Duración real: {Math.floor(Math.round(metadata.duration) / 60)}:{String(Math.round(metadata.duration) % 60).padStart(2, "0")} · {metadata.width} × {metadata.height} · MP4</p>}
    {failed && <p role="alert" className="text-sm text-danger">No se pudo reproducir el archivo. Actualiza el enlace o prueba descargarlo.</p>}
    <div className="flex flex-wrap gap-2">
      {downloadUrl && <a href={downloadUrl} download target="_blank" rel="noopener noreferrer" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink">Descargar MP4</a>}
      <RefreshStatusButton label="Actualizar enlaces" />
    </div>
    {!downloadUrl && <p role="status" className="text-sm text-ink-muted">El enlace de descarga no está disponible. Actualiza los enlaces para volver a solicitarlo.</p>}
  </div>;
}
