/**
 * PI V1 exam — READ-ONLY migration audit against the real Supabase database.
 * Runs inside a READ ONLY transaction: it cannot create, alter or write anything.
 * Reports: recorded migration history (if any), which objects of 0015-0025 exist,
 * name collisions for the new tables/functions, and live activity (jobs in flight).
 */
import { connectResolved } from "../lib/supabase-db";

const col = (t: string, c: string) => `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='${t}' and column_name='${c}') as v`;
const tbl = (t: string) => `select to_regclass('public.${t}') is not null as v`;
const idx = (i: string) => `select exists(select 1 from pg_indexes where schemaname='public' and indexname='${i}') as v`;
const fn = (f: string) => `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${f}') as v`;
const con = (c: string) => `select exists(select 1 from pg_constraint where conname='${c}') as v`;

const PROBES: Record<string, Record<string, string>> = {
  "0015_avatar_recorded_audio": { "video_requests.recorded_audio_path": col("video_requests", "recorded_audio_path"), "constraint video_requests_recorded_audio_path_check": con("video_requests_recorded_audio_path_check") },
  "0016_long_form_mode": { "video_requests.aspect_ratio": col("video_requests", "aspect_ratio"), "video_requests.long_form_stage": col("video_requests", "long_form_stage") },
  "0017_avatar_narration_source": { "video_requests.avatar_narration_source": col("video_requests", "avatar_narration_source") },
  "0019_long_form_production_plan": { "video_requests.long_form_production_plan": col("video_requests", "long_form_production_plan"), "video_requests.long_form_progress": col("video_requests", "long_form_progress") },
  "0020_audiovisual_direction (unmerged branch)": { "video_requests.audiovisual_selection": col("video_requests", "audiovisual_selection"), "video_requests.audiovisual_direction": col("video_requests", "audiovisual_direction") },
  "0021_voices_and_text_to_speech (unmerged branch)": { "video_requests.voice_choice": col("video_requests", "voice_choice"), "table user_voices": tbl("user_voices"), "table tts_jobs": tbl("tts_jobs"), "fn enforce_tts_monthly_limit": fn("enforce_tts_monthly_limit") },
  "0022_tts_podcast (unmerged branch)": { "tts_jobs.long_pilot": col("tts_jobs", "long_pilot"), "tts_jobs.mix_status": col("tts_jobs", "mix_status"), "index tts_jobs_one_active_long_pilot": idx("tts_jobs_one_active_long_pilot") },
  "0023_production_intelligence (new, collision check)": Object.fromEntries(["pi_paid_operations", "pi_telemetry_events", "pi_policy_versions", "pi_policy_history", "pi_memory_snapshots", "pi_project_pins", "pi_asset_transitions", "pi_provider_accounts", "pi_capacity_snapshots"].map((t) => [`table ${t}`, tbl(t)]).concat([["fn pi_reject_mutation", fn("pi_reject_mutation")], ["fn pi_paid_operation_forward_only", fn("pi_paid_operation_forward_only")]])),
  "0024_distribution_youtube (new, collision check)": Object.fromEntries(["yt_channels", "yt_oauth_connections", "yt_metric_rows", "yt_video_observations", "yt_launch_packages"].map((t) => [`table ${t}`, tbl(t)])),
  "0025_delivery_assets (new, collision check)": { "table delivery_assets": tbl("delivery_assets") },
};

async function main() {
  const { client, connection } = await connectResolved();
  const out: Record<string, unknown> = { source: connection.source, projectRef: connection.ref, at: new Date().toISOString() };
  try {
    await client.query("begin transaction read only");
    out.readOnly = (await client.query("show transaction_read_only")).rows[0].transaction_read_only;
    const hist = (await client.query("select to_regclass('supabase_migrations.schema_migrations') is not null as v")).rows[0].v;
    out.supabaseMigrationHistoryTable = hist;
    if (hist) out.supabaseMigrationHistory = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    const probes: Record<string, Record<string, boolean>> = {};
    for (const [m, ps] of Object.entries(PROBES)) { probes[m] = {}; for (const [k, q] of Object.entries(ps)) probes[m][k] = (await client.query(q)).rows[0].v; }
    out.probes = probes;
    out.publicTablesLike = (await client.query("select table_name from information_schema.tables where table_schema='public' and (table_name like 'pi\\_%' or table_name like 'yt\\_%' or table_name like 'delivery%' or table_name like 'tts%' or table_name like 'user_voices') order by 1")).rows.map((r) => r.table_name);
    out.videoRequestsByStatus = (await client.query("select status, count(*)::int as n, max(created_at) as last_created from public.video_requests group by status order by status")).rows;
    out.processingRecent = (await client.query("select id, mode, status, long_form_stage, created_at from public.video_requests where status in ('pending','processing') order by created_at desc limit 10")).rows;
    out.activeSessions = (await client.query("select count(*)::int as n from pg_stat_activity where state = 'active' and pid <> pg_backend_pid()")).rows[0].n;
    await client.query("rollback");
  } finally {
    await client.end();
  }
  console.log("@@PI_MIGRATION_AUDIT " + JSON.stringify(out));
}
main().catch((e) => { console.error("audit failed: " + (e instanceof Error ? e.message : String(e))); process.exitCode = 1; });
