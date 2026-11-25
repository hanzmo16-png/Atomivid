import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCampaign320Evidence, type Campaign320Evidence } from "./campaign-320-evidence";

const complete: Campaign320Evidence[] = [
  { missionId: "youtube-real", product: "long-form", spentUsd: 2 },
  { missionId: "reels-real", product: "reels", spentUsd: 1.5 },
  { missionId: "video-podcast-real", product: "video-podcast", spentUsd: 3 },
  { missionId: "audio-real-es", product: "audio-podcast", spentUsd: 2 },
].map((row, index) => ({
  ...row,
  stage: "VALIDADO_REAL",
  mode: "real",
  runId: `run-${index + 1}`,
  sha: "9ed20e7fc0d5ff5ae6aa05cba6ff4dd9c581da2b",
  finalFileUrl: `https://evidence.invalid/file-${index + 1}`,
  mediaAccepted: true,
  repeatedAfterFix: true,
})) as Campaign320Evidence[];

test("issue #320: solo las cuatro misiones reales completas permiten ENTREGADO", () => {
  const verdict = evaluateCampaign320Evidence(complete);
  assert.equal(verdict.complete, true);
  assert.equal(verdict.totalSpentUsd, 8.5);
  assert.deepEqual(verdict.reasons, []);
});

test("issue #320: un preflight o fixture nunca cuenta como validación real", () => {
  for (const mode of ["preflight", "fixture"] as const) {
    const verdict = evaluateCampaign320Evidence([{ ...complete[0], mode }]);
    assert.equal(verdict.complete, false);
    assert.match(verdict.rows[0].reasons.join(" "), /no una ejecución real/i);
  }
});

test("issue #320: detecta misiones faltantes y duplicadas sin esconderlas", () => {
  const verdict = evaluateCampaign320Evidence([complete[0], complete[0], complete[1]]);
  assert.equal(verdict.complete, false);
  assert.deepEqual(verdict.duplicateMissionIds, ["youtube-real"]);
  assert.deepEqual(verdict.missingMissionIds, ["video-podcast-real", "audio-real-es"]);
});

test("issue #320: exige run, SHA, archivo, aceptación, repetición y gasto", () => {
  const bad = { ...complete[0], runId: null, sha: null, finalFileUrl: null, mediaAccepted: false, repeatedAfterFix: false, spentUsd: null };
  const row = evaluateCampaign320Evidence([bad]).rows[0];
  assert.equal(row.complete, false);
  assert.match(row.reasons.join(" "), /run\/job ID|SHA|archivo final|aceptación|repetición|gasto real/);
});

test("issue #320: rechaza topes por módulo y acumulado", () => {
  const moduleOver = evaluateCampaign320Evidence([{ ...complete[1], spentUsd: 1.51 }]);
  assert.match(moduleOver.rows[0].reasons.join(" "), /tope del módulo/);
  const totalOver = evaluateCampaign320Evidence(complete.map((row) => ({ ...row, spentUsd: row.spentUsd! + 0.01 })));
  assert.match(totalOver.reasons.join(" "), /supera USD 8\.50/);
});
