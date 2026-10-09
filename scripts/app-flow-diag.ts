/** Read-only production diagnostics for the in-app YouTube flow. Prints structure only. */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { connectResolved } from "./lib/supabase-db";

const h10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = () => createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });

async function grants() {
  const { client } = await connectResolved();
  try {
    const q = async (sql: string, args: unknown[] = []) => (await client.query(sql, args)).rows;
    log("MIGRATION_APPLIED", await q(`select name from public._migrations_applied where name like '20261009%' or name like '20261008%' order by name`).catch((e) => [{ error: String(e.message).slice(0, 80) }]));
    for (const t of ["video_requests", "avatars", "documentary_script_jobs", "podcast_episodes"]) {
      const [r] = await q(`select has_table_privilege('authenticated','public.${t}','INSERT') ins, has_table_privilege('authenticated','public.${t}','UPDATE') upd,
        has_table_privilege('authenticated','public.${t}','DELETE') del, has_table_privilege('authenticated','public.${t}','SELECT') sel,
        has_any_column_privilege('authenticated','public.${t}','UPDATE') col_upd, has_any_column_privilege('authenticated','public.${t}','INSERT') col_ins,
        has_table_privilege('service_role','public.${t}','UPDATE') svc_upd`);
      log("GRANTS", { table: t, ...r });
    }
  } finally { await client.end(); }
}

async function longForm() {
  const s = db();
  const { data: reqs } = await s.from("video_requests").select("*").eq("mode", "long_form").order("created_at", { ascending: false }).limit(15);
  for (const r of (reqs ?? []) as Record<string, any>[]) {
    log("LONG_FORM", { id: h10(r.id), short: String(r.id).slice(0, 8), owner: h10(r.user_id), status: r.status, stage: r.progress_stage, attempts: r.render_attempts, video: !!r.video_path,
      confirmedCols: Object.keys(r).filter((k) => /confirm|approv|budget|plan/i.test(k) && r[k] !== null), supplyWait: !!r.supply_wait_started_at, created: r.created_at, updated: r.updated_at, error: typeof r.error_message === "string" ? r.error_message.slice(0, 140) : null });
  }
  const { data: jobs } = await s.from("documentary_script_jobs").select("id,request_id,user_id,status,stage,error_message,created_at,updated_at").order("created_at", { ascending: false }).limit(10);
  for (const j of (jobs ?? []) as Record<string, any>[]) {
    const { data: req } = await s.from("video_requests").select("status").eq("id", j.request_id).maybeSingle();
    log("SCRIPT_JOB", { id: String(j.id).slice(0, 8), request: String(j.request_id).slice(0, 8), owner: h10(j.user_id), status: j.status, stage: j.stage, requestRow: req?.status ?? null, created: j.created_at, updated: j.updated_at, error: typeof j.error_message === "string" ? j.error_message.slice(0, 140) : null });
  }
  const { data: modes } = await s.from("video_requests").select("mode,status");
  const counts: Record<string, number> = {};
  for (const m of modes ?? []) counts[`${m.mode}:${m.status}`] = (counts[`${m.mode}:${m.status}`] ?? 0) + 1;
  log("COUNTS", counts);
}

/** Unauthenticated HTTP smoke of the deployed app: routes exist and refuse without a session. */
async function smoke() {
  const base = "https://atomivid.vercel.app";
  const probe = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(30000) }).catch(() => null);
    return { path, method: init.method ?? "GET", status: r?.status ?? null, location: r?.headers.get("location")?.replace(base, "") ?? null };
  };
  const fake = "00000000-0000-4000-8000-000000000000";
  for (const r of await Promise.all([probe("/"), probe("/login"), probe("/dashboard"), probe("/dashboard/long-form/new"), probe(`/dashboard/videos/${fake}`),
    probe(`/api/generate/${fake}/resume`, { method: "POST" }), probe(`/api/generate/${fake}/render`, { method: "POST" }), probe(`/api/generate/${fake}/confirm-production`, { method: "POST", body: "{}" })])) log("HTTP", r);
}

/** State of the owner-authorized in-app E2E test production (topic chosen by the test, not private). */
async function e2eState() {
  const s = db();
  const { data: jobs } = await s.from("documentary_script_jobs").select("id,request_id,user_id,status,stage,error_message,created_at,updated_at").eq("topic", "Cómo se forman las auroras boreales").order("created_at", { ascending: false }).limit(3);
  for (const j of (jobs ?? []) as Record<string, any>[]) {
    const { data: r } = await s.from("video_requests").select("status,render_attempts,long_form_stage,long_form_progress,supply_wait_started_at,video_path,error_message,long_form_confirmed_at,render_started_at").eq("id", j.request_id).maybeSingle();
    const { data: ops } = await s.from("pi_paid_operations").select("provider,status,reserved_usd,committed_usd,created_at").or(`project_id.eq.${j.request_id},project_id.like.documentary:${j.user_id}:%`).gte("created_at", j.created_at);
    const usd = (ops ?? []).reduce((a, o) => a + Number(o.status === "COMMITTED" ? o.committed_usd : o.status === "REFUNDED" ? 0 : o.reserved_usd), 0);
    log("E2E_JOB", { job: String(j.id).slice(0, 8), status: j.status, stage: j.stage, created: j.created_at, updated: j.updated_at, error: j.error_message ? String(j.error_message).slice(0, 160) : null });
    log("E2E_REQUEST", r ? { status: r.status, attempts: r.render_attempts, stage: r.long_form_stage, waiting: !!r.supply_wait_started_at, video: !!r.video_path, confirmed: !!r.long_form_confirmed_at, startedAt: r.render_started_at, progressAt: (r.long_form_progress as { updatedAt?: string } | null)?.updatedAt ?? null, error: r.error_message ? String(r.error_message).slice(0, 200) : null } : null);
    log("E2E_SPEND", { usd: Math.round(usd * 10000) / 10000, ops: (ops ?? []).length, uncertain: (ops ?? []).filter((o) => ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status)).length });
  }
}

const steps: Record<string, () => Promise<void>> = { grants, "long-form": longForm, smoke, "e2e-state": e2eState };
(async () => {
  for (const m of (process.argv[2] ?? "").split(",").filter(Boolean)) { if (!steps[m]) throw Error(`unknown ${m}`); log("STEP", m); await steps[m]().catch((e) => log("STEP_ERROR", { step: m, error: String(e?.message ?? e).slice(0, 160) })); }
})().catch((e) => { console.error("FAILED", String(e?.message ?? e).slice(0, 200)); process.exitCode = 1; });
