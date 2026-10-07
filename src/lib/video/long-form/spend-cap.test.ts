import { test } from "node:test";
import assert from "node:assert/strict";
import { conservativeUnits, conservativeWorstCaseUsd, productionHardCap, SpendCapExceededError } from "./spend-cap";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { getVideoProvider } from "@/lib/providers/video-gen";

// Gucci cinematic v3 as confirmed: 5,164 characters, 40 image generations
// (39 shots + 1 reference), 1 Runway clip (10 s, 50 credits); plan units 0.05 / 0.50.
const GUCCI = { voiceCharacters: 5164, allocation: { maxAiImageGenerations: 40, maxAiVideoClips: 1, maxGenerativeUsd: 2.5 } };
const ESTIMATES = { imageUsd: 0.05, clipUsd: 0.5, voiceUsdPer1kChars: 0.2 };
const LEDGER_MAX = { imageUsd: 0.056 }; // highest real OpenAI image bill on record
const AUTHORIZED_USD = 4.0;

async function gucciBudget(ceiling = 12) {
  const units = conservativeUnits(ESTIMATES, LEDGER_MAX);
  const cap = productionHardCap(conservativeWorstCaseUsd(GUCCI, units), ceiling);
  const store = memoryBudgetStore();
  const budget = await ProductionBudget.open(store, GUCCI.allocation, { capUsd: cap, fixedUsd: (GUCCI.voiceCharacters / 1000) * units.voiceUsdPer1kChars });
  return { units, cap, store, budget };
}

test("conservative prices are never below the estimate nor the highest real bill", () => {
  const u = conservativeUnits(ESTIMATES, LEDGER_MAX);
  assert.equal(u.imageUsd, 0.06);
  assert.equal(u.clipUsd, 0.5);
  assert.equal(conservativeUnits({ ...ESTIMATES, imageUsd: 0.07 }, LEDGER_MAX).imageUsd, 0.07);
});

test("Gucci worst case is computed BEFORE execution and is below the USD 4.00 authorization", async () => {
  const { cap } = await gucciBudget();
  // 5,164 × 0.20/1k + 40 × 0.06 + 1 × 0.50 = 1.0328 + 2.40 + 0.50 → 3.94
  assert.equal(cap, 3.94);
  assert.ok(cap <= AUTHORIZED_USD);
  assert.throws(() => productionHardCap(cap, 3.5), SpendCapExceededError, "a lower ceiling refuses the plan before any call");
});

test("Gucci simulated end to end: every call re-checks committed spend; total stays within the cap", async () => {
  const { units, cap, budget, store } = await gucciBudget();
  let billed = (GUCCI.voiceCharacters / 1000) * 0.2;
  for (let i = 0; i < 40; i++) {
    assert.equal(await budget.reserveAiImage(0.05, units.imageUsd), true, `image ${i + 1} admitted`);
    await budget.settle(units.imageUsd, 0.0558);
    billed += 0.0558;
  }
  assert.equal(await budget.reserveAiVideoSubmit(0.5, units.clipUsd), true);
  billed += 0.5;
  assert.equal(await budget.reserveAiImage(0.05, units.imageUsd), false, "41st image refused before sending");
  assert.equal(await budget.reserveAiVideoSubmit(0.5, units.clipUsd), false, "2nd clip refused before sending");
  const s = store.current()!;
  assert.ok(Math.abs(s.hardCap!.fixedUsd + s.used.spentUsd! - billed) < 1e-9);
  assert.ok(billed <= cap && cap <= AUTHORIZED_USD, `billed ${billed.toFixed(4)} ≤ cap ${cap}`);
});

test("bills above the reservation are counted in full and the next call is refused before it is sent", async () => {
  const { units, cap, budget, store } = await gucciBudget();
  let admitted = 0;
  // Every image unexpectedly bills 0.12 (double the conservative price).
  while (await budget.reserveAiImage(0.05, units.imageUsd)) { admitted++; await budget.settle(units.imageUsd, 0.12); }
  const s = store.current()!;
  const total = s.hardCap!.fixedUsd + s.used.spentUsd!;
  assert.ok(admitted < 40, `stopped early at ${admitted}`);
  // Only the last admitted call can exceed its reservation; it is bounded by one bill.
  assert.ok(total <= cap + (0.12 - units.imageUsd) + 1e-9, `total ${total} cap ${cap}`);
  assert.ok(total <= AUTHORIZED_USD);
});

test("concurrent shots cannot pass the same headroom", async () => {
  const { units, budget, store } = await gucciBudget();
  const results = await Promise.all(Array.from({ length: 200 }, () => budget.reserveAiImage(0.05, units.imageUsd)));
  assert.equal(results.filter(Boolean).length, 40);
  const s = store.current()!;
  assert.ok(s.hardCap!.fixedUsd + s.used.spentUsd! <= s.hardCap!.capUsd + 1e-9);
});

test("uncertain calls keep their reservation; a new attempt reopens with spend kept and the cap never widened", async () => {
  const { units, store, cap } = await gucciBudget();
  const first = await ProductionBudget.open(store, GUCCI.allocation, { capUsd: cap, fixedUsd: 1.0328 });
  for (let i = 0; i < 10; i++) await first.reserveAiImage(0.05, units.imageUsd); // no settle, no release: uncertain
  const reopened = await ProductionBudget.open(store, GUCCI.allocation, { capUsd: 9, fixedUsd: 1.0328 });
  const s = reopened.snapshot();
  assert.equal(s.hardCap!.capUsd, cap, "a later attempt cannot raise the cap");
  assert.ok(Math.abs(s.used.spentUsd! - 10 * units.imageUsd) < 1e-9, "uncertain reservations still count");
  let more = 0;
  while (await reopened.reserveAiImage(0.05, units.imageUsd)) more++;
  assert.equal(more, 30, "only the remaining confirmed images");
});

test("Runway is resolved for a plan pinned to Runway even when VIDEO_PROVIDER=veo (render.yml)", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { VIDEO_PROVIDER: "veo", PREMIUM_CLIPS_ENABLED: "true", RUNWAY_API_KEY: "test-key", VEO_API_KEY: "test-key" });
    assert.equal(getVideoProvider("runway").name, "runway", "the confirmed plan's provider wins");
    assert.equal(getVideoProvider().name, "veo", "the env default only applies without a pinned provider");
    delete process.env.RUNWAY_API_KEY;
    assert.notEqual(getVideoProvider("runway").name, "veo", "never silently substituted by Veo");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
