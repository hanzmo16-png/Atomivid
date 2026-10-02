/**
 * VFX-001 — spend plan only (no provider call, no network). Usage, once the new take exists:
 *   VFX_SOURCE_PATH=/path/to/hans-walk.mp4 [VFX_RANGE=start,end] npx tsx scripts/vfx/vfx-001-plan.ts
 * Prints VFX_001_SPEND_PLAN. Generation needs a separate human authorization.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { buildVfxSpendPlan, VFX_001 } from "../../src/lib/video/vfx/vfx-001";

const sh = promisify(execFile);

async function main() {
  const path = process.env.VFX_SOURCE_PATH;
  if (!path) {
    console.log(JSON.stringify({ id: VFX_001.id, status: VFX_001.status, note: "Sin video de origen todavía: nada que planificar." }, null, 2));
    return;
  }
  const { stdout } = await sh(process.env.FFPROBE_BIN ?? "ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; side_data_list?: { rotation?: number }[] }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0));
  const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const swap = rot === 90 || rot === 270;
  const range = process.env.VFX_RANGE?.split(",").map(Number);
  const plan = buildVfxSpendPlan(
    { sha256: createHash("sha256").update(await readFile(path)).digest("hex"), durationSeconds: Number(j.format?.duration ?? 0), width: (swap ? v?.height : v?.width) ?? 0, height: (swap ? v?.width : v?.height) ?? 0, fps: d ? n / d : 0 },
    range && range.length === 2 ? { startSeconds: range[0], endSeconds: range[1] } : undefined,
  );
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((e) => {
  console.error("VFX-001 plan:", e instanceof Error ? e.message : e);
  process.exit(1);
});
