/** Read-only planning simulation of e8048599 with the branch code: real script + paid visual plans (blocks 1–7). No provider call, no write. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
import { parseVisualPlan } from "../src/lib/video/long-form/documentary-script";
import { sequencesFromScript, SHOT_DENSITY_MAX_SEC } from "../src/lib/video/long-form/script-sequences";
import { computeProductionPlan, getRealLongFormProviderNames } from "../src/lib/video/long-form/production-plan";
import { applyNarrationPatches } from "../src/lib/video/long-form/narration-patch";
import { readFileSync } from "node:fs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const { data: j } = await db.from("documentary_script_jobs").select("*").eq("id", "e8048599-cf92-45e8-95c8-f145cb9d3be2").single();
  const job = j as any; const cp = job.editorial_checkpoint.script;
  const scope = documentaryLedgerScopeFor(job)!;
  const { data: ops } = await db.from("pi_paid_operations").select("result_ref,created_at").eq("project_id", scope).eq("status", "COMMITTED").order("created_at");
  const plans: any[] = [];
  for (const op of ops ?? []) {
    const d = await db.storage.from("videos").download(op.result_ref); if (!d.data) continue;
    const resp = JSON.parse(await d.data.text());
    try { const p = parseVisualPlan(resp, { cinematic: true, referenceContract: true, dropStubs: true }); if (Array.isArray((p as any).visuals) && (p as any).visuals.length) plans.push((p as any).visuals); } catch { /* not a visual plan */ }
  }
  log("PLANS", { parsed: plans.length, scenes: plans.map((v) => v.length) });
  const n = Math.min(plans.length, 7);
  const beats = cp.beats.slice(0, n).map((b: any, i: number) => ({ id: `beat-${i + 1}`, type: b.type, purpose: b.purpose, narration: b.narration, visuals: plans[i] }));
  const words = (t: string) => t.trim().split(/\s+/).length;
  const durationSec = (b: any) => words(b.narration) / 2.5;
  // Corrections dry-run on the FULL checkpoint script (no visuals yet for 8–10; quotes of 1–7 attached).
  const corr = JSON.parse(readFileSync("content/long-form/e8048599/correcciones.json", "utf8"));
  const full = { ...cp, beats: cp.beats.map((b: any, i: number) => ({ ...b, visuals: i < n ? plans[i] : [] })) };
  const pr = applyNarrationPatches(full, corr.patches);
  log("CORRECTIONS", pr.report);
  const providers = getRealLongFormProviderNames();
  for (const strategy of ["economical", "balanced", "cinematic"] as const) {
    for (const [label, maxShotSec] of [["before", undefined], ["after", SHOT_DENSITY_MAX_SEC[strategy]]] as const) {
      const seqs = sequencesFromScript(beats, maxShotSec ? { maxShotSec } : {});
      if (!seqs) { log("SIM", { strategy, label, error: "not v6" }); continue; }
      const perBeat = seqs.map((s, i) => ({ beat: i + 1, slots: s.slots.length, secPerSlot: Math.round(durationSec(beats[i]) / s.slots.length) }));
      for (const image of ["openai", "recraft"] as const) for (const ai of [false, true]) {
        try {
          const plan = computeProductionPlan({ beats, topic: cp.title, strategy, providers: { ...providers, image }, sequences: seqs, aiVideoEnabled: ai });
          log("SIM", { strategy, label, image, aiVideo: ai, shots: plan.shotCount, aiImages: plan.aiImageCount, stockImages: plan.stockImageCount, stockVideos: plan.stockVideoCount, aiClips: plan.aiVideoClipCount, voiceUsd: plan.estimatedVoiceCostUsd, imageUsd: plan.estimatedImageCostUsd, videoUsd: plan.estimatedAiVideoCostUsd, totalUsd: plan.estimatedProviderCostUsd, seconds: plan.durationSeconds, ...(label === "after" && image === "recraft" && !ai ? { perBeat } : {}) });
        } catch (e) { log("SIM", { strategy, label, image, aiVideo: ai, error: String(e).slice(0, 200) }); }
      }
    }
  }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
