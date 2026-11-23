/**
 * Nazca (23-11-2026): documental de 20 min con estimación conservadora de USD 12,22. Con el techo de producto de USD 12
 * no podía confirmarse; Hans autorizó un techo total de USD 20. Pure checks: sin proveedor, sin red, sin base de datos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getLongFormBudget, DEFAULT_LONG_FORM_BUDGET } from "./cost";
import { authorizeRequestBudget, memoryAuthorizationStore } from "./request-budget";
import { PILOT_COST_STAGES, type PilotStageEstimate } from "./pilot-budget-envelope";

// Reparto realista del subtotal 12,22: guion ya gastado + voz de ~17 min + imágenes + render peor caso.
const nazca: Partial<Record<(typeof PILOT_COST_STAGES)[number], number>> = { script: 1.5, voice: 4.2, images: 2.4, video: 0, music: 0, render: 4.12 };
const stages = (): PilotStageEstimate[] =>
  PILOT_COST_STAGES.map((stage) => ({ stage, ceilingUsd: nazca[stage] ?? 0, retryPolicy: "reuse_paid_results" as const }));

test("techo de producto: 20 por defecto, y LONG_FORM_MAX_TOTAL_USD lo sigue sobrescribiendo", () => {
  assert.equal(DEFAULT_LONG_FORM_BUDGET.maxTotalUsd, 20);
  assert.equal(getLongFormBudget({}).maxTotalUsd, 20);
  assert.equal(getLongFormBudget({ LONG_FORM_MAX_TOTAL_USD: "12" }).maxTotalUsd, 12);
});

test("Nazca: subtotal 12,22 se rechazaba con 12 y se autoriza con 20, con techo de servidor ≤ 20", async () => {
  await assert.rejects(authorizeRequestBudget({ requestId: "nazca-12", stages: stages(), hardMaxUsd: 12, ledgerScopes: ["nazca-12"], store: memoryAuthorizationStore() }),
    /subtotal_exceeds_ceiling:12\.22>12\.00|no autoriz|presupuesto/i);
  const auth = await authorizeRequestBudget({ requestId: "nazca", stages: stages(), hardMaxUsd: getLongFormBudget({}).maxTotalUsd, ledgerScopes: ["nazca"], store: memoryAuthorizationStore() });
  assert.ok(auth.ceilingUsd >= 12.22 && auth.ceilingUsd <= 20, `techo ${auth.ceilingUsd}`);
});

test("una autorización guardada nunca se amplía: el reintento respeta el techo original aunque el producto suba a 20", async () => {
  const store = memoryAuthorizationStore();
  const first = await authorizeRequestBudget({ requestId: "r", stages: stages(), hardMaxUsd: 20, ledgerScopes: ["r"], store });
  const bigger = stages().map((s) => (s.stage === "images" ? { ...s, ceilingUsd: 6 } : s));
  const retry = await authorizeRequestBudget({ requestId: "r", stages: bigger, hardMaxUsd: 20, ledgerScopes: ["r"], store });
  assert.equal(retry.ceilingUsd, first.ceilingUsd);
});
