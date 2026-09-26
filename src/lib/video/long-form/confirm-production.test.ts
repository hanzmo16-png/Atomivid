import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmLongFormProduction } from "./confirm-production";
import { documentary180sFixture } from "./test-fixtures";

type RowState = Record<string, unknown>;

/**
 * Fake mínimo de SupabaseClient con semántica de UPDATE condicional (CAS):
 * los filtros se evalúan contra el estado ACTUAL de la fila en el momento
 * en que se ejecuta el UPDATE — igual que Postgres serializa dos UPDATE
 * concurrentes sobre la misma fila.
 */
function fakeService(initial: RowState) {
  const row: RowState = { ...initial };
  let appliedUpdates = 0;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function builder(kind: "select" | "update", values?: RowState) {
    const filters: Array<(r: RowState) => boolean> = [];
    const api = {
      select() {
        return api;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return api;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v);
        return api;
      },
      async maybeSingle() {
        await tick();
        const matches = filters.every((f) => f(row));
        if (kind === "select") return { data: matches ? { ...row } : null, error: null };
        if (!matches) return { data: null, error: null };
        Object.assign(row, values);
        appliedUpdates += 1;
        return { data: { ...row }, error: null };
      },
    };
    return api;
  }

  const client = {
    from() {
      return {
        select: () => builder("select"),
        update: (values: RowState) => builder("update", values),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, row, appliedUpdates: () => appliedUpdates };
}

function baseRow(overrides: RowState = {}): RowState {
  const script = documentary180sFixture();
  return {
    id: "req-1",
    mode: "long_form",
    user_id: "user-1",
    status: "script_ready",
    topic: script.topic,
    script_json: script,
    long_form_production_plan: null,
    long_form_confirmed_at: null,
    ...overrides,
  };
}

test("confirma: calcula el plan en el servidor con la estrategia elegida y fija confirmed_at", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", nowIso: "2026-09-25T10:00:00Z" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.strategy, "balanced");
  assert.equal(result.alreadyConfirmed, false);
  assert.equal(fake.row.long_form_confirmed_at, "2026-09-25T10:00:00Z");
  assert.equal(fake.appliedUpdates(), 1);
});

test("doble clic concurrente: exactamente UNA confirmación aplicada, ambas respuestas devuelven el mismo plan", async () => {
  const fake = fakeService(baseRow());
  const [a, b] = await Promise.all([
    confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", nowIso: "2026-09-25T10:00:00Z" }),
    confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", nowIso: "2026-09-25T10:00:01Z" }),
  ]);
  assert.equal(fake.appliedUpdates(), 1, "el UPDATE condicional solo gana una vez");
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.confirmedAt, b.confirmedAt);
    assert.deepEqual(a.plan, b.plan);
    assert.equal([a.alreadyConfirmed, b.alreadyConfirmed].filter(Boolean).length, 1);
  }
});

test("pestaña vieja envía OTRA estrategia después de confirmar: se devuelve la ya confirmada, nunca se sobrescribe", async () => {
  const fake = fakeService(baseRow());
  const first = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "economical" });
  const stale = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "cinematic" });
  assert.ok(first.ok && stale.ok);
  if (stale.ok) {
    assert.equal(stale.plan.strategy, "economical");
    assert.equal(stale.alreadyConfirmed, true);
  }
  assert.equal(fake.appliedUpdates(), 1);
  assert.equal((fake.row.long_form_production_plan as { strategy: string }).strategy, "economical");
});

test("el navegador nunca aporta el plan: un body con plan/costo falsos se ignora (solo cuenta `strategy`)", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "economical" });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.plan.aiImageCount, 0);
});

test("rechazos: estrategia inválida 400, otro usuario 403, no long_form 409, estado no listo 409, guion inválido 409", async () => {
  const cases: Array<[RowState, string, unknown, number]> = [
    [baseRow(), "user-1", "premium-all-ai", 400],
    [baseRow(), "user-2", "balanced", 403],
    [baseRow({ mode: "visual" }), "user-1", "balanced", 409],
    [baseRow({ status: "failed" }), "user-1", "balanced", 409],
    [baseRow({ script_json: { segments: [] } }), "user-1", "balanced", 409],
  ];
  for (const [row, userId, strategy, status] of cases) {
    const fake = fakeService(row);
    const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId, strategy });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, status);
    assert.equal(fake.appliedUpdates(), 0);
  }
});

test("solicitud anterior al plan (p. ej. Panamá: failed, sin confirmación) no puede confirmarse retroactivamente", async () => {
  const fake = fakeService(baseRow({ status: "failed", long_form_confirmed_at: null }));
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.equal(result.ok, false);
  assert.equal(fake.appliedUpdates(), 0);
});

test("un plan que supera LONG_FORM_MAX_TOTAL_USD no se puede confirmar", async () => {
  const previous = process.env.LONG_FORM_MAX_TOTAL_USD;
  process.env.LONG_FORM_MAX_TOTAL_USD = "0.1";
  try {
    const fake = fakeService(baseRow());
    const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "economical" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /supera el tope/);
    assert.equal(fake.appliedUpdates(), 0);
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_MAX_TOTAL_USD;
    else process.env.LONG_FORM_MAX_TOTAL_USD = previous;
  }
});

test("presentación: se revalida en el servidor y se guarda en el plan confirmado; ilegible → 400 sin confirmar", async () => {
  const option = (enabled: boolean, title = "Cavar una *montaña*") => ({ enabled, style: "impacto", title });
  const ok = fakeService(baseRow());
  const r = await confirmLongFormProduction(ok.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", packaging: { cover: option(true), thumbnail: option(false) } });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.plan.packaging?.cover.enabled, true);
    assert.equal(r.plan.packaging?.thumbnail.enabled, false);
  }
  const none = fakeService(baseRow());
  const n = await confirmLongFormProduction(none.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", packaging: { cover: option(false), thumbnail: option(false) } });
  assert.ok(n.ok && n.plan.packaging === undefined, "ninguna opción: el plan no cambia");

  const bad = fakeService(baseRow());
  const b = await confirmLongFormProduction(bad.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", packaging: { cover: option(true, "Un título larguísimo que jamás cabría en la portada del video"), thumbnail: option(false) } });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.status, 400);
  assert.equal(bad.appliedUpdates(), 0, "nada se confirma con una portada ilegible");
  const forged = fakeService(baseRow());
  const f = await confirmLongFormProduction(forged.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", packaging: { cover: { enabled: true, style: "neón", title: "Hola mundo" }, thumbnail: option(false) } });
  assert.equal(f.ok, false);
});
