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
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
import { z } from "zod";
import { creativeDirectionIssues, anchorCreativeDirectionQuotes } from "../src/lib/video/long-form/creative-direction";
import { assertOriginalHook, usesBannedOpener } from "../src/lib/video/long-form/originality";

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

async function local() {
  const s = db();
  const { data } = await s.from("documentary_script_jobs").select("id,editorial_checkpoint,input").eq("status", "failed").eq("failure_kind", "editorial").order("created_at", { ascending: false }).limit(3);
  for (const j of (data ?? []) as Record<string, any>[]) {
    const d = j.editorial_checkpoint, p = d?.script ?? {}, beats = p.beats ?? [], history = (j.input?.creativeHistory ?? []).slice(0, 5);
    const ids = new Set((d?.researchPack?.sources ?? []).map((x: any) => x.id));
    const issues: string[] = creativeDirectionIssues(p.creativeDirection, beats, history);
    try { assertOriginalHook(p.hook); } catch (e) { issues.push("HOOK: " + clip(String((e as Error).message), 120)); }
    const bad: unknown[] = [];
    beats.forEach((b: any, i: number) => {
      if (usesBannedOpener(b.narration)) issues.push(`OPENER@${i}`);
      for (const c of b.claims ?? []) if ((c.sourceIds ?? []).some((x: string) => !ids.has(x)) || (c.support === "sourced" && !(c.sourceIds ?? []).length)) bad.push({ beat: i, support: c.support, ids: c.sourceIds });
    });
    const cd = p.creativeDirection;
    const anchored = creativeDirectionIssues(anchorCreativeDirectionQuotes(p.creativeDirection, beats), beats, history);
    log("LOCAL", { id: String(j.id).slice(0, 8), history: history.length, afterAnchor: anchored.map((x) => clip(x, 160)), issues: issues.map((x) => clip(x, 160)), badClaims: bad.slice(0, 8), sourceIds: [...ids].slice(0, 20),
      cd: cd ? { finalists: cd.finalists, chosen: cd.chosenAngle, devices: (cd.angles ?? []).map((a: any) => a.device), avoided: cd.avoidedPatterns?.length, protect: (cd.protectInEdit ?? []).map((x: any) => x.beatIndex), cta: cd.closingCta?.beatIndex,
        quotesOk: [cd.signatureDetail, cd.shareableLine, ...(cd.protectInEdit ?? []), ...(cd.commentMoment ? [cd.commentMoment] : []), ...(cd.closingCta ? [cd.closingCta] : [])].map((x: any) => x && beats[x.beatIndex]?.narration?.includes(x.quote)) } : null });
  }
}

async function holds() {
  const s = db();
  const { data: ops } = await s.from("pi_paid_operations").select("*").in("status", ["RESERVED", "PENDING", "IN_FLIGHT", "UNCERTAIN"]).order("created_at", { ascending: false }).limit(20);
  log("OPEN_OPERATIONS", (ops ?? []).map((o: any) => ({ p: o.provider, st: o.status, m: o.method, project: String(o.project_id ?? "").slice(0, 24), job: o.supply_job_key ? String(o.supply_job_key).slice(0, 30) : null,
    pool: o.supply_pool, units: o.capacity_units, usd: o.committed_usd, at: o.created_at, upd: o.updated_at })));
  const { data: res } = await s.from("pi_supply_job_reservations").select("*").eq("status", "OPEN").order("created_at", { ascending: false }).limit(20);
  log("OPEN_JOB_RESERVATIONS", (res ?? []).map((r: any) => ({ p: r.provider, project: String(r.project_id).slice(0, 24), attempt: r.render_attempt, units: r.reserved_units, usd: r.reserved_usd, used: r.consumed_usd, at: r.created_at })));
}

async function capacity() {
  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    for (const p of ["anthropic", "openai", "elevenlabs", "recraft", "veo", "runway"]) {
      const r = (await client.query("select public.pi_supply_state($1) s", [p]).catch((e: Error) => ({ rows: [{ s: { error: e.message.slice(0, 80) } }] }))).rows[0].s;
      log("CAPACITY", { p, level: r.level, reason: r.reason, free: r.free, held: r.held, active: r.activeCalls ?? r.active_calls, today: r.todayCalls ?? r.today_calls, daily: r.dailySpend, monthly: r.monthlySpend, checked: r.checkedAt, keys: Object.keys(r).slice(0, 25) });
    }
    const act = (await client.query(`select provider, status, method, left(project_id,24) project, updated_at from public.pi_paid_operations where method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') order by updated_at desc limit 15`)).rows;
    log("ACTIVE_OR_UNRECONCILED", act);
    await client.query("rollback");
  } finally { await client.end(); }
}

async function costs() {
  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    const reqs = (await client.query(`select id::text id, duration_seconds, status, created_at, long_form_production_plan->'allocation' alloc, long_form_production_plan->'estimate' est,
      reel_image_source, reel_voice_id is not null custom_voice from public.video_requests where mode='long_form' and status='completed' order by created_at desc limit 4`)).rows;
    for (const r of reqs) {
      const ops = (await client.query(`select provider, method, status, count(*) n, round(sum(coalesce(committed_usd,0))::numeric,4) usd from public.pi_paid_operations
        where project_id like $1 group by 1,2,3 order by 1,2`, [r.id + "%"])).rows;
      log("REAL_COST", { id: r.id.slice(0, 8), minutes: r.duration_seconds / 60, created: r.created_at, images: r.reel_image_source, customVoice: r.custom_voice,
        estimate: clip(JSON.stringify(r.est), 400), allocation: clip(JSON.stringify(r.alloc), 300), ops, totalUsd: ops.reduce((a: number, o: any) => a + Number(o.usd), 0) });
    }
    await client.query("rollback");
  } finally { await client.end(); }
}

const WATCH_JOB = process.env.WATCH_JOB ?? "290de42b";
async function watch() {
  const s = db();
  const { data: jobs } = await s.from("documentary_script_jobs").select("id,status,stage,failure_kind,error_code,error_message,retry_count,editorial_rounds,request_id,updated_at").order("updated_at", { ascending: false }).limit(5);
  for (const j of (jobs ?? []) as Record<string, any>[]) log("JOB", { id: String(j.id).slice(0, 8), status: j.status, stage: j.stage, kind: j.failure_kind, code: j.error_code, retries: j.retry_count, rounds: j.editorial_rounds, request: j.request_id ? String(j.request_id).slice(0, 8) : null, updated: j.updated_at, error: clip(j.error_message, 300) });
  const { data: reqs } = await s.from("video_requests").select("id,status,long_form_stage,long_form_progress,long_form_confirmed_at,long_form_production_plan,render_attempts,video_path,error_message,reel_image_source,reel_voice_id,duration_seconds,updated_at").eq("mode", "long_form").order("updated_at", { ascending: false }).limit(3);
  for (const r of (reqs ?? []) as Record<string, any>[]) log("REQUEST", { id: String(r.id).slice(0, 8), status: r.status, stage: r.long_form_stage, progress: clip(JSON.stringify(r.long_form_progress), 400), confirmed: r.long_form_confirmed_at, minutes: r.duration_seconds / 60,
    allocation: r.long_form_production_plan?.allocation ?? null, images: r.reel_image_source, voice: r.reel_voice_id ? "custom" : "default", attempts: r.render_attempts, video: r.video_path ? String(r.video_path).replace(/^[^/]+\//, "…/") : null, updated: r.updated_at, error: clip(r.error_message, 300) });
  const { data: runs } = await s.from("pi_paid_operations").select("provider,method,status,committed_usd,created_at").gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(300);
  const agg: Record<string, { n: number; usd: number }> = {};
  for (const o of (runs ?? []) as Record<string, any>[]) { const k = `${o.provider}:${o.method}:${o.status}`; agg[k] ??= { n: 0, usd: 0 }; agg[k].n++; agg[k].usd += Number(o.committed_usd ?? 0); }
  log("SPEND_6H", agg);
  void WATCH_JOB;
}

function shape(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 3 ? `array(${v.length})` : [`array(${v.length})`, v.length ? shape(v[0], depth + 1) : null];
  if (typeof v === "object") { if (depth > 3) return "object"; const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as object)) o[k] = shape(x, depth + 1); return o; }
  if (typeof v === "string") return `string(${v.length})`;
  return typeof v;
}
const RepairSchemaCopy = z.object({ firstAnswer: z.object({ delivered: z.boolean(), evidence: z.object({ excerptId: z.string().min(1).max(80) }).strict(), explanation: z.string().min(1).max(1600) }).strict() }).strict();
async function forensic() {
  const s = db();
  const code = process.env.ERROR_CODE ?? "23d86d0a";
  const { data: jobs } = await s.from("documentary_script_jobs").select("*").eq("error_code", code);
  const j = (jobs ?? [])[0] as Record<string, any> | undefined;
  if (!j) return log("FORENSIC", { code, found: false });
  log("FORENSIC_JOB", { id: String(j.id).slice(0, 8), status: j.status, stage: j.stage, kind: j.failure_kind, lang: j.input?.fields?.language, minutes: j.input?.fields?.durationMinutes, contract: j.input?.referenceContract, writer: j.input?.writerContract,
    retries: j.retry_count, rounds: j.editorial_rounds, resubmits: j.resubmit_allowance, created: j.created_at, updated: j.updated_at, checkpointPass: j.editorial_checkpoint?.pass, checkpointReview: !!j.editorial_checkpoint?.review,
    beats: j.editorial_checkpoint?.script?.beats?.length, error: clip(j.error_message, 300) });
  const scope = documentaryLedgerScopeFor(j as any);
  const { data: ops } = await s.from("pi_paid_operations").select("*").eq("provider", "anthropic").eq("project_id", scope).order("created_at", { ascending: true });
  log("FORENSIC_LEDGER", { scope: String(scope).slice(0, 12), ops: ops?.length ?? 0, usd: (ops ?? []).reduce((a: number, o: any) => a + Number(o.committed_usd ?? 0), 0) });
  for (const [i, o] of ((ops ?? []) as any[]).entries()) {
    const row: Record<string, unknown> = { i, st: o.status, m: o.method, usd: o.committed_usd, at: o.created_at };
    if (o.status === "COMMITTED" && o.result_ref && !String(o.result_ref).startsWith("rejected:")) {
      const { data: f } = await s.storage.from("videos").download(o.result_ref);
      if (f) {
        const r = JSON.parse(await f.text());
        row.model = r.model; row.stop = r.stop_reason; row.out = r.usage?.output_tokens;
        const t = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("").trim();
        row.fenced = /^```/.test(t); row.len = t.length;
        let v: any; try { v = JSON.parse(t.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")); row.json = true; } catch { row.json = false; row.head = clip(t.slice(0, 60).replace(/[A-Za-z]/g, "a"), 60); }
        if (v) {
          row.keys = Object.keys(v).slice(0, 12);
          if (v.firstAnswer && Object.keys(v).length <= 3) {
            const p = RepairSchemaCopy.safeParse(v);
            row.openingRepair = { valid: p.success, shape: shape(v), issues: p.success ? [] : p.error.issues.map(x => ({ code: x.code, path: x.path, keys: (x as any).keys, expected: (x as any).expected, max: (x as any).maximum })) };
            row.excerptIdValue = typeof v.firstAnswer?.evidence?.excerptId === "string" ? clip(v.firstAnswer.evidence.excerptId, 40) : null;
          }
        }
      }
    }
    log("FORENSIC_OP", row);
  }
}

const steps: Record<string, () => Promise<void>> = { forensic, review, schema, local, holds, capacity, costs, watch, migrations, jobs, requests, supply, vercel: vercelProbe };
(async () => {
  for (const m of (process.argv[2] ?? "").split(",").filter(Boolean)) {
    if (!steps[m]) throw Error(`unknown ${m}`);
    await steps[m]().catch((e) => log("STEP_ERROR", { step: m, error: clip(String(e?.message ?? e), 200) }));
  }
})().catch((e) => { console.error("FAILED", String(e?.message ?? e).slice(0, 200)); process.exitCode = 1; });
