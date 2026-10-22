/** Read-only scope check: across EVERY documentary job, how many writer drafts had creative-direction passages that are
 * in their beat only up to case/spacing/quote style (blocked by the old exact check, accepted by locateLiteralPassage),
 * versus genuinely absent. No provider key, no writes; prints counts and topics only. */
import { createClient } from "@supabase/supabase-js";
const norm = (x: string) => x.toLowerCase().replace(/[’‘`´]/g, "'").replace(/[“”«»]/g, '"').replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();
async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("Provider credential must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { documentaryScopeInput } = await import("../src/lib/video/long-form/script-jobs");
  const { documentarySupplyScope } = await import("../src/lib/supply/anthropic");
  const { ScriptJobFieldsSchema } = await import("../src/lib/video/long-form/script-job-types");
  const { topLevelObjects } = await import("../src/lib/video/long-form/narrative-fragments");
  const jobs = await db.from("documentary_script_jobs").select("id,user_id,topic,status,failure_kind,editorial_rounds,input").order("created_at");
  const totals = { drafts: 0, withDirection: 0, caseOnly: 0, genuine: 0 };
  for (const j of jobs.data ?? []) {
    const f = ScriptJobFieldsSchema.safeParse(j.input?.fields); if (!f.success) continue;
    const project = documentarySupplyScope(j.user_id, documentaryScopeInput(j.input, f.data), false).projectId;
    const ops = await db.from("pi_paid_operations").select("status,result_ref,created_at").eq("project_id", project).order("created_at");
    const per: string[] = [];
    for (const o of ops.data ?? []) {
      if (o.status !== "COMMITTED" || typeof o.result_ref !== "string" || o.result_ref.startsWith("rejected:")) continue;
      const file = await db.storage.from("videos").download(o.result_ref); if (!file.data) continue;
      const r = JSON.parse(await file.data.text()); const text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      let d: any = null, beats: { index: number; narration: string }[] = [];
      try { const v = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")); if (v?.creativeDirection && v?.beats) { d = v.creativeDirection; beats = v.beats.map((b: any, i: number) => ({ index: i, narration: b.narration })); } } catch {
        const objs = topLevelObjects(text).map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
        const plan = objs.find((x: any) => x?.creativeDirection); if (plan) { d = plan.creativeDirection; beats = objs.filter((x: any) => x?.fragment === "beat"); } }
      if (!d) continue;
      totals.drafts++; totals.withDirection++;
      const ps = [d.signatureDetail, d.shareableLine, ...(d.protectInEdit ?? []), d.commentMoment, d.closingCta].filter(Boolean);
      let caseOnly = 0, genuine = 0;
      for (const p of ps) { const nar = beats.find(b => b.index === p.beatIndex)?.narration ?? "";
        if (nar.includes(p.quote)) continue; if (norm(nar).includes(norm(p.quote))) caseOnly++; else genuine++; }
      if (caseOnly && !genuine) totals.caseOnly++; if (genuine) totals.genuine++;
      per.push(`${caseOnly}c/${genuine}g`);
    }
    console.log("JOB", JSON.stringify({ id: j.id.slice(0, 8), topic: j.topic.slice(0, 60), minutes: f.data.durationMinutes, status: j.status, failure: j.failure_kind, rounds: j.editorial_rounds, drafts: per }));
  }
  console.log("TOTALS", JSON.stringify(totals), "caseOnly = draft blocked ONLY by case/spacing/quote style (old check); genuine = draft with a real paraphrase/absent passage");
}
main().catch(e => { console.error(e instanceof Error ? e.message : "scope failed"); process.exitCode = 1; });
