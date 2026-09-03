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
  durationSeconds: number;
  scenes: Scene[];
  captions: Caption[];
};

export function VerticalReel({ audioUrl, scenes, captions }: VerticalReelProps) {
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {scenes.map((scene, i) => {
        const from = Math.round(scene.startSeconds * fps);
        const to =
          i === scenes.length - 1
            ? durationInFrames
            : Math.round(scene.endSeconds * fps);
        const sceneDuration = Math.max(1, to - from);

        return (
          <Sequence key={i} from={from} durationInFrames={sceneDuration}>
            <KenBurnsImage src={scene.imageUrl} durationInFrames={sceneDuration} />
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
    </AbsoluteFill>
  );
}

function KenBurnsImage({
  src,
  durationInFrames,
}: {
  src: string;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const scale = interpolate(progress, [0, 1], [1, 1.15]);
  const translateX = interpolate(progress, [0, 1], [0, -20]);

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
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
          fontSize: 62,
          color: "white",
          textAlign: "center",
          lineHeight: 1.15,
          padding: "0 60px",
          textShadow: "0 2px 6px rgba(0,0,0,0.85), 0 0 24px rgba(0,0,0,0.6)",
        }}
      >
        {active.text}
      </div>
    </AbsoluteFill>
  );
}
