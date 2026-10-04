import { notFound } from "next/navigation";
import { VfxDirectorView } from "@/app/dashboard/vfx/VfxDirectorView";
import { executionView } from "@/lib/production-intelligence/vfx-director/execution";
import type { Job } from "@/lib/production-intelligence/vfx-director/jobs";

/** Visual QA only under `next dev` (same rule as /dev/states): never in a Vercel build, no Supabase.
 * Fixture with three worlds, long evidence and dispatch history to check mobile layout. */
const sha = (c: string) => c.repeat(64);
const worlds = [["nyc", "city", "night_practical", 0, 50], ["beach", "beach", "daylight_soft", 50, 100], ["moon", "moon", "sun_hard", 100, 150]] as const;
const stages = ["direction", "styleframe", "motion", "integration"] as const;
const evidence = JSON.stringify({ environmentId: "nyc", frames: 50, grainPasses: 0, transition: "cut", subjectInteriorPixels: 1234567, subjectMaxDifference: 0, plateMotionMeanAbsFrameDiff: 2.31, note: "texto-largo-sin-espacios-".repeat(6) });
function fixture(): Job {
  const tasks = [...stages.flatMap((stage, i) => worlds.map(([id]) => ({ stage, environmentId: id, id: `${id}-${stage}`, executor: "artifact-registry",
    dependsOn: i ? [`${id}-${stages[i - 1]}`] : [], inputAssetIds: ["measured-source"], outputAssetId: `${id}-${stage}-out`, instruction: "Registrar artefacto medido", acceptance: ["Huella"] }))),
    { stage: "master" as const, id: "master", executor: "artifact-registry", dependsOn: worlds.map(([id]) => `${id}-integration`), inputAssetIds: worlds.map(([id]) => `${id}-integration-out`), outputAssetId: "master-out", instruction: "Registrar master", acceptance: ["Revisiones"] }];
  const results = Object.fromEntries(tasks.filter(t => t.id !== "master").map(t => [t.id, { assetId: t.outputAssetId, sha256: sha("b"), checks: [{ name: "stored-artifact-fingerprint", pass: true, evidence }] }]));
  return {
    id: "precampaign-three-worlds-v1-preparation", ownerId: "fixture-owner", revision: 53,
    brief: { projectId: "precampaign-three-worlds-v1-preparation", intent: "Approved three-world background preparation; original Hans pixels preserved", emotion: "wonder", frames: 150, fps: 30, width: 1080, height: 1920, sourceSha256: sha("a"), subjectLock: "identity_with_relight", budgetUsd: 4.77, environments: worlds.map(([id, kind, lighting]) => ({ id, kind, lighting })) },
    plan: { version: "vfx-director/1", sourceSha256: sha("a"),
      contract: { shotId: "opening", shotClass: "talking_head", narrationIntent: "x", visualIntent: "Three worlds with hard cuts", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 5, maxGeneratedDuration: 6, qualityTier: "hero" } as Job["plan"]["contract"],
      environments: worlds.map(([id, kind, lighting, start, end]) => ({ id, kind, lighting, startFrame: start, endFrame: end, materialAssetId: "measured-source", materialSha256: sha("a"), light: `${lighting} — luz propia, sin mezcla con el entorno vecino`, continuityIn: "Posición y movimiento del original", continuityOut: "Corte seco" })),
      world: { scaleMeters: 1.8, physics: "Original", light: "Por mundo", optics: "Original", continuityIn: "Persona grabada", continuityOut: "Persona grabada" },
      layersFrontToBack: ["original-subject", "world-plate"], beats: [{ frame: 0, action: "nyc" }], requiredChecks: ["source-fingerprint"], tasks },
    inventory: { "artifact-registry": { available: true, paid: false, preservesOriginalPixels: true, recipeVersion: "artifact-registry/approved-styleframes-1" } },
    assets: ["measured-source"], planHash: "f".repeat(64), approvals: [], artifacts: { master: sha("c") },
    environmentArtifacts: Object.fromEntries(worlds.map(([id]) => [id, Object.fromEntries(stages.map(s => [s, sha("b")]))])), results,
    status: "READY", activeTask: null, error: null,
  };
}
export default function DevVfxDirectorPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const job = fixture();
  const now = Date.parse("2026-10-04T12:00:00Z");
  const op = (n: number, status: "COMMITTED" | "RECONCILIATION_REQUIRED", outcome?: object) => ({ idempotencyKey: `vfx_exec:${job.id}:r53:n${n}`, projectId: job.id, shotId: "master", provider: "internal", model: "vfx-execution/abc", method: "vfx_execution_dispatch", attemptKind: "step", reservedUsd: 0, committedUsd: 0, status, providerJobId: "18123456789",
    resultRef: JSON.stringify({ version: 1, jobId: job.id, mode: "step", taskId: "master", requestedAt: "2026-10-04T11:00:00.000Z", ...(outcome ? { outcome } : {}) }), updatedAt: "2026-10-04T11:05:00.000Z" });
  const view = executionView(job, [op(1, "COMMITTED", { kind: "blocked_before_task", code: "VFX_ARTIFACT_NOT_STAGED", jobStatus: "READY", jobRevision: 53, taskId: "master", finishedAt: "2026-10-04T11:05:00.000Z", runId: "18123456789" }), op(2, "RECONCILIATION_REQUIRED")],
    { enabled: true, token: "x", repo: "o/r", ref: "branch", commit: "c".repeat(40) }, now);
  return <div className="mx-auto max-w-5xl px-4 py-6"><VfxDirectorView projects={[job.id, "another-very-long-project-identifier-without-spaces-for-overflow-testing-v2"]} job={job} media={{}} execution={view} /></div>;
}
