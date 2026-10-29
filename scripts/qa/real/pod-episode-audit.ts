/**
 * Auditoría de SOLO LECTURA de un episodio del estudio (incidente ec30c594, 2026-10-29): estado y autorización, lo que
 * vio el worker, operaciones del libro del estudio, operaciones pagadas de la plataforma ligadas al episodio, y las
 * ejecuciones de podcast-video recientes. Nunca escribe, despacha ni reintenta.
 */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const id = process.env.EPISODE_ID ?? "";
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  if (id === "activos") {
    // Producciones en curso (antes de fusionar/desplegar algo que toque el estudio): solo lectura, sin datos personales.
    const { data: st, error: e1 } = await db.from("podcast_studio_episodes").select("id,status,run_started_at,updated_at").in("status", ["authorized", "generating"]);
    console.log("ACTIVE_STUDIO", (st ?? []).length, JSON.stringify((st ?? []).map((r) => ({ id: String(r.id).slice(0, 8), status: r.status, run_started_at: r.run_started_at, updated_at: r.updated_at }))));
    const { data: cl, error: e2 } = await db.from("podcast_episodes").select("id,video_status").in("video_status", ["queued", "processing", "scheduled"]);
    console.log("ACTIVE_CLASSIC", (cl ?? []).length, JSON.stringify((cl ?? []).map((r) => ({ id: String(r.id).slice(0, 8), video_status: r.video_status }))));
    const { data: rs, error: e3 } = await db.from("podcast_studio_operations").select("op,state,created_at").eq("state", "reserved");
    // Un error de consulta NO se lee como «cero activos».
    if (e1 || e2 || e3) { console.log("ACTIVE_QUERY_ERROR", [e1, e2, e3].map((e) => e?.message ?? null).join(" | ")); process.exitCode = 1; }
    console.log("OPEN_RESERVATIONS", (rs ?? []).length, JSON.stringify(rs));
    return;
  }
  if (id === "todos") {
    // Todos los episodios del estudio (solo lectura): estado, rutas de entrega y si el archivo existe en Storage.
    const { data: all, error } = await db.from("podcast_studio_episodes").select("id,user_id,status,mode,spec,video_path,audio_path,progress,error,authorized_at,run_started_at,created_at,updated_at").order("created_at", { ascending: true });
    if (error) { console.log("ALL_ERROR", error.message); process.exitCode = 1; return; }
    const exists = async (p: string | null) => { if (!p) return null; const dir = p.split("/").slice(0, -1).join("/"), name = p.split("/").pop(); const { data } = await db.storage.from("videos").list(dir, { search: name }); return !!data?.some((f) => f.name === name); };
    const users: string[] = [];
    for (const r of all ?? []) {
      if (!users.includes(String(r.user_id))) users.push(String(r.user_id));
      const pr = r.progress as { stage?: string; pct?: number; stages?: object } | null;
      console.log("EP", JSON.stringify({ id: String(r.id).slice(0, 8), user: `u${users.indexOf(String(r.user_id)) + 1}`, status: r.status, mode: r.mode, output: (r.spec as { output?: string } | null)?.output ?? null,
        video: r.video_path ? "sí" : null, video_exists: await exists(r.video_path), audio: r.audio_path ? "sí" : null, audio_exists: await exists(r.audio_path),
        progress: pr ? { stage: pr.stage, pct: pr.pct, stages: Object.keys(pr.stages ?? {}).length } : null, error: r.error ? String(r.error).slice(0, 120) : null, authorized_at: r.authorized_at, run_started_at: r.run_started_at, created_at: r.created_at, updated_at: r.updated_at }));
    }
    return;
  }
  if (id === "recientes") {
    // Diagnóstico de un intento sin respuesta (solo lectura, sin datos personales): episodios del estudio y clásicos de
    // las últimas 12 h (cualquier estado, incluso «draft»), operaciones del libro y estado de Recraft.
    const since = new Date(Date.now() - 12 * 3600_000).toISOString();
    const { data: st, error: e1 } = await db.from("podcast_studio_episodes").select("id,status,mode,spec,estimated_usd,authorized_usd,authorized_at,run_started_at,error,progress,created_at,updated_at").gte("updated_at", since).order("created_at", { ascending: true });
    console.log("RECENT_STUDIO", (st ?? []).length, e1?.message ?? "", JSON.stringify((st ?? []).map((r) => ({ id: String(r.id).slice(0, 8), status: r.status, mode: r.mode, output: (r.spec as { output?: string } | null)?.output ?? null,
      provider: (r.spec as { visual?: { provider?: string } } | null)?.visual?.provider ?? null, minutes: (r.spec as { minutes?: number } | null)?.minutes ?? null, estimated_usd: r.estimated_usd, authorized_usd: r.authorized_usd,
      authorized_at: r.authorized_at, run_started_at: r.run_started_at, error: r.error ? String(r.error).slice(0, 200) : null, progress: r.progress ? { stage: (r.progress as { stage?: string }).stage, pct: (r.progress as { pct?: number }).pct, stages: Object.keys((r.progress as { stages?: object }).stages ?? {}) } : null,
      created_at: r.created_at, updated_at: r.updated_at }))));
    const { data: ops, error: e2 } = await db.from("podcast_studio_operations").select("episode_id,provider,op,state,created_at").gte("created_at", since);
    const byEp: Record<string, Record<string, number>> = {};
    for (const o of ops ?? []) { const k = String(o.episode_id).slice(0, 8); byEp[k] ??= {}; byEp[k][`${o.op}:${o.state}`] = (byEp[k][`${o.op}:${o.state}`] ?? 0) + 1; }
    console.log("RECENT_STUDIO_OPS", (ops ?? []).length, e2?.message ?? "", JSON.stringify(byEp));
    const { data: cl, error: e3 } = await db.from("podcast_episodes").select("id,status,video_status,created_at").gte("created_at", since);
    console.log("RECENT_CLASSIC", (cl ?? []).length, e3?.message ?? "", JSON.stringify((cl ?? []).map((r) => ({ id: String(r.id).slice(0, 8), status: r.status, video_status: r.video_status, created_at: r.created_at }))));
    const { data: rs, error: e4 } = await db.rpc("pi_supply_state", { p_provider: "recraft" });
    console.log("RECRAFT_STATE", e4?.message ?? "", JSON.stringify(rs));
    const { data: sn } = await db.from("pi_capacity_snapshots").select("available,unit,reliability,status,checked_at").eq("provider", "recraft").order("checked_at", { ascending: false }).limit(3);
    console.log("RECRAFT_SNAPSHOTS", JSON.stringify(sn));
    if (e1 || e2 || e3) process.exitCode = 1;
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("EPISODE_ID inválido");
  const { data: e } = await db.from("podcast_studio_episodes").select("status,mode,title,authorized_usd,authorized_at,estimated_usd,cost_usd,run_started_at,run_token,error,progress,created_at,updated_at").eq("id", id).maybeSingle();
  console.log("EPISODE", JSON.stringify({ ...e, run_token: e?.run_token ? "presente" : null, progress: e?.progress ? "presente" : null }));
  const { data: ops } = await db.from("podcast_studio_operations").select("provider,op,state,reserved_usd,actual_usd,created_at").eq("episode_id", id);
  console.log("STUDIO_OPS", (ops ?? []).length, JSON.stringify(ops));
  const { data: pops } = await db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd,created_at").like("project_id", `%${id}%`);
  console.log("PLATFORM_OPS", (pops ?? []).length, JSON.stringify(pops));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
