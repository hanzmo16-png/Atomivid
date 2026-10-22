/** Read-only scope check: for EVERY reviewer response of every documentary job, what actually blocked it.
 * Separates the reviewer's explicit blocking findings / unmet promises from the code-derived "restatement" rule,
 * and whether the restated block is the final one after the resolution. No provider key, no writes. */
import { createClient } from "@supabase/supabase-js";
async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("Provider credential must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { documentaryScopeInput } = await import("../src/lib/video/long-form/script-jobs");
  const { documentarySupplyScope } = await import("../src/lib/supply/anthropic");
  const { ScriptJobFieldsSchema } = await import("../src/lib/video/long-form/script-job-types");
  const jobs = await db.from("documentary_script_jobs").select("id,user_id,topic,status,failure_kind,editorial_rounds,input,created_at").order("created_at");
  const totals = { reviews: 0, reviewerBlocking: 0, restatementOnly: 0, restatementFinalAfterResolution: 0, restatementMiddle: 0, clean: 0 };
  const beatOf = (e: any) => typeof e?.beatIndex === "number" ? e.beatIndex : Number(/:b(\d+):/.exec(e?.excerptId ?? "")?.[1] ?? NaN);
  for (const j of jobs.data ?? []) {
    const f = ScriptJobFieldsSchema.safeParse(j.input?.fields); if (!f.success) continue;
    const project = documentarySupplyScope(j.user_id, documentaryScopeInput(j.input, f.data), false).projectId;
    const ops = await db.from("pi_paid_operations").select("status,result_ref,created_at").eq("project_id", project).order("created_at");
    const per: string[] = [];
    for (const o of ops.data ?? []) {
      if (o.status !== "COMMITTED" || typeof o.result_ref !== "string" || o.result_ref.startsWith("rejected:")) continue;
      const file = await db.storage.from("videos").download(o.result_ref); if (!file.data) continue;
      const r = JSON.parse(await file.data.text()); const text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      let v: any; try { v = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")); } catch { continue; }
      if (!v?.sections || !v?.ending) continue;
      totals.reviews++;
      const sections = v.sections.map((s: any, i: number) => ({ beat: Number.isFinite(beatOf(s)) ? beatOf(s) : i, fn: s.function }));
      const last = Math.max(...sections.map((s: any) => s.beat));
      const blocking = (v.findings ?? []).filter((x: any) => x.severity === "blocking").length + (v.firstAnswer?.delivered ? 0 : 1) + (v.ending?.resolvesPromise ? 0 : 1);
      const rest = sections.filter((s: any) => s.fn === "restatement").map((s: any) => s.beat);
      const endBeat = beatOf(v.ending?.evidence);
      const finalAfter = rest.filter((b: number) => b === last && v.ending?.resolvesPromise && endBeat < last);
      const middle = rest.filter((b: number) => b !== last);
      if (blocking) totals.reviewerBlocking++;
      if (!blocking && rest.length && !(rest.length === 1 && rest[0] === last && endBeat === last)) totals.restatementOnly++;
      if (finalAfter.length) totals.restatementFinalAfterResolution++;
      if (middle.length) totals.restatementMiddle++;
      if (!blocking && !rest.length) totals.clean++;
      per.push(`B${blocking}/R[${rest.join(",")}]/end${endBeat}/last${last}`);
    }
    console.log("JOB", JSON.stringify({ id: j.id.slice(0, 8), created: j.created_at.slice(0, 10), topic: j.topic.slice(0, 50), status: j.status, failure: j.failure_kind, rounds: j.editorial_rounds,
      lang: f.data.language, minutes: f.data.durationMinutes, reviews: per }));
  }
  console.log("TOTALS", JSON.stringify(totals), "B=reviewer blocking items, R=sections labelled restatement, end=beat the reviewer cites as resolution");
}
main().catch(e => { console.error(e instanceof Error ? e.message : "scope failed"); process.exitCode = 1; });
