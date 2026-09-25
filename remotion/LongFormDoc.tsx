import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { cameraTransform, soundCueVolume, transitionFrames, validateDirection, type SceneDirection, type SoundCue } from "./long-form-direction";
import { type NarrationGap, musicVolumeAtSeconds, voiceVolumeAtSeconds } from "./audio-mix";
import { LARGE_CARD, provenanceLabel, type SceneProvenance } from "./long-form-card-fit";

/**
 * Composición 16:9 para Long Form — independiente de VerticalReel.tsx
 * (9:16, Shorts/Avatar), que queda sin ningún cambio. No importa nada de
 * src/lib/video/long-form/ a propósito: el bundler de Remotion
 * (@remotion/bundler) empaqueta este archivo por separado y mantener sus
 * tipos/funciones auxiliares autocontenidos evita cualquier duda sobre
 * resolución de alias de módulos dentro de ese bundle — los tipos de abajo
 * son estructuralmente compatibles con DocumentaryGraphicSpec
 * (src/lib/video/long-form/diagram-map.ts); el orquestador les pasa los
 * mismos datos ya resueltos como props serializables.
 */

export type LongFormMediaAsset = {
  kind: "media";
  mediaType: "image" | "video";
  url: string;
  /**
   * "contain": imagen completa (fotos de archivo con otra proporción) sobre
   * un fondo de la misma imagen desenfocado y oscurecido — sin recortar el
   * contenido ni dejar barras negras. Por defecto "cover" (comportamiento anterior).
   */
  fit?: "cover" | "contain";
};

export type LongFormDiagramNode = { id: string; label: string; x: number; y: number };
export type LongFormDiagramEdge = { from: string; to: string; label?: string };
export type LongFormDiagramGraphic = {
  kind: "diagram";
  title: string;
  nodes: LongFormDiagramNode[];
  edges: LongFormDiagramEdge[];
  isFixture: boolean;
};

export type LongFormMapMarker = { id: string; label: string; latitude: number; longitude: number };
export type LongFormMapGraphic = {
  kind: "map";
  title: string;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  markers: LongFormMapMarker[];
  isFixture: boolean;
};

export type LongFormTextGraphic = {
  kind: "text";
  title: string;
  body: string;
  citation?: string;
  isFixture: boolean;
  /** "large": tarjeta legible (título ≥ 72 px, cuerpo ≥ 44 px; ver long-form-card-fit.ts). Sin valor: tamaños anteriores. */
  size?: "large";
};

export type LongFormGraphicAsset = {
  kind: "graphic";
  graphic: LongFormDiagramGraphic | LongFormMapGraphic | LongFormTextGraphic;
};

export type LongFormShotScene = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  asset: LongFormMediaAsset | LongFormGraphicAsset;
  motion: "static" | "ken_burns" | "pan" | "cut";
  direction?: SceneDirection;
  /** Procedencia del recurso; "ai_recreation" muestra siempre el rótulo "Recreación IA". */
  provenance?: SceneProvenance;
  /** Crédito breve visible (p. ej. "Archivo: Library of Congress, 1913"). */
  creditText?: string;
  /** Escena NO terminada (carencia o revisión pendiente): se marca visiblemente, nunca pasa por terminada. */
  pending?: string;
};

export type LongFormCaption = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  emphasisWords?: string[];
};

export type LongFormDocProps = {
  audioUrl: string;
  musicUrl?: string;
  /** Undefined preserves legacy music; [] explicitly requests silence. */
  soundCues?: SoundCue[];
  durationSeconds: number;
  scenes: LongFormShotScene[];
  captions: LongFormCaption[];
  narrationGaps?: NarrationGap[];
  accentColor?: string;
  showLogo?: boolean;
};

const DEFAULT_ACCENT_COLOR = "#8f7ff5";

export function LongFormDoc({
  audioUrl,
  musicUrl,
  soundCues,
  durationSeconds,
  scenes,
  captions,
  narrationGaps = [],
  accentColor = DEFAULT_ACCENT_COLOR,
  showLogo = false,
}: LongFormDocProps) {
  const { fps, durationInFrames } = useVideoConfig();
  validateDirection(scenes, soundCues, durationSeconds);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {scenes.map((scene, i) => {
        const isFirst = i === 0;
        const isLast = i === scenes.length - 1;
        const from = Math.round(scene.startSeconds * fps);
        const rawTo = isLast ? durationInFrames : Math.round(scene.endSeconds * fps);
        const next = scenes[i + 1];
        const incoming = transitionFrames(scene.direction, fps, scene.endSeconds - scene.startSeconds);
        const outgoing = next ? Math.min(
          transitionFrames(next.direction, fps, next.endSeconds - next.startSeconds),
          Math.floor((scene.endSeconds - scene.startSeconds) * fps / 2),
        ) : 0;
        const extendedTo = Math.min(durationInFrames, rawTo + outgoing);
        const sequenceDuration = Math.max(1, extendedTo - from);

        return (
          <Sequence key={scene.id} from={from} durationInFrames={sequenceDuration}>
            <SceneRenderer
              scene={scene}
              durationInFrames={sequenceDuration}
              fadeInFrames={isFirst ? 0 : Math.min(incoming, Math.floor((scenes[i - 1].endSeconds - scenes[i - 1].startSeconds) * fps / 2))}
              fadeOutFrames={next?.direction ? 0 : outgoing}
              isHook={isFirst}
            />
          </Sequence>
        );
      })}

      <AbsoluteFill
        style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0) 62%, rgba(0,0,0,0.55) 100%)" }}
      />

      <Captions captions={captions} accentColor={accentColor} />

      {showLogo && <LogoBadge accentColor={accentColor} />}

      {audioUrl && (
        <Audio src={audioUrl} volume={(frame) => voiceVolumeAtSeconds(frame / fps, durationSeconds)} />
      )}
      {soundCues === undefined && musicUrl && (
        <Audio
          src={musicUrl}
          loop
          volume={(frame) => musicVolumeAtSeconds(frame / fps, durationSeconds, narrationGaps)}
        />
      )}
      {soundCues?.map((cue) => {
        const from = Math.round(cue.startSeconds * fps);
        return <Sequence key={cue.id} from={from} durationInFrames={Math.max(1, Math.round(cue.endSeconds * fps) - from)}>
          <Audio src={cue.src} loopVolumeCurveBehavior="extend" loop={cue.loop ?? false} trimBefore={Math.round((cue.sourceStartSeconds ?? 0) * fps)}
            volume={(frame) => soundCueVolume(cue, (from + frame) / fps, soundCues, narrationGaps)} />
        </Sequence>;
      })}
    </AbsoluteFill>
  );
}

function SceneRenderer({
  scene,
  durationInFrames,
  fadeInFrames,
  fadeOutFrames,
  isHook,
}: {
  scene: LongFormShotScene;
  durationInFrames: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  isHook: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;

  // Ken Burns/fade independientes de VerticalReel.tsx a propósito (ver
  // comentario de cabecera) — misma filosofía de movimiento (impulso más
  // marcado en el gancho de apertura), constantes propias de este formato.
  const kenBurnsActive = scene.motion === "ken_burns" || scene.motion === "pan";
  const hookProgress = Math.min(1, progress / 0.4);
  const scale = !kenBurnsActive
    ? 1
    : isHook
      ? interpolate(hookProgress, [0, 1], [1, 1.16], { extrapolateRight: "clamp" })
      : interpolate(progress, [0, 1], [1, 1.08]);
  const translateX = kenBurnsActive && !isHook ? interpolate(progress, [0, 1], [0, -14]) : 0;

  let opacity = 1;
  if (fadeInFrames > 0) {
    opacity = Math.min(
      opacity,
      interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    );
  }
  if (fadeOutFrames > 0) {
    opacity = Math.min(
      opacity,
      interpolate(frame, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }

  const mediaStyle = {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    transform: scene.direction?.camera ? cameraTransform(scene.direction.camera, progress) : `scale(${scale}) translateX(${translateX}px)`,
  };

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      {scene.asset.kind === "media" ? (
        scene.asset.mediaType === "video" ? (
          <OffthreadVideo src={scene.asset.url} trimBefore={Math.round((scene.direction?.mediaStartSeconds ?? 0) * fps)} muted style={mediaStyle} />
        ) : scene.asset.fit === "contain" ? (
          <>
            <Img
              src={scene.asset.url}
              style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.4)", transform: "scale(1.15)" }}
            />
            <AbsoluteFill>
              <Img src={scene.asset.url} style={{ ...mediaStyle, objectFit: "contain" }} />
            </AbsoluteFill>
          </>
        ) : (
          <Img src={scene.asset.url} style={mediaStyle} />
        )
      ) : (
        <GraphicRenderer graphic={scene.asset.graphic} />
      )}
      <SceneLabels scene={scene} />
    </AbsoluteFill>
  );
}

function SceneLabels({ scene }: { scene: LongFormShotScene }) {
  const label = provenanceLabel(scene.provenance);
  if (!label && !scene.creditText && !scene.pending) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: "44px 56px" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, fontFamily: "Arial, Helvetica, sans-serif" }}>
        {scene.pending && (
          <div style={{ padding: "8px 16px", borderRadius: 8, backgroundColor: "rgba(200,40,40,0.9)", color: "white", fontSize: 30, fontWeight: 800 }}>
            Material pendiente
          </div>
        )}
        {label && (
          <div style={{ padding: "6px 14px", borderRadius: 999, backgroundColor: "rgba(10,10,14,0.62)", border: "1px solid rgba(255,255,255,0.35)", color: "white", fontSize: 28, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,0.7)" }}>
            {label}
          </div>
        )}
        {scene.creditText && (
          <div style={{ padding: "4px 12px", borderRadius: 6, backgroundColor: "rgba(10,10,14,0.5)", color: "rgba(255,255,255,0.9)", fontSize: 24, textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}>
            {scene.creditText}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

// --- Gráficos determinísticos (texto/diagrama/mapa) — sin IA, sin red ----

function GraphicRenderer({ graphic }: { graphic: LongFormGraphicAsset["graphic"] }) {
  switch (graphic.kind) {
    case "text":
      return <TextCard graphic={graphic} />;
    case "diagram":
      return <DiagramCard graphic={graphic} />;
    case "map":
      return <MapCard graphic={graphic} />;
    default:
      return null;
  }
}

function GraphicBackground({ children }: { children: React.ReactNode }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b0d14",
        backgroundImage: "radial-gradient(circle at 30% 20%, #1a1f2e 0%, #0b0d14 70%)",
        justifyContent: "center",
        alignItems: "center",
        padding: 96,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

function TextCard({ graphic }: { graphic: LongFormTextGraphic }) {
  if (graphic.size === "large") {
    // Por encima de la franja de subtítulos; el preflight (fitLargeCard) garantiza que cabe sin encoger.
    return (
      <GraphicBackground>
        <div style={{ maxWidth: LARGE_CARD.MAX_WIDTH_PX, textAlign: "center", fontFamily: "Arial, Helvetica, sans-serif", marginBottom: 200 }}>
          <div style={{ fontSize: LARGE_CARD.TITLE_PX, lineHeight: LARGE_CARD.TITLE_LINE_HEIGHT, fontWeight: 800, color: "#f2f0ff" }}>{graphic.title}</div>
          {graphic.body && (
            <div style={{ marginTop: LARGE_CARD.GAP_PX, fontSize: LARGE_CARD.BODY_PX, lineHeight: LARGE_CARD.BODY_LINE_HEIGHT, color: "white" }}>{graphic.body}</div>
          )}
          {graphic.citation && <div style={{ marginTop: 24, fontSize: 28, color: "#b9b3e6" }}>{graphic.citation}</div>}
        </div>
      </GraphicBackground>
    );
  }
  return (
    <GraphicBackground>
      <div style={{ maxWidth: 1400, textAlign: "center", fontFamily: "Arial, Helvetica, sans-serif" }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: "#e8e6f5", marginBottom: 24 }}>{graphic.title}</div>
        <div style={{ fontSize: 32, color: "white", lineHeight: 1.45 }}>{graphic.body}</div>
        {graphic.citation && (
          <div style={{ marginTop: 28, fontSize: 20, color: "#9d97c9" }}>{graphic.citation}</div>
        )}
      </div>
    </GraphicBackground>
  );
}

function DiagramCard({ graphic }: { graphic: LongFormDiagramGraphic }) {
  const W = 1600;
  const H = 800;
  const nodeById = new Map(graphic.nodes.map((n) => [n.id, n]));

  return (
    <GraphicBackground>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: "#e8e6f5", marginBottom: 16, fontFamily: "Arial, sans-serif" }}>
          {graphic.title}
        </div>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {graphic.edges.map((edge, i) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x * W;
            const y1 = from.y * H;
            const x2 = to.x * W;
            const y2 = to.y * H;
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#8f7ff5" strokeWidth={2} opacity={0.7} />
                {edge.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} fill="#c9c4f0" fontSize={18} textAnchor="middle" fontFamily="Arial, sans-serif">
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
          {graphic.nodes.map((node) => (
            <g key={node.id}>
              <circle cx={node.x * W} cy={node.y * H} r={14} fill="#8f7ff5" />
              <text x={node.x * W} y={node.y * H + 40} fill="white" fontSize={22} textAnchor="middle" fontFamily="Arial, sans-serif">
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </GraphicBackground>
  );
}

/** Proyección equirrectangular simple — copia intencional de la de diagram-map.ts (ver comentario de cabecera de este archivo sobre aislamiento del bundle). */
function projectMarkerLocal(marker: LongFormMapMarker, bounds: LongFormMapGraphic["bounds"]) {
  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return {
    xNorm: clamp01((marker.longitude - bounds.minLon) / lonSpan),
    yNorm: clamp01(1 - (marker.latitude - bounds.minLat) / latSpan),
  };
}

function MapCard({ graphic }: { graphic: LongFormMapGraphic }) {
  const W = 1600;
  const H = 800;

  return (
    <GraphicBackground>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: "#e8e6f5", marginBottom: 16, fontFamily: "Arial, sans-serif" }}>
          {graphic.title}
        </div>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <rect x={0} y={0} width={W} height={H} fill="#12172a" stroke="#2a3050" strokeWidth={2} />
          {Array.from({ length: 5 }).map((_, i) => (
            <line key={`v${i}`} x1={(W / 4) * i} y1={0} x2={(W / 4) * i} y2={H} stroke="#1e2440" strokeWidth={1} />
          ))}
          {Array.from({ length: 5 }).map((_, i) => (
            <line key={`h${i}`} x1={0} y1={(H / 4) * i} x2={W} y2={(H / 4) * i} stroke="#1e2440" strokeWidth={1} />
          ))}
          {graphic.markers.map((marker) => {
            const { xNorm, yNorm } = projectMarkerLocal(marker, graphic.bounds);
            return (
              <g key={marker.id}>
                <circle cx={xNorm * W} cy={yNorm * H} r={12} fill="#e24b4b" />
                <text x={xNorm * W} y={yNorm * H - 20} fill="white" fontSize={22} textAnchor="middle" fontFamily="Arial, sans-serif">
                  {marker.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </GraphicBackground>
  );
}

// --- Captions (adaptadas a 16:9 — zonas seguras de YouTube, no TikTok) ---

const SAFE_BOTTOM_PADDING = 120;
const CAPTION_MAX_WIDTH = 1400;
const CAPTION_APPEAR_FRAMES = 5;

function Captions({ captions, accentColor }: { captions: LongFormCaption[]; accentColor: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const active = captions.find((c) => t >= c.startSeconds && t < c.endSeconds);
  if (!active) return null;

  const activeStartFrame = Math.round(active.startSeconds * fps);
  const framesSinceStart = frame - activeStartFrame;
  const appearProgress = Math.min(1, Math.max(0, framesSinceStart / CAPTION_APPEAR_FRAMES));
  const opacity = interpolate(appearProgress, [0, 1], [0, 1]);
  const translateY = interpolate(appearProgress, [0, 1], [10, 0]);

  const emphasisSet = new Set((active.emphasisWords ?? []).map((w) => w.toLowerCase()));
  const words = active.text.split(/\s+/);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: SAFE_BOTTOM_PADDING }}>
      <div
        style={{
          maxWidth: CAPTION_MAX_WIDTH,
          padding: "14px 32px",
          borderRadius: 14,
          backgroundColor: "rgba(10,10,14,0.68)",
          border: "1px solid rgba(143,127,245,0.35)",
          opacity,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontWeight: 800,
            fontSize: 46,
            color: "white",
            textAlign: "center",
            lineHeight: 1.25,
            textShadow: "0 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.7)",
            WebkitTextStroke: "1px rgba(0,0,0,0.35)",
          }}
        >
          {words.map((word, i) => {
            const stripped = word.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
            const isEmphasis = emphasisSet.has(stripped);
            return (
              <span key={i} style={isEmphasis ? { color: accentColor } : undefined}>
                {word}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}

const LOGO_BADGE_TOP = 48;
const LOGO_BADGE_RIGHT = 48;

function LogoBadge({ accentColor }: { accentColor: string }) {
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-end" }}>
      <div
        style={{
          marginTop: LOGO_BADGE_TOP,
          marginRight: LOGO_BADGE_RIGHT,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderRadius: 999,
          backgroundColor: "rgba(10,10,14,0.55)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <g stroke={accentColor} strokeWidth="1.5" strokeLinecap="round">
            <ellipse cx="12" cy="12" rx="10" ry="4.1" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
          </g>
          <circle cx="12" cy="12" r="2.6" fill={accentColor} />
        </svg>
        <span style={{ fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 700, fontSize: 20, color: "white", textShadow: "0 1px 4px rgba(0,0,0,0.6)" }}>
          Atomivid
        </span>
      </div>
    </AbsoluteFill>
  );
}
