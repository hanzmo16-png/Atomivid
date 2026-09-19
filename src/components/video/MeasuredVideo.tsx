"use client";
import { useState } from "react";
import { durationPresentation } from "@/lib/video/duration-presentation";
export function MeasuredVideo({ src, requested, mode, className }: { src: string; requested: number; mode?: string; className?: string }) {
  const [measurement, setMeasurement] = useState<{ src: string; seconds: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const result = durationPresentation(requested, measurement?.src === src ? measurement.seconds : null, mode);
  return <div className="w-full space-y-3">
    <video src={src} controls preload="metadata" className={className}
      onLoadedMetadata={event => { setFailedSrc(null); setMeasurement({ src, seconds: event.currentTarget.duration }); }}
      onDurationChange={event => setMeasurement({ src, seconds: event.currentTarget.duration })}
      onError={() => { setFailedSrc(src); setMeasurement(null); }}>
      Tu navegador no puede reproducir este video.
    </video>
    <div className="space-y-1 text-sm" aria-live="polite">
      <p><strong>Duración solicitada:</strong> {result.requested}</p>
      <p><strong>Duración entregada:</strong> {failedSrc === src ? "No se pudo verificar. Recarga el video." : result.delivered}</p>
      {result.reason && <p>{result.reason}</p>}
    </div>
  </div>;
}
