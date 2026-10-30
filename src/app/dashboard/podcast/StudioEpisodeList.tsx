"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { progressView, type LedgerActivity } from "@/lib/podcast/v3/progress";
import { AtomProgress } from "@/components/podcast/AtomProgress";
import { LibraryArchiveButton } from "./LibraryArchiveButton";

export type StudioListEpisode = { id: string; title: string; status: string; mode: string; cost_usd: number | null;
  /** Biblioteca limpia: archivado por el dueño; `stale` = sin terminar hace más de 7 días (oculto sin escribir nada). */
  archived?: boolean; stale?: boolean };

const STATUS: Record<string, string> = { draft: "Borrador", authorized: "Autorizado", generating: "Generando", ready: "Listo", failed: "Con error" };
const MODE: Record<string, string> = { narracion: "narración", avatar: "avatar", dialogo: "conversación" };

type Media = { status: string; error: string | null; videoUrl: string | null; audioUrl: string | null; cost: number | null; progress: unknown; updatedAt: string | null; activity: LedgerActivity | null; output: "audio" | "video" | null; audioPath: string | null | undefined };

/** Cuerpo visible de un episodio de estudio. Sin red: las pruebas de render le pasan las URLs ya firmadas. */
export function StudioEpisodePlayback({ title, statusLabel, detail, videoUrl, audioUrl, error, canRedispatch, busy, onRedispatch }: {
  title: string; statusLabel: string; detail: string; videoUrl: string | null; audioUrl: string | null; error: string | null;
  canRedispatch: boolean; busy?: boolean; onRedispatch?: () => void;
}) {
  return (
    <>
      <span className="font-medium text-ink">{title}</span>
      <span className="ml-2 text-ink-muted">{statusLabel} · estudio: {detail}</span>
      {error && <p className="mt-1 text-danger">{error}</p>}
      {canRedispatch && <Button type="button" variant="secondary" size="sm" className="mt-2" loading={busy} onClick={onRedispatch}>Volver a pedir el inicio (no se cobra otra vez)</Button>}
      {videoUrl && <video data-testid="studio-player" src={videoUrl} controls playsInline className="mt-2 w-full max-w-full rounded" />}
      {audioUrl && <audio data-testid="studio-audio-player" src={audioUrl} controls className="mt-2 w-full max-w-full" />}
      <div className="mt-1 flex min-w-0 flex-wrap gap-3">
        {videoUrl && <a className="text-accent underline" href={videoUrl} data-testid="studio-download-mp4">Descargar video (MP4)</a>}
        {audioUrl && <a className="text-accent underline" href={audioUrl} data-testid="studio-download-audio">Descargar audio</a>}
      </div>
    </>
  );
}

function StudioEpisodeCard({ episode, canArchive }: { episode: StudioListEpisode; canArchive: boolean }) {
  const [media, setMedia] = useState<Media | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const live = episode.status === "ready" || episode.status === "generating" || episode.status === "authorized" || episode.status === "failed";
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/podcast/v3/${episode.id}`);
        const out = await safeParseJsonResponse<{ episode?: { status?: string; error?: string | null; cost_usd?: number | null; progress?: unknown; updated_at?: string | null; output?: "audio" | "video"; audio_path?: string | null }; activity?: LedgerActivity | null; video_url?: string | null; audio_url?: string | null }>(res);
        if (!out.ok || stop) return;
        const next: Media = { status: out.data.episode?.status ?? episode.status, error: out.data.episode?.error ?? null, videoUrl: out.data.video_url ?? null, audioUrl: out.data.audio_url ?? null, cost: out.data.episode?.cost_usd ?? null,
          progress: out.data.episode?.progress ?? null, updatedAt: out.data.episode?.updated_at ?? null, activity: out.data.activity ?? null, output: out.data.episode?.output ?? null, audioPath: out.data.episode?.audio_path };
        setMedia(next);
        if (next.status === "ready" || next.status === "failed") stop = true;
      } catch { /* el siguiente ciclo reintenta */ }
    };
    void tick();
    const timer = episode.status === "ready" || episode.status === "failed" ? null : setInterval(() => { if (!stop) void tick(); }, 4000);
    return () => { stop = true; if (timer) clearInterval(timer); };
  }, [episode.id, episode.status, live]);
  const status = media?.status ?? episode.status;
  const cost = media?.cost ?? episode.cost_usd;
  async function redispatch() {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await fetch(`/api/podcast/v3/${episode.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const out = await safeParseJsonResponse<{ note?: string | null }>(res);
      if (!out.ok) setNote(out.error);
      else if (out.data.note) setNote(out.data.note);
    } catch { setNote("No se pudo reintentar el inicio."); }
    finally { setBusy(false); }
  }
  return (
    <li data-testid={`studio-episode-${episode.id}`} className="min-w-0 max-w-full rounded-lg border border-border p-3 text-sm">
      <StudioEpisodePlayback
        title={episode.title}
        statusLabel={STATUS[status] ?? status}
        detail={`${MODE[episode.mode] ?? episode.mode}${cost != null ? ` · USD ${Number(cost).toFixed(2)}` : ""}`}
        videoUrl={media?.videoUrl ?? null}
        audioUrl={media?.audioUrl ?? null}
        error={media?.error ?? null}
        canRedispatch={status === "authorized"}
        busy={busy}
        onRedispatch={() => void redispatch()}
      />
      {(status === "authorized" || status === "generating") && <div className="mt-2"><AtomProgress compact view={progressView({ status, progress: media?.progress, updated_at: media?.updatedAt, output: media?.output, audio_path: media?.audioPath }, undefined, media?.activity)} /></div>}
      {note && <p className="mt-1 text-xs text-ink-muted">{note}</p>}
      {episode.stale && <p className="mt-1 text-xs text-ink-muted">Sin terminar desde hace más de 7 días.</p>}
      {canArchive && !episode.stale && status !== "authorized" && status !== "generating" && <LibraryArchiveButton kind="studio" id={episode.id} title={episode.title} archived={!!episode.archived} />}
    </li>
  );
}

/** Episodios del estudio en «Tus episodios»: reproducir y descargar sigue disponible aunque el asistente se reinicie. */
export function StudioEpisodeList({ episodes, canArchive = false }: { episodes: StudioListEpisode[]; canArchive?: boolean }) {
  if (episodes.length === 0) return null;
  return (
    <ul className="mt-2 grid min-w-0 gap-2" data-testid="studio-episodes">
      {episodes.map((e) => <StudioEpisodeCard key={e.id} episode={e} canArchive={canArchive} />)}
    </ul>
  );
}
