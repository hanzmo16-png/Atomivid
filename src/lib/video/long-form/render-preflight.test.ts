import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightRenderInput, assertRenderInputValid, RenderPreflightFailedError } from "./render-preflight";

const VALID_INPUT = {
  scenes: [
    { id: "s1", startSeconds: 0, endSeconds: 5 },
    { id: "s2", startSeconds: 5, endSeconds: 10 },
  ],
  captions: [{ startSeconds: 0, endSeconds: 4 }],
  durationSeconds: 10,
  audioUrl: "http://example.com/audio.wav",
};

test("preflightRenderInput no reporta problemas para un input válido (escenas contiguas, cubren todo el rango)", () => {
  assert.deepEqual(preflightRenderInput(VALID_INPUT), []);
});

test("preflightRenderInput detecta duration_invalid", () => {
  const issues = preflightRenderInput({ ...VALID_INPUT, durationSeconds: 0 });
  assert.ok(issues.some((i) => i.code === "duration_invalid"));
});

test("preflightRenderInput detecta missing_audio", () => {
  const issues = preflightRenderInput({ ...VALID_INPUT, audioUrl: "" });
  assert.ok(issues.some((i) => i.code === "missing_audio"));
});

test("preflightRenderInput detecta no_scenes y se detiene ahí (no valida cobertura sin escenas)", () => {
  const issues = preflightRenderInput({ ...VALID_INPUT, scenes: [] });
  assert.deepEqual(
    issues.map((i) => i.code),
    ["no_scenes"],
  );
});

test("preflightRenderInput detecta gap_at_start si la primera escena no empieza en 0", () => {
  const issues = preflightRenderInput({
    ...VALID_INPUT,
    scenes: [{ id: "s1", startSeconds: 2, endSeconds: 10 }],
  });
  assert.ok(issues.some((i) => i.code === "gap_at_start"));
});

test("preflightRenderInput detecta gap_between_scenes", () => {
  const issues = preflightRenderInput({
    ...VALID_INPUT,
    scenes: [
      { id: "s1", startSeconds: 0, endSeconds: 4 },
      { id: "s2", startSeconds: 6, endSeconds: 10 },
    ],
  });
  assert.ok(issues.some((i) => i.code === "gap_between_scenes"));
});

test("preflightRenderInput detecta overlap_between_scenes", () => {
  const issues = preflightRenderInput({
    ...VALID_INPUT,
    scenes: [
      { id: "s1", startSeconds: 0, endSeconds: 6 },
      { id: "s2", startSeconds: 4, endSeconds: 10 },
    ],
  });
  assert.ok(issues.some((i) => i.code === "overlap_between_scenes"));
});

test("preflightRenderInput detecta gap_at_end si la última escena no llega hasta durationSeconds", () => {
  const issues = preflightRenderInput({
    ...VALID_INPUT,
    scenes: [{ id: "s1", startSeconds: 0, endSeconds: 7 }],
    durationSeconds: 10,
  });
  assert.ok(issues.some((i) => i.code === "gap_at_end"));
});

test("preflightRenderInput detecta caption_out_of_bounds", () => {
  const issues = preflightRenderInput({ ...VALID_INPUT, captions: [{ startSeconds: 8, endSeconds: 15 }] });
  assert.ok(issues.some((i) => i.code === "caption_out_of_bounds"));
});

test("preflightRenderInput reporta no_captions (advertencia, no bloqueante por sí sola) si no hay subtítulos", () => {
  const issues = preflightRenderInput({ ...VALID_INPUT, captions: [] });
  assert.ok(issues.some((i) => i.code === "no_captions"));
});

test("assertRenderInputValid no lanza con un input válido", () => {
  assert.doesNotThrow(() => assertRenderInputValid(VALID_INPUT));
});

test("assertRenderInputValid lanza RenderPreflightFailedError con TODOS los problemas encontrados, no solo el primero", () => {
  try {
    assertRenderInputValid({
      scenes: [
        { id: "s1", startSeconds: 2, endSeconds: 6 },
        { id: "s2", startSeconds: 8, endSeconds: 9 },
      ],
      captions: [],
      durationSeconds: 10,
      audioUrl: "",
    });
    assert.fail("debería haber lanzado");
  } catch (err) {
    assert.ok(err instanceof RenderPreflightFailedError);
    const codes = err.issues.map((i) => i.code);
    assert.ok(codes.includes("missing_audio"));
    assert.ok(codes.includes("gap_at_start"));
    assert.ok(codes.includes("gap_between_scenes"));
    assert.ok(codes.includes("gap_at_end"));
    assert.ok(codes.includes("no_captions"));
  }
});

test("sub-millisecond narration: holding the last scene to the end avoids a false gap_at_end (local walkthrough, 160.7142857 s + 0.5 s tail)", async () => {
  const { holdLastSceneToEnd } = await import("./produce");
  const narration = 160.7142857142857, duration = narration + 0.5;
  const scenes = [{ id: "a", startSeconds: 0, endSeconds: 80 }, { id: "beat-5-shot-9", startSeconds: 80, endSeconds: Math.round(narration * 1000) / 1000 }];
  const input = { scenes, captions: [{ startSeconds: 0, endSeconds: 4 }], durationSeconds: duration, audioUrl: "http://example.com/a.mp3" };
  assert.ok(preflightRenderInput(input).some((i) => i.code === "gap_at_end"), "reproduces the failure");
  const held = holdLastSceneToEnd(scenes, duration);
  assert.deepEqual(preflightRenderInput({ ...input, scenes: held }), []);
  assert.equal(held[0], scenes[0], "only the last scene changes");
  assert.equal(held[1].endSeconds, duration);
  assert.equal(holdLastSceneToEnd(held, duration), held, "idempotent");
});

test("a preflight failure has a customer message without scene ids, timings or issue codes", async () => {
  const { isCustomerSafeError } = await import("./output-policy");
  const error = new RenderPreflightFailedError([{ code: "gap_at_end", message: "la última escena (beat-5-shot-9) termina en 160.714s" }]);
  assert.ok(isCustomerSafeError(error));
  assert.doesNotMatch(error.customerMessage, /gap_at_end|beat-\d|shot-\d|\d+\.\d+s|preflight/i);
  assert.match(error.message, /gap_at_end/, "the technical detail is kept for the log");
});
