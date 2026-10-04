/** Shared by the renderer and pixel review so camera changes cannot bypass QA. */
export const REEL_VIEWPORT = { width: 1080, height: 1920 } as const;
export const REEL_HOOK_ZOOM = 1.22;
export const REEL_SCENE_ZOOM = 1.12;
export const REEL_SCENE_PAN_X = -18;

/** Source pixels visible through object-fit: cover and the final CSS camera transform. */
export function reelVisibleCrop(width: number, height: number, isHook: boolean, zoomed: boolean) {
  const coverScale = Math.max(REEL_VIEWPORT.width / width, REEL_VIEWPORT.height / height);
  const baseWidth = REEL_VIEWPORT.width / coverScale;
  const baseHeight = REEL_VIEWPORT.height / coverScale;
  const zoom = zoomed ? (isHook ? REEL_HOOK_ZOOM : REEL_SCENE_ZOOM) : 1;
  const pan = zoomed && !isHook ? REEL_SCENE_PAN_X : 0;
  const cropWidth = Math.floor(baseWidth / zoom);
  const cropHeight = Math.floor(baseHeight / zoom);
  return {
    left: Math.max(0, Math.min(width - cropWidth, Math.round((width - baseWidth / zoom) / 2 - pan / coverScale))),
    top: Math.max(0, Math.min(height - cropHeight, Math.round((height - baseHeight / zoom) / 2))),
    width: cropWidth,
    height: cropHeight,
  };
}
