/** Authorized visual-only trial: six fixed images, no TTS, no retries or live rollout.
 * The bounded explanation response contract can change; stored images are reused
 * and prior failed/uncertain review reservations remain in the same twenty-call cap.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { getFootageProvider } from "../src/lib/providers/footage";
import { openaiImageProvider, ESTIMATED_COST_USD } from "../src/lib/providers/image/openai";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { VisualIntentSchema } from "../src/lib/video/visual-intent";
import { assertReviewedVisualConfiguration, createFootageSelectionState, resolveReviewedVisual } from "../src/lib/video/reviewed-visual";
import { reviewVisual, visualReviewLedger } from "../src/lib/video/visual-review";

const KEY = "reel_visual_trial_authorization_20261004_174245";
const REQUEST = "4a3af8e9-17e6-45ef-ade4-cac80be6c1d2";
const OWNER = "d2064950-7a95-4208-8dfb-d93b470d141d";
const OUT = path.join(process.cwd(), "reel-visual-trial-output");
const execute = promisify(execFile);
const common = "High quality cinematic portrait, centered vertical 9:16 safe composition. Show the head, torso and defining features fully. Detailed natural materials, believable anatomy and light. No text, lettering, watermarks or logos. ";
const definitions = [
  ["Gris", "grey alien", ["humanoid alien with grey skin", "large bald head", "very large black almond-shaped eyes"], ["lamp", "light bulb", "stars without an alien"], "A fictional grey alien with grey skin, a large bald head and enormous black almond-shaped eyes, slender upright humanoid body, on an atmospheric science-fiction set."],
  ["Reptiliano", "reptilian humanoid alien", ["upright humanoid alien with arms and torso", "green reptilian scales", "amber eyes with vertical slit pupils"], ["ordinary iguana", "ordinary lizard", "four-legged reptile"], "A fictional upright reptilian humanoid alien, green scaled skin, strong humanlike torso and arms, ridged brow, amber eyes with vertical slit pupils, subtle science-fiction armor. Clearly a humanoid alien, never an ordinary animal."],
  ["Arcturiano", "blue Arcturian humanoid alien", ["blue-skinned humanoid alien", "elongated bald head", "luminous blue eyes"], ["grey-skinned alien", "astronaut helmet", "space scenery without a figure"], "An artistic fictional Arcturian character: slender upright blue-skinned humanoid, elongated bald head, luminous blue eyes, calm thoughtful expression, elegant silver robes, futuristic environment."],
  ["Pleyadiano", "Pleiadian humanlike alien character", ["humanlike adult figure", "long golden-blond hair", "blue eyes", "futuristic silver clothing"], ["stars without a figure", "short dark hair", "grey alien"], "An artistic fictional Pleiadian character: humanlike adult with long golden-blond hair, blue eyes, natural facial proportions, peaceful expression, futuristic silver clothing, softly illuminated science-fiction environment."],
  ["Urmah", "Urmah feline humanoid alien", ["upright humanoid torso and arms", "lionlike feline head and muzzle", "golden mane"], ["ordinary four-legged lion", "ordinary cat", "human head"], "An artistic fictional Urmah character: proud upright muscular humanoid with a lionlike feline head and muzzle, golden mane, expressive amber eyes, two humanlike arms and torso, ceremonial science-fiction garments. Clearly a feline humanoid alien, never an ordinary lion."],
  ["Tacos al pastor", "Mexican tacos al pastor", ["soft corn tortillas", "red marinated pork", "chopped onion and cilantro", "pineapple pieces"], ["hamburger", "pizza", "hard taco shells"], "An appetizing realistic food illustration: three Mexican tacos al pastor in soft corn tortillas, clearly visible red marinated pork, finely chopped white onion and green cilantro, small pineapple pieces, warm restaurant light, close view of a ceramic plate."],
] as const;
const scenes = definitions.map(([label, subject, mustShow, mustNotShow, description]) => ({
  label, text: label === "Tacos al pastor" ? "Tacos al pastor con tortillas de maíz, carne adobada, cebolla, cilantro y piña." : `Representación artística de ficción: ${label}.`,
  visualQuery: subject, visualConcepts: [subject],
  visualIntent: VisualIntentSchema.parse({ source: "illustration", subject, mustShow: [...mustShow], mustNotShow: [...mustNotShow], imagePrompt: common + description }),
}));
const PLAN_HASH = stableHash(scenes, 64);
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ planHash: PLAN_HASH, images: scenes.length, maxReviews: 20, maxAccountedUsd: 0.4, labels: scenes.map(s => s.label), paidCalls: 0 }));
} else {
  main().catch(async error => {
    const message = error instanceof Error ? error.message : "unknown";
    try { await createServiceClient().from("video_requests").update({ status: "failed", progress_stage: "failed", error_message: `Prueba visual detenida: ${message.slice(0, 300)}` }).eq("id", REQUEST).eq("user_id", OWNER).eq("status", "processing"); } catch { /* Never replay a paid operation to repair a diagnostic. */ }
    console.error("VISUAL_TRIAL_STOPPED", message); process.exitCode = 1;
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const service = createServiceClient(), base = supabaseLedgerStore(service);
  const receipt = await base.get(KEY);
  if (receipt?.status !== "COMMITTED" || receipt.provider !== "internal" || receipt.method !== "human_direction" || receipt.projectId !== REQUEST || !receipt.resultRef) throw Error("VISUAL_TRIAL_NOT_AUTHORIZED");
  const grant = JSON.parse(receipt.resultRef);
  if (grant.version !== "reel-visual-trial/1" || grant.ownerId !== OWNER || grant.requestId !== REQUEST || grant.planHash !== PLAN_HASH
    || grant.maxImages !== 6 || grant.maxReviews !== 20 || grant.maxAccountedUsd !== 0.4 || grant.voiceCalls !== 0
    || new Date(grant.expiresAt).getTime() <= Date.now()) throw Error("VISUAL_TRIAL_SCOPE_CHANGED");
  const request = await service.from("video_requests").select("user_id,status,mode,idempotency_key,video_path").eq("id", REQUEST).single();
  if (request.error || request.data.user_id !== OWNER || request.data.mode !== "visual" || request.data.idempotency_key !== "reel_visual_trial_20261004_174245") throw Error("VISUAL_TRIAL_REQUEST_CHANGED");
  if (request.data.status === "completed" && request.data.video_path) { console.log("VISUAL_TRIAL_ALREADY_COMPLETED_NO_PAID_REPLAY"); return; }
  if (request.data.status !== "processing") throw Error("VISUAL_TRIAL_REQUEST_NOT_PROCESSING");
  assertReviewedVisualConfiguration(scenes, false);
  if (ESTIMATED_COST_USD !== 0.05 || process.env.OPENAI_IMAGE_MODEL !== "gpt-image-2" || process.env.OPENAI_IMAGE_SIZE !== "1024x1536" || process.env.OPENAI_IMAGE_QUALITY !== "medium") throw Error("VISUAL_TRIAL_IMAGE_CONFIGURATION_CHANGED");
  const provider = getFootageProvider();
  if (provider.name === "fixture") throw Error("VISUAL_TRIAL_REQUIRES_REAL_FOOTAGE");
  async function spend() {
    const { data, error } = await service.from("pi_paid_operations").select("status,reserved_usd,committed_usd,method").eq("project_id", REQUEST).in("method", ["generate_image", "visual_relevance_review"]);
    if (error) throw Error("VISUAL_TRIAL_LEDGER_UNAVAILABLE");
    return { rows: data, usd: data.reduce((sum, row) => sum + Math.max(Number(row.committed_usd ?? 0), row.status === "COMMITTED" ? 0 : Number(row.reserved_usd)), 0) };
  }
  const boundedImages = { ...base, async insert(op: Parameters<typeof base.insert>[0]) {
    const used = await spend();
    if (op.projectId !== REQUEST || op.method !== "generate_image" || op.provider !== "openai" || !/^image:scene-[0-5]$/.test(op.shotId ?? "")
      || op.reservedUsd > 0.05 || used.rows.filter(row => row.method === "generate_image").length >= 6 || used.usd + op.reservedUsd + 0.005 > 0.4) throw Error("VISUAL_TRIAL_IMAGE_BUDGET_BLOCKED");
    return base.insert(op);
  } };
  const reviewedLedger = visualReviewLedger(service);
  const boundedReview = { ...reviewedLedger, async insert(op: Parameters<typeof base.insert>[0]) {
    if ((await spend()).usd + op.reservedUsd > 0.4) throw Error("VISUAL_TRIAL_REVIEW_BUDGET_BLOCKED");
    return reviewedLedger.insert(op);
  } };
  const report: { requestId: string; planHash: string; negativeChecks: object[]; scenes: object[]; paidTotals?: object; qualityPassed?: boolean; outputPaths?: object } = { requestId: REQUEST, planHash: PLAN_HASH, negativeChecks: [], scenes: [] };
  let qualityPassed = true;
  try {
    for (const [query, index] of [["iguana", 1], ["light bulb", 0]] as const) {
      const candidates = await provider.searchImageCandidates?.(query);
      if (!candidates?.length) throw Error("VISUAL_TRIAL_NEGATIVE_SOURCE_MISSING");
      const image = await provider.downloadFootage(candidates[0].url);
      await fs.writeFile(path.join(OUT, `negative-${query.replaceAll(" ", "-")}.jpg`), await sharp(image).jpeg().toBuffer());
      const result = await reviewVisual({ service, requestId: REQUEST, sceneIndex: 10 + index, intent: scenes[index].visualIntent,
        narration: scenes[index].text, buffer: image, mediaType: "image", durationSeconds: 5, ledger: boundedReview });
      report.negativeChecks.push({ query, expectedSubject: scenes[index].label, correctlyRejected: !result.accepted, verdict: result.verdict, photoPage: candidates[0].pageUrl });
      qualityPassed &&= !result.accepted;
      console.log("VISUAL_TRIAL_NEGATIVE", JSON.stringify({ query, correctlyRejected: !result.accepted }));
    }
    const state = createFootageSelectionState();
    const previews: string[] = [];
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index], used = await spend();
      if (used.usd + 0.055 > 0.4) throw Error("VISUAL_TRIAL_TOTAL_BUDGET_BLOCKED");
      const visual = await resolveReviewedVisual({ service, requestId: REQUEST, sceneIndex: index, segment: scene, intent: scene.visualIntent,
        durationSeconds: 5, footageProvider: provider, imageProvider: openaiImageProvider, ledger: boundedImages, state,
        remainingImageBudgetUsd: Math.max(0, 0.4 - used.usd - 0.005), mayGenerate: true });
      const bytes = await provider.downloadFootage(visual.url);
      await fs.writeFile(path.join(OUT, `image-${index + 1}.png`), bytes);
      const frame = await sharp(bytes).resize(1080, 1920, { fit: "cover", position: "centre" }).composite([{ input: labelSvg(scene.label), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
      const framePath = path.join(OUT, `scene-${index + 1}.jpg`); await fs.writeFile(framePath, frame); previews.push(framePath);
      report.scenes.push({ index, label: scene.label, intent: scene.visualIntent, accepted: true, imageCostUsd: visual.imageCostUsd, reviewCostUsd: visual.reviewCostUsd });
      console.log("VISUAL_TRIAL_ACCEPTED", JSON.stringify({ index, label: scene.label }));
    }
    await renderPreview(previews);
    const tiles = await Promise.all(previews.map(file => sharp(file).resize(300, 533).toBuffer()));
    const sheet = await sharp({ create: { width: 900, height: 1066, channels: 3, background: "#09090f" } }).composite(tiles.map((input, i) => ({ input, left: i % 3 * 300, top: Math.floor(i / 3) * 533 }))).jpeg({ quality: 92 }).toBuffer();
    await fs.writeFile(path.join(OUT, "contact-sheet.jpg"), sheet);
    report.qualityPassed = qualityPassed;
    report.paidTotals = await spend();
    const paths: Record<string, string> = {};
    for (const [file, contentType] of [["preview.mp4", "video/mp4"], ["contact-sheet.jpg", "image/jpeg"]]) {
      const storagePath = `${REQUEST}/visual-trial/${file}`;
      const uploaded = await service.storage.from("videos").upload(storagePath, await fs.readFile(path.join(OUT, file)), { contentType, upsert: true });
      if (uploaded.error) throw Error("VISUAL_TRIAL_OUTPUT_STORAGE_FAILED"); paths[file] = storagePath;
    }
    report.outputPaths = paths;
    const saved = await service.from("video_requests").update({ status: qualityPassed ? "completed" : "failed", video_path: qualityPassed ? paths["preview.mp4"] : null,
      progress_stage: qualityPassed ? "completed" : "failed", error_message: qualityPassed ? null : "Una sustitución incorrecta pasó la revisión visual. La mejora permanece desactivada." }).eq("id", REQUEST).eq("status", "processing").select("id");
    if (saved.error || saved.data?.length !== 1) throw Error("VISUAL_TRIAL_STATUS_CONFLICT");
    console.log("VISUAL_TRIAL_FINISHED", JSON.stringify({ qualityPassed, paidTotalsUsd: (report.paidTotals as { usd: number }).usd }));
  } finally {
    report.paidTotals = await spend();
    await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    await service.storage.from("videos").upload(`${REQUEST}/visual-trial/report.json`, Buffer.from(JSON.stringify(report)), { contentType: "application/json", upsert: true });
  }
}
function labelSvg(label: string) {
  return Buffer.from(`<svg width="1080" height="230" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="230" fill="#09090f" fill-opacity=".88"/><text x="540" y="92" fill="white" text-anchor="middle" font-family="DejaVu Sans" font-size="64" font-weight="bold">${label}</text><text x="540" y="165" fill="#bcb4ff" text-anchor="middle" font-family="DejaVu Sans" font-size="34">Ilustración artística · prueba visual</text></svg>`);
}
async function renderPreview(previews: string[]) {
  const clips: string[] = [];
  for (const [index, image] of previews.entries()) {
    const clip = path.join(OUT, `clip-${index}.mp4`);
    await execute(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-loop", "1", "-i", image, "-t", "5", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-y", clip], { timeout: 90_000 }); clips.push(clip);
  }
  const list = path.join(OUT, "clips.txt"); await fs.writeFile(list, clips.map(file => `file '${file}'`).join("\n"));
  await execute(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", "-y", path.join(OUT, "preview.mp4")], { timeout: 60_000 });
}
