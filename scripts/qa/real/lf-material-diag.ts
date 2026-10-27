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
  // Read-only: supply state per provider (no amounts beyond units/levels) and the request's script job state.
  const sdb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  for (const pr of ["anthropic", "elevenlabs", "openai", "pexels", "recraft"]) {
    const { data, error } = await sdb.rpc("pi_supply_state", { p_provider: pr });
    const d = (data ?? {}) as Record<string, unknown>;
    console.log("supply", pr, error ? `error ${error.message.slice(0, 80)}` : JSON.stringify({ level: d.level, reason: d.reason, free: d.free, remainingRatio: d.remainingRatio, coverageHours: d.coverageHours, checkedAt: d.checkedAt, reliability: d.reliability }));
  }
  const { data: jobs } = await sdb.from("documentary_script_jobs").select("status,error_message,created_at,updated_at").eq("request_id", process.env.LF_REQUEST_ID!).order("created_at", { ascending: false }).limit(2);
  console.log("script jobs", JSON.stringify(jobs));
  const { data: unc } = await sdb.from("pi_paid_operations").select("provider,status,method,created_at").in("status", ["SUBMITTED", "RECONCILIATION_REQUIRED", "RESERVED"]).gte("created_at", "2026-10-27T00:00:00Z");
  console.log("open paid ops today", JSON.stringify(unc));
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
