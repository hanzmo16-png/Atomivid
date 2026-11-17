import { test } from "node:test";
import assert from "node:assert/strict";
import { clipAudible, crossfadeAt, DIP_FRAMES, FADE_FRAMES, labelTextFor, sceneOpacity, sceneTiming, sceneTransform, type SceneDirection } from "./reel-direction";

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
  // After the punch-in the opening keeps moving (it used to hold a still frame for 60 % of the first scene).
  const at = (p: number) => sceneTransform(undefined, true, p);
  assert.ok(Math.abs(at(0.4).scale - 1.22) < 1e-9 && at(0.4).translateX === 0, "continuous at the end of the punch-in");
  assert.ok(at(0.7).scale > at(0.4).scale && at(1).scale > at(0.7).scale, "opening keeps zooming after the punch-in");
  assert.ok(at(1).translateX < at(0.7).translateX, "opening keeps drifting after the punch-in");
  assert.ok(at(1).scale <= 1.3 + 1e-9);
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

test("clip sound only when a video scene's direction asks for it; label wording can change but never disappear", () => {
  assert.equal(clipAudible(undefined, "video"), false, "legacy scenes stay muted");
  assert.equal(clipAudible(d({}), "video"), false, "directed scenes stay muted by default");
  assert.equal(clipAudible(d({ audio: "clip" }), "video"), true);
  assert.equal(clipAudible(d({ audio: "clip" }), "image"), false, "a still has no sound");
  assert.equal(labelTextFor(d({ label: "recreacion_ia" })), "Recreación IA");
  assert.equal(labelTextFor(d({ label: "recreacion_ia", labelText: "Ficción creada con IA" })), "Ficción creada con IA");
  assert.equal(labelTextFor(d({ label: "recreacion_ia", labelText: "  " })), "Recreación IA", "an empty override never removes the label");
  assert.equal(labelTextFor(d({ labelText: "x" })), null, "no label, no badge");
});

test("end card (CTA): off by default, last 1.5 s only, never over the hook, fades in and holds to the end", async () => {
  const { END_CARD_SECONDS, END_CARD_FADE_FRAMES, endCardStyleAt, endCardText, endCardWindow } = await import("./reel-direction");
  for (const off of [undefined, null, "", "   "]) assert.equal(endCardWindow(off, FPS, 30 * FPS), null, "no text = no card");
  for (const seconds of [15, 30, 60]) {
    const total = Math.round((seconds - 0.4) * FPS);
    const w = endCardWindow("Sígueme para más", FPS, total)!;
    assert.equal(w.durationInFrames, Math.round(END_CARD_SECONDS * FPS));
    assert.equal(w.from + w.durationInFrames, total, `${seconds}s: the card ends exactly on the last frame`);
    // The hook (first scene, ~5 s in a 15 s Short) is never covered.
    assert.ok(w.from / FPS > 6, `${seconds}s: card starts at ${w.from / FPS}s`);
  }
  assert.equal(endCardWindow("Sígueme", FPS, 7 * FPS), null, "too short to carry a card without crowding the hook");
  assert.deepEqual(endCardStyleAt(0), { opacity: 0, scale: 0.94 });
  assert.deepEqual(endCardStyleAt(END_CARD_FADE_FRAMES), { opacity: 1, scale: 1 });
  assert.deepEqual(endCardStyleAt(40), { opacity: 1, scale: 1 }, "holds until the end (no fade-out to black)");
  assert.equal(endCardText("  Sígueme \n para   más "), "Sígueme para más");
  assert.equal(endCardText("x".repeat(80))!.length, 40);
});

test("end card is wired: VerticalReel draws it in its own Sequence above the caption band, generate-video passes it", async () => {
  const fs = await import("node:fs");
  const reel = fs.readFileSync(new URL("./VerticalReel.tsx", import.meta.url), "utf8");
  assert.match(reel, /endCardWindow\(rawEndCardText, fps, durationInFrames\)/);
  assert.match(reel, /<Sequence from=\{endCard\.from\} durationInFrames=\{endCard\.durationInFrames\}>/);
  const top = Number(/const END_CARD_TOP = (\d+);/.exec(reel)![1]);
  const safeBottom = Number(/const SAFE_BOTTOM_PADDING = (\d+);/.exec(reel)![1]);
  // Caption box: at most 2 lines of 64 px × 1.2 + padding, sitting on the bottom safe area of a 1920 px frame.
  const captionTop = 1920 - safeBottom - (2 * 64 * 1.2 + 28);
  assert.ok(top + 58 * 1.15 * 2 + 44 < captionTop, "a two-line CTA still ends above the caption band");
  const gen = fs.readFileSync(new URL("../src/lib/video/generate-video.ts", import.meta.url), "utf8");
  assert.match(gen, /endCardText = reelEndCardText\(\)/);
  assert.match(gen, /showLogo: shouldShowLogo\(\),\n\s*endCardText,/);
  const { reelEndCardText } = await import("../src/lib/video/brand");
  const prev = process.env.REEL_END_CARD_TEXT;
  try {
    delete process.env.REEL_END_CARD_TEXT; assert.equal(reelEndCardText(), null, "off by default");
    process.env.REEL_END_CARD_TEXT = "  Sígueme  para más "; assert.equal(reelEndCardText(), "Sígueme para más");
  } finally { if (prev === undefined) delete process.env.REEL_END_CARD_TEXT; else process.env.REEL_END_CARD_TEXT = prev; }
});
