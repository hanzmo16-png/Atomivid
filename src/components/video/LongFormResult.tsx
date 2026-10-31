"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { asDownloadUrl } from "@/lib/storage/download-url";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  canRestore,
  capturePlayback,
  formatPosition,
  mediaKey,
  restorePlayback,
  type PlaybackSnapshot,
} from "@/lib/video/player-continuity";

type Links = { video: string | null; thumbnail: string | null };
type Status =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | { kind: "recovered"; at: number | null }
  | { kind: "blocked"; at: number }
  | { kind: "error" }
  | { kind: "loadError" };

/**
 * Finished Long Form: player, downloads and "Actualizar enlaces".
 *
 * Renewing re-renders the owner-checked page (router.refresh, a GET of this same page): no endpoint,
 * no render/resume, no provider call. Before the swap it snapshots the player; when the new media of
 * the SAME request + object has loaded it restores position, speed, volume and play/pause (autoplay
 * rules permitting). If signing fails it keeps the current player and links instead of tearing them
 * down. Mounted with key={request.id}, so a snapshot can never reach another video or account.
 */
export function LongFormResult({
  requestId,
  videoUrl,
  thumbnailUrl,
  subtitleUrl = null,
  thumbnailRequested,
  isLandscape,
}: {
  requestId: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  /** SRT sidecar firmado. Ausente en videos anteriores a la pista de subtítulos. */
  subtitleUrl?: string | null;
  thumbnailRequested: boolean;
  isLandscape: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Links currently on screen: the last ones that signed correctly.
  const [shown, setShown] = useState<Links>({ video: videoUrl, thumbnail: thumbnailUrl });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // A refresh in flight, with the player state captured when it started.
  const [awaiting, setAwaiting] = useState<{ snap: PlaybackSnapshot | null } | null>(null);
  // Snapshot to apply once the renewed media of this same request + object has loaded.
  const [restore, setRestore] = useState<PlaybackSnapshot | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    // Synchronous guard: a second click before React re-renders the disabled button does nothing.
    if (inFlight.current) return;
    inFlight.current = true;
    const el = videoRef.current;
    const key = mediaKey(requestId, shown.video);
    setAwaiting({ snap: el && key ? capturePlayback(el, key) : null });
    setStatus({ kind: "refreshing" });
    startTransition(() => router.refresh());
  }, [requestId, router, shown.video]);

  // The refresh settled: the new server props are committed together with pending=false.
  if (awaiting && !pending) {
    setAwaiting(null);
    if (!videoUrl) {
      // Signing failed: keep the player and links already on screen; the video itself is still stored.
      setStatus({ kind: "error" });
    } else if (videoUrl === shown.video) {
      setShown({ video: videoUrl, thumbnail: thumbnailUrl });
      setStatus({ kind: "recovered", at: null });
    } else {
      setShown({ video: videoUrl, thumbnail: thumbnailUrl });
      // Restoration waits for the new media (effect below); status stays "refreshing" until then.
      if (canRestore(awaiting.snap, mediaKey(requestId, videoUrl))) setRestore(awaiting.snap);
      else setStatus({ kind: "recovered", at: null });
    }
  }

  useEffect(() => {
    if (!awaiting && !restore) inFlight.current = false;
  }, [awaiting, restore]);

  // Apply the snapshot to the renewed media once its metadata is known; give up cleanly if it fails to load.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !restore) return;
    let cancelled = false;
    const apply = () => {
      el.removeEventListener("error", fail);
      void restorePlayback(el, restore).then((outcome) => {
        if (cancelled) return;
        setRestore(null);
        setStatus(outcome === "blocked" ? { kind: "blocked", at: restore.time } : { kind: "recovered", at: restore.time });
      });
    };
    const fail = () => {
      el.removeEventListener("loadedmetadata", apply);
      if (cancelled) return;
      setRestore(null);
      setStatus({ kind: "loadError" });
    };
    if (el.readyState >= 1 && el.currentSrc === shown.video) apply();
    else {
      el.addEventListener("loadedmetadata", apply, { once: true });
      el.addEventListener("error", fail, { once: true });
    }
    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", apply);
      el.removeEventListener("error", fail);
    };
  }, [restore, shown.video]);

  const refreshing = pending || awaiting !== null || restore !== null;
  const button = (
    <Button type="button" variant="secondary" disabled={refreshing} aria-busy={refreshing} data-testid="refresh-links" onClick={refresh}>
      {refreshing ? "Actualizando enlaces…" : "Actualizar enlaces"}
    </Button>
  );

  // Never signed on this page: nothing to keep playing, but the stored video can still be reached.
  if (!shown.video) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="danger" role="alert">
          No se pudo generar el enlace de descarga. Recarga la página para intentarlo de nuevo.
        </Alert>
        <div className="flex flex-col items-center gap-1 text-center">
          {button}
          <p className="text-xs text-ink-muted">Tu video sigue guardado. Puedes intentarlo otra vez; actualizar el enlace no vuelve a producirlo.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <video
        ref={videoRef}
        src={shown.video}
        controls
        preload="metadata"
        data-testid="result-video"
        className={
          isLandscape
            ? "aspect-16/9 w-full max-w-md rounded-lg border border-border-strong bg-black shadow-lg"
            : "aspect-9/16 w-full max-w-72 rounded-lg border border-border-strong bg-black shadow-lg"
        }
      >
        Tu navegador no puede reproducir este video.
      </video>
      <a
        href={asDownloadUrl(shown.video, "atomicvid-video.mp4")}
        download
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:bg-accent-hover"
      >
        Descargar video
      </a>
      {subtitleUrl && (
        <a
          href={asDownloadUrl(subtitleUrl, "subtitles.srt")}
          download
          target="_blank"
          rel="noopener noreferrer"
          data-testid="download-subtitles"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised"
        >
          Descargar subtítulos
        </a>
      )}
      {shown.thumbnail && (
        <div className="flex w-full max-w-md flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada y temporal de Storage */}
          <img src={shown.thumbnail} alt="Miniatura de YouTube" className="aspect-16/9 w-full rounded-lg border border-border-strong object-cover" />
          <a
            href={asDownloadUrl(shown.thumbnail, "atomicvid-miniatura.jpg")}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised"
          >
            Descargar miniatura
          </a>
        </div>
      )}
      {thumbnailRequested && !shown.thumbnail && (
        <Alert tone="warning" role="status">
          Tu video está listo, pero la miniatura solicitada no está disponible. Recarga la página para comprobarlo; si sigue faltando, contacta al soporte. No necesitas volver a generar el video.
        </Alert>
      )}
      <div className="flex w-full max-w-md flex-col items-center gap-2 text-center">
        {button}
        <p className="text-xs text-ink-muted">Tu video está guardado. Si el enlace dejó de funcionar, actualízalo: no se vuelve a producir el video.</p>
        <StatusLine status={status} />
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "error")
    return (
      <Alert tone="warning" role="alert">
        <span data-testid="refresh-status" data-state="error">
          No se pudo renovar el enlace en este momento. Tu video sigue guardado y no hace falta volver a producirlo; el
          reproductor conserva el enlace anterior mientras siga vigente. Vuelve a intentarlo en un momento.
        </span>
      </Alert>
    );
  if (status.kind === "loadError")
    return (
      <Alert tone="warning" role="alert">
        <span data-testid="refresh-status" data-state="loadError">
          El enlace se renovó, pero el video no terminó de cargar. Tu video sigue guardado y no hace falta volver a
          producirlo: vuelve a intentarlo en un momento.
        </span>
      </Alert>
    );
  const text =
    status.kind === "refreshing" ? "Actualizando enlaces… puedes seguir viendo el video."
    : status.kind === "recovered" ? (status.at !== null && status.at > 0 ? `Enlaces actualizados. Continúas en ${formatPosition(status.at)}.` : "Enlaces actualizados.")
    : status.kind === "blocked" ? `Enlaces actualizados. Tu navegador pausó el video: pulsa reproducir para continuar en ${formatPosition(status.at)}.`
    : "";
  return (
    <p role="status" aria-live="polite" className="min-h-5 text-sm text-ink-muted" data-testid="refresh-status" data-state={status.kind}>
      {text}
    </p>
  );
}
