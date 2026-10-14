import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { GeneratedScript } from "@/lib/providers/types";
import { DirectorInspectionPanel } from "./DirectorInspectionPanel";
import { inspectReel, inspectionMotionSummary, inspectionMotionText } from "@/lib/video/director/reel-inspection";

// Local run (Hans, 2026-10-13): the review panel showed "Movimiento real: 4" while the Reel was then built from
// still images. That count came from the simulated storyboard, before any material exists: it is an expectation.
const SCRIPT: GeneratedScript = {
  title: "Tu idea en video",
  segments: [
    { text: "Tienes una idea buena y el teléfono en la mano.", visualQuery: "person recording phone video", visualConcepts: ["person recording video with smartphone", "hands holding phone filming"], energy: "high" },
    { text: "Primero escribe la idea en una sola frase clara.", visualQuery: "writing notes notebook", visualConcepts: ["person writing idea in notebook", "hand writing on paper desk"], energy: "medium" },
    { text: "Graba cada momento con buena luz natural.", visualQuery: "creator filming window light", visualConcepts: ["creator filming near bright window", "microphone close to speaker"], energy: "medium" },
    { text: "Publica y mejora el siguiente video.", visualQuery: "person smiling at phone", visualConcepts: ["person smiling at phone screen", "creator reading comments on phone"], energy: "low" },
  ],
};

test("motion text separates an expected clip, a move over a still image and a still image", () => {
  assert.match(inspectionMotionText({ movement: "real_motion", realMotion: true }), /previsto/);
  assert.equal(inspectionMotionText({ movement: "push_in_still", realMotion: false }), "zoom sobre imagen fija");
  assert.equal(inspectionMotionText({ movement: "pan", realMotion: false }), "paneo sobre imagen fija");
  assert.equal(inspectionMotionText({ movement: "static", realMotion: false }), "imagen fija");
  assert.deepEqual(inspectionMotionSummary([
    { movement: "real_motion", realMotion: true }, { movement: "push_in_still", realMotion: false },
    { movement: "pan", realMotion: false }, { movement: "static", realMotion: false },
  ]), { expectedClips: 1, stillWithMove: 2, still: 1 });
});

test("the review panel never presents planned motion as real, verified motion", () => {
  const inspection = inspectReel(SCRIPT, { renderEnabled: true });
  assert.notEqual(inspection.status, "error");
  const html = renderToStaticMarkup(<DirectorInspectionPanel inspection={inspection} />);
  assert.doesNotMatch(html, /Movimiento real/i);
  assert.doesNotMatch(html, /· movimiento real/);
  assert.match(html, /antes de elegir el material/);
  assert.match(html, /Clips con movimiento previstos \(por confirmar con el material\)/);
  if (inspection.status !== "error") {
    const m = inspectionMotionSummary(inspection.shots);
    assert.equal(m.expectedClips + m.stillWithMove + m.still, inspection.shots.length);
  }
});

// chatgpt-10: this file was only in test:unit, which the CI workflow does not run.
test("CI registration: these panel tests run in test:saas (the suite the CI workflow executes)", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8")).scripts as Record<string, string>;
  assert.ok(scripts["test:saas"].split(/\s+/).includes("src/components/video/DirectorInspectionPanel.test.tsx"));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "e2e-fixture-evidence.yml"), "utf-8"), /npm run test:saas/);
});
