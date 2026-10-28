import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmLongFormProduction } from "./confirm-production";
import { documentary180sFixture } from "./test-fixtures";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { editorialScriptHash } from "./editorial";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";

type RowState = Record<string, unknown>;

/**
 * P0 T-20261019-1553: el fixture del Canal narra «El 15 de agosto de 1914 …» con visuales de stock, que la
 * ruta v3 ahora rechaza (dated-event-preflight.ts). Estas pruebas miden la confirmación (CAS, estrategia,
 * presentación), no la veracidad: usan el mismo guion con la fecha generalizada. El caso fechado se prueba aparte.
 */
function undatedDocumentary() {
  const script = documentary180sFixture();
  return { ...script, beats: script.beats.map((b) => ({ ...b, narration: b.narration.replace("El 15 de agosto de 1914", "En agosto de 1914") })) };
}

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
    from(table?: string) {
      if (table === "documentary_script_jobs") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      if (table === "pi_paid_operations") {
        const chain = {
          eq() { return chain; },
          order() { return chain; },
          limit: async () => ({ data: [], error: null }),
          in: async () => ({ data: [], error: null }),
        };
        return { select: () => chain };
      }
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
  const script = undatedDocumentary();
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

test("editorial approval is checked before confirmation or reuse of a confirmed plan", async () => {
  const generated = editorialFixture();
  const script = { topic: "A legend examined", beats: generated.beats.map((b, i) => ({ id: `beat-${i}`, ...b })),
    editorial: { version: "editorial-v1", status: "approved", scriptHash: editorialScriptHash(generated.beats),
      storyPlan: generated.storyPlan, reviews: [passingReview(generated)], corrected: false, model: "fixture" } };
  const good = fakeService(baseRow({ script_json: script }));
  assert.equal((await confirmLongFormProduction(good.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" })).ok, true);
  script.beats[0].narration += " A change after approval.";
  for (const confirmed of [false, true]) {
    const bad = fakeService(baseRow({ script_json: script,
      long_form_confirmed_at: confirmed ? good.row.long_form_confirmed_at : null,
      long_form_production_plan: confirmed ? good.row.long_form_production_plan : null }));
    const result = await confirmLongFormProduction(bad.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cambió/);
    assert.equal(bad.appliedUpdates(), 0);
  }
});

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

test("el estimado de proveedores cabe y el worker no: guion ya gastado + render se rechazan antes de fijar el plan", async () => {
  const previous = process.env.LONG_FORM_MAX_TOTAL_USD;
  delete process.env.LONG_FORM_MAX_TOTAL_USD;
  try {
    const fake = fakeService(baseRow());
    const result = await confirmLongFormProduction(fake.client, {
      requestId: "req-1", userId: "user-1", strategy: "economical",
      budgetFacts: { scriptSpentUsd: 11, observed: {} },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.match(result.error, /supera el tope/);
      assert.match(result.error, /guion ya gastado \$11\.00/);
      assert.match(result.error, /No se confirmó ni se cobró nada/);
    }
    assert.equal(fake.appliedUpdates(), 0);
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_MAX_TOTAL_USD;
    else process.env.LONG_FORM_MAX_TOTAL_USD = previous;
  }
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

test("P0-01 (T-20261019-1553): v3 con acontecimiento fechado ilustrado con stock → 409 IMPEDIMENTO DE ENTREGA, plan sin fijar", async () => {
  const dated = documentary180sFixture();
  const fake = fakeService(baseRow({ script_json: dated, topic: dated.topic }));
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.match(result.error, /IMPEDIMENTO DE ENTREGA/);
    assert.match(result.error, /No se inició, reservó ni cobró nada/);
  }
  assert.equal(fake.appliedUpdates(), 0);
});

test("Recraft: el plan fija image=recraft (precio Recraft) y la elección se escribe en el MISMO UPDATE de la confirmación", async () => {
  const fake = fakeService(baseRow());
  const style = { styleId: null, referencePaths: ["req-1/recraft-style/ref-0.png"], match: "precise" as const, styleNote: "luz de vela", onMissingStyleId: "stop" as const };
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", recraft: style });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.plan.providers.image, "recraft");
  assert.ok(result.plan.imagePriority, "Recraft plans carry the Recraft-first image plan");
  const reserve = result.plan.imagePriority?.regenerationReserve ?? 0;
  assert.ok(Math.abs((result.plan.estimatedImageCostUsd ?? 0) - (result.plan.aiImageCount + reserve) * 0.04) < 1e-6);
  assert.equal(fake.appliedUpdates(), 1);
  assert.equal(fake.row.reel_image_source, "recraft");
  assert.deepEqual(fake.row.reel_recraft_style, style);
  // A stale tab cannot change the source afterwards: the confirmed plan (and its choice) is returned unchanged.
  const stale = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.ok(stale.ok && stale.alreadyConfirmed && stale.plan.providers.image === "recraft");
  assert.equal(fake.appliedUpdates(), 1);
});

test("sin Recraft: el plan y la fila quedan exactamente como antes (OpenAI, sin columnas de imagen)", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.ok(result.ok && result.plan.providers.image === "openai");
  assert.equal("reel_image_source" in fake.row, false);
});

test("voz elegida (Long Form): se escribe en el MISMO UPDATE de la confirmación y una pestaña vieja no la cambia", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", voiceId: "CeFSZuaHs4SxcBxb9nCr" });
  assert.ok(result.ok);
  assert.equal(fake.appliedUpdates(), 1);
  assert.equal(fake.row.reel_voice_id, "CeFSZuaHs4SxcBxb9nCr");
  const stale = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", voiceId: "otraVoz12345" });
  assert.ok(stale.ok && stale.alreadyConfirmed);
  assert.equal(fake.appliedUpdates(), 1);
  assert.equal(fake.row.reel_voice_id, "CeFSZuaHs4SxcBxb9nCr");
});

test("sin voz elegida: la fila no recibe reel_voice_id (voz predeterminada como antes)", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.ok(result.ok);
  assert.equal("reel_voice_id" in fake.row, false);
});

/** Archivo sintético: cada consulta encuentra material pertinente y único, salvo las de mosquitos (no existe). */
function footageWithout(word: string): FootageProvider {
  let n = 0;
  const found = (query: string, media: "image" | "video"): FootageCandidate[] => query.toLowerCase().includes(word) ? [] : Array.from({ length: 3 }, () => ({
    url: `https://synthetic.invalid/${n}`, sourceId: `s${n++}`, description: query, durationSeconds: 30, mediaType: media,
    mimeType: media === "video" ? "video/mp4" : "image/jpeg", extension: media === "video" ? "mp4" : "jpg" }));
  return {
    name: "synthetic",
    async fetchFootage() { throw new Error("solo candidatos"); },
    async downloadFootage() { throw new Error("sin descargas"); },
    async searchVideoCandidates(query) { return found(query, "video"); },
    async searchImageCandidates(query) { return found(query, "image"); },
  };
}

test("material (2026-10-28): Económico con escenas sin archivo NO se confirma (409, número de escenas), USD 0", async () => {
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "economical", materialFootage: footageWithout("mosquito") });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.match(result.error, /no hay material de archivo pertinente y único para \d+ escena\(s\)/);
  }
  assert.equal(fake.appliedUpdates(), 0);
  assert.equal(fake.row.long_form_confirmed_at, null);
});

test("material: Equilibrado confirma el plan con las escenas sin archivo como imagen IA, ya preciadas", async () => {
  const plain = fakeService(baseRow());
  const without = await confirmLongFormProduction(plain.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", materialFootage: null });
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", materialFootage: footageWithout("mosquito") });
  assert.ok(result.ok && without.ok);
  if (!result.ok || !without.ok) return;
  const promoted = result.plan.materialGapImages ?? [];
  assert.ok(promoted.length > 0);
  assert.equal(result.plan.aiImageCount, without.plan.aiImageCount + promoted.length);
  assert.equal(result.plan.allocation!.maxAiImageGenerations, without.plan.allocation!.maxAiImageGenerations + promoted.length);
  assert.ok(result.plan.estimatedProviderCostUsd > without.plan.estimatedProviderCostUsd);
  assert.deepEqual((fake.row.long_form_production_plan as { materialGapImages?: string[] }).materialGapImages, promoted);
});

test("material: con todo el archivo disponible el plan es idéntico al de antes (sin promociones)", async () => {
  const a = await confirmLongFormProduction(fakeService(baseRow()).client, { requestId: "req-1", userId: "user-1", strategy: "balanced", materialFootage: footageWithout("no-such-word"), nowIso: "2026-10-28T10:00:00Z" });
  const b = await confirmLongFormProduction(fakeService(baseRow()).client, { requestId: "req-1", userId: "user-1", strategy: "balanced", materialFootage: null, nowIso: "2026-10-28T10:00:00Z" });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.deepEqual(a.plan, b.plan);
});

test("material: proveedor de archivo caído → 503, no se confirma nada", async () => {
  const down: FootageProvider = { name: "down", async fetchFootage() { throw new Error("x"); }, async downloadFootage() { throw new Error("x"); },
    async searchImageCandidates() { throw new Error("HTTP 503"); }, async searchVideoCandidates() { throw new Error("HTTP 503"); } };
  const fake = fakeService(baseRow());
  const result = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", materialFootage: down });
  assert.ok(!result.ok && result.status === 503);
  assert.equal(fake.appliedUpdates(), 0);
});

test("reconfiguración: la voz fijada en la primera confirmación no se cambia (trigger inmutable)", async () => {
  const fake = fakeService(baseRow({ reel_voice_id: "CeFSZuaHs4SxcBxb9nCr" }));
  const other = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", voiceId: "otraVoz12345", materialFootage: null });
  assert.ok(!other.ok && other.status === 409);
  const same = await confirmLongFormProduction(fake.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", voiceId: "CeFSZuaHs4SxcBxb9nCr", materialFootage: null });
  assert.ok(same.ok);
});
