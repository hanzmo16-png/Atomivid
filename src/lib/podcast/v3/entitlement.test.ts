/**
 * Podcast Studio para clientes (beta): acceso por lista, derecho del plan y saldo mensual, en el servidor. Sin red ni BD.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceUsed, checkStudioSpend, monthStartUtc, parseStudioLimits, studioSpendDecision } from "./entitlement";
import { studioBetaUser, studioFlag, studioGenerationEnabled } from "./studio";
import { authorizeAction, type ApiDeps } from "./api";
import { StudioSpec, STUDIO_VERSION } from "./spec";

const BETA = "aaaaaaaa-1111-4111-8111-000000000001", OTHER = "bbbbbbbb-2222-4222-8222-000000000002";
const ENV = { PODCAST_STUDIO_BETA_USER_IDS: ` ${BETA.toUpperCase()} , no-es-uuid`, PODCAST_STUDIO_PLAN_LIMITS: JSON.stringify({ pro: { episode_usd: 5, month_usd: 12 } }) };
const user = (id: string, confirmed = true) => ({ id, email_confirmed_at: confirmed ? "2026-10-01T00:00:00Z" : null });

test("beta: solo las cuentas de la lista con email confirmado; vacía = nadie; no toca al dueño", () => {
  assert.equal(studioBetaUser(user(BETA), ENV), true, "mayúsculas y espacios no importan; un id inválido se ignora");
  assert.equal(studioBetaUser(user(BETA, false), ENV), false, "sin email confirmado");
  assert.equal(studioBetaUser(user(OTHER), ENV), false, "cuenta fuera de la lista");
  assert.equal(studioBetaUser(user(BETA), {}), false, "lista vacía: la beta está apagada");
  assert.equal(studioGenerationEnabled(user(BETA), ENV), true);
  assert.equal(studioGenerationEnabled(user(OTHER), ENV), false);
  assert.deepEqual([studioFlag(ENV, user(BETA)).enabled, studioFlag(ENV, user(BETA)).source], [true, "beta"]);
  assert.equal(studioFlag({}, user(BETA)).enabled, false, "desactivar = vaciar la lista");
  // El piloto del dueño sigue igual (no depende de la lista).
  const OWNER = "cccccccc-3333-4333-8333-000000000003";
  assert.equal(studioGenerationEnabled(user(OWNER), { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER }), true);
});

test("límites por plan: sin configuración o inválidos no hay derecho (no se inventan cuotas)", () => {
  assert.deepEqual(parseStudioLimits({}), {});
  assert.deepEqual(parseStudioLimits({ PODCAST_STUDIO_PLAN_LIMITS: "{no json" }), {});
  assert.deepEqual(parseStudioLimits({ PODCAST_STUDIO_PLAN_LIMITS: JSON.stringify({ pro: { episode_usd: 5, month_usd: 3 }, starter: { episode_usd: 0, month_usd: 10 }, x: { episode_usd: 1, month_usd: 2 } }) }), {}, "mes < episodio, cero o plan desconocido");
  assert.deepEqual(parseStudioLimits(ENV), { pro: { episode_usd: 5, month_usd: 12 } });
});

test("saldo del mes: listo = costo real; en curso = autorizado; con error o borrador = 0 (devolución); otro mes no cuenta", () => {
  const start = monthStartUtc(new Date("2026-11-15T10:00:00Z"));
  assert.equal(start, "2026-11-01T00:00:00.000Z");
  const rows = [
    { status: "ready", authorized_usd: 5, cost_usd: 3.21, created_at: "2026-11-02T00:00:00Z" },
    { status: "ready", authorized_usd: "2", cost_usd: null, created_at: "2026-11-03T00:00:00Z" },
    { status: "generating", authorized_usd: "1.5", cost_usd: null, created_at: "2026-11-04T00:00:00Z" },
    { status: "authorized", authorized_usd: 1, cost_usd: null, created_at: "2026-11-05T00:00:00Z" },
    { status: "failed", authorized_usd: 4, cost_usd: 0.4, created_at: "2026-11-06T00:00:00Z" },
    { status: "draft", authorized_usd: null, cost_usd: null, created_at: "2026-11-07T00:00:00Z" },
    { status: "ready", authorized_usd: 9, cost_usd: 9, created_at: "2026-10-31T23:59:59Z" },
  ];
  assert.equal(allowanceUsed(rows, start), 7.71);
});

test("decisión: permitido, sin suscripción, plan sin derecho, tope por episodio y sin saldo", () => {
  const limits = parseStudioLimits(ENV);
  assert.deepEqual(studioSpendDecision({ subscriptionStatus: "active", plan: "pro", limits, usd: 4, used: 8 }), { ok: true });
  const noSub = studioSpendDecision({ subscriptionStatus: "canceled", plan: "pro", limits, usd: 1, used: 0 });
  assert.equal(noSub.ok, false); assert.equal(!noSub.ok && noSub.status, 403);
  const noPlan = studioSpendDecision({ subscriptionStatus: "active", plan: "starter", limits, usd: 1, used: 0 });
  assert.equal(!noPlan.ok && noPlan.status, 403); assert.match(!noPlan.ok ? noPlan.error : "", /no incluye Podcast Studio/);
  const big = studioSpendDecision({ subscriptionStatus: "trialing", plan: "pro", limits, usd: 5.01, used: 0 });
  assert.equal(!big.ok && big.status, 402); assert.match(!big.ok ? big.error : "", /máximo por episodio/);
  const empty = studioSpendDecision({ subscriptionStatus: "active", plan: "pro", limits, usd: 4.5, used: 8 });
  assert.equal(!empty.ok && empty.status, 402); assert.match(!empty.ok ? empty.error : "", /te quedan USD 4\.00 de USD 12\.00/);
});

/** BD simulada para checkStudioSpend: solo lectura de suscripción y episodios del propio usuario. */
function fakeDb(sub: { status: string; price_id: string | null } | null, eps: Record<string, unknown>[], seen: string[] = []) {
  const q = (table: string) => {
    const filters: [string, unknown][] = [];
    const api = {
      select: () => api, eq: (c: string, v: unknown) => { filters.push([c, v]); return api; }, gte: () => api,
      maybeSingle: async () => { seen.push(`${table}:${JSON.stringify(filters)}`); return { data: sub, error: null }; },
      then: (r: (x: unknown) => void) => { seen.push(`${table}:${JSON.stringify(filters)}`); r({ data: eps.filter((e) => e.user_id === filters.find(([c]) => c === "user_id")?.[1]), error: null }); },
    };
    return api;
  };
  return { from: q };
}

test("comprobación con datos: solo lee los episodios del propio cliente; sin saldo → 402", async () => {
  const env = { ...ENV, STRIPE_PRICE_ID_PRO: "price_pro" };
  const now = new Date("2026-11-20T00:00:00Z");
  const eps = [
    { user_id: BETA, status: "ready", authorized_usd: 5, cost_usd: 4, created_at: "2026-11-02T00:00:00Z" },
    { user_id: BETA, status: "generating", authorized_usd: 5, cost_usd: null, created_at: "2026-11-10T00:00:00Z" },
    { user_id: OTHER, status: "ready", authorized_usd: 50, cost_usd: 50, created_at: "2026-11-02T00:00:00Z" },
  ];
  const seen: string[] = [];
  const db = fakeDb({ status: "active", price_id: "price_pro" }, eps, seen);
  const prev = process.env.STRIPE_PRICE_ID_PRO; process.env.STRIPE_PRICE_ID_PRO = "price_pro";
  try {
    assert.deepEqual(await checkStudioSpend(db, BETA, 3, env, now), { ok: true }, "usado 9 + 3 = 12 ≤ 12 (lo de otra cuenta no cuenta)");
    const over = await checkStudioSpend(db, BETA, 3.5, env, now);
    assert.equal(!over.ok && over.status, 402);
    assert.ok(seen.every((s) => s.includes(BETA)), "toda lectura filtra por el propio cliente");
    const none = await checkStudioSpend(fakeDb(null, eps), BETA, 1, env, now);
    assert.equal(!none.ok && none.status, 403, "sin suscripción");
  } finally { if (prev === undefined) delete process.env.STRIPE_PRICE_ID_PRO; else process.env.STRIPE_PRICE_ID_PRO = prev; }
});

const spec = () => StudioSpec.parse({ version: STUDIO_VERSION, mode: "dialogo", title: "T", script: "Ana: Hola, ¿qué tal?\nLuis: Muy bien, gracias por invitarme.\nAna: ¿Qué es Europa?\nLuis: Una luna con océano bajo el hielo.", target_minutes: 1,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }],
  visual: { provider: "solo_set" }, music: {}, budget_usd: 5 });
const row = (over: Record<string, unknown> = {}) => ({ id: "e1", user_id: BETA, title: "T", mode: "dialogo", spec: spec(), status: "draft", estimate: {}, estimated_usd: 1, authorized_usd: null, authorized_at: null, run_started_at: null, progress: null, result: null, error: null, cost_usd: null, video_path: null, audio_path: null, created_at: "t", updated_at: "t", ...over });
const deps = (over: Partial<ApiDeps>): ApiDeps => ({ userId: BETA, viewer: user(BETA) as never, voices: async () => [], enabled: true, llm: null,
  insert: async () => null, load: async () => row() as never, authorize: async () => true, dispatch: async () => true, ...over });

test("autorizar (cliente beta): sin saldo no se autoriza ni despacha; con saldo sí; carrera → se revierte antes de despachar", async () => {
  let authorized = 0, dispatched = 0, reverted = 0;
  const count = { authorize: async () => { authorized++; return true; }, dispatch: async () => { dispatched++; return true; } };
  const deny = await authorizeAction(deps({ ...count, spendGuard: { check: async () => ({ ok: false, status: 402, error: "sin saldo" }), revert: async () => { reverted++; return true; } } }), "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(deny.status, 402); assert.deepEqual([authorized, dispatched, reverted], [0, 0, 0], "bloqueado ANTES de autorizar: nada se cobra");
  const ok = await authorizeAction(deps({ ...count, spendGuard: { check: async () => ({ ok: true }), revert: async () => { reverted++; return true; } } }), "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(ok.status, 200); assert.deepEqual([authorized, dispatched, reverted], [1, 1, 0]);
  // Dos autorizaciones simultáneas: la comprobación posterior (con este episodio ya reservado) falla → se revierte.
  const race = await authorizeAction(deps({ ...count, spendGuard: { check: async (_u, after) => (after ? { ok: false, status: 402, error: "saldo agotado" } : { ok: true }), revert: async () => { reverted++; return true; } } }), "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(race.status, 402); assert.deepEqual([authorized, dispatched, reverted], [2, 1, 1], "autorizado y revertido; nunca despachado");
  // Re-despacho de un autorizado sin arranque: tampoco sale si el saldo ya no lo cubre.
  const redispatch = await authorizeAction(deps({ ...count, load: async () => row({ status: "authorized", authorized_usd: 2, authorized_at: "t" }) as never, spendGuard: { check: async () => ({ ok: false, status: 402, error: "saldo agotado" }), revert: async () => true } }), "e1", { confirm: true });
  assert.equal(redispatch.status, 402); assert.equal(dispatched, 1);
  // El dueño (sin spendGuard) sigue igual.
  const owner = await authorizeAction(deps({ ...count }), "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(owner.status, 200); assert.equal(dispatched, 2);
});

test("generador: un cliente beta solo se produce si la app lo confirma; sin respuesta o fuera de la lista, no", async () => {
  const { studioWorkerEnabled } = await import("../../../../scripts/podcast-3-0/studio-worker");
  const EP = "dddddddd-4444-4444-8444-000000000004", OWNER = "cccccccc-3333-4333-8333-000000000003";
  const of = (u: string | null) => async () => u;
  const ON = { PODCAST_STUDIO_BETA: "1" };
  assert.equal(await studioWorkerEnabled(EP, { ...ON, PODCAST_V3_OWNER_USER_ID: OWNER }, { ownerOf: of(BETA), askBeta: async () => true }), true, "beta confirmada por la app");
  assert.equal(await studioWorkerEnabled(EP, { PODCAST_V3_OWNER_USER_ID: OWNER }, { ownerOf: of(BETA), askBeta: async () => true }), false, "sin el interruptor del generador, la beta no produce");
  assert.equal(await studioWorkerEnabled(EP, { ...ON, PODCAST_V3_OWNER_USER_ID: OWNER }, { ownerOf: of(OTHER), askBeta: async () => false }), false, "fuera de la lista");
  assert.equal(await studioWorkerEnabled(EP, { ...ON, PODCAST_V3_OWNER_PILOT: "0" }, { ownerOf: of(BETA), askApp: async () => true, askBeta: async () => true }), true, "la beta no depende del piloto del dueño");
  assert.equal(await studioWorkerEnabled(EP, { ...ON }, { ownerOf: of(BETA), askApp: async () => false, askBeta: async () => { throw new Error("red"); } }), false, "error: no se produce (fail closed)");
});
