/** Read-only: the editorial objection of one documentary script job (by error_code). No provider key, no writes.
 * Prints the reviewer's real findings for every reviewed pass (checkpoint + ledger results), the local checks
 * recomputed with the current code, and the draft's structure, so the block can be diagnosed without guessing. */
import { createClient } from "@supabase/supabase-js";
const CODE = process.env.CASE_CODE ?? "839857e1";
async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("Provider credential must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error } = await db.from("documentary_script_jobs").select("*").or(`error_code.eq.${CODE},id.eq.${process.env.CASE_JOB ?? "00000000-0000-0000-0000-000000000000"}`);
  if (error) throw Error(`read: ${error.message}`);
  console.log("MATCHES", jobs?.length ?? 0);
  const recent = await db.from("documentary_script_jobs").select("id,topic,status,failure_kind,error_code,editorial_rounds,retry_count,created_at,updated_at").order("created_at", { ascending: false }).limit(12);
  for (const r of recent.data ?? []) console.log("RECENT", JSON.stringify(r));
  const job = jobs?.[0]; if (!job) return;
  const { editorialBlockers } = await import("../src/lib/video/long-form/editorial");
  const { creativeDirectionIssues } = await import("../src/lib/video/long-form/creative-direction");
  const { assertOriginalHook, usesBannedOpener } = await import("../src/lib/video/long-form/originality");
  const { countWords, evaluateNarrationDuration } = await import("../src/lib/video/long-form/duration-budget");
  const { documentaryScopeInput } = await import("../src/lib/video/long-form/script-jobs");
  const { documentarySupplyScope } = await import("../src/lib/supply/anthropic");
  const { ScriptJobFieldsSchema } = await import("../src/lib/video/long-form/script-job-types");
  console.log("JOB", JSON.stringify({ id: job.id, topic: job.topic, status: job.status, stage: job.stage, failure_kind: job.failure_kind, error_code: job.error_code,
    rounds: job.editorial_rounds, retries: job.retry_count, resubmits: job.resubmit_allowance, created: job.created_at, updated: job.updated_at,
    fields: job.input?.fields && { ...job.input.fields, sources: (job.input.fields.sources ?? "").slice(0, 400) }, history: (job.input?.creativeHistory ?? []).length,
    contract: job.input?.referenceContract, writer: job.input?.writerContract, error_message: job.error_message }));
  const cp = job.editorial_checkpoint;
  const show = (tag: string, review: any) => {
    if (!review) { console.log(tag, "no review"); return; }
    console.log(tag, "FIRST", JSON.stringify(review.firstAnswer)); console.log(tag, "ENDING", JSON.stringify(review.ending));
    for (const s of review.sections ?? []) console.log(tag, "SECTION", JSON.stringify(s));
    for (const f of review.findings ?? []) console.log(tag, "FINDING", JSON.stringify(f));
    try { console.log(tag, "BLOCKERS", JSON.stringify(editorialBlockers(review))); } catch (e) { console.log(tag, "BLOCKERS_ERR", String(e)); }
  };
  if (cp) {
    const s = cp.script;
    console.log("CHECKPOINT", JSON.stringify({ pass: cp.pass, status: cp.status, title: s?.title, hook: s?.hook, beats: s?.beats?.length, words: s?.beats?.reduce((n: number, b: any) => n + countWords(b.narration), 0) }));
    const target = Number(job.input.fields.durationMinutes) * 60, ev = evaluateNarrationDuration(s.beats.reduce((n: number, b: any) => n + countWords(b.narration), 0), target);
    console.log("DURATION", JSON.stringify(ev));
    const local: string[] = creativeDirectionIssues(s.creativeDirection, s.beats, job.input.creativeHistory ?? []);
    try { assertOriginalHook(s.hook); } catch { local.push("hook genérico"); }
    const ids = new Set((cp.researchPack?.sources ?? []).map((x: any) => x.id));
    s.beats.forEach((b: any, i: number) => { if (usesBannedOpener(b.narration)) local.push(`banned opener beat ${i}`);
      for (const c of b.claims ?? []) if ((c.sourceIds ?? []).some((id: string) => !ids.has(id)) || (c.support === "sourced" && !(c.sourceIds ?? []).length)) local.push(`claim attribution beat ${i}: ${JSON.stringify(c).slice(0, 300)}`); });
    console.log("LOCAL_ISSUES", JSON.stringify(local));
    console.log("CREATIVE", JSON.stringify(s.creativeDirection));
    console.log("STORYPLAN", JSON.stringify(s.storyPlan));
    console.log("SOURCES", JSON.stringify((cp.researchPack?.sources ?? []).map((x: any) => ({ id: x.id, title: x.title, kind: x.kind, url: x.url }))));
    s.beats.forEach((b: any, i: number) => console.log("BEAT", i, JSON.stringify({ type: b.type, purpose: b.purpose, words: countWords(b.narration), narration: b.narration, claims: b.claims })));
    show("CP", cp.review);
  }
  // Every committed provider response of this job (oldest first): which were reviews and what they said.
  const fields = ScriptJobFieldsSchema.parse(job.input.fields);
  const project = documentarySupplyScope(job.user_id, documentaryScopeInput(job.input, fields), false).projectId;
  const ops = await db.from("pi_paid_operations").select("shot_id,status,created_at,committed_usd,result_ref").eq("project_id", project).order("created_at", { ascending: true });
  let usd = 0; console.log("OPS", ops.data?.length ?? 0);
  for (const [n, o] of (ops.data ?? []).entries()) {
    usd += Number(o.committed_usd ?? 0);
    const row: any = { n, status: o.status, created: o.created_at, usd: o.committed_usd };
    if (o.status === "COMMITTED" && typeof o.result_ref === "string" && !o.result_ref.startsWith("rejected:")) {
      const f = await db.storage.from("videos").download(o.result_ref);
      if (f.data) { const r = JSON.parse(await f.data.text()); const text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
        row.stop = r.stop_reason; row.out = r.usage?.output_tokens;
        let v: any; try { v = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")); } catch {}
        row.keys = v && Object.keys(v).slice(0, 10).join(",");
        console.log("OP", JSON.stringify(row));
        if (v?.sections && (v.findings || v.firstAnswer)) show(`OP${n}`, v);
        if (!v && r.content) {
          // Writer fragments: per creative-direction passage, is it literal in its beat (exactly / ignoring case & spaces)?
          const { topLevelObjects } = await import("../src/lib/video/long-form/narrative-fragments");
          const objs = topLevelObjects(text).map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
          const plan = objs.find((o: any) => o.creativeDirection), beats = objs.filter((o: any) => o.fragment === "beat").sort((a: any, b: any) => a.index - b.index);
          if (plan) {
            const d = plan.creativeDirection, norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
            const ps = [["signatureDetail", d.signatureDetail], ["shareableLine", d.shareableLine], ...(d.protectInEdit ?? []).map((p: any, i: number) => [`protectInEdit${i}`, p]), ["commentMoment", d.commentMoment], ["closingCta", d.closingCta]];
            for (const [name, p] of ps) if (p) { const nar = beats.find((b: any) => b.index === p.beatIndex)?.narration ?? "";
              console.log(`OP${n}`, "PASSAGE", JSON.stringify({ name, beat: p.beatIndex, exact: nar.includes(p.quote), relaxed: norm(nar).includes(norm(p.quote)), quote: p.quote })); }
            console.log(`OP${n}`, "LOCAL", JSON.stringify(creativeDirectionIssues(d, beats.map((b: any) => ({ narration: b.narration })), job.input.creativeHistory ?? [])));
            console.log(`OP${n}`, "WORDS", beats.reduce((k: number, b: any) => k + countWords(b.narration), 0));
          }
        }
        if (v?.beats) console.log(`OP${n}`, "NARRATIVE", JSON.stringify({ title: v.title, beats: v.beats.length, words: v.beats.map((b: any) => countWords(b.narration ?? "")) }));
        continue;
      }
    }
    console.log("OP", JSON.stringify(row));
  }
  console.log("TOTAL_USD", usd.toFixed(4));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "diagnostic failed"); process.exitCode = 1; });
