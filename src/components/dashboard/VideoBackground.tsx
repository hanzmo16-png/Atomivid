"use client";

import { useEffect, useState } from "react";
import { backgroundSources, shouldPlayVideo, type Orientation } from "./video-background";

const PORTRAIT = "(orientation: portrait)";

/**
 * Fondo en video del panel: fijo detrás del contenido, decorativo (aria-hidden, sin eventos de puntero).
 * El póster se pinta desde el servidor; el video se monta en el cliente solo si conviene (ver shouldPlayVideo),
 * silenciado, en bucle, autoplay y playsInline. Un velo oscuro mantiene legibles textos y botones.
 */
export function VideoBackground() {
  const [orientation, setOrientation] = useState<Orientation | null>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const portrait = window.matchMedia(PORTRAIT);
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    const update = () => {
      const play = shouldPlayVideo({ reducedMotion: motion.matches, saveData: connection?.saveData, effectiveType: connection?.effectiveType });
      setOrientation(play ? (portrait.matches ? "portrait" : "landscape") : null);
    };
    update();
    motion.addEventListener("change", update);
    portrait.addEventListener("change", update);
    return () => {
      motion.removeEventListener("change", update);
      portrait.removeEventListener("change", update);
    };
  }, []);

  const p = backgroundSources("portrait");
  const l = backgroundSources("landscape");
  const src = orientation ? backgroundSources(orientation) : null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-canvas" data-testid="fondo-video">
      <picture>
        <source media={PORTRAIT} srcSet={p.poster} />
        <img src={l.poster} alt="" className="absolute inset-0 size-full object-cover" fetchPriority="low" decoding="async" />
      </picture>
      {src && (
        <video
          key={orientation}
          className="absolute inset-0 size-full object-cover"
          poster={src.poster}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          data-testid="fondo-video-reproductor"
        >
          <source src={src.webm} type="video/webm" />
          <source src={src.mp4} type="video/mp4" />
        </video>
      )}
      {/* Velo: oscurece todo y, abajo, se funde con el fondo del panel para que la lista de proyectos quede sobre negro. */}
      <div className="absolute inset-0 bg-canvas/55" />
      <div className="absolute inset-0 bg-gradient-to-b from-canvas/30 via-canvas/45 to-canvas" />
    </div>
  );
}
