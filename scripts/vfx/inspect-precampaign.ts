/** Read-only media audit. No planner, paid provider, generation or storage writes. */
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { createServiceClient } from "../../src/lib/supabase/service";
const exec = promisify(execFile);
const root = resolve("vfx-inspection");
async function main() {
  await mkdir(root, { recursive: true });
  const videos = createServiceClient().storage.from("videos");
  const prefix = "precampaign-teaser-v1/v2";
  const { data: files, error: listError } = await videos.list(prefix, { limit: 100 });
  if (listError) throw new Error("VFX_AUDIT_LIST_FAILED");
  const sources = (files ?? []).filter(f => f.name.startsWith("vfx-001-source-") && f.name.endsWith(".mp4"));
  if (sources.length !== 1) throw new Error("VFX_AUDIT_SOURCE_AMBIGUOUS");
  const paths = { source: `${prefix}/${sources[0].name}`, composite: `${prefix}/vfx-002b-composite.mp4`,
    master: "precampaign-teaser-v1/output/ATOMIVID-precampaign-v2-REVIEW-vfx002b.mp4" };
  const records = [];
  for (const [kind, path] of Object.entries(paths)) {
    const { data, error } = await videos.download(path);
    if (error || !data) throw new Error(`VFX_AUDIT_DOWNLOAD_FAILED:${kind}`);
    const bytes = Buffer.from(await data.arrayBuffer()); const file = join(root, `${kind}.mp4`); await writeFile(file, bytes);
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
    const media = JSON.parse(stdout);
    for (const time of kind === "master" ? [2.8, 4, 5.6] : [0.8, 2, 3.4]) {
      await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-y", join(root, `${kind}-${time}.png`)]);
    }
    records.push({ kind, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
      streams: media.streams.map((s: Record<string, unknown>) => ({ codec_type: s.codec_type, codec_name: s.codec_name, width: s.width, height: s.height, avg_frame_rate: s.avg_frame_rate })), duration: media.format.duration });
  }
  await writeFile(join(root, "media-audit.json"), JSON.stringify({ providerCalls: 0, storageWrites: 0, spendUsd: 0, records }, null, 2));
  console.log("Existing source, composite and master inspected without generation or storage writes.");
}
main().catch(() => { console.error("VFX_MEDIA_AUDIT_FAILED"); process.exitCode = 1; });
