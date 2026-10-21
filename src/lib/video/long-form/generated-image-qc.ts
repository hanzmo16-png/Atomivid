/**
 * Automatic quality check of a GENERATED image before it may occupy a scene. "Generated" is never "approved":
 * - this check only rejects measurable defects (wrong framing, too small, blank/uniform frame);
 * - it does NOT judge whether the image matches the narration — that needs a human (or a separately approved paid
 *   vision review). Every passing image stays marked «pendiente de revisión humana» in the visual report.
 */
import { imageDimensions } from "@/lib/providers/image/recraft";
import type { GenerativeAsset } from "@/lib/providers/types";

export type QcCheck = { name: "framing" | "resolution" | "content"; ok: boolean; detail: string };
export type GeneratedImageQc = { passed: boolean; checks: QcCheck[] };
type Stats = (buffer: Buffer) => Promise<{ stdev: number[] } | null>;

const RATIO = { "16:9": 16 / 9, "9:16": 9 / 16 } as const;
/** Recraft landscape_16_9 is ~1.78; anything outside ±3 % would be cropped or letterboxed visibly. */
export const FRAMING_TOLERANCE = 0.03;
export const MIN_SHORT_SIDE = 700;
/** Max per-channel standard deviation of a frame considered blank/uniform (0–255 scale). */
export const UNIFORM_STDEV = 4;

async function sharpStats(buffer: Buffer): Promise<{ stdev: number[] } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const s = await sharp(buffer).stats();
    return { stdev: s.channels.slice(0, 3).map((c) => c.stdev) };
  } catch {
    return null;
  }
}

export async function checkGeneratedImage(asset: Pick<GenerativeAsset, "buffer" | "width" | "height">, aspect: "16:9" | "9:16",
  opts: { stats?: Stats } = {}): Promise<GeneratedImageQc> {
  const dim = asset.width && asset.height ? { width: asset.width, height: asset.height } : imageDimensions(asset.buffer);
  const checks: QcCheck[] = [];
  if (!dim) {
    checks.push({ name: "framing", ok: false, detail: "dimensiones ilegibles" });
  } else {
    const ratio = dim.width / dim.height;
    const off = Math.abs(ratio - RATIO[aspect]) / RATIO[aspect];
    checks.push({ name: "framing", ok: off <= FRAMING_TOLERANCE, detail: `${dim.width}x${dim.height} (${aspect} ±${FRAMING_TOLERANCE * 100} %)` });
    checks.push({ name: "resolution", ok: Math.min(dim.width, dim.height) >= MIN_SHORT_SIDE, detail: `lado corto ${Math.min(dim.width, dim.height)} px (mín. ${MIN_SHORT_SIDE})` });
  }
  const stats = await (opts.stats ?? sharpStats)(asset.buffer);
  if (stats) {
    const max = Math.max(...stats.stdev);
    checks.push({ name: "content", ok: max >= UNIFORM_STDEV, detail: max >= UNIFORM_STDEV ? "contenido visible" : "imagen en blanco o uniforme" });
  }
  return { passed: checks.every((c) => c.ok), checks };
}

/**
 * Whether paying for another generation can fix this verdict. Framing and resolution come from the provider's output
 * size, which a new generation of the same request repeats: only a blank/uniform frame (content) is worth regenerating.
 */
export function regenerationCanFix(qc: GeneratedImageQc): boolean {
  const failed = qc.checks.filter((c) => !c.ok);
  return failed.length > 0 && failed.every((c) => c.name === "content");
}
