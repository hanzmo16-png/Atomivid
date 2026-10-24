/** Read-only audit of e8048599: saved input, paid responses (Storage), narrative text, visual plans, media. No writes, no provider call. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const textOf = (r: any) => (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
const tryJson = (s: string) => { const t = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim(); try { return JSON.parse(t); } catch { try { return JSON.parse(t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/,\s*([}\]])/g, "$1")); } catch { return null; } } };
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const { data: j } = await db.from("documentary_script_jobs").select("*").eq("id", "e8048599-cf92-45e8-95c8-f145cb9d3be2").single();
  const job = j as Record<string, any>;
  const f = job.input?.fields ?? {};
  log("JOB", { status: job.status, stage: job.stage, code: job.error_code, retries: job.retry_count, rounds: job.editorial_rounds, created: job.created_at, updated: job.updated_at,
    fields: { topic: f.topic, durationMinutes: f.durationMinutes, language: f.language, keys: Object.keys(f) }, inputKeys: Object.keys(job.input ?? {}), checkpoint: job.editorial_checkpoint ? { pass: job.editorial_checkpoint.pass, keys: Object.keys(job.editorial_checkpoint) } : null,
    resultKeys: job.result ? Object.keys(job.result) : null, columns: Object.keys(job) });
  const scope = documentaryLedgerScopeFor(job)!;
  const { data: ops } = await db.from("pi_paid_operations").select("shot_id,status,reserved_usd,committed_usd,result_ref,created_at").eq("project_id", scope).order("created_at");
  let narrative: any = null, narrativeAt = "", plans: { at: string; scenes: number; classes: Record<string, number>; descs: string[] }[] = [], usd = 0;
  for (const op of ops ?? []) {
    usd += Number(op.committed_usd ?? 0);
    if (!op.result_ref) continue;
    const d = await db.storage.from("videos").download(op.result_ref); if (!d.data) continue;
    const resp = JSON.parse(await d.data.text()); const obj = tryJson(textOf(resp));
    if (obj?.beats && Array.isArray(obj.beats) && obj.beats.some((b: any) => typeof b?.narration === "string")) { narrative = obj; narrativeAt = op.created_at; }
    const vis = obj?.visuals ?? obj?.scenes;
    if (Array.isArray(vis)) { const classes: Record<string, number> = {}; for (const v of vis) classes[v?.beatClass ?? "?"] = (classes[v?.beatClass ?? "?"] ?? 0) + 1; plans.push({ at: op.created_at, scenes: vis.length, classes, descs: vis.slice(0, 3).map((v: any) => String(v?.description ?? "").slice(0, 90)) }); }
  }
  log("OPS", { count: ops?.length ?? 0, committedUsd: Math.round(usd * 1e4) / 1e4, statuses: (ops ?? []).map((o) => o.status).join(",") });
  for (const p of plans) log("PLAN", p);
  if (narrative) {
    const beats = narrative.beats as any[]; const all = beats.map((b) => b.narration).join("\n\n");
    log("NARRATIVE", { at: narrativeAt, beats: beats.length, words: all.split(/\s+/).filter(Boolean).length, chars: all.length, minutesAt150wpm: Math.round(all.split(/\s+/).length / 150 * 10) / 10, title: narrative.title ?? null, keys: Object.keys(narrative) });
    const flags = ["hipot", "imagin", "nunca se enfrentaron", "jamás se enfrentaron", "siglos", "¿qué pasaría", "qué habría pasado", "si ", "ficción", "simulación"];
    log("FRAMING", Object.fromEntries(flags.map((k) => [k, (all.toLowerCase().match(new RegExp(k.replace(/[?¿]/g, "\\$&"), "g")) ?? []).length])));
    for (let i = 0, k = 0; i < all.length && k < 6; i += 3600, k++) console.log("TEXT" + k + " " + all.slice(i, i + 3600).replace(/\n/g, " ⏎ "));
  } else log("NARRATIVE", { found: false });
  const { data: files } = await db.storage.from("videos").list(`${job.user_id}`, { limit: 100, search: "e8048599" });
  log("MEDIA", { storageMatches: files?.map((x) => x.name) ?? [] });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
