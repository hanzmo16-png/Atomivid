import test from "node:test";
import assert from "node:assert/strict";
import { runReelReal } from "../../../../scripts/mystery-shopper/reels-mission";
import { defaultCatalog } from "../catalog";
import type { RealCtx } from "../../../../scripts/mystery-shopper/real-missions";
function fixture(real: boolean, cap: number | null, stopped = false) {
  const actions: string[] = [], steps: { state: string; detail: string }[] = [];
  const el = (name: string): any => ({ // eslint-disable-line @typescript-eslint/no-explicit-any -- controlled browser double
    fill: async () => {}, selectOption: async () => {}, waitFor: async () => {}, click: async () => { actions.push(name); }, getAttribute: async () => "/dashboard/videos/11111111-1111-4111-8111-111111111111",
  });
  const c = {
    page: { url: () => "https://atomivid.vercel.app/dashboard/new?formato=reel", getByLabel: el, getByTestId: el, getByRole: (_: string, o: { name: string }) => el(o.name), waitForURL: async () => {} },
    jobId: "ms-fixture", real, runCapUsd: 1.5, goto: async () => ({ httpStatus: 200 }), killSwitch: () => true, readReelCap: async () => cap,
    step: async (_: string, fn: () => Promise<{ state: string; detail: string }>) => { const r = await fn(); steps.push(r); return r; },
    ledger: { stopped: async () => stopped, state: async () => ({ reservations: [], settlements: [] }), reserve: async () => { actions.push("reserve"); return { ok: false, reason: "fixture reservation rejected" }; } },
  } as unknown as RealCtx;
  return { c, actions, steps };
}
test("Reel browser double: free mode configures without creating or reserving", async () => {
  const f = fixture(false, 1.5); await runReelReal(f.c);
  assert.deepEqual(f.actions, ["30s"]); assert.equal(f.steps.at(-1)?.state, "BLOCKED");
});
test("Reel browser double: missing or excessive persisted cap cannot reach any paid button", async () => {
  for (const cap of [null, 0, Infinity, 1.5001]) {
    const f = fixture(true, cap); await runReelReal(f.c);
    assert.deepEqual(f.actions, ["30s", "Crear solicitud"]); assert.equal(f.steps.at(-1)?.state, "BLOCKED");
  }
});
test("Reel browser double: STOP and rejected reservation prevent script and render", async () => {
  for (const stopped of [true, false]) {
    const f = fixture(true, 1.5, stopped); await runReelReal(f.c);
    assert.ok(!f.actions.includes("Generar guion")); assert.ok(!f.actions.includes("Generar video final")); assert.equal(f.steps.at(-1)?.state, "BLOCKED");
  }
});

test("adding real Reel preserves the existing default navigation mission", () => {
  assert.equal(defaultCatalog().missions[0].id, "cuenta-navegacion");
  assert.equal(defaultCatalog().missions.filter(m => m.id === "reels-real").length, 1);
});
