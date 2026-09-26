/**
 * Miniatura de YouTube (1280×720) de un Long Form: la imagen de la primera
 * escena (u otra que elija el llamador) con su reencuadre/gradación, el
 * título de portada y — si la imagen es una recreación IA — el rótulo
 * «Recreación IA». Se renderiza como fotograma fijo (renderStill).
 */
import { AbsoluteFill, Img, OffthreadVideo, useVideoConfig } from "remotion";
import { lookStyle, type SceneLook } from "./long-form-direction";
import { fitCover, type CoverSpec } from "./cover-rules";
import { OpeningTitle } from "./OpeningTitle";
import { useCoverFont } from "./cover-font";

export type LongFormThumbnailProps = {
  background: { mediaType: "image" | "video"; url: string; look?: SceneLook; mediaStartSeconds?: number };
  cover: CoverSpec;
  /** Rótulo de procedencia visible (p. ej. «Recreación IA»); null si la imagen es documental o de stock. */
  provenanceLabel?: string | null;
};

export function LongFormThumbnail({ background, cover, provenanceLabel }: LongFormThumbnailProps) {
  useCoverFont(true);
  const { fps } = useVideoConfig();
  const look = lookStyle(background.look, "none");
  const media = {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    transform: look.transform,
    ...(look.transformOrigin ? { transformOrigin: look.transformOrigin } : {}),
    ...(look.filter ? { filter: look.filter } : {}),
  };
  return (
    <AbsoluteFill style={{ backgroundColor: "black", overflow: "hidden" }}>
      {background.mediaType === "video" ? (
        <OffthreadVideo src={background.url} muted trimBefore={Math.round((background.mediaStartSeconds ?? 0) * fps)} style={media} />
      ) : (
        <Img src={background.url} style={media} />
      )}
      {look.vignette > 0 && <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,${look.vignette}) 100%)` }} />}
      <OpeningTitle spec={cover} layout={fitCover(cover, "thumbnail")} />
      {provenanceLabel && (
        <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: "0 0 28px 32px" }}>
          <div style={{ padding: "5px 12px", borderRadius: 999, backgroundColor: "rgba(10,10,14,0.72)", border: "1px solid rgba(255,255,255,0.4)", color: "white", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 22, fontWeight: 700 }}>
            {provenanceLabel}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
