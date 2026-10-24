/** Read-only planning simulation of e8048599 with the branch code: real script + paid visual plans (blocks 1–7). No provider call, no write. */
import { createClient } from "@supabase/supabase-js";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
import { parseVisualPlan } from "../src/lib/video/long-form/documentary-script";
import { sequencesFromScript, SHOT_DENSITY_MAX_SEC } from "../src/lib/video/long-form/script-sequences";
import { computeProductionPlan, getRealLongFormProviderNames } from "../src/lib/video/long-form/production-plan";
import { applyNarrationPatches } from "../src/lib/video/long-form/narration-patch";
import { readFileSync } from "node:fs";
import { narrationCatalog } from "../src/lib/video/long-form/narration-catalog";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const { data: j } = await db.from("documentary_script_jobs").select("*").eq("id", "e8048599-cf92-45e8-95c8-f145cb9d3be2").single();
  const job = j as any; const cp = job.editorial_checkpoint.script;
  const scope = documentaryLedgerScopeFor(job)!;
  const { data: ops } = await db.from("pi_paid_operations").select("result_ref,created_at").eq("project_id", scope).eq("status", "COMMITTED").order("created_at");
  const catalog = new Map(narrationCatalog(cp.beats).map((e: any) => [e.id, e]));
  const byBeat = new Map<number, any[]>();
  const textOf = (r: any) => (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  for (const op of ops ?? []) {
    const d = await db.storage.from("videos").download(op.result_ref); if (!d.data) continue;
    const resp = JSON.parse(await d.data.text());
    let visuals: any[] | null = null;
    try { const p = parseVisualPlan(resp, { cinematic: true, referenceContract: true, dropStubs: true }); visuals = (p as any).visuals; }
    catch { try { const t = textOf(resp).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""); const o = JSON.parse(t); if (Array.isArray(o?.visuals)) visuals = o.visuals.filter((v: any) => typeof v?.description === "string" && v.description.trim() && v.excerptId); } catch { /* not a plan */ } }
    if (!visuals?.length) continue;
    const beatsSeen = [...new Set(visuals.map((v: any) => (catalog.get(v.excerptId) as any)?.beatIndex ?? (v.quote ? "q" : "?")))];
    void beatsSeen;
    const resolved = visuals.map((v: any) => { const e: any = v.excerptId ? catalog.get(v.excerptId) : null; const { excerptId: _x, ...rest } = v; return e ? { ...rest, quote: e.quote, _beat: e.beatIndex } : null; }).filter(Boolean) as any[];
    if (!resolved.length) continue;
    const b = resolved[0]._beat;
    byBeat.set(b, [...(byBeat.get(b) ?? []), ...resolved.map(({ _beat, ...r }: any) => r)]);
  }
  log("PLANS", { beats: [...byBeat.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({ beat: b, scenes: v.length })) });
  const plans: any[] = []; for (let i = 0; i < 10; i++) plans.push(byBeat.get(i));
  const have = plans.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const beats = have.map((i, k) => ({ id: `beat-${k + 1}`, type: cp.beats[i].type, purpose: cp.beats[i].purpose, narration: cp.beats[i].narration, visuals: plans[i] }));
  log("SUBSET", { beatsSimulated: have, words: beats.reduce((n: number, b: any) => n + b.narration.split(/\s+/).length, 0) });
  const cd = cp.creativeDirection ?? {};
  log("MARKS", ["signatureDetail", "shareableLine", "commentMoment", "closingCta"].map((k) => [k, cd[k]?.beatIndex, String(cd[k]?.quote ?? "").slice(0, 120)]).concat((cd.protectInEdit ?? []).map((m: any, i: number) => [`protect${i}`, m?.beatIndex, String(m?.quote ?? "").slice(0, 160)])));
  const words = (t: string) => t.trim().split(/\s+/).length;
  const durationSec = (b: any) => words(b.narration) / 2.5;
  // Corrections dry-run on the FULL checkpoint script (no visuals yet for 8–10; quotes of 1–7 attached).
  const corr = JSON.parse(readFileSync("content/long-form/e8048599/correcciones.json", "utf8"));
  const full = { ...cp, beats: cp.beats.map((b: any, i: number) => ({ ...b, visuals: plans[i] ?? [] })) };
  const pr = applyNarrationPatches(full, corr.patches);
  log("CORRECTIONS", pr.report);
  const providers = getRealLongFormProviderNames();
  for (const strategy of (process.env.SIM_ONLY ? [process.env.SIM_ONLY] : ["economical", "balanced", "cinematic"]) as ("economical" | "balanced" | "cinematic")[]) {
    for (const [label, maxShotSec] of [["before", undefined], ["after", SHOT_DENSITY_MAX_SEC[strategy]]] as const) {
      const seqs = sequencesFromScript(beats, maxShotSec ? { maxShotSec, aiVideoCandidates: strategy === "cinematic" } : {});
      if (!seqs) { log("SIM", { strategy, label, error: "not v6" }); continue; }
      if (strategy === "cinematic" && label === "after") {
        const all = seqs.flatMap((q) => q.slots);
        const dist: Record<string, number> = {}; for (const sl of all) { const k = `${sl.role}:i${sl.impact}:${(sl.visual as any).motion ? "m" : "s"}`; dist[k] = (dist[k] ?? 0) + 1; }
        log("CANDIDATES", { aiVideoCandidates: all.filter((sl) => (sl.visual as any).aiVideoCandidate).length, dist });
        try {
          const [{ scoreAiVideoEligibility }, { planSequenceShots }, { resolveSequences, PLAN_ESTIMATE_AVAILABILITY }, pp] = await Promise.all([import("../src/lib/video/long-form/ai-video-eligibility"), import("../src/lib/video/long-form/sequence-direction"), import("../src/lib/video/long-form/sequence-intent"), import("../src/lib/video/long-form/production-plan")]);
          const { shots, narrationSeconds } = planSequenceShots(beats as any, resolveSequences(seqs, PLAN_ESTIMATE_AVAILABILITY));
          const limits = pp.strategyLimits("cinematic", 2.36, { aiVideoEnabled: true, units: pp.getGenerativeUnitCosts("veo", "recraft") });
          const av = shots.filter((sh: any) => sh.type === "ai_video");
          log("ELIG", { limits: { maxClips: limits.maxAiVideoClips, maxImages: limits.maxAiImageGenerations, maxGenUsd: limits.maxGenerativeUsd, clipUsd: limits.units.veoClipUsd, cfg: limits.aiVideoCostConfig },
            shots: av.map((sh: any) => { const e = scoreAiVideoEligibility({ id: sh.id, visualIntent: sh.visualIntent, durationSec: sh.durationSec, type: "ai_video", motionRequired: sh.motionRequired }, limits.aiVideoCostConfig); return { d: Math.round(sh.durationSec), score: e.eligibilityScore, rec: e.recommendedAssetType, why: e.reason.slice(0, 90), intent: sh.visualIntent.slice(0, 70) }; }) });
          const alloc = pp.allocateShotTypes(shots, narrationSeconds, limits);
          log("ELIG", { allocated: alloc.aiVideoClipCount, reasons: alloc.shots.filter((x: any) => x.plannedType === "ai_video" || (x as any).degradeReason?.includes("video")).map((x: any) => x.degradeReason ?? x.plannedType).slice(0, 10) });
        } catch (e) { log("ELIG", { error: String(e).slice(0, 200) }); }
      }
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
