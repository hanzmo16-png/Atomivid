/** Read-only production diagnosis of documentary preparation jobs.
 * No provider credential is present and no write is issued. Only structural
 * facts (status, stage, stop reasons, token usage, schema issue paths) are printed;
 * never narration, prompts, topics or identifiers beyond short hashes. */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DocumentaryNarrativeSchema } from "../src/lib/video/long-form/documentary-script";
import { EditorialReviewSchema } from "../src/lib/video/long-form/editorial";
import { ReferencedEditorialReviewSchema } from "../src/lib/video/long-form/narration-catalog";
import { CitationRepairSchema } from "../src/lib/video/long-form/editorial-evidence";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const issues = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v);
  return r.success ? [] : r.error.issues.slice(0, 12).map(i => `${i.code}@${i.path.map(p => typeof p === "number" ? "#" : String(p)).join(".")}`);
};

async function main() {
  if (process.env.ANTHROPIC_API_KEY) throw Error("Provider credential must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const jobs = await db.from("documentary_script_jobs").select("id,user_id,topic,status,stage,error_message,run_token,created_at,updated_at,editorial_checkpoint,input,failure_kind,error_code,retry_count,editorial_rounds,resubmit_allowance").order("created_at", { ascending: true });
  if (jobs.error) throw Error(`jobs read: ${jobs.error.code ?? ""} ${jobs.error.message ?? ""}`.slice(0, 200));
  console.log("SCHEMA", JSON.stringify({ newColumnsReadable: true }));
  for (const j of jobs.data ?? []) {
    const cp = j.editorial_checkpoint as { pass?: number; review?: unknown; script?: { beats?: { narration: string }[] } } | null;
    console.log("JOB", JSON.stringify({ id: j.id.slice(0, 8), owner: h(j.user_id), topicHash: h(j.topic), gucci: /gucci/i.test(j.topic), status: j.status, stage: j.stage,
      error: j.error_message, running: !!j.run_token, failureKind: j.failure_kind, errorCode: j.error_code, retries: j.retry_count, rounds: j.editorial_rounds, resubmits: j.resubmit_allowance, created: j.created_at, updated: j.updated_at,
      minutes: j.input?.fields?.durationMinutes, language: j.input?.fields?.language, sourcesChars: j.input?.fields?.sources?.length, contract: j.input?.referenceContract ?? null,
      checkpoint: cp ? { pass: cp.pass, reviewed: !!cp.review, beats: cp.script?.beats?.length, words: cp.script?.beats?.reduce((n, b) => n + b.narration.split(/\s+/).length, 0) } : null }));
  }
  const ops = await db.from("pi_paid_operations").select("*").eq("provider", "anthropic").like("project_id", "documentary:%").order("created_at", { ascending: true });
  if (ops.error) throw Error("ops read");
  for (const o of ops.data ?? []) {
    const row: Record<string, unknown> = { project: h(o.project_id), shot: h(o.shot_id), status: o.status, created: o.created_at, reserved: o.reserved_usd, committed: o.committed_usd };
    if (o.status === "COMMITTED" && typeof o.result_ref === "string" && !o.result_ref.startsWith("rejected:")) {
      const f = await db.storage.from("videos").download(o.result_ref);
      if (f.error || !f.data) row.result = "missing";
      else {
        const r = JSON.parse(await f.data.text());
        row.stop = r.stop_reason; row.usage = { in: r.usage?.input_tokens, out: r.usage?.output_tokens };
        row.blocks = (r.content ?? []).map((b: { type: string }) => b.type).join(",");
        const text = (r.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("").trim();
        row.textChars = text.length;
        const json = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
        let v: unknown; try { v = JSON.parse(json); row.json = true; } catch { row.json = false; row.tail = text.slice(-1).charCodeAt(0); row.startsWithBrace = text.startsWith("{"); }
        if (v && typeof v === "object") {
          const keys = Object.keys(v as object); row.keys = keys.slice(0, 12).join(",");
          if ("beats" in (v as object)) row.narrativeIssues = issues(DocumentaryNarrativeSchema, v);
          else if ("sections" in (v as object)) { row.reviewIssues = issues(EditorialReviewSchema, v); row.refReviewIssues = issues(ReferencedEditorialReviewSchema, v); }
          else if ("replacements" in (v as object)) row.repairIssues = issues(CitationRepairSchema, v);
          else if ("visuals" in (v as object)) row.visuals = ((v as { visuals: unknown[] }).visuals ?? []).length;
        }
      }
    }
    console.log("OP", JSON.stringify(row));
  }
  // Map each job to its ledger project (owner + input-derived scope); hashes only.
  const { documentarySupplyScope } = await import("../src/lib/supply/anthropic");
  const { EDITORIAL_VERSION } = await import("../src/lib/video/long-form/editorial");
  const { RESEARCH_VERSION } = await import("../src/lib/video/long-form/research");
  for (const j of jobs.data ?? []) {
    if (!j.input?.fields) continue;
    const scope = documentarySupplyScope(j.user_id, { ...j.input.fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: j.input.creativeHistory,
      ...(j.input.referenceContract ? { referenceContract: j.input.referenceContract } : {}) }, false);
    console.log("MAP", JSON.stringify({ job: j.id.slice(0, 8), project: h(scope.projectId) }));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "diagnostic failed"); process.exitCode = 1; });
