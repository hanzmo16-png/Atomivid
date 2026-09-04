import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type Scene = {
  imageUrl: string;
  startSeconds: number;
  endSeconds: number;
};

export type Caption = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type VerticalReelProps = {
  audioUrl: string;
  musicUrl?: string;
  durationSeconds: number;
  scenes: Scene[];
  captions: Caption[];
};

// Duración del crossfade entre escenas. A 30fps, 15 frames = 0.5s.
const FADE_FRAMES = 15;
const MUSIC_VOLUME = 0.12;

export function VerticalReel({
  audioUrl,
  musicUrl,
  scenes,
  captions,
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
            <KenBurnsImage
              src={scene.imageUrl}
              durationInFrames={sequenceDuration}
              fadeInFrames={isFirst ? 0 : FADE_FRAMES}
              fadeOutFrames={isLast ? 0 : FADE_FRAMES}
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

      <Captions captions={captions} />

      {audioUrl && <Audio src={audioUrl} />}
      {musicUrl && <Audio src={musicUrl} loop volume={MUSIC_VOLUME} />}
    </AbsoluteFill>
  );
}

function KenBurnsImage({
  src,
  durationInFrames,
  fadeInFrames,
  fadeOutFrames,
}: {
  src: string;
  durationInFrames: number;
  fadeInFrames: number;
  fadeOutFrames: number;
}) {
  const frame = useCurrentFrame();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const scale = interpolate(progress, [0, 1], [1, 1.15]);
  const translateX = interpolate(progress, [0, 1], [0, -20]);

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

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translateX(${translateX}px)`,
        }}
      />
    </AbsoluteFill>
  );
}

function Captions({ captions }: { captions: Caption[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const active = captions.find((c) => t >= c.startSeconds && t < c.endSeconds);

  if (!active) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 220,
      }}
    >
      <div
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontWeight: 800,
          fontSize: 58,
          color: "white",
          textAlign: "center",
          lineHeight: 1.25,
          padding: "0 70px",
          textShadow: "0 2px 6px rgba(0,0,0,0.85), 0 0 24px rgba(0,0,0,0.6)",
        }}
      >
        {active.text}
      </div>
    </AbsoluteFill>
  );
}
