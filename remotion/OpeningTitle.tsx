/**
 * Dibujo de la portada/miniatura a partir de un CoverLayout ya validado
 * (cover-rules.ts). React puro, sin Remotion: lo usan la composición de
 * video, la miniatura y la vista previa web, así las tres coinciden.
 * Coordenadas en px del lienzo (1920×1080 o 1280×720); quien lo usa escala.
 */
import type { CSSProperties } from "react";
import { COVER_FONT_FAMILY, COVER_LETTER_SPACING_EM, COVER_LINE_HEIGHT, COVER_STYLES, lineExtraTopEm, type CoverLayout, type CoverSpec } from "./cover-rules";

function outline(px: number, color: string): string {
  // Contorno por sombras en 8 direcciones + sombra de profundidad: legible sobre cualquier fondo.
  const d = Math.max(2, Math.round(px * 0.045));
  const dirs = [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, d], [d, -d], [-d, -d]];
  return [...dirs.map(([x, y]) => `${x}px ${y}px 0 ${color}`), `0 ${Math.round(px * 0.06)}px ${Math.round(px * 0.18)}px rgba(0,0,0,0.75)`].join(", ");
}

export function OpeningTitle({ spec, layout, opacity = 1 }: { spec: CoverSpec; layout: CoverLayout; opacity?: number }) {
  const style = COVER_STYLES[spec.style];
  const { box, titlePx, kickerPx, align } = layout;
  const width = layout.canvas === "video" ? 1920 : 1280;
  const height = layout.canvas === "video" ? 1080 : 720;
  const corner = align === "right" ? "to bottom left" : "to bottom right";
  const text: CSSProperties = {
    fontFamily: COVER_FONT_FAMILY,
    fontWeight: 400,
    letterSpacing: `${COVER_LETTER_SPACING_EM}em`,
    lineHeight: COVER_LINE_HEIGHT,
    whiteSpace: "nowrap",
  };
  const kickerPad = Math.round(kickerPx * 0.35);
  return (
    <div style={{ position: "absolute", inset: 0, width, height, opacity, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(${corner}, rgba(0,0,0,${style.scrimOpacity}) 0%, rgba(0,0,0,${style.scrimOpacity * 0.55}) 32%, rgba(0,0,0,0) 60%)`,
        }}
      />
      <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, display: "flex", flexDirection: "column", alignItems: align === "right" ? "flex-end" : "flex-start" }}>
        {layout.kicker && (
          <div
            style={{
              ...text,
              fontSize: kickerPx,
              color: style.kickerFg,
              backgroundColor: style.kickerBg,
              padding: `${Math.round(kickerPad * 0.6)}px ${kickerPad}px`,
              marginBottom: Math.round(kickerPx * 0.4),
              boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
            }}
          >
            {layout.kicker}
          </div>
        )}
        {layout.lines.map((line, i) => (
          <div key={i} style={{ ...text, fontSize: titlePx, marginTop: `${lineExtraTopEm(line)}em`, color: style.titleColor, textShadow: outline(titlePx, style.outlineColor), textAlign: align }}>
            {line.map((word, j) => {
              const sep = j < line.length - 1 ? " " : "";
              if (!word.highlight) return <span key={j}>{word.text + sep}</span>;
              if (style.highlightMode === "plate") {
                return (
                  <span key={j}>
                    <span style={{ backgroundColor: style.highlightColor, color: style.highlightTextColor, padding: "0 0.08em", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
                      {word.text}
                    </span>
                    {sep}
                  </span>
                );
              }
              return (
                <span key={j} style={{ color: style.highlightTextColor }}>
                  {word.text + sep}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
