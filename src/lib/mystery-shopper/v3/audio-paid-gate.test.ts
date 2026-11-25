import test from "node:test";
import assert from "node:assert/strict";
import { runAudioReal, AUDIO_VARIANTS, qaScript, type RealCtx } from "../../../../scripts/mystery-shopper/real-missions";
function scenario(stopAfterReservation: boolean) {
  const actions: string[] = []; const steps: { name: string; state: string }[] = [];
  let reserved = false;
  const el = (id: string): any => ({ // eslint-disable-line @typescript-eslint/no-explicit-any -- controlled browser double
    first() { return this; }, locator() { return this; }, fill: async () => {}, selectOption: async () => {},
    check: async () => { actions.push(`check:${id}`); }, click: async () => { actions.push(`click:${id}`); },
    isVisible: async () => true, isEnabled: async () => true, isDisabled: async () => true,
    innerText: async () => id === "audio-authorize-usd" ? "USD 1.00" : id === "audio-estimated-usd" ? "USD 0.50" : "Audio Podcast",
    allInnerTexts: async () => [],
  });
  const page = { url: () => "https://atomivid.vercel.app/dashboard/audio-studio/11111111-1111-4111-8111-111111111111", locator: el, getByLabel: el, getByTestId: el, getByRole: el, waitForResponse: async () => ({ ok: () => true, json: async () => ({ generation: { status: "inactiva" } }) }), waitForURL: async () => {}, waitForFunction: async () => {} };
  const ctx = {
    page, jobId: "ms-test", baseUrl: "https://atomivid.vercel.app", real: true, out: "/tmp", media: [], incidents: [],
    step: async (name: string, fn: () => Promise<{ state: string; detail: string }>) => { const r = await fn(); steps.push({ name, state: r.state }); return r; },
    goto: async () => ({ httpStatus: 200 }), mark: () => {}, cIdx: () => 0, metrics: async () => ({}), act: () => {}, sleep: async () => {}, setCritical: () => {}, setHumanGate: () => {}, addSpend: () => {},
    readAudioProject: async () => ({ script: qaScript("es", 2), voiceCount: 2, targetMinutes: 5, budgetUsd: 1, voices: AUDIO_VARIANTS["audio-real-es"].voiceIds, spentUsd: 0 }),
    readAudioSynthesis: async () => "real", killSwitch: () => stopAfterReservation, runCapUsd: 1,
    ledger: { state: async () => ({ reservations: [], settlements: [] }), stopped: async () => reserved && stopAfterReservation, reserve: async () => { reserved = true; actions.push("reserve"); return { ok: true, reason: "fixture" }; }, settle: async () => { actions.push("settle"); } },
  } as unknown as RealCtx;
  return { ctx, actions, steps };
}
test("Audio real: interruptor apagado impide reserva y clic pagado", async () => {
  const s = scenario(false); await runAudioReal(s.ctx, AUDIO_VARIANTS["audio-real-es"]);
  assert.ok(!s.actions.includes("reserve")); assert.ok(!s.actions.includes("check:audio-authorize")); assert.ok(!s.actions.includes("click:audio-generate"));
  assert.equal(s.steps.at(-1)?.state, "BLOCKED");
});
test("Audio real: STOP posterior a reserva impide generar sin liberar ni liquidar la reserva", async () => {
  const s = scenario(true); await runAudioReal(s.ctx, AUDIO_VARIANTS["audio-real-es"]);
  assert.ok(s.actions.includes("reserve")); assert.ok(!s.actions.includes("check:audio-authorize")); assert.ok(!s.actions.includes("click:audio-generate")); assert.ok(!s.actions.includes("settle"));
  assert.equal(s.steps.at(-1)?.state, "BLOCKED");
});

test("Audio comercial: demo/local/inactiva o catálogo ausente bloquean antes de crear episodios", async () => {
  for (const mode of ["demo", "local", "inactiva", null]) {
    const s = scenario(true); s.ctx.readAudioSynthesis = async () => mode;
    await runAudioReal(s.ctx, AUDIO_VARIANTS["audio-real-es"]);
    assert.deepEqual(s.actions, []); assert.equal(s.steps.length, 1); assert.equal(s.steps[0].state, "BLOCKED");
  }
});

test("Audio: stale/default saved configuration cannot pass or reserve money", async () => {
  const s = scenario(true); s.ctx.readAudioProject = async () => ({ script: "", voiceCount: 1, targetMinutes: 10, budgetUsd: 6 });
  await runAudioReal(s.ctx, AUDIO_VARIANTS["audio-real-es"]);
  assert.equal(s.steps.at(-1)?.state, "FAIL"); assert.ok(!s.actions.includes("reserve"));
});
