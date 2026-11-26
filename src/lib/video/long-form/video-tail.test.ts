import { test } from "node:test";
import assert from "node:assert/strict";
import { compositionDurationSeconds } from "./composition-duration";
import { coverVideoTail } from "./produce";
import { preflightRenderInput } from "./render-preflight";

// Caso real del ensayo R8 (Marco Aurelio): voz de 473.772 s + cola → 474.27200000000005 s.
const voiceEnd = 473.772;
// Valores exactos del mensaje del worker (la suma binaria no da 474.272).
const duration = 474.27200000000005;
const captions = [{ startSeconds: 1, endSeconds: 3 }];
const scenes = [{ id: "a", startSeconds: 0, endSeconds: 200 }, { id: "b", startSeconds: 200, endSeconds: voiceEnd }];

test("R8: la última escena cubre la cola → el preflight del render no rechaza un documental ya pagado", () => {
  const covered = coverVideoTail(scenes, duration);
  assert.equal(covered[covered.length - 1].endSeconds, duration);
  assert.deepEqual(preflightRenderInput({ scenes: covered, captions, durationSeconds: duration, audioUrl: "memory://voice.mp3" }), []);
  assert.equal(scenes[1].endSeconds, voiceEnd, "no muta la entrada");
});

test("sin cobertura (comportamiento anterior) el mismo caso falla por gap_at_end", () => {
  const issues = preflightRenderInput({ scenes, captions, durationSeconds: duration, audioUrl: "memory://voice.mp3" });
  assert.deepEqual(issues.map((i) => i.code), ["gap_at_end"]);
});

test("coverVideoTail no acorta ni toca escenas que ya cubren el final", () => {
  const long = [{ id: "a", startSeconds: 0, endSeconds: 500 }];
  assert.equal(coverVideoTail(long, duration), long);
  assert.deepEqual(coverVideoTail([], duration), []);
});


test("near-target 3-minute composition reaches 180s without changing narration or earlier scenes", () => {
  const narrationSeconds = 178.1;
  const duration = compositionDurationSeconds(narrationSeconds, 180);
  assert.equal(duration, 180);
  const original = [{ id: "a", startSeconds: 0, endSeconds: 100 }, { id: "last", startSeconds: 100, endSeconds: narrationSeconds }];
  const covered = coverVideoTail(original, duration, true);
  assert.equal(covered[0], original[0]);
  assert.deepEqual(covered[1], { ...original[1], endSeconds: 180, holdFromSeconds: narrationSeconds });
  assert.equal(original[1].endSeconds, narrationSeconds);
  assert.deepEqual(preflightRenderInput({ scenes: covered, captions, durationSeconds: duration, audioUrl: "memory://unchanged-voice.mp3" }), []);
});

test("duration floor never truncates, hides missing narration, or extends an unrequested legacy composition", () => {
  assert.equal(compositionDurationSeconds(180, 180), 180.5);
  assert.equal(compositionDurationSeconds(178.1), 178.6);
  assert.equal(compositionDurationSeconds(177.5, 180), 180, "bounded two-second extra outro");
  assert.equal(compositionDurationSeconds(177.49, 180), 177.99, "larger gaps retain natural composition, without long silent padding");
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => compositionDurationSeconds(invalid, 180), RangeError);
    assert.throws(() => compositionDurationSeconds(178, invalid), RangeError);
  }
});
