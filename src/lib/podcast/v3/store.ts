/**
 * Podcast 3.0 — persistencia (Supabase, service role) de episodios de estudio y su libro de operaciones.
 * Tablas nuevas (propuesta supabase/proposals/20261024140000_podcast_v3_studio.sql, NO aplicada). Si no existen,
 * las rutas responden 503 «requiere migración» y nada se cobra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerRow, StudioLedger } from "./cost";
import type { RunGuard } from "./pipeline";

export const STUDIO_TABLE = "podcast_studio_episodes";
export const STUDIO_OPS_TABLE = "podcast_studio_operations";
export const STUDIO_COLUMNS = "id,user_id,title,mode,spec,status,estimate,estimated_usd,authorized_usd,authorized_at,run_started_at,progress,result,video_path,audio_path,cost_usd,error,created_at,updated_at";
export type StudioStatus = "draft" | "authorized" | "generating" | "ready" | "failed";
export type StudioEpisodeRow = { id: string; user_id: string; title: string; mode: string; spec: unknown; status: StudioStatus; estimate: unknown; estimated_usd: number | null; authorized_usd: number | null;
  authorized_at: string | null; run_started_at: string | null; progress: { stage: string; pct: number } | null; result: Record<string, unknown> | null; video_path: string | null; audio_path: string | null; cost_usd: number | null; error: string | null; created_at: string; updated_at: string };
export class StudioMigrationMissingError extends Error { detail?: string; constructor(detail?: string) { super("Podcast 3.0 requiere aplicar la migración del estudio (pendiente de autorización)."); this.name = "StudioMigrationMissingError"; this.detail = detail; } }
const missing = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|schema cache/i.test(e.message ?? ""));

export function supabaseStudioLedger(service: SupabaseClient, userId: string): StudioLedger {
  return {
    async get(key) {
      const { data, error } = await service.from(STUDIO_OPS_TABLE).select("*").eq("key", key).maybeSingle();
      if (missing(error)) throw new StudioMigrationMissingError(`${error?.code ?? ""} ${error?.message ?? ""}`.trim()); if (error) throw new Error("LEDGER_READ");
      return data ? { key: data.key, owner: data.user_id, episode: data.episode_id, provider: data.provider, op: data.op, state: data.state, reserved_usd: Number(data.reserved_usd), actual_usd: data.actual_usd == null ? null : Number(data.actual_usd), result: data.result ?? undefined } : undefined;
    },
    async put(r: LedgerRow) {
      if (r.owner !== userId) throw new Error("ACCESO_DENEGADO");
      const { error } = await service.from(STUDIO_OPS_TABLE).upsert({ key: r.key, user_id: r.owner, episode_id: r.episode, provider: r.provider, op: r.op, state: r.state, reserved_usd: r.reserved_usd, actual_usd: r.actual_usd, result: r.result ?? null, updated_at: new Date().toISOString() });
      if (missing(error)) throw new StudioMigrationMissingError(`${error?.code ?? ""} ${error?.message ?? ""}`.trim()); if (error) throw new Error("LEDGER_WRITE");
    },
    async byEpisode(episode) {
      const { data, error } = await service.from(STUDIO_OPS_TABLE).select("*").eq("episode_id", episode).eq("user_id", userId);
      if (missing(error)) throw new StudioMigrationMissingError(`${error?.code ?? ""} ${error?.message ?? ""}`.trim()); if (error) throw new Error("LEDGER_READ");
      return (data ?? []).map((d) => ({ key: d.key, owner: d.user_id, episode: d.episode_id, provider: d.provider, op: d.op, state: d.state, reserved_usd: Number(d.reserved_usd), actual_usd: d.actual_usd == null ? null : Number(d.actual_usd), result: d.result ?? undefined }));
    },
  };
}

/** Exclusión por compare-and-set sobre la fila: solo una ejecución «generating» por episodio (o una vencida). */
export function supabaseRunGuard(service: SupabaseClient, staleMs = 45 * 60_000): RunGuard {
  return {
    async acquire(episode, token) {
      const uuid = toUuid(token);
      const cur = await service.from(STUDIO_TABLE).select("status, run_started_at").eq("id", episode).maybeSingle();
      if (missing(cur.error)) throw new StudioMigrationMissingError(`${cur.error?.code ?? ""} ${cur.error?.message ?? ""}`.trim());
      if (cur.error || !cur.data) return false;
      const row = cur.data as { status: string; run_started_at: string | null };
      const stale = row.status === "generating" && (!row.run_started_at || Date.parse(row.run_started_at) < Date.now() - staleMs);
      // Solo con una autorización vigente (o un runner perdido): un episodio «failed» exige que el dueño vuelva a
      // autorizar (failed → authorized en la API); un worker rezagado no lo regenera por su cuenta.
      if (!(row.status === "authorized" || stale)) return false;
      // Compare-and-set: solo gana quien vea el mismo estado (y la misma marca de inicio) que leyó.
      let q = service.from(STUDIO_TABLE).update({ status: "generating", run_token: uuid, run_started_at: new Date().toISOString(), error: null }).eq("id", episode).eq("status", row.status);
      q = row.run_started_at ? q.eq("run_started_at", row.run_started_at) : q.is("run_started_at", null);
      const { data, error } = await q.select("id");
      if (missing(error)) throw new StudioMigrationMissingError(`${error?.code ?? ""} ${error?.message ?? ""}`.trim());
      return !error && (data?.length ?? 0) === 1;
    },
    async release(episode, token) { await service.from(STUDIO_TABLE).update({ run_token: null }).eq("id", episode).eq("run_token", toUuid(token)); },
  };
}
const toUuid = (hex: string) => { const h = (hex + "0".repeat(32)).slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export async function listStudioEpisodes(service: SupabaseClient, userId: string): Promise<(StudioEpisodeRow & { archived_at?: string | null })[] | null> {
  // Con la marca de archivo (biblioteca limpia) si su columna existe; sin ella, la lista sigue igual que antes.
  // Tope de 100 por actividad reciente (updated_at): un episodio viejo editado hoy no queda fuera del tope.
  const q = (cols: string) => service.from(STUDIO_TABLE).select(cols).eq("user_id", userId).order("updated_at", { ascending: false }).limit(100);
  let { data, error } = await q(`${STUDIO_COLUMNS},archived_at`);
  if (error) ({ data, error } = await q(STUDIO_COLUMNS));
  if (error) return null; // tabla ausente (migración no aplicada) → la lista de estudio simplemente no aparece
  return data as unknown as (StudioEpisodeRow & { archived_at?: string | null })[];
}
