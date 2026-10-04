/**
 * Server-controlled executor configuration for page-initiated runs (see execution.ts).
 *
 * This file — reviewed in git and pinned by the dispatch record's commit — is the ONLY source of
 * executors, material locations and capabilities for the runner. Nothing here comes from the browser,
 * from a model or from runtime environment variables. Materials are private Storage objects bound by
 * SHA-256; the runner downloads and verifies them into a fixed local directory so a compositor's
 * recipe fingerprint (which includes its file paths) is identical on every run.
 *
 * Capabilities must equal the job's frozen inventory: runTask recompiles the plan with the runner's
 * executors and refuses any difference, so a profile can never silently change an approved plan.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { PaidResultStore } from "@/lib/paid-calls/result-store";
import type { Capability } from "./index";
import type { DurableExecutor, Job } from "./jobs";
import { worldCompositeExecutor, cutMasterExecutor, assertReviewedSegments } from "./sequence-compositor";

/** Fixed runner directory: compositor recipe fingerprints include their local paths. */
export const RUNNER_ROOT = "/tmp/atomivid-vfx-runner";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const STAGE = z.enum(["preview", "direction", "styleframe", "motion", "integration", "master"]);
const CapabilitySchema = z.object({ available: z.boolean(), paid: z.literal(false), preservesOriginalPixels: z.boolean(),
  recipeVersion: z.string().optional(), fullShotOnly: z.boolean().optional(),
  environments: z.array(z.object({ kind: z.enum(["city", "beach", "moon", "other"]), lighting: z.enum(["night_practical", "daylight_soft", "sun_hard", "other"]) }).strict()).optional() }).strict();
const StoredArtifact = z.object({ kind: z.literal("stored-artifact"), capability: CapabilitySchema, stages: z.array(STAGE).min(1) }).strict();
const Compositor = z.object({ kind: z.enum(["world-composite", "cut-master"]), config: z.record(z.string(), z.unknown()) }).strict();
const ProfileSchema = z.object({ jobId: z.string().min(1), executors: z.record(z.string(), z.union([StoredArtifact, Compositor])) }).strict();
export type ExecutionProfile = z.infer<typeof ProfileSchema>;

/** Paid executors are not registerable from the page (capability.paid is literally false). */
const PROFILES: ExecutionProfile[] = [
  {
    // Three-world preparation: an artifact registry. Physical renders were measured and reviewed
    // outside the page; the registry only records operator-staged private artifacts by fingerprint.
    // It cannot render, call a provider or replace the approved master (completed tasks are skipped).
    jobId: "precampaign-three-worlds-v1-preparation",
    executors: {
      "artifact-registry": { kind: "stored-artifact", stages: ["direction", "styleframe", "motion", "integration", "master"],
        capability: { available: true, paid: false, preservesOriginalPixels: true, recipeVersion: "artifact-registry/approved-styleframes-1" } },
    },
  },
];
export function executionProfile(jobId: string): ExecutionProfile | null {
  const profile = PROFILES.find(p => p.jobId === jobId);
  return profile ? ProfileSchema.parse(profile) : null;
}

/** Operator-staged artifact record, written only by trusted service scripts (never the API). */
export const StagedArtifactSchema = z.object({ jobId: z.string().min(1), taskId: z.string().min(1), assetId: z.string().min(1),
  assetPath: z.string().min(1), sha256: sha, bytes: z.number().int().positive(), evidence: z.string().trim().min(1).max(2000) }).strict();
export const stagedArtifactPath = (jobId: string, taskId: string) => `${jobId}/execution/staged/${taskId}.json`;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Executor plus an optional side-effect-free preflight run BEFORE the job is claimed. */
export type ProfiledExecutor = DurableExecutor & { preflight?: (task: Job["plan"]["tasks"][number]) => Promise<void> };
export function storedArtifactExecutor(jobId: string, spec: z.infer<typeof StoredArtifact>, results: PaidResultStore): ProfiledExecutor {
  async function load(task: Job["plan"]["tasks"][number]) {
    const raw = await results.getJson(stagedArtifactPath(jobId, task.id));
    if (!raw) throw new Error("VFX_ARTIFACT_NOT_STAGED");
    const record = StagedArtifactSchema.parse(raw);
    if (record.jobId !== jobId || record.taskId !== task.id || record.assetId !== task.outputAssetId || !record.assetPath.startsWith(`${jobId}/`)) throw new Error("VFX_STAGED_ARTIFACT_MISMATCH");
    const bytes = await results.getBytes(record.assetPath);
    if (!bytes || bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw new Error("VFX_STAGED_ARTIFACT_CHANGED");
    return record;
  }
  return { capability: spec.capability as Capability, allowedStages: spec.stages,
    async preflight(task) { await load(task); },
    async run(task) {
      const record = await load(task);
      return { assetId: task.outputAssetId, sha256: record.sha256, checks: [{ name: "stored-artifact-fingerprint", pass: true, evidence: `${record.assetPath} ${record.sha256}; ${record.evidence}` }] };
    },
    async recover(task) { try { const r = await load(task); return { assetId: task.outputAssetId, sha256: r.sha256, checks: [{ name: "stored-artifact-fingerprint", pass: true, evidence: `${r.assetPath} ${r.sha256}` }] }; } catch { return null; } },
  };
}

/** Replace every { storagePath, sha256 } reference with a verified local { path, sha256 }. */
export async function materialize(value: unknown, results: PaidResultStore, root = RUNNER_ROOT): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(v => materialize(v, results, root)));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 2 && typeof (value as { storagePath?: unknown }).storagePath === "string" && sha.safeParse((value as { sha256?: unknown }).sha256).success) {
    const { storagePath, sha256 } = value as { storagePath: string; sha256: string };
    const bytes = await results.getBytes(storagePath);
    if (!bytes || hash(bytes) !== sha256) throw new Error("VFX_MATERIAL_CHANGED");
    const dir = join(root, "materials"); await mkdir(dir, { recursive: true });
    const path = join(dir, sha256);
    try { if (hash(await readFile(path)) !== sha256) throw new Error("VFX_MATERIAL_CACHE_CHANGED"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await writeFile(path, bytes); }
    return { path, sha256 };
  }
  return Object.fromEntries(await Promise.all(entries.map(async ([k, v]) => [k, await materialize(v, results, root)] as const)));
}

/** Builds the runner's executors for a job strictly from its profile. */
export async function profileExecutors(profile: ExecutionProfile, deps: { results: PaidResultStore; currentJob: () => Promise<Job> }): Promise<Record<string, ProfiledExecutor>> {
  const executors: Record<string, ProfiledExecutor> = {};
  for (const [name, spec] of Object.entries(profile.executors)) {
    if (spec.kind === "stored-artifact") { executors[name] = storedArtifactExecutor(profile.jobId, spec, deps.results); continue; }
    const config = { ...(await materialize(spec.config, deps.results) as Record<string, unknown>), root: join(RUNNER_ROOT, "out", profile.jobId, name) };
    if (spec.kind === "world-composite") { executors[name] = worldCompositeExecutor(config as Parameters<typeof worldCompositeExecutor>[0]); continue; }
    const executor = cutMasterExecutor(config as Parameters<typeof cutMasterExecutor>[0]);
    const parsed = config as Parameters<typeof assertReviewedSegments>[0];
    const bind = async () => assertReviewedSegments(parsed, await deps.currentJob());
    executors[name] = { ...executor, async run(...a) { await bind(); return executor.run(...a); }, async recover(...a) { await bind(); return executor.recover!(...a); } };
  }
  return executors;
}
