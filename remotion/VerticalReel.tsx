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
import { type NarrationGap, musicVolumeAtSeconds, voiceVolumeAtSeconds } from "./audio-mix";

export type Scene = {
  mediaUrl: string;
  mediaType: "image" | "video";
  startSeconds: number;
  endSeconds: number;
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
};

// Duración del crossfade entre escenas. A 30fps, 15 frames = 0.5s.
const FADE_FRAMES = 15;
const DEFAULT_ACCENT_COLOR = "#FFC94D";

export function VerticalReel({
  audioUrl,
  musicUrl,
  durationSeconds,
  scenes,
  captions,
  narrationGaps = [],
  accentColor = DEFAULT_ACCENT_COLOR,
}: VerticalReelProps) {
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {scenes.map((scene, i) => {
        const isFirst = i === 0;
        const isLast = i === scenes.length - 1;
        const from = Math.round(scene.startSeconds * fps);
        const rawTo = isLast ? durationInFrames : Math.round(scene.endSeconds * fps);
        // Cada escena (salvo la última) se extiende un poco más allá de su
        // fin para solaparse con la siguiente y poder cruzar (crossfade).
        const extendedTo = Math.min(durationInFrames, rawTo + (isLast ? 0 : FADE_FRAMES));
        const sequenceDuration = Math.max(1, extendedTo - from);

        return (
          <Sequence key={i} from={from} durationInFrames={sequenceDuration}>
            <SceneMedia
              scene={scene}
              durationInFrames={sequenceDuration}
              fadeInFrames={isFirst ? 0 : FADE_FRAMES}
              fadeOutFrames={isLast ? 0 : FADE_FRAMES}
              isHook={isFirst}
            />
          </Sequence>
        );
      })}

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0) 55%, rgba(0,0,0,0.6) 100%)",
        }}
      />

      <Captions captions={captions} accentColor={accentColor} />

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
          volume={(frame) => musicVolumeAtSeconds(frame / fps, durationSeconds, narrationGaps)}
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
  const scale = isHook
    ? interpolate(hookProgress, [0, 1], [1, 1.22], { extrapolateRight: "clamp" })
    : interpolate(progress, [0, 1], [1, 1.12]);
  const translateX = isHook
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
          backgroundColor: "rgba(0,0,0,0.32)",
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
