/** Read-only diagnosis for the 15-minute Long Form readiness mission. Never calls a provider or writes. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const clip = (s: unknown, n = 240) => (typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, n) : s ?? null);
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith(process.env.JOB ?? "e8048599")) as any;
  if (!j) return log("JOB", { found: false });
  const scope = documentaryLedgerScopeFor(j);
  const { data: ops } = await db.from("pi_paid_operations").select("status,method,committed_usd,created_at,shot_id").eq("project_id", scope).order("created_at");
  log("JOB", { status: j.status, stage: j.stage, kind: j.failure_kind, code: j.error_code, retries: j.retry_count, rounds: j.editorial_rounds, resubmits: j.resubmit_allowance,
    request: j.request_id ? String(j.request_id).slice(0, 8) : null, updated: j.updated_at, error: clip(j.error_message),
    checkpoint: { pass: j.editorial_checkpoint?.pass, beats: j.editorial_checkpoint?.script?.beats?.length, review: !!j.editorial_checkpoint?.review, status: j.editorial_checkpoint?.status },
    input: { lang: j.input?.fields?.language, minutes: j.input?.fields?.durationMinutes, contract: j.input?.referenceContract, writer: j.input?.writerContract, keys: Object.keys(j.input?.fields ?? {}) },
    ledger: { ops: ops?.length, usd: Number((ops ?? []).reduce((a: number, o: any) => a + Number(o.committed_usd ?? 0), 0).toFixed(4)), byStatus: (ops ?? []).reduce((m: any, o: any) => (m[o.status] = (m[o.status] ?? 0) + 1, m), {}),
      after1900: (ops ?? []).filter((o: any) => o.created_at >= "2026-10-23T19:00").length } });
  if (j.request_id) {
    const { data: r } = await db.from("video_requests").select("*").eq("id", j.request_id).maybeSingle();
    log("REQUEST", r ? { status: r.status, mode: r.mode, duration: r.duration_seconds, imageSource: r.reel_image_source, style: r.reel_recraft_style, voice: r.reel_voice_id ? "custom" : null, voiceChoice: r.voice_choice,
      plan: !!r.long_form_production_plan, confirmed: r.long_form_confirmed_at, scriptBeats: r.script_json?.beats?.length } : { found: false });
  }
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
