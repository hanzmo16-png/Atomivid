/** Read-only trace of the "Revisar y configurar producción" link for the Gucci
 * job. Evaluates every branch of /dashboard/long-form/configure/[id] that can
 * end in notFound() with the persisted rows. No writes, no provider calls.
 * Prints booleans/counts only. */
import { createClient } from "@supabase/supabase-js";
import { isLongFormScriptJson } from "../src/lib/video/long-form/script-json";
import { editorialApprovalError } from "../src/lib/video/long-form/editorial";
import { computeProductionPlan, getRealLongFormProviderNames, VISUAL_STRATEGIES } from "../src/lib/video/long-form/production-plan";

async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("Provider credential must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error } = await db.from("documentary_script_jobs").select("id,user_id,status,stage,request_id");
  if (error) throw Error("read jobs");
  const job = jobs!.find(j => j.id.startsWith("7b7d4b60"))!;
  console.log("JOB", JSON.stringify({ status: job.status, stage: job.stage, href: `/dashboard/long-form/configure/<request_id>`, requestIdIsUuid: /^[0-9a-f-]{36}$/.test(job.request_id), requestIdEqualsJobId: job.request_id === job.id }));
  const byId = await db.from("video_requests").select("id,user_id,mode,status,long_form_confirmed_at,duration_seconds,script_json").eq("id", job.request_id).maybeSingle();
  const byOwner = await db.from("video_requests").select("id,mode,status,created_at").eq("user_id", job.user_id).eq("mode", "long_form").order("created_at", { ascending: false }).limit(3);
  const row = byId.data;
  console.log("REQUEST", JSON.stringify({ readError: byId.error?.code ?? null, exists: !!row, ownerMatches: row?.user_id === job.user_id, mode: row?.mode, status: row?.status,
    confirmed: !!row?.long_form_confirmed_at, duration: row?.duration_seconds, latestOwnerLongForm: byOwner.data?.map(r => ({ isThisRequest: r.id === job.request_id, status: r.status })) }));
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  const env = { id: process.env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim().toLowerCase(), email: process.env.AVATAR_PREPARATION_OWNER_EMAIL?.trim().toLowerCase() };
  console.log("OWNER", JSON.stringify({ emailConfirmed: !!owner?.user?.email_confirmed_at, ownerIdSecretPresent: !!env.id, ownerIdMatches: env.id ? env.id === owner?.user?.id : null,
    ownerEmailSecretPresent: !!env.email, ownerEmailMatches: env.email ? env.email === owner?.user?.email?.toLowerCase() : null }));
  if (!row) return;
  const script = row.script_json as { topic?: string; beats: { id: string; type: string; narration: string; visuals?: unknown[] }[] };
  const valid = isLongFormScriptJson(script);
  console.log("PAGE", JSON.stringify({ isLongFormScriptJson: valid, topicType: typeof script?.topic, beatIds: script?.beats?.map(b => typeof b.id), beats: script?.beats?.length,
    visuals: script?.beats?.reduce((n, b) => n + (b.visuals?.length ?? 0), 0), editorialApprovalError: valid ? editorialApprovalError(script as never) : "n/a" }));
  if (!valid) return;
  for (const strategy of VISUAL_STRATEGIES) {
    try {
      const plan = computeProductionPlan({ beats: script.beats.map(b => ({ id: b.id, type: b.type, narration: b.narration, visuals: b.visuals as never })), topic: script.topic!,
        strategy, providers: getRealLongFormProviderNames(), requestedDurationSeconds: row.duration_seconds ?? undefined });
      console.log("PLAN", JSON.stringify({ strategy, ok: !!plan }));
    } catch (e) { console.log("PLAN", JSON.stringify({ strategy, ok: false, error: e instanceof Error ? e.name : "unknown" })); }
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
