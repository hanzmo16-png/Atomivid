/** Read-only trace of the "Revisar y configurar producción" link for the Gucci
 * job. Evaluates every branch of /dashboard/long-form/configure/[id] that can
 * end in notFound() with the persisted rows. No writes, no provider calls.
 * Prints booleans/counts only. */
import { createClient } from "@supabase/supabase-js";
import { isLongFormScriptJson } from "../src/lib/video/long-form/script-json";
import { lookupConfigurableRequest } from "../src/lib/video/long-form/configure-lookup";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultView } from "../src/components/video/ResultView";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { selectIfOwned } from "../src/lib/video/access";
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
  // The exact page lookup, with the owner filter the page applies on top of RLS.
  // Access is passed as granted: the production worker's own owner-access check
  // passed for this job (it completed), using the same canAccessLongFormBeta.
  const owner_ = { id: job.user_id };
  for (const [label, id] of [["request_id", job.request_id], ["job_id", job.id], ["placeholder", "<request>"]] as const) {
    const r = await lookupConfigurableRequest(db as never, owner_, id, true);
    console.log("LOOKUP", JSON.stringify({ link: label, kind: r.kind, reason: r.kind === "not_found" ? r.reason : undefined, to: r.kind === "redirect" ? r.to.replace(id, "<id>") : undefined }));
  }
  const other = await lookupConfigurableRequest(db as never, { id: "00000000-0000-4000-8000-000000000000" }, job.request_id, true);
  console.log("LOOKUP", JSON.stringify({ link: "request_id_as_other_user", kind: other.kind, reason: other.kind === "not_found" ? other.reason : undefined }));
  if (!row) return;
  // The detail page /dashboard/videos/[id]: same columns and ownership filter as the page.
  const detail = await db.from("video_requests").select("id, mode, user_id, topic, style, duration_seconds, language, status, video_path, error_message, script_json, progress_stage, render_attempts, render_started_at, created_at, aspect_ratio, long_form_stage, long_form_progress, long_form_production_plan, long_form_confirmed_at, recorded_audio_path")
    .eq("id", job.request_id).eq("user_id", job.user_id).maybeSingle();
  const summary = selectIfOwned(detail.data as never, job.user_id)!;
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={{ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never}><ResultView request={summary} nowMs={Date.now()} /></AppRouterContext.Provider>);
  console.log("DETAIL_PAGE", JSON.stringify({ emptyStage: html.includes("Todavía no se generó el video"), cta: html.includes("Revisar y configurar producción"),
    ctaTargetsThisRequest: html.includes(`href="/dashboard/long-form/configure/${job.request_id}"`), confirmed: !!summary.long_form_confirmed_at, startButtonShown: html.includes("Iniciar producción") }));
  const script = row.script_json as { topic?: string; beats: { id: string; type: string; narration: string; visuals?: unknown[] }[] };
  const valid = isLongFormScriptJson(script);
  console.log("PAGE", JSON.stringify({ isLongFormScriptJson: valid, topicType: typeof script?.topic, beatIds: script?.beats?.map(b => typeof b.id), beats: script?.beats?.length,
    visuals: script?.beats?.reduce((n, b) => n + (b.visuals?.length ?? 0), 0), editorialApprovalError: valid ? editorialApprovalError(script as never) : "n/a" }));
  if (!valid) return;
  for (const strategy of VISUAL_STRATEGIES) {
    try {
      const plan = computeProductionPlan({ beats: script.beats.map(b => ({ id: b.id, type: b.type, narration: b.narration, visuals: b.visuals })) as never, topic: script.topic!,
        strategy, providers: getRealLongFormProviderNames(), requestedDurationSeconds: row.duration_seconds ?? undefined });
      console.log("PLAN", JSON.stringify({ strategy, ok: !!plan }));
    } catch (e) { console.log("PLAN", JSON.stringify({ strategy, ok: false, error: e instanceof Error ? e.name : "unknown" })); }
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
