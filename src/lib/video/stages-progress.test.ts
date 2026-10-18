import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RENDER_STAGES, approximateRenderProgress } from "./stages";

test("Reel/Avatar: milestones ordered and strictly under 100 until completed", () => {
  const values = RENDER_STAGES.map(approximateRenderProgress);
  assert.deepEqual(values, [5, 20, 45, 65, 80, 95]);
  assert.ok(values.every((v) => v !== null && v > 0 && v < 100));
  assert.equal(approximateRenderProgress(null), null);
  assert.equal(approximateRenderProgress("unknown"), null);
  assert.equal(approximateRenderProgress("completed"), null);
});

test("Regression: progressbars visible in dashboard and video while processing", () => {
  for (const file of ["src/components/video/RequestCard.tsx", "src/components/video/ResultView.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /approximateRenderProgress\(request\.progress_stage\)/);
    assert.match(source, /role="progressbar"/);
    assert.match(source, /aria-valuenow=\{reelPercent \?\? undefined\}/);
    assert.match(source, /Porcentaje orientativo|Avance orientativo/);
  }
});

test("Regression: script requests and regenerations show indeterminate activity, never a fake number", () => {
  for (const file of ["src/app/dashboard/GenerateButton.tsx", "src/app/dashboard/review/[id]/ScriptReview.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /role="progressbar"/);
    assert.match(source, /porcentaje no disponible/);
    assert.doesNotMatch(source, /aria-valuenow=\{[0-9]/);
  }
});

test("Regression: review bars must be next to their clicked controls, not after the entire scene list", () => {
  const source = readFileSync("src/app/dashboard/review/[id]/ScriptReview.tsx", "utf8");
  assert.match(source, /regeneratingAll && <PendingOperationProgress label="Regenerando guion completo"/);
  assert.match(source, /savingIndex === i && \(/);
  assert.match(source, /ref=\{activeSceneProgressRef\}/);
  assert.match(source, /scrollIntoView\(\{ block: "center", behavior: "auto" \}\)/);
  assert.match(source, /<PendingOperationProgress label=\{`Regenerando escena/);
  assert.match(source, /generating && <PendingOperationProgress label="Iniciando producción del video"/);
  const lastCard = source.lastIndexOf("</Card>");
  const sticky = source.indexOf('className="sticky bottom-4');
  const afterSceneList = source.indexOf("script.segments.map((scene, i)");
  assert.ok(afterSceneList >= 0 && lastCard >= afterSceneList);
  assert.ok(sticky > lastCard);
  assert.ok(!source.includes("(regeneratingAll || savingIndex !== null || generating) &&"), "no global progressbar below all scenes");
});

test("Regression: stalled renders never expose a misleading percentage on the video page", () => {
  const source = readFileSync("src/components/video/ResultView.tsx", "utf8");
  assert.match(source, /!waitingForSupply && !stalled &&/);
  assert.match(source, /!waitingForSupply && stalled &&/);
  assert.match(source, /Esta producción dejó de reportar avances/);
  assert.match(source, /No mostraremos un porcentaje antiguo/);
});
