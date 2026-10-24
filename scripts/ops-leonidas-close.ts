/**
 * READ-ONLY closing analysis of e8048599 at REPLAY_REF (PR #199 head). No provider call, no write.
 *  1. Offline replay of the script job exactly as runScriptJobStep runs it: every Anthropic request is answered from the
 *     COMMITTED ledger responses (exact fingerprint). The three visual plans that were never paid (blocks 8–10) are
 *     answered with a PROJECTION built from the observed plans (same class/era/motion mix, catalog excerpt ids), and
 *     reported as such. Any other uncached request stops the run.
 *  2. Owner corrections (owner-corrections-registry) on the finished script + editorialApprovalError.
 *  3. Per-block counts (observed vs projected) for the plans Configure would show, Recraft vs OpenAI, with/without clips.
 *  4. Budget envelope as produce.ts builds it, ledger history, recovery budget, supply state and snapshots.
 *  5. Music: original license pages (HTML), Silverman FAQ; loudness of the pending track vs the mix levels.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const JOB = "e8048599-cf92-45e8-95c8-f145cb9d3be2";

async function main() {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "FAL_KEY", "FAL_ADMIN_KEY", "RUNWAY_API_KEY"]) delete process.env[k];
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { stableHash } = await import("../src/lib/production-intelligence/canonical");
  const { documentarySupplyScope } = await import("../src/lib/supply/anthropic");
  const { researchDocumentary, RESEARCH_VERSION } = await import("../src/lib/video/long-form/research");
  const { generateDocumentaryScript } = await import("../src/lib/video/long-form/documentary-script");
  const { parseSources, parseOpenQuestions } = await import("../src/app/dashboard/long-form/new/parse");
  const { EDITORIAL_VERSION, editorialApprovalError } = await import("../src/lib/video/long-form/editorial");
  const { cinematicV6Enabled } = await import("../src/lib/video/long-form/cinematic-v6-access");
  const { withOwnerCorrections, ownerCorrectionsFor } = await import("../src/lib/video/long-form/owner-corrections-registry");
  const { applyOwnerCorrections } = await import("../src/lib/video/long-form/owner-corrections");
  const { narrationCatalog } = await import("../src/lib/video/long-form/narration-catalog");

  // ---- job, owner, ledger
  const { data: job, error } = await db.from("documentary_script_jobs").select("id,user_id,status,stage,error_code,retry_count,editorial_rounds,resubmit_allowance,input,updated_at").eq("id", JOB).single();
  if (error || !job) throw Error("job read");
  log("JOB", { status: job.status, stage: job.stage, code: job.error_code, retries: job.retry_count, updated: job.updated_at });
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  // The worker reads CINEMATIC_V6_ENABLED_EMAILS (not passed to this workflow). The paid plans carry beatClass/impact,
  // i.e. they were produced in V6: force it and verify below that every reused plan declares impact.
  const v6env = cinematicV6Enabled(owner?.user as never); const v6 = true;
  const input = job.input as any, fields = input.fields;
  const scope = documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: input.creativeHistory,
    ...(input.referenceContract ? { referenceContract: input.referenceContract } : {}) }, false);
  const { data: allOps } = await db.from("pi_paid_operations").select("idempotency_key,shot_id,status,reserved_usd,committed_usd,result_ref,provider,created_at").eq("project_id", scope.projectId).order("created_at");
  const byStatus: Record<string, { n: number; usd: number }> = {};
  for (const o of allOps ?? []) { const s = (byStatus[o.status] ??= { n: 0, usd: 0 }); s.n++; s.usd += Number(o.committed_usd ?? 0) || (o.status === "COMMITTED" ? 0 : Number(o.reserved_usd ?? 0)); }
  log("LEDGER", { project: scope.projectId.slice(0, 40), v6env, v6forced: v6, byStatus, first: allOps?.[0]?.created_at, last: allOps?.at(-1)?.created_at });
  const { data: budget } = await db.from("pi_recovery_budgets").select("project_id,cap_usd,authorization_ref,status,created_at").eq("job_id", JOB).maybeSingle();
  const usage = budget ? await db.rpc("pi_recovery_budget_usage", { p_project_id: budget.project_id, p_exclude_key: null }) : null;
  const durable = budget ? await db.rpc("pi_recovery_resume_authorization", { p_project_id: budget.project_id, p_authorization_ref: budget.authorization_ref }) : null;
  log("BUDGET", { budget, usage: usage?.data ?? usage?.error?.message ?? null, durableForBudgetRef: durable?.data ?? durable?.error?.message ?? null });
  const responses = new Map<string, unknown>();
  for (const o of allOps ?? []) if (o.status === "COMMITTED" && o.result_ref && !String(o.result_ref).startsWith("rejected:")) {
    const f = await db.storage.from("videos").download(o.result_ref); if (f.data) responses.set(String(o.shot_id).split(":")[2], JSON.parse(await f.data.text()));
  }

  // ---- supply / policies / snapshots (before fetch is replaced)
  const providers = ["anthropic", "elevenlabs", "recraft", "openai", "veo", "__global__"];
  const { data: policies } = await db.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,baseline,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence").in("provider", providers);
  log("POLICY", policies);
  for (const p of providers.filter((p) => p !== "__global__")) {
    const st = await db.rpc("pi_supply_state", { p_provider: p });
    const { data: snaps } = await db.from("pi_capacity_snapshots").select("available,unit,health,reliability,status,checked_at").eq("provider", p).order("checked_at", { ascending: false }).limit(3);
    log("SUPPLY", { p, state: st.data ?? st.error?.message, snapshots: snaps });
  }
  const { data: reqs } = await db.from("video_requests").select("id,status,created_at").eq("user_id", job.user_id).order("created_at", { ascending: false }).limit(3);
  log("REQUESTS", { recent: reqs?.map((r) => ({ id: r.id.slice(0, 8), status: r.status, created: r.created_at })) });

  // ---- offline replay with projection for unpaid visual plans
  const origFetch = globalThis.fetch;
  const projectionSource: any[] = [];   // observed scenes (fields only) to model unpaid blocks
  const projected = new Set<number>(); let hits = 0, stage = "";
  process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (!String(url).includes("anthropic")) throw Error(`OFFLINE: unexpected host ${String(url).slice(0, 40)}`);
    const params = JSON.parse(String(init?.body));
    const saved = responses.get(stableHash(params, 16));
    const user = (() => { try { return JSON.parse(params.messages?.[0]?.content ?? "{}"); } catch { return {}; } })();
    const isPlan = typeof params.system === "string" ? params.system.includes("Planifica escenas documentales") : JSON.stringify(params.system ?? "").includes("Planifica escenas documentales");
    if (saved) {
      hits++;
      if (isPlan) { try { const t = (saved as any).content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""); const m = t.match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0].replace(/,\s*([A-Za-z_]\w*)\s*:/g, ',"$1":')) : null; for (const v of o?.visuals ?? []) projectionSource.push(v); } catch { /* best effort */ } }
      return new Response(JSON.stringify(saved), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (isPlan && Array.isArray(user.narrationExcerpts) && user.narrationExcerpts.length) {
      const ex = user.narrationExcerpts as { id: string; beatIndex: number }[];
      const beatIndex = ex[0].beatIndex; projected.add(beatIndex);
      const n = Math.min(12, Math.max(2, Math.round(8)));
      const step = ex.length / n;
      const visuals = Array.from({ length: n }, (_, k) => {
        const src = projectionSource[(k + beatIndex * 3) % Math.max(1, projectionSource.length)] ?? {};
        const { excerptId: _e, quote: _q, identity: _i, evidence: _v, ...rest } = src;
        const cls = rest.beatClass === "IDENTITY" || rest.beatClass === "EVIDENCE" ? "PLACE" : (rest.beatClass ?? "PLACE");
        return { ...rest, beatClass: cls, description: `PROJECTION ${rest.description ?? "scene"}`.slice(0, 120), excerptId: ex[Math.min(ex.length - 1, Math.floor(k * step))].id,
          impact: rest.impact ?? 2, impactReason: rest.impactReason ?? "projection", motion: rest.motion === true, subject: rest.subject ?? "scene" };
      });
      return new Response(JSON.stringify({ id: "proj", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ visuals }) }], usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw Error(`OFFLINE_BOUNDARY at ${stage}`);
  }) as typeof fetch;
  let script: any = null, editorial: any = null;
  try {
    const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
    const beats = await generateDocumentaryScript({ researchPack, creativeHistory: input.creativeHistory, referenceContract: input.referenceContract, writerContract: input.writerContract,
      extraEditorialRounds: job.editorial_rounds ?? 0, mode: "curiosity_documentary", language: fields.language, targetDurationSeconds: Number(fields.durationMinutes) * 60,
      cinematicV6: v6, allowVisualSceneRepair: (job.retry_count ?? 0) > 0, onStage: async (l: string) => { stage = l; }, onEditorialApproved: (r: unknown) => { editorial = r; } } as never);
    script = { topic: fields.topic, beats: (beats as any[]).map((b, i) => ({ id: `beat-${i + 1}`, ...b })), editorial, sources: researchPack.sources };
  } catch (e) { log("REPLAY", { error: String(e).slice(0, 300), stage, hits }); }
  finally { globalThis.fetch = origFetch; delete process.env.ANTHROPIC_API_KEY; }
  if (!script) return;
  log("REPLAY", { reusedPlansDeclareImpact: script.beats.filter((_: any, i: number) => !projected.has(i)).every((b: any) => (b.visuals ?? []).every((v: any) => [1, 2, 3].includes(v.impact))), savedResponses: responses.size, hits, projectedBlocks: [...projected].map((b) => b + 1), approved: !!editorial, approvalError: editorialApprovalError(script) });

  // ---- owner corrections on the finished script
  const entry = ownerCorrectionsFor(JOB)!;
  const dry = applyOwnerCorrections(script, entry.corrections, entry.source);
  log("CORRECTIONS", { ok: dry.ok, errors: dry.errors, applied: dry.record?.narration?.map((a) => [a.beatIndex + 1, a.wordsBefore, a.wordsAfter]), claims: dry.record?.claims, reviewQuotesUpdated: dry.record?.reviewQuotesUpdated,
    quotesUpdated: dry.report?.quotesUpdated, marksUpdated: dry.report?.marksUpdated, wordDelta: dry.report?.wordDelta });
  // Claims/review evidence still mentioning corrected facts (to decide claim patches).
  const stale = /440 BCE|eight[- ]meter|8 m\b|undocumented|defeated open ground|None of that exists|widely held but unverified|general historical understanding/i;
  script.beats.forEach((b: any, i: number) => (b.claims ?? []).forEach((c: any) => { if (stale.test(c.text)) log("CLAIM", { beat: i + 1, id: c.id, support: c.support, text: c.text }); }));
  let corrected: any = script;
  try { corrected = withOwnerCorrections(JOB, script); log("CORRECTED", { approvalError: editorialApprovalError(corrected), hashChanged: corrected.editorial.scriptHash !== script.editorial.scriptHash }); }
  catch (e) { log("CORRECTED", { error: String(e).slice(0, 400) }); }
  (corrected.beats as any[]).forEach((b: any, i: number) => (b.claims ?? []).forEach((c: any) => { if (stale.test(c.text)) log("CLAIM_AFTER", { beat: i + 1, id: c.id, text: c.text.slice(0, 160) }); }));

  // ---- anchors, order, coverage, duration per block (before → after corrections)
  const { intentWordSpans } = await import("../src/lib/video/long-form/scene-anchoring");
  const { estimateNarrationSeconds } = await import("../src/lib/video/long-form/production-plan");
  const anchorStats = (b: any) => { const sp = intentWordSpans(b.narration, b.visuals ?? []); const words = b.narration.trim().split(/\s+/).length;
    const covered = new Set<number>(); sp.forEach((s: any) => { for (let w = s.start; w < s.end; w++) covered.add(w); });
    return { scenes: (b.visuals ?? []).length, quoteAnchored: sp.filter((s: any) => s.anchoredBy === "quote").length, ordered: sp.every((s: any, k: number) => k === 0 || s.start >= sp[k - 1].start), coverage: +(covered.size / words).toFixed(3), sec: +estimateNarrationSeconds(b.narration).toFixed(1) }; };
  const rows = script.beats.map((b: any, i: number) => ({ block: i + 1, projected: projected.has(i), before: anchorStats(b), after: anchorStats(corrected.beats[i]) }));
  for (const r of rows) log("ANCHORS", r);
  const eras: Record<string, number> = {}; for (const b of corrected.beats) for (const v of b.visuals ?? []) { const k = `${String(v.era ?? "") || "(vacía)"}:${v.motion ? "m" : "s"}`; eras[k] = (eras[k] ?? 0) + 1; }
  log("ERAS", eras);

  // ---- plans per strategy × image provider × clips, per-block breakdown
  const pp = await import("../src/lib/video/long-form/production-plan");
  const { productPlan } = await import("../src/lib/video/long-form/product-plan");
  const { sequencesFromScript, SHOT_DENSITY_MAX_SEC } = await import("../src/lib/video/long-form/script-sequences");
  const { planSequenceShots } = await import("../src/lib/video/long-form/sequence-direction");
  const { resolveSequences, PLAN_ESTIMATE_AVAILABILITY } = await import("../src/lib/video/long-form/sequence-intent");
  const { allocateWithImagePriority, recraftImageBudget } = await import("../src/lib/video/long-form/image-priority");
  const beats = corrected.beats.map((b: any) => ({ id: b.id, type: b.type, purpose: b.purpose, narration: b.narration, visuals: b.visuals }));
  const prov = pp.getRealLongFormProviderNames();
  for (const strategy of ["balanced", "cinematic"] as const) for (const image of ["recraft", "openai"] as const) for (const ai of strategy === "cinematic" ? [false, true] : [false]) {
    const providers = { ...prov, image };
    let plan: any;
    try { const saved = process.env.LONG_FORM_AI_VIDEO_ENABLED; process.env.LONG_FORM_AI_VIDEO_ENABLED = String(ai); plan = productPlan({ beats, topic: corrected.topic, strategy, providers, requestedDurationSeconds: 900, cinematicV6: true }).plan; process.env.LONG_FORM_AI_VIDEO_ENABLED = saved; }
    catch (e) { log("PLAN", { strategy, image, ai, error: String(e).slice(0, 200) }); continue; }
    // per block: replicate computeProductionPlan's allocation to read each shot's type
    const seqs = sequencesFromScript(beats, { maxShotSec: SHOT_DENSITY_MAX_SEC[strategy], aiVideoCandidates: strategy === "cinematic" })!;
    const { shots, narrationSeconds } = planSequenceShots(beats, resolveSequences(seqs, PLAN_ESTIMATE_AVAILABILITY));
    const limits = { ...pp.strategyLimits(strategy, plan.estimatedVoiceCostUsd, { aiVideoEnabled: ai, units: pp.getGenerativeUnitCosts(providers.aiVideo, image) }), cinematic: true };
    const alloc = image === "recraft" ? allocateWithImagePriority(shots as any, new Map(beats.map((b: any) => [b.id, b.type])), recraftImageBudget(Number(process.env.LONG_FORM_MAX_IMAGE_USD || 5), pp.imageUnitUsd("recraft")).planned, (s: any) => pp.allocateShotTypes(s, narrationSeconds, limits)).allocation : pp.allocateShotTypes(shots as any, narrationSeconds, limits);
    const per = beats.map((b: any, i: number) => { const s = alloc.shots.filter((x: any) => x.beatId === b.id); const c = (t: string[]) => s.filter((x: any) => t.includes(x.type)).length;
      const subs = s.filter((x: any) => (x.anchoredVisual as any)?.subShot).length;
      return [i + 1, projected.has(i) ? "P" : "O", Math.round(estimateNarrationSeconds(b.narration)), s.length, c(["generated_placeholder"]), c(["stock_image", "ken_burns_image"]), c(["stock_video"]), c(["ai_video"]), c(["text", "diagram", "map"]), subs]; });
    const reasons: Record<string, number> = {}; for (const x of alloc.shots as any[]) if (x.degradeReason) reasons[x.degradeReason.slice(0, 70)] = (reasons[x.degradeReason.slice(0, 70)] ?? 0) + 1;
    log("PLAN", { strategy, image, ai, shots: plan.shotCount, aiImages: plan.aiImageCount, stockImages: plan.stockImageCount, stockVideos: plan.stockVideoCount, clips: plan.aiVideoClipCount, cards: plan.deterministicCount,
      seconds: plan.durationSeconds, voiceChars: plan.voiceCharacters, voiceUsd: plan.estimatedVoiceCostUsd, imageUsd: plan.estimatedImageCostUsd, videoUsd: plan.estimatedAiVideoCostUsd, totalUsd: plan.estimatedProviderCostUsd,
      allocation: plan.allocation, priority: plan.imagePriority ? { planned: plan.imagePriority.plannedImages, reserve: plan.imagePriority.regenerationReserve, perImageUsd: plan.imagePriority.perImageUsd } : null });
    log("PERBLOCK", { strategy, image, ai, cols: ["block", "O/P", "sec", "shots", "aiImg", "stockImg", "stockVid", "clips", "cards", "subShots"], rows: per });
    log("DEGRADE", { strategy, image, ai, reasons });
  }
  const pricing = (await import("../src/lib/billing/pricing")).getPricingConfig?.();
  log("UNITS", { recraft: pp.getGenerativeUnitCosts("veo", "recraft"), openai: pp.getGenerativeUnitCosts("veo", "openai"), pricing, budgetEnv: { maxImage: process.env.LONG_FORM_MAX_IMAGE_USD, maxTotal: process.env.LONG_FORM_MAX_TOTAL_USD } });

  // ---- music: original pages + loudness of the pending track
  for (const u of ["https://www.silvermansound.com/free-music/passage-of-arms", "https://www.silvermansound.com/free-music/the-fall-of-heroes", "https://www.silvermansound.com/faqs"]) {
    try { const r = await fetch(u); const h = await r.text(); const txt = h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const pick = (re: RegExp) => (txt.match(re) ?? []).slice(0, 4).map((s) => s.slice(0, 260));
      log("MUSIC_LICENSE", { u, http: r.status, license: pick(/[^.]{0,120}(CC BY|Creative Commons|Attribution 4\.0)[^.]{0,160}/g), credit: pick(/Music: [^"<]{0,140}/g), vocals: pick(/[^.]{0,80}(vocal|choir|instrumental)[^.]{0,80}/gi), youtube: pick(/[^.]{0,120}YouTube[^.]{0,160}/g) }); }
    catch (e) { log("MUSIC_LICENSE", { u, error: String(e).slice(0, 120) }); }
  }
  try {
    const r = await fetch("https://www.silvermansound.com/wp-content/uploads/passage-of-arms.mp3"); const b = Buffer.from(await r.arrayBuffer()); writeFileSync("/tmp/poa.mp3", b);
    const out = execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-i", "/tmp/poa.mp3", "-af", "ebur128=peak=true", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    void out;
  } catch (e: any) { const s = String(e?.stderr ?? e); const I = s.match(/I:\s+(-?[\d.]+) LUFS/g)?.at(-1); const P = s.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.at(-1); log("MUSIC_LOUDNESS", { integrated: I, truePeak: P }); }
  log("END", { providerCalls: 0, writes: 0 });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
