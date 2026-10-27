/**
 * Consumo de HeyGen en solo lectura (USD 0). Nada se inserta: ni snapshots ni filas. Lee:
 *  - historial de saldos ya guardados (pi_capacity_snapshots, heygen, desde DESDE);
 *  - saldo actual del wallet (GET /v3/users/me, sin persistir);
 *  - videos del proveedor en el intervalo (GET de listado; solo hora, estado y duración; ids abreviados con hash);
 *  - operaciones HeyGen registradas por Atomivid en el intervalo (estudio y libro pi_*).
 */
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { heygenApiSnapshot } from "@/lib/supply/heygen";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const out = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const since = process.env.DESDE ?? "2026-10-27T00:00:00Z";
  const service = createServiceClient();
  const { data: snaps } = await service.from("pi_capacity_snapshots").select("available,unit,health,checked_at").eq("provider", "heygen").gte("checked_at", since).order("checked_at");
  out("SNAPSHOTS", snaps ?? []);
  const now = await heygenApiSnapshot(fetch, process.env, new Date().toISOString());
  out("WALLET_NOW", { available: now.available, unit: now.unit, health: now.health, at: now.lastCheckedAt });
  const key = process.env.HEYGEN_API_KEY ?? "";
  for (const url of ["https://api.heygen.com/v1/video.list?limit=100", "https://api.heygen.com/v2/videos?limit=100"]) {
    try {
      const r = await fetch(url, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => null) as { data?: { videos?: Record<string, unknown>[] } | Record<string, unknown>[] } | null;
      const list = (Array.isArray(j?.data) ? j?.data : (j?.data as { videos?: Record<string, unknown>[] } | undefined)?.videos) ?? [];
      const rows = list.map((v) => ({ id: h(String(v.video_id ?? v.id ?? "")), created: v.created_at, status: v.status, duration: v.duration ?? null, type: v.type ?? null }))
        .filter((v) => { const t = typeof v.created === "number" ? Number(v.created) * 1000 : Date.parse(String(v.created)); return Number.isFinite(t) && t >= Date.parse(since); });
      out("PROVIDER_VIDEOS", { endpoint: new URL(url).pathname, http: r.status, total: list.length, inWindow: rows });
    } catch (e) { out("PROVIDER_VIDEOS", { endpoint: new URL(url).pathname, error: e instanceof Error ? e.name : "error" }); }
  }
  const { data: studio } = await service.from("podcast_studio_operations").select("episode_id,op,state,reserved_usd,actual_usd,created_at,updated_at").eq("provider", "heygen").gte("created_at", since).order("created_at");
  out("STUDIO_HEYGEN_OPS", (studio ?? []).map((o) => ({ ...o, episode_id: h(o.episode_id) })));
  const { data: pi } = await service.from("pi_paid_operations").select("method,status,reserved_usd,committed_usd,created_at").eq("provider", "heygen").gte("created_at", since).order("created_at");
  out("PI_HEYGEN_OPS", pi ?? []);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
