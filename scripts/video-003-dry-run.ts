/**
 * Video #003 deterministic pre-production dry run. Reads the REAL storyboard, takes read-only
 * capacity snapshots (ElevenLabs subscription endpoint, OpenAI model listing; Runway is ledger-
 * derived) BEFORE the dry run, then runs the zero-network pipeline and freezes the package:
 * research, script, storyboard, shot contracts, mix plan + preset deviation, policy evaluation,
 * cost estimate, capacity forecast, QA plan, production manifest, and a freeze file with hashes.
 * NO billable generation call can happen here: the pipeline throws on any fetch, and the capacity
 * endpoints used are free read-only endpoints. Usage: npx tsx scripts/video-003-dry-run.ts [outDir]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { video003ShotRecords, VIDEO_003, ROWS } from "../content/productions/video-003-lake-nyos/storyboard";
import { dryRunPipeline } from "../src/lib/production-core/pipeline";
import { buildProductionManifest } from "../src/lib/production-core/manifest";
import { MIX_PRESETS, measureMix, checkMixPreset } from "../src/lib/production-core/mix-presets";
import { PRODUCTION_POLICY_V1 } from "../src/lib/production-core/policy-engine";
import type { AdapterRegistry } from "../src/lib/production-core/admission";
import { elevenLabsSnapshot, openAiSnapshot, runwaySnapshot } from "../src/lib/production-intelligence/capacity/adapters";
import type { CapacitySnapshot } from "../src/lib/production-intelligence/capacity/capacity";

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

async function main() {
  const dir = "content/productions/video-003-lake-nyos";
  const out = process.argv[2] ?? path.join(dir, "freeze");
  fs.mkdirSync(out, { recursive: true });
  const now = new Date().toISOString();
  const budgetUsd = Number(process.env.VIDEO_003_BUDGET_USD ?? 40);

  // Read-only capacity snapshots taken BEFORE the dry run (the dry run forbids network).
  const realFetch = globalThis.fetch as never;
  const [eleven, openai] = await Promise.all([
    elevenLabsSnapshot(realFetch, process.env, 0, 0, now),
    openAiSnapshot(realFetch, process.env, 0, 0, now, { topupsUsd: 0, consumedUsd: 0 }),
  ]);
  const runway = runwaySnapshot(0, 0, now, { topupsUsd: 0, consumedUsd: 0 });
  const snapshots: Record<string, CapacitySnapshot> = { elevenlabs: eleven, openai, runway };
  const adapters: AdapterRegistry = Object.fromEntries(Object.entries(snapshots).map(([p, s]) => [p, ({ reserved, pending }) => ({ ...s, reserved, pending })]));

  // Paid records only (graphics are rendered internally; the dry-run router maps them to a paid provider — see acceptance doc).
  const allRecords = video003ShotRecords();
  const records = video003ShotRecords({ includeGraphics: false });
  const totalSeconds = allRecords.reduce((t, r) => t + r.durationTargetSec, 0);
  // The dry-run timeline holds the PAID shots only (graphics are internal, USD 0, outside the paid mix); narration timing is checked against that timeline.
  const finished = records.reduce((t, r) => t + r.durationTargetSec, 0);
  const speechSeconds = finished;
  const narrationCharacters = fs.readFileSync(path.join(dir, "SCRIPT.md"), "utf8").split("## S1")[1].split("---")[0].replace(/^##.*$/gm, "").length;
  const dry = await dryRunPipeline({ projectId: VIDEO_003.projectId, records, finishedSeconds: finished, narrationCharacters, speech: [{ startSec: 0, endSec: speechSeconds }], projectBudgetUsd: budgetUsd, adapters, ceilings: PRODUCTION_POLICY_V1.budget.perProviderCeilingUsd, now, operatorAcceptsUnknown: false });
  const manifest = buildProductionManifest({ dryRun: dry, projectId: VIDEO_003.projectId, projectBudgetUsd: budgetUsd, now, preset: MIX_PRESETS.ECONOMICAL_30_70 });

  // Full-timeline mix measure (graphics included, planned methods from the dry run).
  const planned = new Map(dry.records.map((r) => [r.contract.shotId, r.plannedMethod]));
  const full = allRecords.map((r) => ({ ...r, plannedMethod: planned.get(r.contract.shotId) ?? null }));
  const mixFull = measureMix(full);
  const presets = Object.values(MIX_PRESETS).map((p) => checkMixPreset(mixFull, p));
  const first30 = (() => { let t = 0; const s: number[] = []; for (const r of allRecords) { if (t >= 30) break; s.push(r.durationTargetSec); t += r.durationTargetSec; } return { shots: s.length, averageSeconds: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100 }; })();
  const script = fs.readFileSync(path.join(dir, "SCRIPT.md"), "utf8");
  const narration = script.split("## S1")[1].split("---")[0].replace(/^##.*$/gm, "");
  const summary = {
    title: VIDEO_003.title, projectId: VIDEO_003.projectId, generatedAt: now, budgetUsd,
    script: { words: words(narration), characters: narrationCharacters, estimatedSpeechMinutesAt150wpm: Math.round((words(narration) / 150) * 100) / 100 },
    storyboard: { shots: allRecords.length, paidShots: records.length, graphics: allRecords.length - records.length, targetSeconds: totalSeconds, paidTimelineSeconds: finished, first30Seconds: first30, byKind: ROWS.reduce<Record<string, number>>((m, r) => ({ ...m, [r[1]]: (m[r[1]] ?? 0) + 1 }), {}) },
    mix: { measured: mixFull, presets, selected: "mix/economical-30-70", engine: { generativeShots: dry.mix.generativeShots, generativeSecondsUsed: dry.mix.generativeSecondsUsed, generativeSecondsBudget: dry.mix.generativeSecondsBudget, heroShots: dry.mix.heroShots, unresolvedRhythm: dry.mix.rhythm?.unresolved.length ?? null } },
    cost: manifest.cost, capacity: { verdict: manifest.capacity.verdict, perProvider: manifest.capacity.perProvider, snapshots: Object.fromEntries(Object.entries(snapshots).map(([p, s]) => [p, { unit: s.unit, available: s.available, health: s.health, reliability: s.reliability, renewalDate: s.renewalDate }])) },
    policy: { violations: manifest.policy.violations.length, timelinePass: manifest.policy.timelinePass, findings: manifest.policy.timelineFindings },
    ok: manifest.ok, blockers: manifest.blockers, networkCallsDuringDryRun: manifest.networkCalls,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(path.join(out, "shot-contracts.json"), JSON.stringify(dry.records.map((r) => r), null, 1) + "\n");
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const freeze = { freeze: "VIDEO_003_PREPRODUCTION", generatedAt: now, files: Object.fromEntries(["TOPIC-SELECTION.md", "RESEARCH.md", "SCRIPT.md", "storyboard.ts"].map((f) => [f, sha(path.join(dir, f))])), artifacts: Object.fromEntries(["manifest.json", "shot-contracts.json", "summary.json"].map((f) => [f, sha(path.join(out, f))])), pins: manifest.pins, engineNote: "frozen PI V1.1 engine imported unchanged" };
  const freezeHash = crypto.createHash("sha256").update(JSON.stringify(freeze)).digest("hex");
  fs.writeFileSync(path.join(out, "freeze.json"), JSON.stringify({ ...freeze, freezeHash }, null, 1) + "\n");
  console.log(JSON.stringify({ ok: summary.ok, blockers: summary.blockers, shots: summary.storyboard, script: summary.script, mix: { share: mixFull.share, engine: summary.mix.engine, preset30_70: presets.find((p) => p.presetId === "mix/economical-30-70")?.note }, cost: { estimated: manifest.cost.estimatedUsd, reserved: manifest.cost.reservedUsd, retry: manifest.cost.retryUsd, remaining: manifest.cost.remainingBudgetUsd, byProvider: manifest.cost.byProvider }, capacity: summary.capacity, timeline: summary.policy, freezeHash }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
