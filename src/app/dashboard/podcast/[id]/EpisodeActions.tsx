"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import { createClient } from "@/lib/supabase/client";
import { balanceProvenance } from "@/app/dashboard/long-form/configure/[id]/ConfigureProduction";
import type { PodcastCapacity } from "@/lib/podcast/episode";

const VERDICT_CLASS: Record<string, string> = { Suficiente: "text-success", Insuficiente: "text-danger", "Sin verificar": "text-warning" };

export function EpisodeActions(props: { episodeId: string; source: "tts" | "upload"; status: string; stalled: boolean; error: string | null; capacity: PodcastCapacity | null; playUrl: string | null; downloadUrl: string | null }) {
  const router = useRouter();
  const [capacity, setCapacity] = useState(props.capacity);
  const [busy, setBusy] = useState<null | "generate" | "refresh" | "upload">(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [background, setBackground] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);
  // While another tab/run is generating, re-read the page every 10 s.
  useEffect(() => {
    if (!(props.status === "generating" || (background && props.status !== "ready")) || props.stalled || busy) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [props.status, props.stalled, busy, router, background]);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));

  async function call<T>(url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const out = await safeParseJsonResponse<T>(res);
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }

  async function refresh() {
    if (busy || cooldown) return;
    setBusy("refresh"); setMessage(null);
    const t = Date.now(); setCooldownUntil(t + 60_000); setNowMs(t);
    try { setCapacity((await call<{ capacity: PodcastCapacity }>(`/api/podcast/${props.episodeId}/refresh-capacity`)).capacity); }
    catch (e) { setMessage({ ok: false, text: `No se pudo actualizar la disponibilidad: ${classifyClientFetchError(e)}` }); }
    finally { setBusy(null); }
  }

  async function generate() {
    if (busy) return;
    setBusy("generate"); setMessage(null);
    try {
      const out = await call<{ costUsd?: number; background?: boolean }>(`/api/podcast/${props.episodeId}/generate`);
      if (out.background) {
        setBackground(true);
        setMessage({ ok: true, text: "La narración se está generando en segundo plano. Puedes cerrar la app y volver: el avance y lo ya pagado se conservan." });
      } else {
        setMessage({ ok: true, text: `Episodio listo. Costo registrado: ${Number(out.costUsd).toFixed(4)} USD.` });
      }
    } catch (e) { setMessage({ ok: false, text: classifyClientFetchError(e) }); }
    finally { setBusy(null); router.refresh(); }
  }

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const file = new FormData(e.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) return setMessage({ ok: false, text: "Elige un archivo de audio." });
    setBusy("upload"); setMessage(null);
    try {
      const ticket = await call<{ path: string; token: string }>(`/api/podcast/${props.episodeId}/recording`, { action: "ticket", mime: file.type, size: file.size });
      const { error } = await createClient().storage.from("videos").uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type });
      if (error) throw new Error("La subida no se completó. Revisa tu conexión e inténtalo de nuevo.");
      await call(`/api/podcast/${props.episodeId}/recording`, { action: "finalize", path: ticket.path });
      setMessage({ ok: true, text: "Grabación procesada: volumen normalizado y episodio listo." });
    } catch (err) { setMessage({ ok: false, text: classifyClientFetchError(err) }); }
    finally { setBusy(null); router.refresh(); }
  }

  const c = capacity?.check;
  const canGenerate = props.source === "tts" && (props.status === "draft" || props.status === "failed" || props.stalled);
  return (
    <Card className="mt-4 p-4 text-sm">
      {props.error && props.status === "failed" && <p role="alert" className="mb-3 text-danger">{props.error}</p>}
      {props.status === "generating" && !props.stalled && busy !== "generate" && <p role="status" className="mb-3">Generando… esta página se actualiza sola.</p>}
      {props.stalled && <p role="status" className="mb-3 text-warning">La generación anterior se interrumpió. Puedes continuarla: lo ya generado se reutiliza sin volver a cobrar.</p>}

      {props.source === "tts" && props.status !== "ready" && (
        <section aria-label="Capacidad">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">Capacidad de ElevenLabs para este episodio</h2>
          {c ? (
            <div className="mt-1 rounded-md border border-border px-3 py-2">
              <div className="flex justify-between"><span>{c.label}</span><span className={`font-medium ${VERDICT_CLASS[c.verdict] ?? ""}`}>{c.verdict}</span></div>
              <p className="mt-1 text-xs text-ink-muted">{balanceProvenance(c)}</p>
              {c.refreshError && <p className="mt-1 text-xs text-danger">{c.refreshError}</p>}
              {c.action && <p className="mt-1 text-xs text-ink-muted">{c.action}</p>}
            </div>
          ) : <p className="mt-1 text-xs text-ink-muted">Sin datos de capacidad.</p>}
          {capacity?.note && <p className="mt-1 text-xs text-warning">{capacity.note}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={refresh} loading={busy === "refresh"} disabled={cooldown > 0 || !!busy}>
              {cooldown > 0 ? `Actualizar disponibilidad (${cooldown} s)` : "Actualizar disponibilidad"}
            </Button>
            <span className="text-xs text-ink-muted">Consulta el saldo; no genera ni cobra. Al generar se vuelve a comprobar.</span>
          </div>
        </section>
      )}

      {canGenerate && (
        <Button type="button" onClick={generate} loading={busy === "generate"} disabled={!!busy || c?.verdict === "Insuficiente"} className="mt-4">
          {props.stalled || props.status === "failed" ? "Continuar / reintentar generación" : "Generar narración (cobra el costo estimado)"}
        </Button>
      )}
      {busy === "generate" && <p role="status" className="mt-2 text-xs text-ink-muted">Generando y masterizando el audio. Puede tardar unos minutos; no cierres la página.</p>}

      {props.source === "upload" && props.status !== "generating" && (
        <form onSubmit={upload} className="mt-2 grid gap-2">
          <label className="text-sm">{props.status === "ready" ? "Reemplazar grabación" : "Sube tu grabación"} (MP3, M4A, WAV, WebM u Ogg; hasta 150 MB)
            <input name="file" type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/webm,audio/ogg" className="mt-1 block w-full" />
          </label>
          <Button type="submit" loading={busy === "upload"} disabled={!!busy}>Subir y procesar</Button>
        </form>
      )}

      {props.playUrl && (
        <section aria-label="Episodio" className="mt-4">
          <audio controls preload="metadata" src={props.playUrl} className="w-full" />
          {props.downloadUrl && <a href={props.downloadUrl} className="mt-2 inline-block font-medium underline">Descargar episodio (M4A)</a>}
        </section>
      )}
      {message && <p role={message.ok ? "status" : "alert"} className={`mt-3 ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
    </Card>
  );
}
