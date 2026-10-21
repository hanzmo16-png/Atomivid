import { test } from "node:test";
import assert from "node:assert/strict";
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
