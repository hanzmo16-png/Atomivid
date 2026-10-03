import { z } from "zod";
import { ShotContractSchema } from "../contract";
import { stableHash } from "../canonical";
import { reserveProject } from "../budget";
import { assertBeforeTask, assertGate, BlockedDirectionSchema, type GateContext } from "./gates";

export const DIRECTOR_VERSION = "vfx-director/1";
const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const BriefSchema = z.object({
  projectId: text, intent: text, emotion: text,
  frames: z.number().int().positive(), fps: z.number().positive().max(120),
  width: z.number().int().positive(), height: z.number().int().positive(),
  sourceSha256: sha, subjectLock: z.enum(["original_pixels", "identity_with_relight"]),
  budgetUsd: z.number().finite().nonnegative(),
}).strict();
const TaskSchema = z.object({
  stage: z.enum(["preview", "direction", "styleframe", "motion", "integration", "master"]),
  id: text, executor: text, dependsOn: z.array(text),
  inputAssetIds: z.array(text).min(1), outputAssetId: text,
  instruction: text, acceptance: z.array(text).min(1),
}).strict();
export const PlanSchema = z.object({
  version: z.literal(DIRECTOR_VERSION), sourceSha256: sha,
  contract: ShotContractSchema,
  world: z.object({ scaleMeters: z.number().positive(), physics: text,
    light: text, optics: text, continuityIn: text, continuityOut: text }).strict(),
  layersFrontToBack: z.array(text).min(2),
  beats: z.array(z.object({ frame: z.number().int().nonnegative(), action: text }).strict()).min(1),
  tasks: z.array(TaskSchema).min(1),
  requiredChecks: z.array(text).min(1),
}).strict();
export type Brief = z.infer<typeof BriefSchema>;
export type Plan = z.infer<typeof PlanSchema>;
/** An executor is available only when the host supplies a real implementation.
 * Price and identity properties belong to the host, never to model output. */
export type Capability = { available: boolean; paid: boolean; preservesOriginalPixels: boolean };
export type Inventory = Record<string, Capability>;

export const DIRECTOR_INSTRUCTIONS = `You are the ATOMIVID VFX Director. Return a structured plan, never a finished clip or an approval.
If infeasible, return status REJECTED with reason and alternative. If essential material is missing, return status NEEDS_MATERIAL with reason and requiredMaterial. Do not force a plan.
Plans use status PLANNED and a plan field. Assign every task its stage. Preview tasks may create proof material; final stages require trusted approvals of previous stages. Never include approval records in model output.
Serve the brief: define story function, silent readability, world rules, lighting, minimum viable technique and continuity.
Preserve what is real. Generate only what must become impossible.
Respect source fps, framing and the declared subject lock. Do not invent source optics or geometry: request measurements or mark assumptions in instructions.
Specify scale, camera, light, ordered layers, frame beats, interactions, continuity and observable acceptance for each task.
Use only the supplied executor inventory. A missing capability blocks the plan; never substitute a still for required motion.
Prefer reusable plates and deterministic composition when sufficient. Approve motion before beauty. Integrate edges, occlusion, contact, shadow, reflection, blur and focus before grading.
Inspect cropped plate resolution against output pixels; a 4K source alone does not prove a sharp crop.
Image/video prompts use English with concrete optics, action, timing, light and continuity. Do not modify an explicitly verbatim user prompt.
Do not authorize spend, set prices, invent approvals or declare perceptual QA passed. Human review is required.
Keep all blocking defects; prioritize at most three corrections per iteration. Repair the failed stage instead of regenerating approved material.`;

/** Pure preflight. No network, generation, billing or mutation. */
export function compilePlan(rawBrief: unknown, rawPlan: unknown, inventory: Inventory, assets: readonly string[]) {
  const brief = BriefSchema.parse(rawBrief);
  const plan = PlanSchema.parse(rawPlan);
  const errors: string[] = [];
  if (brief.sourceSha256 !== plan.sourceSha256) errors.push("source fingerprint mismatch");
  if (Math.abs(plan.contract.desiredDuration - brief.frames / brief.fps) > 1 / brief.fps) errors.push("shot duration differs from brief");
  if (plan.beats.some(b => b.frame >= brief.frames)) errors.push("beat outside shot");
  if (plan.beats.some((b, i) => i > 0 && b.frame <= plan.beats[i - 1].frame)) errors.push("beats must be strictly ordered");
  const ids = new Set<string>(); const outputs = new Set(assets); const completed = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task ${task.id}`);
    ids.add(task.id);
    const cap = inventory[task.executor];
    if (!cap?.available) errors.push(`executor unavailable: ${task.executor}`);
    if (cap?.paid) errors.push(`paid executor requires production paid-call integration: ${task.executor}`);
    if (brief.subjectLock === "original_pixels" && cap && !cap.preservesOriginalPixels) errors.push(`subject lock unsupported: ${task.executor}`);
    if (task.dependsOn.some(id => !completed.has(id))) errors.push(`dependency not ready: ${task.id}`);
    if (task.inputAssetIds.some(id => !outputs.has(id))) errors.push(`input asset missing: ${task.id}`);
    if (outputs.has(task.outputAssetId)) errors.push(`output would replace existing asset: ${task.outputAssetId}`);
    completed.add(task.id); outputs.add(task.outputAssetId);
  }
  if (new Set(plan.requiredChecks).size !== plan.requiredChecks.length) errors.push("duplicate QA checks");
  const reservation = reserveProject(brief.projectId, { expectedCostUsd: 0, worstCaseUsd: 0 }, brief.budgetUsd);
  return { brief, plan, reservation, errors, executable: errors.length === 0,
    planHash: stableHash({ brief, plan, inventory, assets }, 64), reviewRequired: true as const };
}

/** Planning adapter: the caller provides its existing model transport. No model call here. */
export async function direct(brief: unknown, inventory: Inventory, assets: readonly string[], propose: (input: {
  instructions: string; brief: Brief; inventory: Inventory; assets: readonly string[];
}) => Promise<unknown>) {
  const parsed = BriefSchema.parse(brief);
  const response = await propose({ instructions: DIRECTOR_INSTRUCTIONS, brief: parsed, inventory, assets });
  const blocked = BlockedDirectionSchema.safeParse(response);
  if (blocked.success) return { ...blocked.data, executable: false as const };
  const planned = z.object({ status: z.literal("PLANNED"), plan: PlanSchema }).strict().parse(response);
  return { status: "PLANNED" as const, ...compilePlan(parsed, planned.plan, inventory, assets) };
}

export type Check = { name: string; pass: boolean; evidence: string };
export type Executor = { capability: Capability; allowedStages: Plan["tasks"][number]["stage"][]; run: (task: Plan["tasks"][number], brief: Brief) => Promise<{ assetId: string; checks: Check[] }> };
/** Sequential execution with revalidation; only host-registered zero-cost executors run.
 * Durable retries and paid execution deliberately remain with the existing production worker. */
export async function execute(rawBrief: unknown, rawPlan: unknown, executors: Record<string, Executor>, assets: readonly string[], gates?: GateContext) {
  const inventory = Object.fromEntries(Object.entries(executors).map(([name, executor]) => [name, executor.capability]));
  const compiled = compilePlan(rawBrief, rawPlan, inventory, assets);
  if (!compiled.executable) throw new Error(compiled.errors.join("; "));
  const results: { assetId: string; checks: Check[] }[] = [];
  for (const task of compiled.plan.tasks) {
    if (!executors[task.executor].allowedStages.includes(task.stage)) throw new Error(`executor stage unsupported: ${task.id}`);
    if (task.stage !== "preview") {
      if (!gates || gates.planHash !== compiled.planHash) throw new Error("trusted gates for current plan required");
      assertBeforeTask(task.stage, gates);
    }
    const result = await executors[task.executor].run(task, compiled.brief);
    if (result.assetId !== task.outputAssetId) throw new Error(`executor output mismatch: ${task.id}`);
    if (!result.checks.length || result.checks.some(c => !c.pass || !c.evidence.trim())) throw new Error(`executor QA failed: ${task.id}`);
    results.push(result);
  }
  return { planHash: compiled.planHash, results, status: "REVIEW_REQUIRED" as const };
}
export function review(plan: Plan, checks: Check[], humanApproved: boolean) {
  const missing = plan.requiredChecks.filter(name => !checks.some(c => c.name === name && c.pass && c.evidence.trim()));
  const failed = checks.filter(c => !c.pass).map(c => c.name);
  return { approved: humanApproved && missing.length === 0 && failed.length === 0, missing, failed };
}

/** Final delivery gate is separate from rendering the review master. */
export function assertDelivery(context: GateContext) {
  assertBeforeTask("master", context);
  assertGate("master", context);
}
