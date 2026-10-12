import { test } from "node:test";
import assert from "node:assert/strict";
import { crossfadeAt, DIP_FRAMES, FADE_FRAMES, sceneOpacity, sceneTiming, sceneTransform, type SceneDirection } from "./reel-direction";

const FPS = 30;
const legacy = [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 3, endSeconds: 6 }, { startSeconds: 6, endSeconds: 9 }];

// The historic VerticalReel math, copied verbatim from the pre-change component, to prove backward compatibility.
function historic(i: number, total: number) {
  const s = legacy[i], isFirst = i === 0, isLast = i === legacy.length - 1;
  const from = Math.round(s.startSeconds * FPS);
  const rawTo = isLast ? total : Math.round(s.endSeconds * FPS);
  const extendedTo = Math.min(total, rawTo + (isLast ? 0 : 15));
  return { from, duration: Math.max(1, extendedTo - from), fadeIn: isFirst ? 0 : 15, fadeOut: isLast ? 0 : 15 };
}

test("scenes without direction keep the historic timing, crossfades and Ken Burns exactly", () => {
  const total = 9 * FPS;
  for (let i = 0; i < legacy.length; i++) {
    const t = sceneTiming(legacy, i, FPS, total), h = historic(i, total);
    assert.equal(t.from, h.from); assert.equal(t.durationInFrames, h.duration);
    for (let f = 0; f < t.durationInFrames; f += 3) {
      let o = 1;
      if (h.fadeIn) o = Math.min(o, Math.min(1, Math.max(0, f / h.fadeIn)));
      if (h.fadeOut) o = Math.min(o, Math.min(1, Math.max(0, (h.duration - f) / h.fadeOut)));
      assert.ok(Math.abs(sceneOpacity(t, f) - o) < 1e-9, `scene ${i} frame ${f}`);
    }
  }
  const hook = sceneTransform(undefined, true, 0.2);
  assert.ok(Math.abs(hook.scale - 1.11) < 1e-9 && hook.translateX === 0, "historic hook zoom on the first scene");
  const kb = sceneTransform(undefined, false, 0.5);
  assert.ok(Math.abs(kb.scale - 1.06) < 1e-9 && Math.abs(kb.translateX + 9) < 1e-9);
});

const d = (over: Partial<SceneDirection>): SceneDirection => ({ motion: "static", transitionIn: "cut", transitionOut: "cut", ...over });

test("directed scenes: a cut has no overlap and no fade; crossfade only where a side asks for it", () => {
  const scenes = [{ startSeconds: 0, endSeconds: 3, direction: d({}) }, { startSeconds: 3, endSeconds: 6, direction: d({ transitionOut: "crossfade" }) }, { startSeconds: 6, endSeconds: 9, direction: d({}) }];
  const t0 = sceneTiming(scenes, 0, FPS, 270), t1 = sceneTiming(scenes, 1, FPS, 270), t2 = sceneTiming(scenes, 2, FPS, 270);
  assert.equal(t0.durationInFrames, 90, "cut: scene ends exactly at its end time");
  assert.equal(sceneOpacity(t0, 89), 1, "no fade-out before a cut");
  assert.equal(t1.overlapIn, 0); assert.equal(sceneOpacity(t1, 0), 1, "cut-in starts fully visible");
  assert.equal(t1.overlapOut, FADE_FRAMES); assert.equal(t2.overlapIn, FADE_FRAMES);
  assert.equal(crossfadeAt(undefined, d({})), true, "a legacy neighbour keeps the historic crossfade");
});

test("fade from/to black stays inside the scene (no overlap) and reaches black at the edges", () => {
  const scenes = [{ startSeconds: 0, endSeconds: 2, direction: d({ transitionIn: "fade" }) }, { startSeconds: 2, endSeconds: 4, direction: d({ transitionOut: "fade" }) }];
  const a = sceneTiming(scenes, 0, FPS, 120), b = sceneTiming(scenes, 1, FPS, 120);
  assert.equal(a.dipIn, DIP_FRAMES); assert.equal(sceneOpacity(a, 0), 0); assert.equal(sceneOpacity(a, DIP_FRAMES), 1);
  assert.equal(b.dipOut, DIP_FRAMES); assert.equal(sceneOpacity(b, b.durationInFrames), 0); assert.equal(a.durationInFrames, 60);
});

test("motion follows the recipe: real clips and static shots never get a synthetic zoom; push-in and pan are declared moves", () => {
  for (const p of [0, 0.5, 1]) {
    assert.deepEqual(sceneTransform(d({ motion: "real" }), true, p), { scale: 1, translateX: 0 }, "real clip plays as filmed, even first");
    assert.deepEqual(sceneTransform(d({ motion: "static" }), false, p), { scale: 1, translateX: 0 });
  }
  assert.equal(sceneTransform(d({ motion: "push_in" }), false, 1).scale, 1.15);
  assert.equal(sceneTransform(d({ motion: "pan" }), false, 0).translateX, 40);
  assert.equal(sceneTransform(d({ motion: "pan" }), false, 1).translateX, -40);
});
