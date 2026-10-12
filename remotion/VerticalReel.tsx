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
import { LABEL_TEXT, type SceneDirection, type SceneTiming, sceneOpacity, sceneTiming, sceneTransform } from "./reel-direction";

export type Scene = {
  mediaUrl: string;
  mediaType: "image" | "video";
  startSeconds: number;
  endSeconds: number;
  /** Optional per-scene direction from a Director plan (see reel-direction.ts). Absent = historic look. */
  direction?: SceneDirection;
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
};

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
}: VerticalReelProps) {
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {scenes.map((scene, i) => {
        // Crossfade overlaps (0.5 s) by default; a Director scene may ask for a cut or a fade from/to black instead.
        const timing = sceneTiming(scenes, i, fps, durationInFrames);
        return (
          <Sequence key={i} from={timing.from} durationInFrames={timing.durationInFrames}>
            <SceneMedia scene={scene} timing={timing} isFirst={i === 0} />
            {scene.direction?.label && <SceneLabelBadge text={LABEL_TEXT[scene.direction.label]} />}
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
          volume={(frame) => musicVolumeAtSeconds(frame / fps, durationSeconds, narrationGaps)}
        />
      )}
    </AbsoluteFill>
  );
}

function SceneMedia({ scene, timing, isFirst }: { scene: Scene; timing: SceneTiming; isFirst: boolean }) {
  const frame = useCurrentFrame();
  const progress = timing.durationInFrames > 1 ? frame / (timing.durationInFrames - 1) : 0;

  // Sin dirección: Ken Burns en todo plano y un gancho de zoom más rápido en el primero (comportamiento histórico).
  // Con dirección (plan del Director): la receta decide — un clip real se muestra tal cual se filmó (sin zoom
  // sintético encima), un zoom o paneo sobre foto se declara como tal, y un plano estático no se mueve.
  const { scale, translateX } = sceneTransform(scene.direction, isFirst, progress);
  const opacity = sceneOpacity(timing, frame);

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

// Etiqueta obligatoria de procedencia (recreación IA / ilustrativa): arriba a la izquierda, lejos de la franja de
// subtítulos y del badge de logo (arriba a la derecha). Visible durante todo el plano que la requiere.
function SceneLabelBadge({ text }: { text: string }) {
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start" }}>
      <div
        style={{
          marginTop: 64,
          marginLeft: 32,
          padding: "8px 14px",
          borderRadius: 10,
          backgroundColor: "rgba(10,10,14,0.62)",
          border: "1px solid rgba(255,255,255,0.22)",
          fontFamily: "Arial, Helvetica, sans-serif",
          fontWeight: 700,
          fontSize: 26,
          color: "white",
          letterSpacing: 0.3,
        }}
      >
        {text}
      </div>
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
