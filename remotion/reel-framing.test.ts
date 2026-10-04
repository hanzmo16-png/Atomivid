import { test } from "node:test";
import assert from "node:assert/strict";
import { reelVisibleCrop } from "./reel-framing";

test("vertical crop removes landscape sides, and hook zoom checks a tighter safe area", () => {
  assert.deepEqual(reelVisibleCrop(3840, 2160, true, false), { left: 1313, top: 0, width: 1215, height: 2160 });
  const base = reelVisibleCrop(1024, 1536, true, false);
  const zoom = reelVisibleCrop(1024, 1536, true, true);
  assert.deepEqual(base, { left: 80, top: 0, width: 864, height: 1536 });
  assert.ok(zoom.left > base.left && zoom.top > base.top);
  assert.ok(zoom.width < base.width && zoom.height < base.height);
});

test("normal camera crop includes the actual leftward CSS pan, which reveals pixels farther right", () => {
  const crop = reelVisibleCrop(1080, 1920, false, true);
  assert.equal(crop.left, 76);
  assert.equal(crop.top, 103);
  assert.equal(crop.width, 964);
  assert.equal(crop.height, 1714);
  assert.ok(crop.left + crop.width <= 1080);
});
