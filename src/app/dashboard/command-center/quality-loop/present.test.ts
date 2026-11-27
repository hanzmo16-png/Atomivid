import { test } from "node:test";
import assert from "node:assert/strict";
import { initialQueue, publicView, type Cycle } from "@/lib/mystery-shopper/quality-loop/model";
import { ackOf, summarize } from "./present";

const SHA = "f51751374f203e7ced7038c226957cd2b4a82e69";
const cyc = (id: string, trigger: Cycle["trigger"], at: string, scope: Cycle["scope"] = "authenticated-readonly"): Cycle => ({ id, trigger, scope, startedAt: at, finishedAt: at, sha: SHA, runnerSha: SHA, url: `https://github.com/x/${id}`, authenticated: scope !== "fixture", sentinel: "READ", checks: [], spendUsd: 0 });

test("AQL: separa manual, posterior a despliegue y programada; sin cron acreditado lo dice", () => {
  const q = initialQueue("2026-11-27T16:00:00Z");
  q.cycles = [cyc("a", "workflow_dispatch", "2026-11-27T16:10:00Z"), cyc("b", "deployment_status", "2026-11-27T16:08:00Z"), cyc("f", "fixture", "2026-11-27T16:20:00Z", "fixture")];
  const s = summarize(publicView(q, "2026-11-27T16:30:00Z"));
  assert.deepEqual(s.byTrigger.map((t) => [t.trigger, t.count]), [["schedule", 0], ["deployment_status", 1], ["workflow_dispatch", 1]]);
  assert.equal(s.lastReal?.id, "b", "la simulación nunca es la última ejecución auténtica");
  assert.equal(s.scheduleProven, false);
  assert.match(s.next.note, /aún no hay ninguna ejecución programada acreditada/);
  q.cycles.push(cyc("c", "schedule", "2026-11-27T16:25:00Z"));
  assert.equal(summarize(publicView(q, "2026-11-27T16:30:00Z")).scheduleProven, true);
});

test("AQL: kill switch visible y sin próxima ejecución cuando está detenido", () => {
  const q = initialQueue("2026-11-27T16:00:00Z"); q.enabled = false;
  const s = summarize(publicView(q, "2026-11-27T16:30:00Z"));
  assert.equal(s.killSwitch.engaged, true);
  assert.match(s.killSwitch.label, /ACTIVADA/);
  assert.equal(s.next.display, "Ninguna");
});

test("AQL: el ACK muestra actor con hash y vencimiento, nunca el token", () => {
  const q = initialQueue("2026-11-27T16:00:00Z");
  q.defects = [{ id: "d1", checkId: "x", checkIds: ["x"], product: "reels", severity: "P1", owner: "claude", module: "m", state: "CLAIMED", firstSeen: "2026-11-27T16:00:00Z", lastSeen: "2026-11-27T16:00:00Z", occurrences: 1, sha: SHA, evidence: "https://github.com/x", claim: { token: "SECRET-TOKEN", actor: "abc123", expiresAt: "2026-11-27T18:00:00Z" }, fixSha: null, closedAt: null, taskId: "T", driveId: null }];
  const v = publicView(q, "2026-11-27T16:30:00Z");
  const text = ackOf(v.defects[0]) ?? "";
  assert.match(text, /actor abc123/);
  assert.doesNotMatch(JSON.stringify(v.defects[0].claim), /SECRET-TOKEN/);
  assert.match(ackOf(publicView(q, "2026-11-27T19:00:00Z").defects[0]) ?? "", /vencido/);
});
