/**
 * Read-only production diagnosis for the YouTube Long Form flow (final mission, 2026-10-23).
 * Never calls a paid provider, never writes a row. Prints statuses, counts, stages and the
 * customer-facing error text already shown in the app; never keys, emails, topics or scripts.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readdirSync, appendFileSync } from "node:fs";
import { connectResolved } from "./lib/supabase-db";
import { scriptJobSignature, SCRIPT_JOB_PATH } from "../src/lib/video/long-form/script-job-auth";
import { editorialBlockers } from "../src/lib/video/long-form/editorial";
import { evaluateNarrationDuration } from "../src/lib/video/long-form/duration-budget";

const out = process.env.DIAG_OUT ?? "diag.jsonl";
const h10 = (s: string) => createHash("sha256").update(String(s)).digest("hex").slice(0, 10);
const log = (tag: string, v: unknown) => { const line = `${tag} ${JSON.stringify(v)}`; console.log(line); appendFileSync(out, line + "\n"); };
const clip = (s: unknown, n = 220) => (typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, n) : s ?? null);
const db = () => createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });

async function migrations() {
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
  const { client } = await connectResolved();
  try {
    const applied = new Set<string>((await client.query("select name from public._migrations_applied")).rows.map((r: { name: string }) => r.name.replace(/\.sql$/, "")));
    let sm: string[] = [];
    try { sm = (await client.query("select version from supabase_migrations.schema_migrations")).rows.map((r: { version: string }) => r.version); } catch { /* optional */ }
    const missing = files.filter((f) => !applied.has(f) && !sm.some((v) => f.startsWith(v)));
    log("MIGRATIONS", { repoFiles: files.length, trackedApplied: applied.size, cliTracked: sm.length, missing });
    const cols = (await client.query(`select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('video_requests','documentary_script_jobs') and (column_name like 'long_form%' or column_name like '%voice%' or column_name like '%recraft%' or column_name like '%image%')`)).rows;
    log("COLUMNS", cols.map((c: { table_name: string; column_name: string }) => `${c.table_name}.${c.column_name}`));
  } finally { await client.end(); }
}

async function jobs() {
  const s = db();
  const { data, error } = await s.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(10);
  if (error) return log("SCRIPT_JOBS_ERROR", { code: error.code, message: clip(error.message) });
  for (const j of (data ?? []) as Record<string, any>[]) {
    log("SCRIPT_JOB", { id: String(j.id).slice(0, 8), owner: h10(j.user_id), status: j.status, stage: j.stage, kind: j.failure_kind, code: j.error_code, retries: j.retry_count, rounds: j.editorial_rounds,
      resubmits: j.resubmit_allowance, request: j.request_id ? String(j.request_id).slice(0, 8) : null, created: j.created_at, updated: j.updated_at, error: clip(j.error_message), lang: j.input?.fields?.language, minutes: j.input?.fields?.durationMinutes,
      contract: j.input?.referenceContract, writer: j.input?.writerContract, checkpoint: !!j.editorial_checkpoint });
  }
}

async function requests() {
  const s = db();
  const { data, error } = await s.from("video_requests").select("*").eq("mode", "long_form").order("created_at", { ascending: false }).limit(10);
  if (error) return log("LONG_FORM_ERROR", { code: error.code, message: clip(error.message) });
  for (const r of (data ?? []) as Record<string, any>[]) {
    const set = Object.keys(r).filter((k) => /confirm|voice|image|recraft|visual|budget|cost|plan|music|subtit|caption|thumb/i.test(k) && r[k] !== null && r[k] !== false);
    log("LONG_FORM", { id: String(r.id).slice(0, 8), owner: h10(r.user_id), status: r.status, stage: r.progress_stage, attempts: r.render_attempts, video: !!r.video_path, setCols: set,
      created: r.created_at, updated: r.updated_at, error: clip(r.error_message) });
  }
}

async function supply() {
  const s = db();
  const { data: pol } = await s.from("pi_supply_policies").select("provider,enabled,unit,baseline,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,updated_at");
  log("SUPPLY_POLICIES", pol ?? []);
  const since = new Date(Date.now() - 4 * 86400_000).toISOString();
  const { data: ops, error } = await s.from("pi_paid_operations").select("provider,status,method,committed_usd,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  if (error) return log("LEDGER_ERROR", { code: error.code });
  const agg: Record<string, { n: number; usd: number }> = {};
  for (const o of (ops ?? []) as Record<string, any>[]) { const k = `${o.provider}:${o.status}:${o.method}`; agg[k] ??= { n: 0, usd: 0 }; agg[k].n++; agg[k].usd += Number(o.committed_usd ?? 0); }
  log("LEDGER_4D", agg);
  const { data: alerts } = await s.from("pi_supply_alerts").select("provider,level,created_at,payload").order("created_at", { ascending: false }).limit(8);
  log("SUPPLY_ALERTS", (alerts ?? []).map((a: Record<string, any>) => ({ p: a.provider, l: a.level, at: a.created_at, why: clip(JSON.stringify(a.payload), 160) })));
}

async function vercelProbe() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const id = crypto.randomUUID(), ts = String(Date.now());
  const r = await fetch(`https://atomivid.vercel.app${SCRIPT_JOB_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { "x-script-job": id, "x-script-time": ts, "x-script-signature": scriptJobSignature(key, id, ts), "x-script-probe": "1" } });
  log("VERCEL_SCRIPT_PROBE", { status: r.status, body: clip(await r.text(), 120) });
  for (const p of ["/", "/login", "/dashboard/long-form/new"]) {
    const x = await fetch(`https://atomivid.vercel.app${p}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    log("VERCEL_PAGE", { path: p, status: x.status, location: x.headers.get("location")?.replace(/\?.*/, "") ?? null });
  }
}

async function review() {
  const s = db();
  const { data } = await s.from("documentary_script_jobs").select("id,status,failure_kind,editorial_checkpoint,input,editorial_rounds").eq("status", "failed").eq("failure_kind", "editorial").order("created_at", { ascending: false }).limit(3);
  for (const j of (data ?? []) as Record<string, any>[]) {
    const d = j.editorial_checkpoint, r = d?.review, beats = d?.script?.beats ?? [];
    const words = beats.reduce((n: number, b: any) => n + String(b.narration ?? "").split(/\s+/).filter(Boolean).length, 0);
    let duration: unknown = null;
    try { duration = evaluateNarrationDuration(words, Number(j.input?.fields?.durationMinutes) * 60); } catch (e) { duration = String(e).slice(0, 80); }
    let blockers: string[] = [];
    try { blockers = r ? editorialBlockers(r) : []; } catch (e) { blockers = ["(blockers error) " + String(e).slice(0, 80)]; }
    log("REVIEW", { id: String(j.id).slice(0, 8), pass: d?.pass, rounds: j.editorial_rounds, beats: beats.length, words, duration,
      firstAnswer: r?.firstAnswer?.delivered, ending: r?.ending?.resolvesPromise, endingBeat: r?.ending?.evidence?.beatIndex,
      functions: (r?.sections ?? []).map((x: any) => x.function), findings: (r?.findings ?? []).map((f: any) => `${f.severity}:${f.kind}@${(f.evidence ?? []).map((e: any) => e.beatIndex).join("/")}`),
      blockers: blockers.map((b) => clip(b, 260)) });
  }
}

async function schema() {
  const { client } = await connectResolved();
  try {
    const q = async (sql: string) => (await client.query(sql)).rows;
    log("CONSTRAINTS", (await q(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.video_requests'::regclass and conname in ('video_requests_reel_image_source_valid','video_requests_reel_voice_id_valid','video_requests_mode_check','video_requests_status_check','video_requests_duration_seconds_check')`)).map((r: any) => ({ n: r.conname, d: clip(r.def, 300) })));
    log("TRIGGERS", (await q(`select tgname from pg_trigger where tgrelid='public.video_requests'::regclass and not tgisinternal order by 1`)).map((r: any) => r.tgname));
    log("FN_HAS_LONG_FORM", (await q(`select proname, position('long_form' in prosrc)>0 lf from pg_proc where proname in ('reel_voice_immutable','reel_recraft_immutable')`)));
    log("PROVIDER_ACCOUNTS", await q(`select provider,status,plan from public.pi_provider_accounts order by 1`));
    log("SNAPSHOTS", await q(`select provider, max(checked_at) last from public.pi_capacity_snapshots group by 1 order by 1`).catch((e) => [{ err: String(e.message).slice(0, 80) }]));
  } finally { await client.end(); }
}

const steps: Record<string, () => Promise<void>> = { review, schema, migrations, jobs, requests, supply, vercel: vercelProbe };
(async () => {
  for (const m of (process.argv[2] ?? "").split(",").filter(Boolean)) {
    if (!steps[m]) throw Error(`unknown ${m}`);
    await steps[m]().catch((e) => log("STEP_ERROR", { step: m, error: clip(String(e?.message ?? e), 200) }));
  }
})().catch((e) => { console.error("FAILED", String(e?.message ?? e).slice(0, 200)); process.exitCode = 1; });
