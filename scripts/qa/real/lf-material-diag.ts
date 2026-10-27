// Read-only diagnosis of the Long Form material preflight for ONE request (closure 2026-10-27): rebuilds the confirmed
// plan's shots and, for the first stock scenes the worker reported missing, prints the visual intent, the queries and
// why each Pexels candidate was rejected. Free searches only; writes nothing; prints no ids or private text beyond the
// visual intents (generic stock descriptions) and the providers' public photo/video descriptions.
import { createClient } from "@supabase/supabase-js";
import { planShotsFromScript } from "@/lib/video/long-form/production-plan";
import { usesAnchoredVisuals, usesVisualIdentity, type ProductionPlan } from "@/lib/video/long-form/production-plan-types";
import { screenCandidate, searchCandidatesStrict, selectionQueries } from "@/lib/video/long-form/stock-selection";
import { getFootageProvider } from "@/lib/providers/footage";

async function main() {
if (process.env.DIAG_SUPPLY) {
  // SOLO LECTURA (SELECT y la función pi_supply_state, sin escrituras). Imprime niveles, contadores y límites numéricos;
  // nunca claves, textos de evidencia (solo presente/ausente), correos ni ids de cuenta (se muestran como hash corto).
  const sdb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { createHash } = await import("node:crypto");
  const redact = (v: unknown) => String(v ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `acct#${createHash("sha256").update(m).digest("hex").slice(0, 6)}`);
  const now = Date.now();
  const { data: pols } = await sdb.from("pi_supply_policies").select("provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,timezone,evidence,updated_at");
  for (const p of pols ?? []) console.log("policy", JSON.stringify({ ...p, evidence: String(p.evidence ?? "").trim() ? "present" : "absent" }));
  for (const pr of ["__global__", "anthropic", "elevenlabs", "openai"]) {
    const { data, error } = await sdb.rpc("pi_supply_state", { p_provider: pr });
    const d = (data ?? {}) as Record<string, unknown>;
    const age = d.checkedAt ? Math.round((now - Date.parse(String(d.checkedAt))) / 3600000) : null;
    console.log("supply", pr, error ? `error ${error.message.slice(0, 80)}` : JSON.stringify({ level: d.level, reason: d.reason, free: d.free, unreserved: d.unreserved, held: d.held, activeCalls: d.activeCalls, todayCalls: d.todayCalls, dailySpend: d.dailySpend, monthlySpend: d.monthlySpend, coverageHours: d.coverageHours, checkedAt: d.checkedAt, ageHours: age }));
  }
  const { data: jobs } = await sdb.from("documentary_script_jobs").select("id,status,stage,retry_count,editorial_rounds,resubmit_allowance,error_message,error_code,failure_kind,created_at,updated_at").eq("request_id", process.env.LF_REQUEST_ID!).order("created_at", { ascending: false }).limit(2);
  console.log("script jobs (by request)", redact(JSON.stringify(jobs)));
  const { data: jobs2 } = await sdb.from("documentary_script_jobs").select("id,request_id,topic,status,stage,retry_count,error_message,created_at,updated_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("script jobs today", redact(JSON.stringify((jobs2 ?? []).map((j) => ({ ...j, topic: String(j.topic).slice(0, 40) })))));
  const { data: ops } = await sdb.from("pi_paid_operations").select("project_id,shot_id,status,method,model,reserved_usd,committed_usd,attempt_kind,created_at,updated_at").eq("provider", "anthropic").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  const byStatus: Record<string, { n: number; reserved: number; committed: number }> = {};
  for (const o of ops ?? []) { const k = `${o.method}/${o.status}`; byStatus[k] ??= { n: 0, reserved: 0, committed: 0 }; byStatus[k].n++; byStatus[k].reserved += Number(o.reserved_usd ?? 0); byStatus[k].committed += Number(o.committed_usd ?? 0); }
  console.log("anthropic ops today by status", JSON.stringify(byStatus));
  for (const o of (ops ?? []).filter((x) => x.status !== "COMMITTED")) console.log("anthropic non-committed op", redact(JSON.stringify(o)));
  const last = (ops ?? []).slice(-3).map((o) => ({ project: redact(o.project_id).slice(0, 40), status: o.status, reserved_usd: o.reserved_usd, committed_usd: o.committed_usd, created_at: o.created_at, updated_at: o.updated_at }));
  console.log("anthropic last ops", JSON.stringify(last));
  const { data: eps } = await sdb.from("podcast_studio_episodes").select("id,title,status,authorized_usd,cost_usd,created_at,updated_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("podcast studio episodes today", JSON.stringify((eps ?? []).map((e) => ({ ...e, title: String(e.title).slice(0, 34) }))));
  const { data: pops } = await sdb.from("podcast_studio_operations").select("episode_id,provider,op,state,reserved_usd,actual_usd,created_at").gte("created_at", "2026-10-27T00:00:00Z").order("created_at");
  console.log("podcast studio ops today", JSON.stringify(pops));
  return;
}
const id = process.env.LF_REQUEST_ID!, max = Number(process.env.DIAG_SHOTS || 6);
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: row } = await db.from("video_requests").select("script_json,long_form_production_plan,language").eq("id", id).single();
const plan = row!.long_form_production_plan as ProductionPlan; const script = row!.script_json as { topic: string; beats: never[] };
console.log("plan", { version: plan.version, strategy: plan.strategy, anchored: usesAnchoredVisuals(plan), language: row!.language });
const { shots } = planShotsFromScript(script.beats, script.topic, plan.strategy, usesAnchoredVisuals(plan), usesVisualIdentity(plan));
const provider = getFootageProvider();
let n = 0;
for (const shot of shots as Array<{ id: string; type?: string; anchoredVisual?: never; visualIntent?: string; durationSec?: number }>) {
  const visual = (shot.anchoredVisual ?? { description: shot.visualIntent ?? "", motion: false }) as never;
  const qs = selectionQueries(visual);
  let accepted = false; const rejects: string[] = [];
  for (const [tier, q] of qs.entries()) {
    const cands = await searchCandidatesStrict(provider, q, true, (shot.durationSec ?? 4) + 1.2).catch((e) => { rejects.push(`ERROR ${String(e).slice(0, 80)}`); return []; });
    for (const c of cands) { const s = screenCandidate(visual, c, tier, { footageProvider: provider }); if ("reject" in s) rejects.push(`[q${tier}] ${s.reject.slice(0, 160)}`); else { accepted = true; break; } }
    if (accepted) break;
  }
  if (accepted) continue;
  const v = visual as { subject?: string; description?: string; place?: string };
  if (process.env.DIAG_COMPACT) console.log(`MISS ${shot.id} | type ${shot.type} | subject «${v.subject ?? ""}» | place «${v.place ?? ""}» | desc «${(v.description ?? "").slice(0, 90)}» | best «${(rejects[0] ?? "").replace(/^\[q\d\] /, "").slice(0, 110)}»`);
  else { console.log(`\n== ${shot.id} | intent: ${JSON.stringify(visual).slice(0, 300)}\n   queries: ${JSON.stringify(qs)}`); for (const r of rejects.slice(0, 5)) console.log("   ", r); }
  if (++n >= max) break;
}
console.log(`\nDONE: printed ${n} scene(s) without an accepted candidate (of ${shots.length} planned)`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
