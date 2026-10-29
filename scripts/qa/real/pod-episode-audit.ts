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
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("EPISODE_ID inválido");
  const { data: e } = await db.from("podcast_studio_episodes").select("status,mode,title,authorized_usd,authorized_at,estimated_usd,cost_usd,run_started_at,run_token,error,progress,created_at,updated_at").eq("id", id).maybeSingle();
  console.log("EPISODE", JSON.stringify({ ...e, run_token: e?.run_token ? "presente" : null, progress: e?.progress ? "presente" : null }));
  const { data: ops } = await db.from("podcast_studio_operations").select("provider,op,state,reserved_usd,actual_usd,created_at").eq("episode_id", id);
  console.log("STUDIO_OPS", (ops ?? []).length, JSON.stringify(ops));
  const { data: pops } = await db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd,created_at").like("project_id", `%${id}%`);
  console.log("PLATFORM_OPS", (pops ?? []).length, JSON.stringify(pops));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
