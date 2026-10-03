import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import type { DurableExecutor } from "./jobs";
const exec = promisify(execFile);
const fingerprint = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
async function media(path: string) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path]);
  const result = JSON.parse(stdout); return { ...result.streams[0], duration: Number(result.format.duration) };
}
/** Registered only in the render runner. Explicit measured inputs, no model-supplied commands.
 * Current recipe is source+one plate; multi-world sequencing needs separately reviewed plates. */
export function vfx002bExecutor(config: { source: string; plate: string; model: string; root: string; script: string; plateStart?: number }): DurableExecutor {
  return { capability: { available: true, paid: false, preservesOriginalPixels: false }, allowedStages: ["preview", "integration"],
    async run(task, brief, operationKey) {
      if (brief.width !== 1080 || brief.height !== 1920 || brief.fps !== 30 || brief.subjectLock !== "identity_with_relight") throw new Error("VFX002B_FORMAT_OR_LOCK_UNSUPPORTED");
      if (await fingerprint(config.source) !== brief.sourceSha256) throw new Error("VFX_SOURCE_CHANGED");
      const [source, plate] = await Promise.all([media(config.source), media(config.plate)]);
      const duration = brief.frames / brief.fps;
      if (Math.abs(source.duration - duration) > 1 / brief.fps) throw new Error("VFX_SOURCE_DURATION_MISMATCH");
      // The legacy compositor stretches full frame; reject mismatched aspect ratio instead.
      if (plate.width < brief.width || plate.height < brief.height || Math.abs(plate.width / plate.height - brief.width / brief.height) > 0.01) throw new Error("VFX_PLATE_RESOLUTION_OR_ASPECT");
      if (plate.duration - (config.plateStart ?? 0) < duration) throw new Error("VFX_PLATE_TOO_SHORT");
      const key = createHash("sha256").update(operationKey).digest("hex");
      const output = resolve(config.root, key); await mkdir(output, { recursive: true });
      await exec("python", [config.script, config.model, config.source, config.plate, output, String(config.plateStart ?? 0)], { timeout: 15 * 60_000, maxBuffer: 1024 * 1024 });
      const report = JSON.parse(await readFile(join(output, "vfx-002-report.json"), "utf8"));
      // Locate only the compositor's known filename; never accept a model-supplied output path.
      const video = join(output, "vfx-002-composite.mp4");
      return { assetId: task.outputAssetId, sha256: await fingerprint(video), checks: [
        { name: "plate-resolution", pass: true, evidence: `${plate.width}x${plate.height}; matching aspect; no upscale` },
        { name: "background-motion", pass: report.plateMotionMeanAbsFrameDiff > 0.1, evidence: JSON.stringify(report.plateMotionMeanAbsFrameDiff) },
        { name: "graded-subject-lock", pass: report.subjectLock?.interiorPixels > 0 && report.subjectLock.maxAbsDiffInteriorVsGradedSource <= 5, evidence: JSON.stringify(report.subjectLock) },
      ] };
    } };
}
