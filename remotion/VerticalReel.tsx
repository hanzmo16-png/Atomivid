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
import { type MusicMixLevels, type NarrationGap, musicVolumeAtSeconds, voiceVolumeAtSeconds } from "./audio-mix";
import { framingStyle, reelMotionTransform, vignetteBackground, type ReelFraming, type ReelLook, type ReelMotion } from "./reel-motion";

export type Scene = {
  mediaUrl: string;
  mediaType: "image" | "video";
  startSeconds: number;
  endSeconds: number;
  /**
   * Solo Reels con dirección audiovisual (src/lib/video/audiovisual/). Con
   * `motion` ausente el plano usa el Ken Burns de siempre; con
   * `transitionInFrames` ausente, el fundido de siempre (FADE_FRAMES).
   */
  motion?: ReelMotion;
  transitionInFrames?: number;
  framing?: ReelFraming;
};

export type Caption = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  /** Palabras (tal cual aparecen en `text`) que deben recibir énfasis visual — ver src/lib/video/caption-emphasis.ts. */
  emphasisWords?: string[];
};

export type VerticalReelProps = {
  audioUrl: string;
  musicUrl?: string;
  durationSeconds: number;
  scenes: Scene[];
  captions: Caption[];
  /** Huecos de silencio real en la narración — ver remotion/audio-mix.ts. */
  narrationGaps?: NarrationGap[];
  /** Color de acento para el énfasis de subtítulos — ver src/lib/video/brand.ts. */
  accentColor?: string;
  /** Badge de logo opt-in en la esquina — nunca activo por defecto, ver src/lib/video/brand.ts. */
  showLogo?: boolean;
  /** Grado visual de la dirección audiovisual (filtro, viñeta, tinte). Ausente = sin cambios. */
  look?: ReelLook;
  /** Niveles de música de la dirección audiovisual (nunca por encima de AUDIO_MIX). Ausente = AUDIO_MIX. */
  mix?: MusicMixLevels;
};

// Duración del crossfade entre escenas. A 30fps, 15 frames = 0.5s.
const FADE_FRAMES = 15;
const DEFAULT_ACCENT_COLOR = "#8f7ff5";

export function VerticalReel({
  audioUrl,
  musicUrl,
  durationSeconds,
  scenes,
  captions,
  narrationGaps = [],
  accentColor = DEFAULT_ACCENT_COLOR,
  showLogo = false,
  look,
  mix,
}: VerticalReelProps) {
  const { fps, durationInFrames } = useVideoConfig();
  const vignette = look ? vignetteBackground(look.vignette) : undefined;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={look && look.filter !== "none" ? { filter: look.filter } : undefined}>
      {scenes.map((scene, i) => {
        const isFirst = i === 0;
        const isLast = i === scenes.length - 1;
        const from = Math.round(scene.startSeconds * fps);
        const rawTo = isLast ? durationInFrames : Math.round(scene.endSeconds * fps);
        // Cada escena (salvo la última) se extiende un poco más allá de su
        // fin para solaparse con la siguiente y poder cruzar (crossfade).
        // Con dirección audiovisual el solape lo fija el fundido de entrada
        // del plano siguiente (0 = corte seco); sin ella, FADE_FRAMES.
        const fadeIn = isFirst ? 0 : (scene.transitionInFrames ?? FADE_FRAMES);
        const nextFade = isLast ? 0 : (scenes[i + 1].transitionInFrames ?? FADE_FRAMES);
        const extendedTo = Math.min(durationInFrames, rawTo + nextFade);
        const sequenceDuration = Math.max(1, extendedTo - from);

        return (
          <Sequence key={i} from={from} durationInFrames={sequenceDuration}>
            <SceneMedia
              scene={scene}
              durationInFrames={sequenceDuration}
              fadeInFrames={fadeIn}
              fadeOutFrames={nextFade}
              isHook={isFirst}
            />
          </Sequence>
        );
      })}
      </AbsoluteFill>

      {look?.tint && <AbsoluteFill style={{ backgroundColor: look.tint, mixBlendMode: "multiply" }} />}
      {vignette && <AbsoluteFill style={{ background: vignette }} />}

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0) 55%, rgba(0,0,0,0.6) 100%)",
        }}
      />

      <Captions captions={captions} accentColor={accentColor} />

      {showLogo && <LogoBadge accentColor={accentColor} />}

      {audioUrl && (
        <Audio
          src={audioUrl}
          volume={(frame) => voiceVolumeAtSeconds(frame / fps, durationSeconds)}
        />
      )}
      {musicUrl && (
        <Audio
          src={musicUrl}
          loop
          volume={(frame) => musicVolumeAtSeconds(frame / fps, durationSeconds, narrationGaps, mix)}
        />
      )}
    </AbsoluteFill>
  );
}

function SceneMedia({
  scene,
  durationInFrames,
  fadeInFrames,
  fadeOutFrames,
  isHook,
}: {
  scene: Scene;
  durationInFrames: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  /** El primer plano del video — recibe un impulso de zoom más rápido y marcado ("gancho") en vez del mismo Ken Burns parejo de las demás escenas. */
  isHook: boolean;
}) {
  const frame = useCurrentFrame();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;

  // Ken Burns aplicado a TODO plano (antes solo a imágenes estáticas — los
  // videos se mostraban completamente inmóviles en cámara, aplanando el
  // ritmo justo cuando la mayoría de los planos ahora son video real, no
  // foto). El gancho de apertura usa una curva más rápida y perceptible
  // (todo el impulso ocurre en el primer ~40% del plano, no repartido en
  // todo su rango) para captar atención de inmediato en vez de un
  // zoom uniforme e imperceptible.
  const hookProgress = Math.min(1, progress / 0.4);
  const directed = scene.motion ? reelMotionTransform(scene.motion, progress) : null;
  const framing = framingStyle(scene.framing);
  const scale = directed
    ? directed.scale * framing.baseScale
    : isHook
      ? interpolate(hookProgress, [0, 1], [1, 1.22], { extrapolateRight: "clamp" })
      : interpolate(progress, [0, 1], [1, 1.12]);
  const translateX = directed
    ? directed.translateX
    : isHook
      ? 0
      : interpolate(progress, [0, 1], [0, -18]);

  let opacity = 1;
  if (fadeInFrames > 0) {
    opacity = Math.min(opacity, interpolate(frame, [0, fadeInFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }));
  }
  if (fadeOutFrames > 0) {
    opacity = Math.min(
      opacity,
      interpolate(
        frame,
        [durationInFrames - fadeOutFrames, durationInFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      ),
    );
  }

  const mediaStyle = {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    transform: `scale(${scale}) translateX(${translateX}px)`,
    ...(framing.transformOrigin ? { transformOrigin: framing.transformOrigin } : {}),
  };

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      {scene.mediaType === "video" ? (
        <OffthreadVideo src={scene.mediaUrl} muted style={mediaStyle} />
      ) : (
        <Img src={scene.mediaUrl} style={mediaStyle} />
      )}
    </AbsoluteFill>
  );
}

// Zona segura inferior: TikTok/Reels/Shorts reservan esta franja para
// descripción, botones de interacción y la barra de navegación — un
// subtítulo que empieza más abajo de esto queda tapado en al menos una
// de las tres plataformas.
const SAFE_BOTTOM_PADDING = 280;
const CAPTION_MAX_WIDTH = 900; // dentro de 1080px de ancho, con margen a los lados (evita el riel de botones lateral de TikTok/Reels)
const CAPTION_APPEAR_FRAMES = 5; // ~165ms a 30fps — sobrio, no instantáneo ni con rebote

function Captions({ captions, accentColor }: { captions: Caption[]; accentColor: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const activeIndex = captions.findIndex((c) => t >= c.startSeconds && t < c.endSeconds);
  const active = captions[activeIndex];

  if (!active) return null;

  const activeStartFrame = Math.round(active.startSeconds * fps);
  const framesSinceStart = frame - activeStartFrame;
  // Animación sobria por bloque (no por palabra — nunca "karaoke"): un
  // fundo de entrada breve + un desplazamiento vertical mínimo, sin rebote
  // ni escalado exagerado.
  const appearProgress = Math.min(1, Math.max(0, framesSinceStart / CAPTION_APPEAR_FRAMES));
  const opacity = interpolate(appearProgress, [0, 1], [0, 1]);
  const translateY = interpolate(appearProgress, [0, 1], [10, 0]);

  const emphasisSet = new Set((active.emphasisWords ?? []).map((w) => w.toLowerCase()));
  const words = active.text.split(/\s+/);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: SAFE_BOTTOM_PADDING,
      }}
    >
      <div
        style={{
          maxWidth: CAPTION_MAX_WIDTH,
          padding: "14px 28px",
          borderRadius: 16,
          backgroundColor: "rgba(10,10,14,0.72)",
          border: "1px solid rgba(143,127,245,0.35)",
          opacity,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontWeight: 800,
            fontSize: 64,
            color: "white",
            textAlign: "center",
            lineHeight: 1.2,
            textShadow: "0 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.7)",
            // -webkit-text-stroke da un contorno fino adicional — mantiene
            // legibilidad sobre fondos claros donde la sombra sola no basta.
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

// Zona segura superior: la esquina superior derecha es donde TikTok/Reels/
// Shorts colocan menos elementos de UI fijos que la inferior (reservada
// para captions/descripción/botones) — por eso el badge va arriba, nunca
// abajo, y solo cuando showLogo=true (ver VerticalReelProps.showLogo).
const LOGO_BADGE_TOP = 64;
const LOGO_BADGE_RIGHT = 32;

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
        {/* Misma marca (núcleo + 3 órbitas) que src/components/ui/Logo.tsx, reimplementada aquí porque Remotion renderiza en un entorno de Chromium aislado sin acceso a los componentes de la app. */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <g stroke={accentColor} strokeWidth="1.5" strokeLinecap="round">
            <ellipse cx="12" cy="12" rx="10" ry="4.1" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
          </g>
          <circle cx="12" cy="12" r="2.6" fill={accentColor} />
        </svg>
        <span
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            fontWeight: 700,
            fontSize: 20,
            color: "white",
            textShadow: "0 1px 4px rgba(0,0,0,0.6)",
          }}
        >
          Atomivid
        </span>
      </div>
    </AbsoluteFill>
  );
}
