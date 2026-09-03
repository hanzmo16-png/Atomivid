import { Composition } from "remotion";
import { VerticalReel, type VerticalReelProps } from "./VerticalReel";

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

const defaultProps: VerticalReelProps = {
  audioUrl: "",
  durationSeconds: 30,
  scenes: [],
  captions: [],
};

export function RemotionRoot() {
  return (
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
  );
}
