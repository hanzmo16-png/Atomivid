import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { initialQueue, publicView, type Cycle } from "@/lib/mystery-shopper/quality-loop/model";
import { QualityLoopPanel } from "./QualityLoopPanel";

const SHA = "f51751374f203e7ced7038c226957cd2b4a82e69";
const cycle = (id: string, trigger: Cycle["trigger"], at: string): Cycle => ({ id, trigger, scope: "authenticated-readonly", startedAt: at, finishedAt: at, sha: SHA, runnerSha: SHA, url: `https://github.com/hanzmo16-png/Atomivid/actions/runs/${id}`, authenticated: true, sentinel: "READ",
  checks: [{ id: "reels-progress", product: "reels", state: "PASS", severity: "P1", owner: "claude", module: "reels", detail: "" }, { id: "audio-play", product: "audio-podcast", state: "BLOCKED", severity: "P1", owner: "codex", module: "audio", detail: "" }], spendUsd: 0 });

test("panel AQL: origen de cada ejecución, kill switch, próxima nominal honesta y productos con nombre", () => {
  const q = initialQueue("2026-11-27T16:00:00Z");
  q.cycles = [cycle("46030797559", "deployment_status", "2026-11-27T16:08:00Z"), cycle("46030887722", "workflow_dispatch", "2026-11-27T16:10:00Z")];
  const html = renderToStaticMarkup(<QualityLoopPanel initial={{ ...publicView(q, "2026-11-27T16:20:00Z"), claimTokens: {} }} />);
  assert.match(html, /Última ejecución auténtica/);
  assert.match(html, /· Manual/);
  assert.match(html, /Posterior a despliegue/);
  assert.match(html, /Programada \(cron\)<\/p><p[^>]*>0</);
  assert.match(html, /aún no hay ninguna ejecución programada acreditada/);
  assert.match(html, /Parada de emergencia \(kill switch\)/);
  assert.match(html, /Sin activar/);
  assert.match(html, /HOLD/);
  assert.match(html, /Reels<\/h3><p[^>]*>1 PASS · 0 FAIL · 0 BLOCKED · 0 SKIP/);
  assert.match(html, /Audio Podcast<\/h3><p[^>]*>0 PASS · 0 FAIL · 1 BLOCKED/);
  assert.doesNotMatch(html, />Activo</, "nunca «Activo» a secas");
  assert.doesNotMatch(html, /<main/, "el layout ya aporta el único <main>");
});

test("panel AQL sin datos: no afirma que el motor esté operativo", () => {
  const html = renderToStaticMarkup(<QualityLoopPanel />);
  assert.match(html, /Sin evidencia/);
  assert.match(html, /Ninguna acreditada/);
});
