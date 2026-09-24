import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRealRunResponse } from "./visual-test-v2-real-display";

test("summarizeRealRunResponse: 200 con resultado completo se mapea a kind:'result'", () => {
  const result = summarizeRealRunResponse(200, {
    videoId: "gobekli-tepe-001",
    shots: [
      { shotId: "b1-s4", status: "generated", costUsd: 0.05, storagePath: "long-form/gobekli-tepe-001/visual-test-v2/b1-s4-x.png" },
      { shotId: "b4-s2", status: "reused", costUsd: 0, storagePath: "long-form/gobekli-tepe-001/visual-test-v2/b4-s2-y.png" },
      { shotId: "b8-s5", status: "generated", costUsd: 0.05, storagePath: "long-form/gobekli-tepe-001/visual-test-v2/b8-s5-z.png" },
    ],
    totalSpentThisRunUsd: 0.1,
    ledgerTotalSpentUsd: 0.1,
    ledgerVisualTestV2SpentUsd: 0.1,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    paidApisCalled: true,
  });
  assert.equal(result.kind, "result");
  if (result.kind !== "result") return;
  assert.equal(result.shots.length, 3);
  assert.equal(result.shots[0].status, "generated");
  assert.equal(result.shots[1].status, "reused");
  assert.equal(result.totalSpentThisRunUsd, 0.1);
  assert.equal(result.paidApisCalled, true);
});

test("summarizeRealRunResponse: 401/403/400/402/409/502 se mapean a kind:'error' con el mensaje del backend", () => {
  for (const status of [401, 403, 400, 402, 409, 502]) {
    const result = summarizeRealRunResponse(status, { error: "mensaje seguro" });
    assert.equal(result.kind, "error");
    if (result.kind !== "error") continue;
    assert.equal(result.httpStatus, status);
    assert.equal(result.message, "mensaje seguro");
  }
});

test("summarizeRealRunResponse: error sin campo 'error' válido cae a mensaje genérico seguro", () => {
  const result = summarizeRealRunResponse(500, {});
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.ok(result.message.length > 0);
});

test("summarizeRealRunResponse: body null/no-objeto en cualquier status nunca lanza", () => {
  assert.doesNotThrow(() => summarizeRealRunResponse(500, null));
  assert.doesNotThrow(() => summarizeRealRunResponse(200, null));
  assert.doesNotThrow(() => summarizeRealRunResponse(200, "no es un objeto"));
  assert.doesNotThrow(() => summarizeRealRunResponse(200, undefined));
});

test("summarizeRealRunResponse: un campo inesperado con apariencia de secreto en el body NUNCA aparece en el resultado", () => {
  const result = summarizeRealRunResponse(200, {
    shots: [],
    totalSpentThisRunUsd: 0,
    ledgerTotalSpentUsd: 0,
    ledgerVisualTestV2SpentUsd: 0,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    paidApisCalled: false,
    OPENAI_API_KEY: "sk-esto-nunca-deberia-verse-en-la-ui",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sk-esto-nunca-deberia-verse-en-la-ui"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
});

test("summarizeRealRunResponse: shots con entradas mal formadas no rompe — usa valores por defecto seguros", () => {
  const result = summarizeRealRunResponse(200, {
    shots: [null, {}, { shotId: 123, status: "algo-raro", costUsd: "gratis" }],
    totalSpentThisRunUsd: 0,
    ledgerTotalSpentUsd: 0,
    ledgerVisualTestV2SpentUsd: 0,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    paidApisCalled: false,
  });
  assert.equal(result.kind, "result");
  if (result.kind !== "result") return;
  assert.equal(result.shots.length, 3);
  for (const shot of result.shots) {
    assert.equal(typeof shot.shotId, "string");
    assert.ok(["reused", "generated", "unknown"].includes(shot.status));
    assert.equal(typeof shot.costUsd, "number");
  }
});
