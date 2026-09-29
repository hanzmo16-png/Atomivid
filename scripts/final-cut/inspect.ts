/**
 * Retrospective / standalone Final Cut inspection, INSPECT_ONLY. Never modifies an input.
 *   npx tsx scripts/final-cut/inspect.ts --storyboard <file.json> --production <id> [--master <id>] [--media <file.mp4>] [--title-card-sec <s>] [--out <report.json>]
 * The storyboard family is detected from its fields (motion/assetType vs productionMethod/origin).
 * With --media, local ffmpeg measurements (black, freeze, silence, loudness) are merged in.
 * Paid API calls: none, by construction (fetch is disabled for the run).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { edlFromMotionStoryboard, edlFromSlotStoryboard, type MotionStoryboard, type SlotStoryboard } from "@/lib/final-cut/adapters/storyboard";
import { measureMedia, mergeMeasurement } from "@/lib/final-cut/adapters/media";
import { runFinalCut } from "@/lib/final-cut/run";

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const sbPath = arg("storyboard"), productionId = arg("production"), media = arg("media"), out = arg("out");
  if (!sbPath || !productionId) { console.error("usage: --storyboard <json> --production <id> [--master <id>] [--media <mp4>] [--out <json>]"); process.exit(2); }
  const raw = fs.readFileSync(sbPath);
  const sha = createHash("sha256").update(raw).digest("hex");
  const sb = JSON.parse(raw.toString());
  const ids = { masterId: arg("master") ?? `${productionId}-master`, productionId, ref: `${sbPath}@${sha.slice(0, 12)}` };
  let edl = Array.isArray(sb.shots) && sb.shots[0] && "productionMethod" in sb.shots[0]
    ? edlFromSlotStoryboard(sb as SlotStoryboard, ids)
    : edlFromMotionStoryboard(sb as MotionStoryboard, ids, { titleCardSec: arg("title-card-sec") ? Number(arg("title-card-sec")) : undefined }); // a title OVER a shot is an overlay, not a slot: only an explicit flag adds a card
  let mediaShaBefore: string | null = null, mediaShaAfter: string | null = null;
  if (media) {
    mediaShaBefore = createHash("sha256").update(fs.readFileSync(media)).digest("hex");
    edl = mergeMeasurement(edl, await measureMedia(media), `${media}@${mediaShaBefore.slice(0, 12)}`);
    mediaShaAfter = createHash("sha256").update(fs.readFileSync(media)).digest("hex");
  }
  const run = await runFinalCut(edl, { mode: "INSPECT_ONLY", now: new Date().toISOString() });
  const r = run.finalReport;
  const summary = { masterId: r.masterId, source: r.source, verdict: r.verdict, counts: r.counts, opening: r.opening, editorial: r.editorial, technical: r.technical, issuesByRule: Object.fromEntries([...new Set(r.issues.map((i) => i.rule))].sort().map((k) => [k, r.issues.filter((i) => i.rule === k).length])), inputUntouched: run.inputUntouched, mediaUntouched: media ? mediaShaBefore === mediaShaAfter : null, networkCalls: run.networkCalls };
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ summary, report: r, storyboardSha256: sha }, null, 1) + "\n"); }
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
