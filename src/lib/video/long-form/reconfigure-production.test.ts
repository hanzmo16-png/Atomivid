import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaidOperation } from "@/lib/production-intelligence/ledger";
import { encodeStoredFailure } from "@/lib/video/failure-action";
import { LongFormMaterialUnavailableError } from "./material-preflight";
import type { ProductionBudgetState } from "./production-budget";
import { isMaterialUnavailableFailure, reopenLongFormAfterMaterialGap, type ReconfigureDeps } from "./reconfigure-production";

/**
 * Reconfiguración tras un impedimento de material SIN gasto (2026-10-28). Fake de Supabase con UPDATE condicional
 * (los filtros se evalúan contra la fila actual, como Postgres). Sin red.
 */
globalThis.fetch = (async () => { throw new Error("red prohibida"); }) as typeof fetch;

type RowState = Record<string, unknown>;

function fakeService(initial: RowState) {
  const row: RowState = { ...initial };
  let updates = 0;
  function builder(kind: "select" | "update", values?: RowState) {
    const filters: Array<(r: RowState) => boolean> = [];
    const api = {
      select() { return api; },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return api; },
      async maybeSingle() {
        await new Promise((r) => setTimeout(r, 0));
        const matches = filters.every((f) => f(row));
        if (kind === "select") return { data: matches ? { ...row } : null, error: null };
        if (!matches) return { data: null, error: null };
        Object.assign(row, values);
        updates += 1;
        return { data: { ...row }, error: null };
      },
    };
    return api;
  }
  const client = { from: () => ({ select: () => builder("select"), update: (v: RowState) => builder("update", v) }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, row, updates: () => updates };
}

const MATERIAL_ERROR = `${new LongFormMaterialUnavailableError([{ shotId: "beat-1-shot-1", plannedType: "stock_video", status: "nonexistent", reason: "no existe material pertinente y único" }]).message} (Código: abc123)`;

function failedRow(overrides: RowState = {}): RowState {
  return {
    id: "req-1", mode: "long_form", user_id: "owner", status: "failed", error_message: MATERIAL_ERROR,
    long_form_confirmed_at: "2026-10-28T10:00:00Z", long_form_production_plan: { version: 3, strategy: "economical" },
    script_json: { topic: "Un día en la sabana africana", beats: [] }, reel_image_source: null, ...overrides,
  };
}

const unusedBudget: ProductionBudgetState = {
  version: 1, allocation: { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 },
  used: { aiImageGenerations: 0, aiVideoSubmits: 0, generativeUsd: 0, spentUsd: 0 }, deviations: [], updatedAtIso: "2026-10-28T10:01:00Z",
};

function deps(over: Partial<{ ops: PaidOperation[]; budget: ProductionBudgetState | null; authorized: boolean }> = {}) {
  const removed: string[] = [];
  const d: ReconfigureDeps = {
    listOperations: async () => over.ops ?? [],
    loadBudget: async () => (over.budget === undefined ? unusedBudget : over.budget),
    removeBudget: async (id) => { removed.push(id); },
    authorizationExists: async () => over.authorized ?? false,
  };
  return { d, removed };
}

const op = (o: Partial<PaidOperation>): PaidOperation => ({
  idempotencyKey: "op_1", projectId: "req-1", shotId: "beat-1", provider: "elevenlabs", model: "m", method: "tts", attemptKind: "first",
  reservedUsd: 0.12, committedUsd: null, status: "RESERVED", providerJobId: null, resultRef: null, updatedAt: "2026-10-28T10:01:00Z", ...o,
});

test("permitido: fallo de material con USD 0 → vuelve a script_ready, sin plan ni confirmación; guion intacto; idempotente", async () => {
  const fake = fakeService(failedRow());
  const { d, removed } = deps();
  const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, d);
  assert.deepEqual(result, { ok: true, alreadyReopened: false });
  assert.equal(fake.row.status, "script_ready");
  assert.equal(fake.row.long_form_confirmed_at, null);
  assert.equal(fake.row.long_form_production_plan, null);
  assert.equal(fake.row.error_message, null);
  assert.deepEqual(fake.row.script_json, { topic: "Un día en la sabana africana", beats: [] });
  assert.deepEqual(removed, ["req-1"], "el presupuesto sin uso (allocation anterior) se retira para no recortar el nuevo plan");
  const again = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, d);
  assert.deepEqual(again, { ok: true, alreadyReopened: true });
  assert.equal(fake.updates(), 1);
});

test("doble clic concurrente: una sola transición", async () => {
  const fake = fakeService(failedRow());
  const [a, b] = await Promise.all([
    reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, deps().d),
    reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, deps().d),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(fake.updates(), 1);
  if (a.ok && b.ok) assert.equal([a.alreadyReopened, b.alreadyReopened].filter(Boolean).length, 1);
});

test("rechazado: cualquier gasto de producción registrado (abierto, comprometido o con importe)", async () => {
  for (const ops of [[op({ status: "RESERVED" })], [op({ status: "COMMITTED", committedUsd: 0.12 })], [op({ status: "RECONCILIATION_REQUIRED" })]]) {
    const fake = fakeService(failedRow());
    const { d, removed } = deps({ ops });
    const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, d);
    assert.ok(!result.ok && result.status === 409, JSON.stringify(result));
    assert.equal(fake.row.status, "failed");
    assert.equal(fake.row.long_form_confirmed_at, "2026-10-28T10:00:00Z");
    assert.equal(fake.updates(), 0);
    assert.deepEqual(removed, []);
  }
});

test("rechazado: presupuesto de producción con uso, o autorización total ya creada", async () => {
  const used = { ...unusedBudget, used: { ...unusedBudget.used, spentUsd: 0.05 } };
  for (const over of [{ budget: used }, { authorized: true }]) {
    const fake = fakeService(failedRow());
    const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, deps(over).d);
    assert.ok(!result.ok && result.status === 409);
    assert.equal(fake.updates(), 0);
  }
});

test("el guion pagado (otro alcance del ledger) no cuenta como gasto de producción", async () => {
  const fake = fakeService(failedRow());
  const script = op({ provider: "anthropic", method: "generate_script", status: "COMMITTED", committedUsd: 0.4 });
  const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, deps({ ops: [script] }).d);
  assert.ok(result.ok);
});

test("rechazado: otros errores, otros estados o sin plan confirmado", async () => {
  for (const over of [
    { error_message: "Error temporal del proveedor de voz (Código: x)" },
    { error_message: encodeStoredFailure(MATERIAL_ERROR, "support") },
    { error_message: "No se pudo comprobar el material (error temporal del proveedor de stock en 3 escena(s))" },
    { status: "processing" },
    { status: "completed" },
    { long_form_confirmed_at: null },
  ]) {
    const fake = fakeService(failedRow(over));
    const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" }, deps().d);
    assert.ok(!result.ok && result.status === 409, `${JSON.stringify(over)} → ${JSON.stringify(result)}`);
    assert.equal(fake.updates(), 0);
  }
});

test("rechazado: otro usuario (403), otra modalidad (409) o Recraft fijado", async () => {
  const stranger = fakeService(failedRow());
  const r1 = await reopenLongFormAfterMaterialGap(stranger.client, { requestId: "req-1", userId: "intruso" }, deps().d);
  assert.ok(!r1.ok && r1.status === 403);
  assert.equal(stranger.row.status, "failed");
  const reel = fakeService(failedRow({ mode: "visual" }));
  const r2 = await reopenLongFormAfterMaterialGap(reel.client, { requestId: "req-1", userId: "owner" }, deps().d);
  assert.ok(!r2.ok && r2.status === 409);
  const recraft = fakeService(failedRow({ reel_image_source: "recraft" }));
  const r3 = await reopenLongFormAfterMaterialGap(recraft.client, { requestId: "req-1", userId: "owner" }, deps().d);
  assert.ok(!r3.ok && r3.status === 409);
  assert.equal(stranger.updates() + reel.updates() + recraft.updates(), 0);
});

test("ledger ilegible: no se cambia nada (503)", async () => {
  const fake = fakeService(failedRow());
  const result = await reopenLongFormAfterMaterialGap(fake.client, { requestId: "req-1", userId: "owner" },
    { ...deps().d, listOperations: async () => { throw new Error("db down"); } });
  assert.ok(!result.ok && result.status === 503);
  assert.equal(fake.updates(), 0);
});

test("isMaterialUnavailableFailure reconoce solo el impedimento de material", () => {
  assert.equal(isMaterialUnavailableFailure(MATERIAL_ERROR), true);
  assert.equal(isMaterialUnavailableFailure(null), false);
  assert.equal(isMaterialUnavailableFailure("No se pudo comprobar el material"), false);
});
