import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { aqlCard, aqlSummaryOf } from "./aql";
import { initialQueue, type Cycle, type Queue } from "@/lib/mystery-shopper/quality-loop/model";
import { ResourceSentinelPanel } from "@/app/dashboard/command-center/sentinel/ResourceSentinelPanel";
import { buildSentinelView } from "./view";

const NOW = "2026-11-27T05:30:00.000Z";
const cycle = (finishedAt: string, states: ("PASS" | "FAIL" | "BLOCKED" | "SKIP")[], scope: Cycle["scope"] = "authenticated-readonly"): Cycle => ({
  id: `c-${finishedAt}`, trigger: "schedule", scope, startedAt: finishedAt, finishedAt, sha: "6815e483", runnerSha: "6815e483", url: "https://example.invalid/run", authenticated: true, sentinel: "BLOCKED", spendUsd: 0,
  checks: states.map((state, i) => ({ id: `k${i}`, product: "reels", state, severity: "P2", owner: "codex", module: "m", detail: "d" })),
});
const queue = (over: Partial<Queue>): Queue => ({ ...initialQueue("2026-11-27T00:00:00.000Z"), ...over });
const fmt = (iso: string) => `F(${iso})`;

test("AQL: el resumen nunca incluye tokens de reclamo ni actores", () => {
  const q = queue({ cycles: [cycle("2026-11-27T05:20:00.000Z", ["PASS", "PASS", "BLOCKED", "SKIP"])],
    lease: { cycleId: "c", token: "SECRET-LEASE", expiresAt: NOW },
    defects: [{ id: "d1", checkId: "k2", checkIds: ["k2"], product: "reels", severity: "P0", owner: "claude", module: "m", state: "CLAIMED", firstSeen: NOW, lastSeen: NOW, occurrences: 1, sha: null, evidence: "e", claim: { token: "SECRET-CLAIM", actor: "abc123", expiresAt: NOW }, fixSha: null, closedAt: null, taskId: "t" }] as Queue["defects"] });
  const s = aqlSummaryOf(q, NOW);
  const json = JSON.stringify(s);
  assert.ok(!json.includes("SECRET") && !json.includes("abc123"), json);
  assert.equal(s.operational, "BLOCKED"); assert.equal(s.pending, 1); assert.equal(s.critical, 1); assert.equal(s.sentinel, "BLOCKED");
  assert.deepEqual(s.lastChecks, { pass: 2, fail: 0, blocked: 1, skip: 1 });
});

test("AQL: estados operativos con su etiqueta; los ciclos de fixture no cuentan", () => {
  const recent = "2026-11-27T05:20:00.000Z";
  assert.equal(aqlSummaryOf(queue({ cycles: [cycle(recent, ["PASS", "PASS"])] }), NOW).operational, "ACTIVE");
  assert.equal(aqlSummaryOf(queue({ cycles: [cycle(recent, ["PASS", "FAIL"])] }), NOW).operational, "ERROR");
  assert.equal(aqlSummaryOf(queue({ cycles: [cycle("2026-11-27T03:00:00.000Z", ["PASS"])] }), NOW).operational, "STALE");
  assert.equal(aqlSummaryOf(queue({ cycles: [cycle(recent, ["PASS"], "fixture")] }), NOW).operational, "STALE", "un fixture no es una evaluación auténtica");
  assert.equal(aqlSummaryOf(queue({ enabled: false }), NOW).operational, "STOPPED");
  const c = aqlCard(aqlSummaryOf(queue({ cycles: [cycle(recent, ["PASS", "PASS"])] }), NOW), fmt);
  assert.equal(c.label, "Última evaluación sin fallos"); assert.equal(c.tone, "ok");
  assert.ok(c.facts.some((f) => f.label === "Próxima (nominal, no garantizada)"));
  assert.equal(c.href, "/dashboard/command-center/quality-loop");
});

test("AQL: sin lectura → «Desconocido», sin cifras inventadas", () => {
  const c = aqlCard(null, fmt);
  assert.equal(c.label, "Desconocido"); assert.equal(c.tone, "muted"); assert.deepEqual(c.facts, []); assert.equal(c.checks, null);
});

test("AQL: la tarjeta se ve en la misma pantalla de recursos, con enlace al bucle", () => {
  const view = buildSentinelView({ version: "resource-sentinel/1", generatedAt: NOW, timezone: "America/Cancun", source: "existing-supply-tables", errors: [], providers: [] });
  const html = renderToStaticMarkup(createElement(ResourceSentinelPanel, { view, aql: aqlCard(aqlSummaryOf(queue({ cycles: [cycle("2026-11-27T05:20:00.000Z", ["PASS", "BLOCKED"])] }), NOW), fmt) }));
  assert.ok(html.includes('data-testid="sentinel-aql"') && html.includes("Bucle de calidad: Con bloqueos"));
  assert.ok(html.includes("1 PASS · 0 FAIL · 1 BLOCKED · 0 SKIP"));
  assert.ok(html.includes('href="/dashboard/command-center/quality-loop"'));
  assert.ok(!renderToStaticMarkup(createElement(ResourceSentinelPanel, { view })).includes("sentinel-aql"), "sin prop aql no se pinta");
});
