"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function VideoPlayback({ src, compact = false }: { src: string; compact?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const router = useRouter();
  return <div className={compact ? "w-36" : "w-full max-w-72"}>
    <video key={src} src={src} controls preload="metadata" playsInline aria-label="Video generado"
      onError={() => setFailedSrc(src)} className="max-h-[70vh] w-full rounded-lg bg-black object-contain">
      Tu navegador no puede reproducir este video.
    </video>
    {failedSrc === src && <div role="alert" className="mt-2 space-y-2 text-sm text-danger">
      <p>No se pudo reproducir el video. El enlace puede haber vencido.</p>
      <Button variant="secondary" size="sm" onClick={() => router.refresh()}>Actualizar enlace</Button>
    </div>}
  </div>;
}
