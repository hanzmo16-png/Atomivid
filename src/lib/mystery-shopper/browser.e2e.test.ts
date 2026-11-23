import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { runFixtureWalk } from "../../../scripts/mystery-shopper/run";

test("el cliente misterioso recorre Audio Podcast en el arnés y repite el celular", { timeout: 180000 }, async () => {
  const result = await runFixtureWalk();
  const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
    status: string; spendUsd: number; scope: string; fixtureLabeled: boolean; realMode: { executed: boolean };
    steps: { name: string; status: string }[]; findings: { fact: string; profile: string }[];
    scores: { product: string; weighted: number | null; criticalBlock: string | null }[];
    liveProbe: { detail: string } | null; media: { lipSync: { approved: boolean }; technicalVerdict: string } | null;
  };
  assert.equal(report.spendUsd, 0);
  assert.equal(report.realMode.executed, false);
  assert.equal(report.fixtureLabeled, true);
  assert.equal(report.scope, "fixture-harness");
  assert.equal(report.status, "TERMINADA");
  for (const name of ["Iniciar sesión", "Entrar desde el menú y encontrar el producto", "Descargarlo", "Guardar y recuperar el proyecto"]) {
    assert.equal(report.steps.find((s) => s.name === name)?.status, "ok", name);
  }
  assert.ok(report.findings.some((f) => f.profile === "principiante" && f.fact.includes("MP3")));
  const audio = report.scores.find((s) => s.product === "audio-podcast");
  assert.ok(audio);
  assert.notEqual(audio.weighted, null);
  assert.equal(audio.criticalBlock, null);
  assert.equal(report.media?.lipSync.approved, false);
  assert.notEqual(report.media?.technicalVerdict, "FAIL");
  assert.match(report.liveProbe?.detail ?? "", /ATOMIVID|sesión|HTTP|No se pudo/);
  for (const name of ["audio-390.png", "audio-412.png"]) {
    const info = await stat(`artifacts/mystery-shopper/evidence/${name}`);
    assert.ok(info.size > 1000, name);
  }
});
