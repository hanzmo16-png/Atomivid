/**
 * Disponibilidad de proveedores para el reintento de P2, con la MISMA regla que el worker (studio-worker.ts → readiness):
 * ensureJobSupplyReady con la demanda del episodio + lo gastado por el estudio en 24 h. Solo GET de facturación
 * (refresco del saldo cuando está sin verificar); nunca generación. Imprime niveles, libres y el presupuesto restante.
 */
import { createServiceClient } from "@/lib/supabase/service";
import { STUDIO_TABLE, STUDIO_OPS_TABLE } from "@/lib/podcast/v3/store";
import { ensureJobSupplyReady } from "@/lib/supply/readiness";
import { studioSupplyDemands, studioSpendByProvider } from "@/lib/podcast/v3/readiness";

async function main() {
  const episode = process.env.EPISODE_ID ?? "";
  const service = createServiceClient();
  const { data: row } = await service.from(STUDIO_TABLE).select("status,estimate,authorized_usd,run_started_at").eq("id", episode).single();
  const est = (row?.estimate ?? {}) as { lines?: { concept: string; usd: number }[] };
  const line = (c: string) => est.lines?.find((l) => l.concept === c)?.usd ?? 0;
  const { data: ops } = await service.from(STUDIO_OPS_TABLE).select("provider,state,reserved_usd,actual_usd").eq("episode_id", episode);
  const { data: recent } = await service.from(STUDIO_OPS_TABLE).select("provider,state,reserved_usd,actual_usd").gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
  const vozDetail = String((est.lines?.find((l) => l.concept === "voz") as { detail?: string } | undefined)?.detail ?? "");
  const chars = Number(/(\d+) caracteres/.exec(vozDetail)?.[1] ?? 0);
  const needs = { ttsChars: chars, ttsUsd: line("voz"), avatarUsd: line("avatar"), imagesUsd: line("imagenes") };
  const demands = studioSupplyDemands(needs, studioSpendByProvider(recent ?? []));
  const r = await ensureJobSupplyReady(service, demands);
  const settled = (ops ?? []).filter((o) => o.state === "settled").reduce((n, o) => n + Number(o.actual_usd ?? o.reserved_usd), 0);
  console.log("SUPPLY", JSON.stringify({ episodeStatus: row?.status, demands, ready: r.ready, failure: r.failure ?? null, providers: r.providers.map((p) => ({ p: p.provider, refreshed: p.refreshed, level: p.level, free: p.free, ok: p.ok, failure: p.failure ?? null })) }));
  const spent = studioSpendByProvider(recent ?? []);
  console.log("BUDGET", JSON.stringify({ episodeSettledUsd: Math.round(settled * 1e4) / 1e4, studioSpent24hUsd: spent }));
  if (!r.ready) process.exitCode = 1;
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
