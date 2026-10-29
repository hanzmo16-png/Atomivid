/**
 * Auditoría de SOLO LECTURA de un episodio del estudio (incidente ec30c594, 2026-10-29): estado y autorización, lo que
 * vio el worker, operaciones del libro del estudio, operaciones pagadas de la plataforma ligadas al episodio, y las
 * ejecuciones de podcast-video recientes. Nunca escribe, despacha ni reintenta.
 */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const id = process.env.EPISODE_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("EPISODE_ID inválido");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: e } = await db.from("podcast_studio_episodes").select("status,mode,title,authorized_usd,authorized_at,estimated_usd,cost_usd,run_started_at,run_token,error,progress,created_at,updated_at").eq("id", id).maybeSingle();
  console.log("EPISODE", JSON.stringify({ ...e, run_token: e?.run_token ? "presente" : null, progress: e?.progress ? "presente" : null }));
  const { data: ops } = await db.from("podcast_studio_operations").select("provider,op,state,reserved_usd,actual_usd,created_at").eq("episode_id", id);
  console.log("STUDIO_OPS", (ops ?? []).length, JSON.stringify(ops));
  const { data: pops } = await db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd,created_at").like("project_id", `%${id}%`);
  console.log("PLATFORM_OPS", (pops ?? []).length, JSON.stringify(pops));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
