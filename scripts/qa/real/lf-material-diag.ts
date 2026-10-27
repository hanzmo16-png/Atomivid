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
  console.log(`\n== ${shot.id} | intent: ${JSON.stringify(visual).slice(0, 300)}\n   queries: ${JSON.stringify(qs)}`);
  for (const r of rejects.slice(0, 5)) console.log("   ", r);
  if (++n >= max) break;
}
console.log(`\nDONE: printed ${n} scene(s) without an accepted candidate (of ${shots.length} planned)`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
