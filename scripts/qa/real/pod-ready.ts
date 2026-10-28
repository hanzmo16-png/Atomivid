/**
 * ¿Puede arrancar hoy un episodio de estudio ilustrado? (USD 0, solo lectura). Misma regla que el worker
 * (studio-worker.ts → ensureJobSupplyReady) con una demanda representativa (10 min, dos anfitriones, Recraft) más lo
 * gastado por el estudio en 24 h, SIN refrescar (no inserta snapshots). Aparte, lee el saldo actual de cada proveedor
 * con su GET de facturación oficial y lo evalúa sin guardarlo. Nunca genera nada.
 */
import { createServiceClient } from "@/lib/supabase/service";
import { STUDIO_OPS_TABLE } from "@/lib/podcast/v3/store";
import { ensureJobSupplyReady } from "@/lib/supply/readiness";
import { studioSupplyDemands, studioSpendByProvider } from "@/lib/podcast/v3/readiness";
import { elevenLabsSnapshot } from "@/lib/production-intelligence/capacity/adapters";
import { assessCapacity } from "@/lib/production-intelligence/capacity/capacity";
import { heygenApiSnapshot } from "@/lib/supply/heygen";
import { falApiSnapshot, falBillingKey } from "@/lib/supply/fal";

async function main() {
  const service = createServiceClient();
  const { data: policies } = await service.from("pi_supply_policies").select("provider,enabled,daily_cap_usd,monthly_cap_usd,max_daily_calls")
    .in("provider", ["elevenlabs", "heygen", "recraft", "__global__"]);
  console.log("POLICIES", JSON.stringify(policies));
  const { data: recent } = await service.from(STUDIO_OPS_TABLE).select("provider,state,reserved_usd,actual_usd").gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
  const spent = studioSpendByProvider(recent ?? []);
  // 10 min de diálogo ≈ 9 000 caracteres de voz; avatares HeyGen en los primeros planos; 20 ilustraciones Recraft.
  const needs = { ttsChars: 9000, ttsUsd: 1.8, ttsCalls: 60, avatarUsd: 2, avatarCalls: 6, imagesUsd: 0.8, imagesCalls: 20 };
  const demands = studioSupplyDemands(needs, spent);
  const r = await ensureJobSupplyReady(service, demands, { refresh: false });
  console.log("READINESS", JSON.stringify({ spent24h: spent, demands, ready: r.ready, failure: r.failure ?? null,
    providers: r.providers.map((p) => ({ p: p.provider, level: p.level, free: p.free, ok: p.ok, failure: p.failure ?? null })) }));
  const at = new Date().toISOString();
  const live: Record<string, unknown> = {};
  const probe = async (name: string, f: () => Promise<Parameters<typeof assessCapacity>[0]>) => {
    try { const s = await f(); live[name] = { available: s.available, unit: s.unit, health: s.health, status: assessCapacity(s).status }; }
    catch (e) { live[name] = { error: e instanceof Error ? e.message.slice(0, 120) : "error" }; }
  };
  if (process.env.ELEVENLABS_API_KEY) await probe("elevenlabs", () => elevenLabsSnapshot(fetch, process.env, 0, 0, at));
  if (process.env.HEYGEN_API_KEY) await probe("heygen", () => heygenApiSnapshot(fetch, process.env, at));
  if (falBillingKey(process.env)) await probe("recraft", () => falApiSnapshot(fetch, process.env, at));
  console.log("LIVE", JSON.stringify(live));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
