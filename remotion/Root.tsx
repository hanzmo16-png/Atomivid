import { Composition } from "remotion";
import { VerticalReel, type VerticalReelProps } from "./VerticalReel";
import { LongFormDoc, type LongFormDocProps } from "./LongFormDoc";
import { LongFormThumbnail, type LongFormThumbnailProps } from "./LongFormThumbnail";

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

// Long Form (documental 16:9) — composición independiente, no reemplaza
// ni modifica la de arriba (Shorts). Ver src/lib/video/long-form/.
export const LONG_FORM_FPS = 30;
export const LONG_FORM_WIDTH = 1920;
export const LONG_FORM_HEIGHT = 1080;

const defaultProps: VerticalReelProps = {
  audioUrl: "",
  durationSeconds: 30,
  scenes: [],
  captions: [],
  narrationGaps: [],
};

const longFormDefaultProps: LongFormDocProps = {
  audioUrl: "",
  durationSeconds: 30,
  scenes: [],
  captions: [],
  narrationGaps: [],
};

// Miniatura de YouTube de Long Form (fotograma fijo 1280×720).
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;
const thumbnailDefaultProps: LongFormThumbnailProps = {
  background: { mediaType: "image", url: "" },
  cover: { style: "impacto", title: "Título" },
};

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="VerticalReel"
        component={VerticalReel}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        durationInFrames={Math.round(defaultProps.durationSeconds * FPS)}
        defaultProps={defaultProps}
        calculateMetadata={async ({ props }) => ({
          durationInFrames: Math.max(1, Math.round(props.durationSeconds * FPS)),
        })}
      />
      <Composition
        id="LongFormDoc"
        component={LongFormDoc}
        fps={LONG_FORM_FPS}
        width={LONG_FORM_WIDTH}
        height={LONG_FORM_HEIGHT}
        durationInFrames={Math.round(longFormDefaultProps.durationSeconds * LONG_FORM_FPS)}
        defaultProps={longFormDefaultProps}
        calculateMetadata={async ({ props }) => ({
          durationInFrames: Math.max(1, Math.round(props.durationSeconds * LONG_FORM_FPS)),
        })}
      />
      <Composition
        id="LongFormThumbnail"
        component={LongFormThumbnail}
        fps={LONG_FORM_FPS}
        width={THUMBNAIL_WIDTH}
        height={THUMBNAIL_HEIGHT}
        durationInFrames={1}
        defaultProps={thumbnailDefaultProps}
      />
    </>
  );
}
