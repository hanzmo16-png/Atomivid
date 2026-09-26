"use client";

import { useEffect, useRef, useState } from "react";
import { OpeningTitle } from "../../../remotion/OpeningTitle";
import {
  COVER_CANVAS,
  THUMBNAIL_DURATION_ZONE,
  VIDEO_CAPTION_ZONE_TOP,
  VIDEO_LABEL_ZONE,
  validateCover,
  type CoverCanvasId,
  type CoverIssue,
  type CoverSpec,
} from "../../../remotion/cover-rules";

/**
 * Vista previa del primer fotograma (portada) o de la miniatura, con el
 * MISMO dibujo y las MISMAS reglas que el render (remotion/). El fondo es
 * de ejemplo: la imagen real es la primera escena del video, que se elige
 * al producir. Se marcan las zonas reservadas (subtítulos, rótulos,
 * duración de YouTube) para que se vea que el título no las invade.
 */
export function CoverPreview({ spec, canvas, onIssues }: { spec: CoverSpec; canvas: CoverCanvasId; onIssues?: (issues: CoverIssue[]) => void }) {
  const { width, height } = COVER_CANVAS[canvas];
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const result = validateCover(spec, canvas, { labelsTopLeft: canvas === "video" });
  const issuesKey = JSON.stringify(result.issues);

  useEffect(() => {
    onIssues?.(JSON.parse(issuesKey) as CoverIssue[]);
  }, [issuesKey, onIssues]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const zone = (r: { x: number; y: number; w: number; h: number }, label: string) => (
    <div
      style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, border: "3px dashed rgba(255,255,255,0.35)", color: "rgba(255,255,255,0.55)", fontSize: 26, padding: 10, fontFamily: "Arial, sans-serif" }}
    >
      {label}
    </div>
  );

  return (
    <div>
      <style>{`@font-face{font-family:'AtomividDisplay';src:url('/fonts/Anton-Regular.ttf') format('truetype');font-display:block}`}</style>
      <div ref={box} className="relative w-full overflow-hidden rounded-md border border-border bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
        {scale > 0 && (
          <div style={{ position: "absolute", left: 0, top: 0, width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #3b3526 0%, #1e2a1c 45%, #0f1410 100%)" }} />
            {canvas === "video" ? (
              <>
                {zone(VIDEO_LABEL_ZONE, "Rótulos («Recreación IA», créditos)")}
                {zone({ x: 160, y: VIDEO_CAPTION_ZONE_TOP, w: width - 320, h: height - VIDEO_CAPTION_ZONE_TOP - 40 }, "Subtítulos")}
              </>
            ) : (
              zone(THUMBNAIL_DURATION_ZONE, "Duración")
            )}
            <OpeningTitle spec={spec} layout={result.layout} />
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Fondo de ejemplo: el fondo real es la primera escena del video, que se decide al producir. Las líneas punteadas son zonas reservadas.
      </p>
    </div>
  );
}
