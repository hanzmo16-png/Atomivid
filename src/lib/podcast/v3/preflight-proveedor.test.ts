/**
 * P0 incidente real 4290175a (2026-11-08 17:18Z, run 42504283810): un podcast de Anunnaki necesitaba 48 llamadas de
 * HeyGen y el worker lo bloqueó con «HeyGen (avatar): alcanzó su cuota diaria de llamadas» (límite PROPIO de ATOMIVID,
 * pi_supply_policies.max_daily_calls; HeyGen estaba GREEN con saldo). Ninguna llamada de pago, pero la persona ya había
 * pulsado «Generar», el episodio pasó a «authorized», se despachó un runner y vio 0 % con fallo.
 * Ahora la misma verificación corre en la API ANTES de autorizar/despachar y en la estimación (pantalla Producir).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STUDIO_VERSION, EL_DURO_VOICE_ID } from "./spec";
import { authorizeAction, studioAction, SUPPLY_CHECK_UNAVAILABLE, type ApiDeps } from "./api";
import type { ProviderNeeds } from "./pipeline";
import type { SupplyReadiness } from "@/lib/supply/readiness";
import type { AccountVoice } from "@/lib/podcast/voices";
import { isProviderNotReady, providerBlockText, providerBlocked } from "../../../app/dashboard/podcast/PodcastWizard";

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro")];
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const SCRIPT = Array.from({ length: 12 }, (_, i) => `Párrafo ${i + 1} sobre los anunnaki, Sumeria y las tablillas de arcilla de Nippur.`).join("\n\n");
const SPEC = { version: STUDIO_VERSION, mode: "avatar", output: "video", title: "Anunnaki", script: SCRIPT, target_minutes: 2,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }], visual: { provider: "solo_set" }, music: {}, budget_usd: 40 };
const QUOTA_48: SupplyReadiness = { ready: false, providers: [], failure: { provider: "heygen", reason: "daily request quota", quota: { max: 40, today: 0, calls: 48, timezone: "America/Cancun" } } };
const QUOTA_TODAY: SupplyReadiness = { ready: false, providers: [], failure: { provider: "heygen", reason: "daily request quota", quota: { max: 60, today: 30, calls: 48, timezone: "America/Cancun" } } };

function harness(status: string, check: (n: ProviderNeeds) => Promise<SupplyReadiness>, extra: Partial<ApiDeps> = {}) {
  const calls = { authorize: 0, dispatch: 0, checks: [] as ProviderNeeds[] };
  let row = { id: "e1", user_id: "u1", status, estimated_usd: 1, spec: SPEC, authorized_at: status === "authorized" ? new Date().toISOString() : null, run_started_at: null as string | null };
  const d: ApiDeps = { userId: "u1", viewer, voices: async () => VOICES, enabled: true, llm: null, env: {}, ownsAvatar: async () => true,
    insert: async () => ({ id: "e1" }), load: async () => row as never,
    authorize: async () => { calls.authorize++; row = { ...row, status: "authorized", authorized_at: new Date().toISOString() }; return true; },
    dispatch: async () => { calls.dispatch++; row = { ...row, status: "generating", run_started_at: new Date(Date.now() + 1000).toISOString() }; return true; },
    supplyCheck: async (n) => { calls.checks.push(n); return check(n); }, ...extra };
  return { d, calls, row: () => row };
}

test("cuota de HeyGen que no cabe en un día: 409 ANTES de autorizar; sin cambio de estado, sin runner, sin cargo", async () => {
  const h = harness("draft", async () => QUOTA_48);
  const r = await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PROVEEDOR_NO_LISTO");
  assert.match(String(r.body.error), /^Proveedor no listo: HeyGen \(avatar\): este episodio necesita 48 llamadas y el límite diario de la plataforma es 40; no cabe en un día aunque se espere\./);
  assert.match(String(r.body.error), /No se inició la producción ni se hizo ningún cargo; tu borrador se conserva\.$/);
  assert.equal((r.body.readiness as { waitHelps?: boolean }).waitHelps, false, "esperar no sirve: lo dice");
  assert.equal(h.calls.authorize, 0); assert.equal(h.calls.dispatch, 0); assert.equal(h.row().status, "draft");
  assert.ok(h.calls.checks[0].avatarCalls! > 0, "la verificación recibe las llamadas de avatar del episodio");
});

test("cuota agotada por hoy: el mensaje da la hora de restablecimiento y dice que esperar sí sirve", async () => {
  const h = harness("draft", async () => QUOTA_TODAY);
  const r = await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 });
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /hoy ya se usaron 30 de las 60 llamadas diarias.*00:00 hora de Cancún/);
  assert.equal((r.body.readiness as { waitHelps?: boolean }).waitHelps, true);
  assert.equal(h.calls.dispatch, 0);
});

test("reintento de un episodio fallido con la cuota aún agotada: no autoriza ni despacha (ninguna llamada inútil)", async () => {
  const h = harness("failed", async () => QUOTA_48);
  for (let i = 0; i < 3; i++) assert.equal((await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 })).status, 409);
  assert.equal(h.calls.authorize, 0); assert.equal(h.calls.dispatch, 0); assert.equal(h.row().status, "failed", "el episodio fallido sigue recuperable");
});

test("«Volver a pedir el inicio» de un autorizado sin arrancar también se frena si el proveedor no está listo", async () => {
  const h = harness("authorized", async () => QUOTA_48);
  const r = await authorizeAction(h.d, "e1", { confirm: true });
  assert.equal(r.status, 409); assert.equal(h.calls.dispatch, 0);
});

test("si no se puede comprobar la disponibilidad, no se inicia (falla cerrado)", async () => {
  const h = harness("draft", async () => { throw new Error("rpc caído"); });
  const r = await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 });
  assert.equal(r.status, 409); assert.equal(r.body.error, SUPPLY_CHECK_UNAVAILABLE);
  assert.equal(h.calls.authorize, 0); assert.equal(h.calls.dispatch, 0);
  const h2 = harness("draft", async () => ({ ready: true, providers: [] }), { settledOps: async () => { throw new Error("ops"); } });
  assert.equal((await authorizeAction(h2.d, "e1", { confirm: true, authorizedUsd: 40 })).status, 409, "sin leer lo liquidado tampoco");
  assert.equal(h2.calls.dispatch, 0);
});

test("proveedores listos: una autorización y un despacho; repetir el clic no duplica trabajo ni cobro", async () => {
  const h = harness("draft", async () => ({ ready: true, providers: [] }));
  assert.equal((await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 })).status, 200);
  const again = await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 });
  assert.equal(again.status, 409); assert.match(String(again.body.error), /Ya se está generando/);
  assert.equal(h.calls.authorize, 1); assert.equal(h.calls.dispatch, 1);
});

test("lo ya liquidado no cuenta para la cuota al reintentar (reutilización sin pagar dos veces)", async () => {
  const seen: number[] = [];
  const base = harness("failed", async (n) => { seen.push(n.avatarCalls ?? 0); return { ready: true, providers: [] }; });
  await authorizeAction(base.d, "e1", { confirm: true, authorizedUsd: 40 });
  const h = harness("failed", async (n) => { seen.push(n.avatarCalls ?? 0); return { ready: true, providers: [] }; },
    { settledOps: async () => [{ op: "avatar_clip" }, { op: "avatar_clip" }, { op: "avatar_prepare" }] });
  await authorizeAction(h.d, "e1", { confirm: true, authorizedUsd: 40 });
  assert.ok(seen[0] >= 3, `llamadas de avatar del episodio: ${seen[0]}`);
  // Avatar existente: no hay preparación de foto, así que solo se descuentan los dos clips liquidados.
  assert.equal(seen[1], seen[0] - 2, "dos clips liquidados se descuentan");
});

test("la estimación (pantalla Producir) ya trae la disponibilidad real: el botón se desactiva antes del clic", async () => {
  const h = harness("draft", async () => QUOTA_48);
  const r = await studioAction(h.d, { action: "estimate", spec: SPEC });
  assert.equal(r.status, 200);
  const e = r.body.estimate as { readiness: { ready: boolean; message: string; waitHelps: boolean } };
  assert.equal(e.readiness.ready, false); assert.equal(providerBlocked(e), true);
  assert.match(providerBlockText(e), /^Ahora no se puede iniciar: HeyGen \(avatar\): este episodio necesita 48 llamadas.*No se hará ningún cargo y tu configuración se conserva\.$/);
  const ok = await studioAction(harness("draft", async () => ({ ready: true, providers: [] })).d, { action: "estimate", spec: SPEC });
  assert.equal(providerBlocked(ok.body.estimate as never), false);
});

test("UI: el botón «Generar episodio» depende de la disponibilidad y un 409 de proveedor la marca sin perder el borrador", () => {
  const wiz = readFileSync(path.join(__dirname, "../../../app/dashboard/podcast/PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /disabled=\{[^}]*providerBlocked\(estimate\)\}[^>]*>Generar episodio</);
  assert.match(wiz, /data-testid="proveedor-no-listo"/);
  const e409 = Object.assign(new Error("Proveedor no listo: HeyGen (avatar): x. No se inició la producción ni se hizo ningún cargo; tu borrador se conserva."), { status: 409 });
  assert.equal(isProviderNotReady(e409), true);
  assert.equal(isProviderNotReady(Object.assign(new Error("Otra solicitud cambió el episodio; recarga la página."), { status: 409 })), false);
});

test("las rutas reales conectan la verificación (misma regla que el worker) y el worker usa la misma cuenta de llamadas", () => {
  const root = path.join(__dirname, "../../..");
  for (const f of ["app/api/podcast/v3/route.ts", "app/api/podcast/v3/[id]/route.ts"]) assert.match(readFileSync(path.join(root, f), "utf8"), /supplyCheck: studioProvidersSimulated\(\) \? undefined : \(needs\) => studioSupplyCheck\(service, needs\)/, f);
  assert.match(readFileSync(path.join(root, "app/api/podcast/v3/[id]/route.ts"), "utf8"), /settledOps: .*\.eq\("user_id", user\.id\)\.eq\("state", "settled"\)/);
  assert.match(readFileSync(path.join(root, "lib/podcast/v3/readiness.ts"), "utf8"), /ensureJobSupplyReady\(service, demands, \{ now \}\)/);
  assert.match(readFileSync(path.join(root, "lib/podcast/v3/pipeline.ts"), "utf8"), /const needs = providerNeeds\(spec, pf, settledRows,/);
});

test("solo el arnés local con proveedores simulados omite la verificación; en producción nunca", async () => {
  const { studioProvidersSimulated } = await import("./readiness");
  assert.equal(studioProvidersSimulated({ PODCAST_V3_PROVIDERS: "mock", NODE_ENV: "development" }), true);
  for (const env of [{ PODCAST_V3_PROVIDERS: "mock", NODE_ENV: "production" }, { PODCAST_V3_PROVIDERS: "mock", VERCEL: "1" }, { PODCAST_V3_PROVIDERS: "mock", ATOMIVID_RUNTIME: "production" }, { NODE_ENV: "development" }])
    assert.equal(studioProvidersSimulated(env), false, JSON.stringify(env));
});
