"use client";

import { useEffect, useRef, useState } from "react";
import { ambientById, orientationFor, videoPolicy, type AmbientId, type Orientation } from "./ambients";

type State = "gradient" | "poster" | "loading" | "playing" | "paused" | "fallback";

/**
 * Fondo cinematográfico fijo detrás de la portada. Un solo ambiente a la vez.
 *
 * - Pinta al instante el degradado y el póster (sin saltos de contenido: es una capa fija, fuera del flujo).
 * - Reproduce el video en silencio, en bucle y sin controles; aparece con un fundido cuando de verdad está sonando.
 * - Pausa cuando la portada sale de la pantalla (observa `watchId`) o la pestaña se oculta, y reanuda al volver.
 * - Sin video con «reducir movimiento», ahorro de datos o 2G; si el video falla, se queda el póster.
 * - Al desmontar, suelta el archivo (pause + quitar src + load) para liberar memoria y red.
 */
export function CinematicBackground({ ambientId = "cosmos", watchId }: { ambientId?: AmbientId; watchId?: string }) {
  const ambient = ambientById(ambientId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [orientation, setOrientation] = useState<Orientation | null>(null);
  const [mode, setMode] = useState<"video" | "poster" | "gradient" | null>(null);
  const [state, setState] = useState<State>("gradient");
  const [dim, setDim] = useState(false);

  // Decide orientación y política en el cliente (dependen de la ventana y preferencias del usuario).
  useEffect(() => {
    const decide = () => {
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setOrientation(orientationFor(window.innerWidth, window.innerHeight));
      setMode(videoPolicy(ambient, { reducedMotion: reduced, saveData: conn?.saveData, effectiveType: conn?.effectiveType }));
    };
    // El video espera a que la página termine de cargar (y a un momento libre): el póster ya pintado por el servidor es
    // el contenido principal, y el video no compite con lo crítico (LCP medido: ver scripts/harness/e2e/cinematic/perf.cjs).
    let first = 0;
    const start = () => { first = requestAnimationFrame(() => { const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback; if (ric) ric(decide, { timeout: 1200 }); else setTimeout(decide, 200); }); };
    if (document.readyState === "complete") start(); else window.addEventListener("load", start, { once: true });
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let t: ReturnType<typeof setTimeout> | undefined;
    // Solo cambia de archivo si cambia la orientación (no en cada redimensión de la barra del navegador móvil).
    const onResize = () => { clearTimeout(t); t = setTimeout(decide, 250); };
    mq.addEventListener("change", decide);
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("load", start); cancelAnimationFrame(first); mq.removeEventListener("change", decide); window.removeEventListener("resize", onResize); clearTimeout(t); };
  }, [ambient]);

  // Reproducción, pausa por visibilidad y liberación de recursos.
  useEffect(() => {
    const v = videoRef.current;
    if (mode !== "video" || !v) return;
    let inView = true;
    const sync = () => {
      if (document.hidden || !inView) { v.pause(); return; }
      const p = v.play();
      if (p) p.catch(() => setState((s) => (s === "playing" ? s : "poster")));
    };
    const onPlaying = () => setState("playing");
    const onPause = () => setState((s) => (s === "fallback" ? s : "paused"));
    const onError = () => setState("fallback");
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onError);
    const lastSource = v.querySelector("source:last-of-type");
    lastSource?.addEventListener("error", onError);
    document.addEventListener("visibilitychange", sync);
    let io: IntersectionObserver | undefined;
    const target = watchId ? document.getElementById(watchId) : null;
    if (target && "IntersectionObserver" in window) {
      io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; setDim(!e.isIntersecting); sync(); }, { threshold: 0 });
      io.observe(target);
    }
    sync();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onError);
      lastSource?.removeEventListener("error", onError);
      v.pause();
      v.removeAttribute("src");
      v.querySelectorAll("source").forEach((s) => s.removeAttribute("src"));
      v.load();
    };
  }, [mode, orientation, watchId]);

  const media = ambient.media;
  const poster = media && orientation ? media.posters[orientation] : null;
  const showVideo = mode === "video" && media && orientation && state !== "fallback";
  const effective: State = mode === "gradient" ? "gradient" : mode === "poster" ? "poster" : mode === "video" && state === "gradient" ? "loading" : state;

  return (
    <div aria-hidden="true" data-testid="cinematic-bg" data-ambient={ambient.id} data-state={effective} data-orientation={orientation ?? ""}
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" style={{ background: ambient.fallback }}>
      {media && (
        // Póster pintado por el servidor (sin esperar a JavaScript): el navegador elige la orientación por CSS.
        <picture>
          <source media="(orientation: portrait)" srcSet={media.posters.portrait} />
          <img src={media.posters.landscape} alt="" decoding="async" fetchPriority="high" data-testid="cinematic-poster" className="absolute inset-0 size-full object-cover" />
        </picture>
      )}
      {showVideo && (
        <video key={orientation} ref={videoRef} muted loop playsInline autoPlay preload="auto" disablePictureInPicture disableRemotePlayback
          poster={poster ?? undefined} tabIndex={-1} data-testid="cinematic-video"
          className={`absolute inset-0 size-full object-cover transition-opacity duration-[1200ms] ease-out ${state === "playing" || state === "paused" ? "opacity-100" : "opacity-0"}`}>
          {media.sources[orientation].map((s) => <source key={s.src} src={s.src} type={s.type} />)}
        </video>
      )}
      {/* Gradientes cinematográficos: legibilidad del texto encima, y oscurecer cuando la portada ya pasó. */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,3,9,0.35)_0%,rgba(2,3,9,0.05)_30%,rgba(2,3,9,0.5)_64%,rgba(5,6,12,0.96)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_30%,rgba(2,3,9,0)_0%,rgba(2,3,9,0.45)_100%)]" />
      <div className={`absolute inset-0 bg-[#05060c] transition-opacity duration-700 ${dim ? "opacity-80" : "opacity-0"}`} />
    </div>
  );
}
