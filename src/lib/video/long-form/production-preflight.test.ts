import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { providerCheck, strategyPreflight, visualBlockMessage, type VisualCheck } from "./production-preflight";
import type { ProviderReadiness } from "@/lib/supply/readiness";
import type { ProductionPlan } from "./production-plan";

const row = (over: Partial<ProviderReadiness>): ProviderReadiness => ({ provider: "elevenlabs", refreshed: false, level: "GREEN", reason: null, free: 100000, units: 12000, usd: 1.2, ok: false, ...over });

test("capacidad: Suficiente / Insuficiente con monto exacto / Sin verificar / tope de gasto", () => {
  assert.deepEqual([providerCheck(row({ ok: true }), "character").verdict, providerCheck(row({ ok: true }), "character").action], ["Suficiente", null]);
  const short = providerCheck(row({ free: 2000, failure: "supplier balance unavailable", level: "YELLOW" }), "character");
  assert.equal(short.verdict, "Insuficiente");
  assert.match(short.action!, /Recarga al menos 10[.,]000 caracteres \(≈ 1\.00 USD\) en ElevenLabs \(voz\)/);
  const red = providerCheck(row({ level: "RED", free: null, failure: "supplier balance unavailable" }), "character");
  assert.equal(red.verdict, "Insuficiente");
  const unknown = providerCheck(row({ level: "UNKNOWN", free: null, failure: "supplier balance unavailable" }), "character");
  assert.equal(unknown.verdict, "Sin verificar");
  assert.match(unknown.action!, /Se consulta al proveedor al iniciar.*no se inicia ni se cobra/);
  const cap = providerCheck(row({ provider: "openai", failure: "provider funded spend ceiling", usd: 3 }), "usd");
  assert.equal(cap.verdict, "Insuficiente");
  assert.match(cap.action!, /tope de gasto diario o mensual configurado para OpenAI/);
  // Credit-priced providers convert the shortfall to USD with the demand's own rate.
  const credits = providerCheck(row({ provider: "runway", units: 50, free: 20, usd: 0.5, level: "GREEN", failure: "supplier balance unavailable" }), "credit");
  assert.match(credits.action!, /Recarga al menos 30 créditos \(≈ 0\.30 USD\) en Runway/);
});

test("bloqueo visual: mensaje accionable con identidades, pruebas y proporción de tarjetas (caso Bigfoot)", () => {
  const v: VisualCheck = { applies: true, ready: false, codes: ["HERO_EVIDENCE_COVERAGE_MISSING", "HERO_IDENTITY_COVERAGE_MISSING", "OPENING_TEXT_CARD_RUN", "TEXT_FALLBACK_RATIO"],
    missingHeroIdentities: 2, missingHeroEvidence: 4, textCardRatio: 0.41, maxTextCardRatio: 0.25, verifiedAssets: 0 };
  const m = visualBlockMessage(v);
  assert.match(m, /2 identidad\(es\).*4 prueba\(s\).*41 % de escenas acabarían en tarjeta de texto \(máximo 25 %\).*3 o más tarjetas seguidas/);
  assert.match(m, /no se confirmó, reservó ni cobró nada/);
});

/** Fake service: policies, supply state and spend RPCs (no network). */
function fakeService(states: Record<string, { level: string; free: number | null }>, spend = 0) {
  const policies = [
    { provider: "__global__", enabled: true, unit: "usd", unit_cost_usd: 1, daily_cap_usd: 40, monthly_cap_usd: 300, timezone: "UTC", evidence: "fixture" },
    { provider: "elevenlabs", enabled: true, unit: "character", unit_cost_usd: 0.0001, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "UTC", evidence: "fixture" },
    { provider: "openai", enabled: true, unit: "usd", unit_cost_usd: 1, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "UTC", evidence: "fixture" },
  ];
  return {
    from: () => ({ select: () => ({ in: async () => ({ data: policies, error: null }) }) }),
    rpc: async (fn: string, args: { p_provider?: string }) => fn === "pi_supply_state" ? { data: states[args.p_provider!] ?? { level: "UNKNOWN", free: null }, error: null } : { data: spend, error: null },
  } as never;
}
const plan = { strategy: "balanced", estimatedProviderCostUsd: 0.61, estimatedVoiceCostUsd: 0.5, providers: { voice: "elevenlabs", image: "openai", aiVideo: "runway", footage: "pexels", music: "curated-library" },
  aiImageCount: 2, allocation: { maxGenerativeUsd: 0.11, maxAiImageGenerations: 2, maxAiVideoClips: 0 } } as unknown as ProductionPlan;
const scriptJson = { topic: "t", beats: [{ narration: "x".repeat(5000) }] };

test("pre-flight completo: mismas demandas que el inicio, sin refrescar saldos al cargar la página", async () => {
  const ok = await strategyPreflight(fakeService({ elevenlabs: { level: "GREEN", free: 100000 }, openai: { level: "GREEN", free: 10 } }), { strategy: "balanced", plan, scriptJson, env: { LONG_FORM_MAX_TOTAL_USD: "12" } });
  assert.equal(ok.capacityReady, true);
  assert.deepEqual(ok.providers.map((p) => [p.provider, p.verdict]), [["elevenlabs", "Suficiente"], ["openai", "Suficiente"]]);
  assert.equal(ok.withinLimit, true);
  const low = await strategyPreflight(fakeService({ elevenlabs: { level: "YELLOW", free: 1000 }, openai: { level: "GREEN", free: 10 } }), { strategy: "balanced", plan, scriptJson });
  assert.equal(low.capacityReady, false);
  assert.match(low.providers.find((p) => p.provider === "elevenlabs")!.action!, /Recarga al menos 4[.,]000 caracteres/);
  const stale = await strategyPreflight(fakeService({ openai: { level: "GREEN", free: 10 } }), { strategy: "balanced", plan, scriptJson });
  assert.equal(stale.providers.find((p) => p.provider === "elevenlabs")!.verdict, "Sin verificar");
  const over = await strategyPreflight(fakeService({}), { strategy: "balanced", plan, scriptJson, env: { LONG_FORM_MAX_TOTAL_USD: "0.5" } });
  assert.equal(over.withinLimit, false);
  const broken = await strategyPreflight({ from: () => { throw new Error("db down"); } } as never, { strategy: "balanced", plan, scriptJson });
  assert.match(broken.globalNote!, /Se comprobará al iniciar/);
});

test("servidor: la verificación visual corre antes de reservar; la reserva solo se libera si el intento nunca empezó", () => {
  const src = readFileSync(path.join(__dirname, "../../../app/api/generate/[id]/render/route.ts"), "utf8");
  const visual = src.indexOf("await visualCheck(service"), reserve = src.indexOf("await reserveJobSupply("), cas = src.indexOf('.update({\n          supply_wait_started_at');
  assert.ok(visual > 0 && visual < reserve && reserve < cas);
  const release = src.indexOf("await releaseUnusedJobSupply(");
  assert.ok(release > src.indexOf('.eq("progress_stage", "queued")\n          .select("id")'), "release only after the failed-CAS that proves the attempt never started");
  assert.match(src.slice(release - 400, release), /failed\?\.length === 1/);
  const confirm = readFileSync(path.join(__dirname, "confirm-production.ts"), "utf8");
  assert.ok(confirm.indexOf("visualCheck(service") < confirm.indexOf(".update({ long_form_production_plan: plan"), "confirm never locks a plan the worker would refuse");
  const produce = readFileSync(path.join(__dirname, "produce.ts"), "utf8");
  assert.match(produce, /await visualReleasePreflight\(/, "the worker and the page share one implementation");
});

test("actualizar disponibilidad: reutiliza lecturas < 60 s, errores claros sin detalles, manuales no se consultan", async () => {
  const { refreshDemandedCapacity, REFRESH_MIN_INTERVAL_MS } = await import("./refresh-capacity");
  const now = Date.parse("2026-10-08T12:00:00Z");
  const lastApi: Record<string, string> = { elevenlabs: new Date(now - 20_000).toISOString(), runway: new Date(now - REFRESH_MIN_INTERVAL_MS - 1).toISOString() };
  const svc = { from: () => { let p = ""; const q = { select: () => q, eq: (k: string, v: string) => { if (k === "provider") p = v; return q; }, order: () => q, limit: () => q, maybeSingle: async () => ({ data: lastApi[p] ? { checked_at: lastApi[p] } : null }) }; return q; } } as never;
  const calls: string[] = [];
  const out = await refreshDemandedCapacity(svc, ["elevenlabs", "elevenlabs", "runway", "heygen", "openai", "anthropic"], { now: () => now,
    refresh: async (_s, p) => { calls.push(p); if (p === "runway") throw new Error("401 account acct_secret@example.com"); return false; } });
  assert.deepEqual(calls, ["runway", "heygen"], "elevenlabs read 20 s ago is reused; duplicates collapse");
  assert.deepEqual(out.reused, ["elevenlabs"]);
  assert.deepEqual(out.manual, ["openai", "anthropic"]);
  assert.match(out.errors.runway, /Runway no respondió/);
  assert.doesNotMatch(JSON.stringify(out), /secret|401|@/);
  assert.match(out.errors.heygen, /credencial de HeyGen no está configurada/);
});

test("origen del saldo: API del proveedor vs registro manual, y el error de actualización llega al panel", async () => {
  const { sourceLabel } = await import("./production-preflight");
  assert.equal(sourceLabel("provider_api"), "consultado al proveedor");
  assert.match(sourceLabel("manual_entry")!, /manualmente \(no consultado al proveedor\)/);
  const svc = fakeService({ elevenlabs: { level: "UNKNOWN", free: null }, openai: { level: "GREEN", free: 10 } }) as unknown as { from: unknown };
  const base = svc.from as () => unknown;
  const snapRows: Record<string, { checked_at: string; reliability: string; health: string }> = { elevenlabs: { checked_at: "2026-10-08T11:00:00Z", reliability: "provider_api", health: "ok" }, openai: { checked_at: "2026-10-06T05:05:00Z", reliability: "manual_entry", health: "ok" } };
  (svc as { from: unknown }).from = (table: string) => {
    if (table !== "pi_capacity_snapshots") return base();
    let p = ""; const q = { select: () => q, eq: (_k: string, v: string) => { p = v; return q; }, order: () => q, limit: () => q, maybeSingle: async () => ({ data: snapRows[p] ?? null }) };
    return q;
  };
  const r = await strategyPreflight(svc as never, { strategy: "balanced", plan, scriptJson, refreshErrors: { elevenlabs: "ElevenLabs no respondió" } });
  const el = r.providers.find((p) => p.provider === "elevenlabs")!, oa = r.providers.find((p) => p.provider === "openai")!;
  assert.deepEqual([el.verdict, el.source, el.refreshError], ["Sin verificar", "provider_api", "ElevenLabs no respondió"], "UNKNOWN never becomes sufficient");
  assert.deepEqual([oa.source, oa.snapshotAt], ["manual_entry", "2026-10-06T05:05:00Z"]);
});

test("ruta de actualización: solo dueño, solo consulta saldos, nunca reserva ni cobra", () => {
  const src = readFileSync(path.join(__dirname, "../../../app/api/generate/[id]/refresh-capacity/route.ts"), "utf8");
  assert.match(src, /lookupConfigurableRequest\(supabase, user, id/);
  assert.match(src, /refreshDemandedCapacity\(service, providers\)/);
  assert.doesNotMatch(src, /reserveJobSupply|pi_reserve_job_supply|guardPaidCall|synthesize|\.insert\(|\.update\(/);
  const ui = readFileSync(path.join(__dirname, "../../../app/dashboard/long-form/configure/[id]/ConfigureProduction.tsx"), "utf8");
  assert.match(ui, /setCooldownUntil\(started \+ 60_000\)/);
  assert.match(ui, /disabled=\{refresh\.cooldownSeconds > 0\}/);
});
