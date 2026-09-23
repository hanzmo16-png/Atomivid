import { Composition } from "remotion";
import { VerticalReel, type VerticalReelProps } from "./VerticalReel";
import { LongFormDoc, type LongFormDocProps } from "./LongFormDoc";

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
    </>
  );
}
