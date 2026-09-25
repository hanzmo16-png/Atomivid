import { test } from "node:test";
import assert from "node:assert/strict";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";

const ALLOCATION = { maxAiImageGenerations: 2, maxAiVideoClips: 1, maxGenerativeUsd: 1.1 };

test("reserva write-ahead: se persiste ANTES de devolver true, y nunca excede la allocation", async () => {
  const store = memoryBudgetStore();
  const budget = await ProductionBudget.open(store, ALLOCATION);
  assert.equal(await budget.reserveAiImage(0.05), true);
  assert.equal(store.current()?.used.aiImageGenerations, 1, "persistido antes de la llamada pagada");
  assert.equal(await budget.reserveAiImage(0.05), true);
  assert.equal(await budget.reserveAiImage(0.05), false, "tope de imágenes");
  assert.equal(await budget.reserveAiVideoSubmit(0.96), true);
  assert.equal(await budget.reserveAiVideoSubmit(0.96), false, "tope de clips");
});

test("tope USD: una reserva que excedería maxGenerativeUsd se rechaza aunque haya cupo de cantidad", async () => {
  const budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 10, maxAiVideoClips: 10, maxGenerativeUsd: 1 });
  assert.equal(await budget.reserveAiVideoSubmit(0.96), true);
  assert.equal(await budget.reserveAiImage(0.05), false);
});

test("durable entre intentos: un reintento hereda lo consumido y nunca amplía la allocation", async () => {
  const store = memoryBudgetStore();
  const first = await ProductionBudget.open(store, ALLOCATION);
  await first.reserveAiImage(0.05);
  await first.reserveAiImage(0.05);
  const retry = await ProductionBudget.open(store, { ...ALLOCATION, maxAiImageGenerations: 50 });
  assert.equal(await retry.reserveAiImage(0.05), false, "la allocation vigente es el mínimo, nunca se amplía");
  assert.equal(retry.snapshot().allocation.maxAiImageGenerations, 2);
});

test("release solo devuelve cupo de un fallo con costo cero conocido; deviaciones quedan persistidas", async () => {
  const store = memoryBudgetStore();
  const budget = await ProductionBudget.open(store, ALLOCATION);
  await budget.reserveAiImage(0.05);
  await budget.releaseAiImage(0.05);
  assert.equal(store.current()?.used.aiImageGenerations, 0);
  await budget.recordDeviation({ shotId: "s1", planned: "ai_video", executed: "generated_placeholder", reason: "Veo terminal" });
  assert.equal(store.current()?.deviations.length, 1);
  assert.equal(store.current()?.deviations[0].reason, "Veo terminal");
});
