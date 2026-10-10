"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { PodcastVideoStatus } from "@/lib/podcast/episode";

/**
 * Episode video, produced in the background by the app's worker (narration first if needed, then the editor v3
 * render). The page can be closed at any time: state lives on the server and this panel re-reads it.
 */
export function VideoPanel(props: {
  episodeId: string; status: PodcastVideoStatus; stage: string | null; stalled: boolean; error: string | null;
  canRequest: boolean; playUrl: string | null; downloadUrl: string | null; sizeMb: number | null; minutes: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const working = (props.status === "queued" || props.status === "running") && !props.stalled;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [working, router]);

  async function request() {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/podcast/${props.episodeId}/video`, { method: "POST" });
      const out = await safeParseJsonResponse<{ status: string }>(res);
      if (!out.ok) throw new Error(out.error);
      setMessage({ ok: true, text: "Producción iniciada. Puedes cerrar la app y volver: te mostraremos el avance aquí." });
    } catch (e) { setMessage({ ok: false, text: classifyClientFetchError(e) }); }
    finally { setBusy(false); router.refresh(); }
  }

  const retry = props.status === "failed" || props.stalled;
  return (
    <Card className="mt-4 p-4 text-sm">
      <h2 className="text-base font-semibold text-ink">Video del episodio</h2>
      <p className="mt-1 text-ink-muted">Video 16:9 en 1080p con la narración del episodio: clips y fotos en movimiento con licencia de Pexels que siguen lo que se dice y subtítulos sincronizados con la voz. El montaje no tiene costo de proveedores ni vuelve a cobrar la narración.</p>
      {working && <p className="mt-3 text-ink">En producción: {props.stage ?? "en cola"}… Puedes cerrar la app; el avance se guarda.</p>}
      {props.stalled && <p className="mt-3 text-warning">La producción dejó de responder. Puedes reintentarla: la narración y lo ya pagado se conservan.</p>}
      {props.status === "failed" && props.error && <p className="mt-3 text-danger">{props.error}</p>}
      {props.status === "ready" && props.playUrl && (
        <div className="mt-3 space-y-2">
          <video controls preload="metadata" playsInline src={props.playUrl} className="aspect-video w-full rounded-lg bg-black" />
          {props.downloadUrl && <a href={props.downloadUrl} className="inline-block font-medium text-accent underline">Descargar video{props.sizeMb ? ` (${props.sizeMb} MB)` : ""}</a>}
          {props.minutes ? <p className="text-ink-muted">Duración: {props.minutes} min. El enlace dura 6 horas; si caduca, recarga la página.</p> : null}
        </div>
      )}
      {props.canRequest && (props.status === "none" || retry || props.status === "ready") && (
        <div className="mt-3">
          <Button onClick={request} loading={busy}>{props.status === "ready" ? "Volver a producir el video" : retry ? "Reintentar" : "Producir video"}</Button>
        </div>
      )}
      {message && <p className={`mt-2 ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
    </Card>
  );
}
