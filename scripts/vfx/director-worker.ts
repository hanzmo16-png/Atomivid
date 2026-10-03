/** Dedicated VFX worker. No render occurs unless action=step and its gates pass.
 * Usage: VFX_JOB_MANIFEST=/trusted/manifest.json VFX_WORKER_ACTION=init|step npx tsx scripts/vfx/director-worker.ts
 * Manifest is operator/runner configuration, never model output or browser input.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createServiceClient } from "../../src/lib/supabase/service";
import { supabaseJobStore } from "../../src/lib/production-intelligence/vfx-director/store";
import { createJob, runTask, ownedJob, type DurableExecutor } from "../../src/lib/production-intelligence/vfx-director/jobs";
import { vfx002bExecutor } from "../../src/lib/production-intelligence/vfx-director/compositor";
import { STAGES } from "../../src/lib/production-intelligence/vfx-director/gates";
import { BriefSchema } from "../../src/lib/production-intelligence/vfx-director";
import { claudeDirection } from "../../src/lib/production-intelligence/vfx-director/planner";
import { supabaseLedgerStore } from "../../src/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "../../src/lib/paid-calls/result-store";
import Anthropic from "@anthropic-ai/sdk";
const Proof = z.object({ kind: z.literal("artifact"), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), stage: z.enum(STAGES) }).strict();
const Composite = z.object({ kind: z.literal("vfx002b"), source: z.string(), plate: z.string(), model: z.string(), root: z.string(), script: z.string() }).strict();
const Manifest = z.object({ jobId: z.string(), ownerId: z.string().uuid(), brief: z.unknown(), plan: z.unknown(), assets: z.array(z.string()), executors: z.record(z.string(), z.union([Proof, Composite])) }).strict();
async function main() {
  if (process.env.VFX_DIRECTOR_ENABLED !== "1") throw new Error("VFX_DISABLED");
  const manifest = Manifest.parse(JSON.parse(await readFile(process.env.VFX_JOB_MANIFEST ?? "", "utf8")));
  const sb = createServiceClient();
  const user = await sb.auth.admin.getUserById(manifest.ownerId);
  const { directorActor } = await import("../../src/lib/production-intelligence/vfx-director/access");
  if (user.error) throw new Error("VFX_OWNER_LOOKUP_FAILED");
  const actor = directorActor(user.data.user);
  const executors: Record<string, DurableExecutor> = {};
  for (const [name, config] of Object.entries(manifest.executors)) {
    executors[name] = config.kind === "vfx002b" ? vfx002bExecutor(config) : {
      capability: { available: true, paid: false, preservesOriginalPixels: true }, allowedStages: [config.stage],
      async run(task) {
        const sha256 = createHash("sha256").update(await readFile(config.path)).digest("hex");
        if (sha256 !== config.sha256) throw new Error("VFX_ARTIFACT_CHANGED");
        return { assetId: task.outputAssetId, sha256, checks: [{ name: "artifact-fingerprint", pass: true, evidence: sha256 }] };
      },
    };
  }
  const store = supabaseJobStore(sb);
  const action = process.env.VFX_WORKER_ACTION ?? "inspect";
  if (action === "plan") {
    const brief = BriefSchema.parse(manifest.brief);
    if (brief.projectId !== manifest.jobId) throw new Error("VFX_JOB_ID_MISMATCH");
    // Existing durable job wins: resumption must never request a new plan.
    if (await store.get(manifest.jobId)) { await ownedJob(store, manifest.jobId, actor); return; }
    const inventory = Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, e.capability]));
    const result = await claudeDirection({ brief, inventory, assets: manifest.assets }, {
      ledger: supabaseLedgerStore(sb), results: supabaseResultStore(sb),
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 }),
      model: process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5",
      quote: { maxUsd: Number(process.env.VFX_PLANNING_MAX_USD ?? 0), maxInputTokens: 16000, maxOutputTokens: 8000,
        inputUsdPerMillion: Number(process.env.VFX_PLANNING_INPUT_USD_PER_MILLION), outputUsdPerMillion: Number(process.env.VFX_PLANNING_OUTPUT_USD_PER_MILLION),
        verifiedSource: process.env.VFX_PLANNING_PRICE_SOURCE ?? "" },
    });
    if (result.result.status !== "PLANNED") { console.log(JSON.stringify(result.result)); return; }
    const job = await createJob(store, actor, actor, brief, result.result.plan, inventory, manifest.assets);
    console.log(JSON.stringify({ jobId: job.id, status: job.status, planHash: job.planHash }));
  } else if (action === "init") {
    if (BriefSchema.parse(manifest.brief).projectId !== manifest.jobId) throw new Error("VFX_JOB_ID_MISMATCH");
    const inventory = Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, e.capability]));
    const job = await createJob(store, actor, actor, manifest.brief, manifest.plan, inventory, manifest.assets);
    if (job.id !== manifest.jobId) throw new Error("VFX_JOB_ID_MISMATCH");
    console.log(JSON.stringify({ jobId: job.id, status: job.status, planHash: job.planHash }));
  } else if (action === "step") {
    const result = await runTask(store, manifest.jobId, actor, executors);
    console.log(JSON.stringify({ jobId: result.job.id, status: result.job.status, executed: result.executed }));
  } else if (action === "inspect") {
    const job = await ownedJob(store, manifest.jobId, actor);
    console.log(JSON.stringify({ jobId: job.id, status: job.status, activeTask: job.activeTask }));
  } else throw new Error("VFX_ACTION_UNSUPPORTED");
}
main().catch(() => { console.error("VFX_WORKER_BLOCKED"); process.exitCode = 1; });
