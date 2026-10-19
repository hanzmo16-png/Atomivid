/**
 * Control de costos (2026-10-18) — «comprobar antes del primer gasto». ROJO = the behaviour on main
 * (bb3e4549): only the plan was checked before the script, so a production that could never be made was
 * discovered after paying for the script (and the render told the customer to top up Atomivid's provider).
 * VERDE = checkProduction answers the five cases before any paid call. Every refusal is proven with a
 * simulated provider's CALL COUNTER, not only with the message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCanGenerate } from "@/lib/billing/quota";
import { scriptPricingIssues } from "@/lib/billing/pricing";
import { scriptCallParamsFor } from "@/lib/ai/script";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { anthropicReservation, ceilLedgerUsd } from "./anthropic-cost";
import { checkProduction, classifyReadiness, costIncrease, narrationCharsCeiling, productionDemands, scriptGenerationCeilingUsd, type CheckRequest } from "./production-check";
import { ensureJobSupplyReady } from "./readiness";
import { providerCheck } from "@/lib/video/long-form/production-preflight";

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NOW = Date.parse("2026-10-18T19:00:00Z");
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "cliente@example.test", email_confirmed_at: "2026-10-01" };
const FLAGS: FeatureFlags = { ...getFeatureFlags(), imageGenerationEnabled: false, visualDirectorEnabled: false, musicProvider: "curated-library" } as FeatureFlags;
const REEL: CheckRequest = { mode: "visual", duration_seconds: 60, language: "es", topic: "Los principios herméticos", style: "Misterioso", recorded_audio_path: null, script_json: null };

type Level = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
/** In-memory supply store with the production admission inputs: policies, state (level/free, already net of
 * other productions' reservations, as pi_supply_state is), and spend per period. */
function fakeSupply(state: Record<string, { level: Level; free: number | null; reason?: string }>, opts: { spent?: Record<string, number>; caps?: Record<string, number>; noGlobal?: boolean; stateError?: boolean } = {}) {
  const policy = (provider: string, unit: string) => ({ provider, enabled: true, unit, unit_cost_usd: unit === "character" ? 0.0001 : 1,
    daily_cap_usd: opts.caps?.[provider] ?? 20, monthly_cap_usd: 150, timezone: "America/Cancun", evidence: "owner-funded" });
  const policies = [
    ...(opts.noGlobal ? [] : [{ ...policy("__global__", "usd"), daily_cap_usd: opts.caps?.__global__ ?? 40, monthly_cap_usd: 300 }]),
    policy("elevenlabs", "character"), policy("anthropic", "usd"), policy("heygen", "usd"), policy("openai", "usd"),
  ];
  const rpcCalls: string[] = [];
  const service = {
    rpcCalls,
    from() { return { select() { return { in: async (_k: string, values: string[]) => ({ data: policies.filter(p => values.includes(p.provider)), error: null }) }; } }; },
    async rpc(name: string, args: { p_provider: string | null }) {
      rpcCalls.push(`${name}:${args.p_provider}`);
      if (name === "pi_supply_spend") return { data: args.p_provider ? (opts.spent?.[args.p_provider] ?? 0) : Object.values(opts.spent ?? {}).reduce((a, b) => a + b, 0), error: null };
      if (name === "pi_supply_state") {
        if (opts.stateError) return { data: null, error: { message: "timeout" } };
        const s = state[args.p_provider ?? ""];
        return { data: s ? { level: s.level, reason: s.reason ?? "fresh", free: s.free } : { level: "UNKNOWN", reason: "unconfigured", free: null }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return service as unknown as SupabaseClient & { rpcCalls: string[] };
}
const GREEN = { elevenlabs: { level: "GREEN" as Level, free: 1_000_000 }, anthropic: { level: "GREEN" as Level, free: 100 }, heygen: { level: "GREEN" as Level, free: 100 } };
const allowed = async () => ({ allowed: true as const });
const refused = (reason: string) => async () => ({ allowed: false as const, reason });

/** The paid provider of the script step, with a call counter (no network). */
function simulatedScriptProvider() {
  let calls = 0;
  return { get calls() { return calls; }, async generate() { calls++; return { segments: [{ text: "guion" }] }; } };
}
/** The start of the script as the route runs it NOW (check → only then the paid call). */
async function startScriptNow(service: SupabaseClient, provider: ReturnType<typeof simulatedScriptProvider>, deps: Parameters<typeof checkProduction>[0]["deps"], request = REEL) {
  const check = await checkProduction({ service, user: USER, ownerId: USER.id, request, stage: "before_script", voiceProvider: "elevenlabs", scriptProvider: "anthropic", flags: FLAGS,
    deps: { guard: true, ensureJobSupplyReady: (s, d) => ensureJobSupplyReady(s, d, { refresh: false, now: () => NOW }), ...deps } });
  if (check.outcome === "ready") await provider.generate();
  return check;
}
/** The start of the script on main (bb3e4549): only the plan was checked before the paid call. */
async function startScriptOnMain(provider: ReturnType<typeof simulatedScriptProvider>, plan: () => Promise<{ allowed: boolean }>) {
  if ((await plan()).allowed) await provider.generate();
}

test("estimate before the script: the script ceiling is the ledger's own reservation of every call it may make; voice is sized from the duration", () => {
  const params = scriptCallParamsFor({ topic: REEL.topic!, style: REEL.style!, durationSeconds: 60, language: "es" });
  assert.equal(params.length, 3, "MAX_LENGTH_ATTEMPTS length attempts");
  const expected = params.reduce((s, p) => s + ceilLedgerUsd(anthropicReservation(p as never, { scriptInputUsdPer1MTokens: 2, scriptOutputUsdPer1MTokens: 10 })), 0);
  assert.equal(scriptGenerationCeilingUsd({ topic: REEL.topic!, style: REEL.style!, durationSeconds: 60, language: "es" }), expected);
  // 60 s → targetWordsFor = round(59.5 × 2.8) = 167 → ≤ 110 % accepted = 183 words × 8 chars.
  assert.equal(narrationCharsCeiling(60), 183 * 8);
  const { demands, lines } = productionDemands(REEL, "elevenlabs", "before_script", { flags: FLAGS });
  assert.deepEqual(demands.map(d => d.provider), ["anthropic", "elevenlabs"]);
  assert.equal(demands.find(d => d.provider === "elevenlabs")!.units, 183 * 8 * 2, "Reel keeps the pacing correction (×2) of jobSupplyDemands");
  assert.ok(lines.every(l => l.basis.length > 0));
  // Own recording: no voice and no script. A provider the production does not use is never demanded.
  const recorded = productionDemands({ ...REEL, mode: "avatar", recorded_audio_path: "r/a.m4a" }, "elevenlabs", "before_script", { flags: { ...FLAGS, avatarProvider: "heygen", maxAvatarCostUsd: 3 } as FeatureFlags });
  assert.deepEqual(recorded.demands.map(d => d.provider), ["heygen"]);
  assert.deepEqual(productionDemands(REEL, "fixture", "before_script", { flags: FLAGS }).demands.map(d => d.provider), ["anthropic"]);
  assert.ok(!productionDemands(REEL, "elevenlabs", "before_script", { flags: FLAGS }).demands.some(d => ["openai", "beatoven", "runway", "heygen"].includes(d.provider)));
});

test("ROJO/VERDE: customer with a plan, Atomivid's voice provider out of capacity — main paid the script; now 0 calls and Atomivid is responsible", async () => {
  const service = fakeSupply({ ...GREEN, elevenlabs: { level: "RED", free: 10 } });
  const rojo = simulatedScriptProvider();
  await startScriptOnMain(rojo, allowed);
  assert.equal(rojo.calls, 1, "ROJO: the script was paid for a production the voice provider could not make");
  const verde = simulatedScriptProvider();
  const check = await startScriptNow(service, verde, { assertCanGenerate: allowed });
  assert.equal(verde.calls, 0, "VERDE: zero paid calls");
  assert.equal(check.outcome, "provider_unavailable");
  assert.equal(check.responsible, "atomicvid");
  assert.match(check.message, /no de tu cuenta: no tienes que recargar nada/);
  assert.doesNotMatch(`${check.title} ${check.message} ${check.next}`, /\bRecarga\b/);
});

test("inverse case: provider fine, customer's plan does not allow it → customer_limit, 0 calls, no provider blamed", async () => {
  const verde = simulatedScriptProvider();
  const check = await startScriptNow(fakeSupply(GREEN), verde, { assertCanGenerate: refused("Alcanzaste el límite de 10 videos este mes en tu plan (Starter).") });
  assert.equal(verde.calls, 0);
  assert.equal(check.outcome, "customer_limit");
  assert.equal(check.responsible, "cliente");
  assert.match(check.message, /Alcanzaste el límite/);
  // Both at once: the customer is told first; Atomivid's problem is still recorded, never as the customer's fault.
  const both = await startScriptNow(fakeSupply({ ...GREEN, anthropic: { level: "RED", free: 0 } }), simulatedScriptProvider(), { assertCanGenerate: refused("Necesitas una suscripción activa.") });
  assert.equal(both.outcome, "customer_limit");
  assert.deepEqual(both.issues.map(i => [i.outcome, i.responsible]), [["customer_limit", "cliente"], ["provider_unavailable", "atomicvid"]]);
});

test("sufficient, insufficient and EXACTLY at the limit (units = unreserved free capacity, net of other productions' reservations)", async () => {
  const units = productionDemands(REEL, "elevenlabs", "before_script", { flags: FLAGS }).demands.find(d => d.provider === "elevenlabs")!.units;
  const exact = await startScriptNow(fakeSupply({ ...GREEN, elevenlabs: { level: "GREEN", free: units } }), simulatedScriptProvider(), { assertCanGenerate: allowed });
  assert.equal(exact.outcome, "ready", "exactly at the limit is enough");
  const short = simulatedScriptProvider();
  const below = await startScriptNow(fakeSupply({ ...GREEN, elevenlabs: { level: "GREEN", free: units - 1 } }), short, { assertCanGenerate: allowed });
  assert.equal(below.outcome, "provider_unavailable");
  assert.equal(below.issues[0].reason, "unreserved capacity below this production");
  assert.equal(short.calls, 0);
  const ok = simulatedScriptProvider();
  const ready = await startScriptNow(fakeSupply(GREEN), ok, { assertCanGenerate: allowed });
  assert.equal(ready.outcome, "ready");
  assert.equal(ok.calls, 1);
  assert.match(ready.message, /Techo estimado de proveedores: hasta USD \d+\.\d\d \(estimación conservadora, no es el precio exacto\)/);
});

test("availability unknown, stale or with error (401/429/timeout read) → unverifiable, never treated as available; 0 calls", async () => {
  for (const [name, service] of [
    ["stale/unverified reading", fakeSupply({ ...GREEN, elevenlabs: { level: "UNKNOWN", free: null, reason: "balance unverified or stale" } })],
    ["state RPC timeout", fakeSupply(GREEN, { stateError: true })],
  ] as const) {
    const p = simulatedScriptProvider();
    const check = await startScriptNow(service, p, { assertCanGenerate: allowed });
    assert.equal(check.outcome, "unverifiable", name);
    assert.equal(check.responsible, "atomicvid");
    assert.equal(p.calls, 0, name);
  }
  // A billing read answered 401/429 is stored as health DOWN → pi_supply_state RED: Atomivid's provider is unavailable.
  const down = await startScriptNow(fakeSupply({ ...GREEN, elevenlabs: { level: "RED", free: null, reason: "urgent replenishment or provider unavailable" } }), simulatedScriptProvider(), { assertCanGenerate: allowed });
  assert.equal(down.outcome, "provider_unavailable");
  // A plan check that errors (database) is unverifiable, never «you have no plan».
  const planDown = await startScriptNow(fakeSupply(GREEN), simulatedScriptProvider(), { assertCanGenerate: async () => { throw new Error("db"); } });
  assert.equal(planDown.outcome, "unverifiable");
});

test("daily/monthly limits and an unconfigured budget: Atomivid's ceiling (not the customer's), 0 calls", async () => {
  const p = simulatedScriptProvider();
  const capped = await startScriptNow(fakeSupply(GREEN, { spent: { elevenlabs: 19.99 }, caps: { elevenlabs: 20 } }), p, { assertCanGenerate: allowed });
  assert.equal(capped.outcome, "provider_unavailable");
  assert.equal(capped.issues[0].reason, "provider funded spend ceiling");
  // Spend of another provider (not demanded here) fills the GLOBAL ceiling: each demanded provider is within its own.
  const global = await startScriptNow(fakeSupply(GREEN, { spent: { openai: 39.99 }, caps: { __global__: 40 } }), p, { assertCanGenerate: allowed });
  assert.equal(global.issues[0].reason, "global funded spend ceiling");
  const unconfigured = await startScriptNow(fakeSupply(GREEN, { noGlobal: true }), p, { assertCanGenerate: allowed });
  assert.equal(unconfigured.outcome, "needs_correction");
  assert.equal(unconfigured.responsible, "atomicvid");
  assert.equal(p.calls, 0);
});

test("unknown price: a rate set to a non-number, or another script model without its own rates, is unknown — never the default; 0 calls", async (t) => {
  const saved = { ...process.env };
  t.after(() => { for (const k of ["PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS", "PRICING_SCRIPT_OUTPUT_USD_PER_1M_TOKENS", "ANTHROPIC_SCRIPT_MODEL", "PRICING_ELEVENLABS_USD_PER_1K_CHARS"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  assert.deepEqual(scriptPricingIssues({}), [], "documented defaults for the audited model");
  assert.equal(scriptPricingIssues({ PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS: "tres" }).length, 1);
  assert.equal(scriptPricingIssues({ PRICING_ELEVENLABS_USD_PER_1K_CHARS: "0" }).length, 1);
  assert.equal(scriptPricingIssues({ ANTHROPIC_SCRIPT_MODEL: "claude-opus-5-5" }).length, 1);
  assert.equal(scriptPricingIssues({ ANTHROPIC_SCRIPT_MODEL: "claude-opus-5-5", PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS: "5", PRICING_SCRIPT_OUTPUT_USD_PER_1M_TOKENS: "25" }).length, 0);
  process.env.PRICING_SCRIPT_OUTPUT_USD_PER_1M_TOKENS = "abc";
  const p = simulatedScriptProvider();
  const check = await startScriptNow(fakeSupply(GREEN), p, { assertCanGenerate: allowed });
  assert.equal(check.outcome, "needs_correction");
  assert.equal(check.responsible, "atomicvid");
  assert.match(check.issues[0].reason, /tarifa no verificable/);
  assert.equal(p.calls, 0);
});

test("owner (internal production) vs commercial plan, with the REAL assertCanGenerate", async (t) => {
  const prev = process.env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = USER.id;
  t.after(() => { if (prev === undefined) delete process.env.INTERNAL_PRODUCTION_OWNER_USER_ID; else process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = prev; });
  const noSubscription = (base: SupabaseClient) => new Proxy(base, { get(target, prop) {
    if (prop !== "from") return Reflect.get(target, prop);
    return (table: string) => table === "subscriptions"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
      : (target as unknown as { from: (t: string) => unknown }).from(table);
  } }) as SupabaseClient;
  const owner = await startScriptNow(noSubscription(fakeSupply(GREEN)), simulatedScriptProvider(), { assertCanGenerate });
  assert.equal(owner.outcome, "ready", "the owner's internal production needs no retail subscription");
  const other = { ...USER, id: "22222222-2222-4222-8222-222222222222" };
  const p = simulatedScriptProvider();
  const customer = await checkProduction({ service: noSubscription(fakeSupply(GREEN)), user: other, ownerId: other.id, request: REEL, stage: "before_script", voiceProvider: "elevenlabs", flags: FLAGS,
    deps: { guard: true, assertCanGenerate, ensureJobSupplyReady: (s, d) => ensureJobSupplyReady(s, d, { refresh: false, now: () => NOW }) } });
  if (customer.outcome === "ready") await p.generate();
  assert.equal(customer.outcome, "customer_limit");
  assert.match(customer.message, /suscripción activa/);
  assert.equal(p.calls, 0);
});

test("C. after the script: the ceiling is recomputed with the real text; a higher one needs explicit acceptance; a change of duration/mode invalidates the old estimate by construction", async () => {
  const before = productionDemands(REEL, "elevenlabs", "before_script", { flags: FLAGS, scriptProvider: "none" }).lines.reduce((s, l) => s + l.usd, 0);
  const shortScript = { ...REEL, script_json: { segments: [{ text: "Una frase breve." }] } };
  const longScript = { ...REEL, script_json: { segments: Array.from({ length: 20 }, () => ({ text: "x".repeat(800) })) } };
  const at = async (row: CheckRequest) => checkProduction({ service: fakeSupply(GREEN), user: USER, ownerId: USER.id, request: row, stage: "before_render", voiceProvider: "elevenlabs", flags: FLAGS,
    deps: { guard: true, assertCanGenerate: allowed, ensureJobSupplyReady: (s, d) => ensureJobSupplyReady(s, d, { refresh: false, now: () => NOW }) } });
  assert.equal(costIncrease(shortScript, await at(shortScript), FLAGS), null, "a script within the estimate needs no new acceptance");
  const inc = costIncrease(longScript, await at(longScript), FLAGS)!;
  assert.ok(inc && inc.afterUsd > inc.beforeUsd, "a longer edited script exceeds the pre-script ceiling");
  assert.equal(inc.beforeUsd, Math.round(before * 100) / 100);
  // Longer duration → its own (larger) pre-script ceiling: the same script no longer exceeds it.
  const longer = { ...longScript, duration_seconds: 300 };
  assert.ok((costIncrease(longer, await at(longer), FLAGS)?.afterUsd ?? 0) <= (inc.afterUsd));
  // The render route refuses without an accepted ceiling ≥ the new one, keeps the script, starts nothing.
  const route = src("src/app/api/generate/[id]/render/route.ts");
  const guard = route.indexOf("const increase = costIncrease(videoRequest, check);");
  assert.ok(guard > 0 && guard < route.indexOf("await reserveJobSupply(") && guard < route.indexOf("await worker.trigger("));
  assert.match(route, /accepted === null \|\| accepted \+ 1e-9 < increase\.afterUsd/);
  assert.match(route, /No se inició nada ni se cobró; tu guion se conserva/);
});

test("ROJO/VERDE: the render refusal no longer asks a CUSTOMER to top up Atomivid's provider; the owner still gets the operator action", () => {
  const failing = { provider: "elevenlabs", refreshed: false, level: "GREEN", reason: null, free: 10, units: 2928, usd: 0.29, ok: false, failure: "supplier balance unavailable" };
  const action = providerCheck(failing, "character").action!;
  assert.match(action, /^Recarga al menos/, "the operator text the route used to append for everyone");
  const route = src("src/app/api/generate/[id]/render/route.ts");
  assert.doesNotMatch(route, /error: action \? `\$\{START_SUPPLY_UNAVAILABLE\} \$\{action\}`/, "ROJO pattern removed");
  assert.match(route, /const action = failing && isInternalProductionOwner\(user\) \? providerCheck/);
  assert.match(route, /error: START_SUPPLY_UNAVAILABLE, operatorAction: action/);
  const resume = src("src/app/api/generate/[id]/resume/route.ts");
  assert.doesNotMatch(resume, /`\$\{START_SUPPLY_UNAVAILABLE\} \$\{action\}`/);
  assert.match(resume, /failing && isInternalProductionOwner\(user\) \? providerCheck/);
  const classified = classifyReadiness({ ready: false, providers: [failing], failure: { provider: "elevenlabs", reason: "supplier balance unavailable" } })!;
  assert.deepEqual([classified.outcome, classified.responsible], ["provider_unavailable", "atomicvid"]);
});

test("formulario fail-closed (C3): antes de adquirir la llave compartida no se emite submission_id ni se puede enviar", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { NewVideoForm } = await import("@/app/dashboard/new/NewVideoForm");
  // The first render (server, and the client before its effect resolves) is the state «draftReady=false».
  const html = renderToStaticMarkup(React.createElement(NewVideoForm, { action: () => {}, avatarModeEnabled: true, existingAvatars: [] }));
  const hidden = html.match(/<input[^>]*name="submission_id"[^>]*>/)?.[0] ?? "";
  assert.ok(hidden, "el campo de la llave existe");
  assert.match(hidden, /value=""/, "sin llave compartida, el valor está vacío");
  assert.match(hidden, /disabled=""/, "y el campo está deshabilitado: un envío no lo incluye");
  const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
  assert.match(submit, /disabled=""/, "el botón de envío está deshabilitado");
  assert.match(html, /Sincronizando borrador entre pestañas/, "y se dice por qué");
  // Enter (implicit submission) is refused by the form itself while not ready.
  assert.match(src("src/app/dashboard/new/NewVideoForm.tsx"), /onSubmit=\{event => \{ if \(!draftReady\) event\.preventDefault\(\); \}\}/);
});

test("server-side order: the script route checks the whole production BEFORE the first paid call; regenerate-scene and avatar text-to-speech check the plan before theirs", () => {
  const script = src("src/app/api/generate/[id]/script/route.ts");
  const check = script.indexOf("await checkProductionForRequest(");
  assert.ok(check > 0 && check < script.indexOf("await runScriptGeneration("), "check before the script call");
  assert.match(script, /if \(check\.outcome !== "ready"\) \{\s*return NextResponse\.json\(checkResponseBody\(check\), \{ status: checkHttpStatus\(check\) \}\);/);
  const scene = src("src/app/api/generate/[id]/script/regenerate-scene/route.ts");
  assert.ok(scene.indexOf("await assertCanGenerate(") > 0 && scene.indexOf("await assertCanGenerate(") < scene.indexOf("scriptProvider.regenerateScene("), "regenerate-scene: plan before the paid call (it had none)");
  const action = src("src/app/dashboard/new/actions.ts");
  assert.ok(action.indexOf("await checkProductionForRequest(") > 0 && action.indexOf("await checkProductionForRequest(") < action.indexOf("await gatedVoiceSynthesize("), "avatar text-to-speech: whole check before the paid synthesis");
  // Double click / browser resend / a second tab of the same draft: one draft key shared by the tabs (corrección 2,
  // counted in draft-idempotency.test.ts), recognised before paying. Corrección 3 (fail-closed): the key is emitted
  // ONLY once the shared acquisition finished; before that the hidden field is empty AND disabled (never sent) and
  // the submit is refused. The rendered behaviour is asserted in the next test.
  assert.match(src("src/app/dashboard/new/NewVideoForm.tsx"),
    /<input type="hidden" name="submission_id" value=\{draftReady \? submissionId : ""\} disabled=\{!draftReady\} \/>/);
  const seen = action.indexOf('.from("video_requests").select("id").eq("id", requestId).eq("user_id", user.id).maybeSingle()');
  assert.ok(seen > 0 && seen < action.indexOf("await gatedVoiceSynthesize("));
  // Isolation: the read-only readiness endpoint answers 404 alike for missing and foreign requests.
  const readiness = src("src/app/api/generate/[id]/readiness/route.ts");
  assert.match(readiness, /if \(error \|\| !row \|\| row\.user_id !== user\.id\) return NextResponse\.json\(\{ error: "Solicitud no encontrada" \}, \{ status: 404 \}\)/);
  assert.doesNotMatch(readiness, /reserveJobSupply|\.insert\(|\.update\(|\.upsert\(/, "read-only: never reserves or writes");
});
