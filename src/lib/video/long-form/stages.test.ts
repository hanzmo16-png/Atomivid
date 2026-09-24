import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_FORM_STAGES, LONG_FORM_STAGE_LABEL } from "./stages";

test("LONG_FORM_STAGES coincide EXACTAMENTE con el vocabulario de la migración 0016 (video_requests_long_form_stage_check)", () => {
  assert.deepEqual([...LONG_FORM_STAGES], ["scripting", "storyboard", "assets", "ai_video", "rendering"]);
});

test("LONG_FORM_STAGE_LABEL tiene una etiqueta no vacía para cada etapa", () => {
  for (const stage of LONG_FORM_STAGES) {
    assert.ok(LONG_FORM_STAGE_LABEL[stage] && LONG_FORM_STAGE_LABEL[stage].length > 0, `falta etiqueta para "${stage}"`);
  }
});
