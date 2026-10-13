/**
 * LOCAL SYNTHETIC harness for the Director → VerticalReel bridge (chatgpt-26). USD 0: no provider, no Supabase, no
 * network beyond 127.0.0.1, no Hans media. Every clip/image is an ffmpeg test pattern labelled SINTÉTICO and the
 * narration is a silent track; it proves wiring (timeline, media types, captions, duration), never quality.
 * Usage: npx tsx scripts/director-bridge-render.ts <outDir>
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { GeneratedScript } from "../src/lib/providers/types";
import { simulateStoryboard } from "../src/lib/video/storyboard/simulate";
import { inputFromReel } from "../src/lib/video/director/from-reel";
import { proposePlan } from "../src/lib/video/director/propose";
import { bundledRecipeCatalog } from "../src/lib/video/director/recipes";
import { planToVerticalReel, type ExistingMedia } from "../src/lib/video/director/render-bridge";

const SCRIPT: GeneratedScript = {
  title: "Sintético",
  segments: [
    { text: "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo?", visualQuery: "tired creator laptop", visualConcepts: ["tired creator at laptop", "person checking clock"], energy: "high" },
    { text: "Escribe tu idea y la aplicación prepara guion, voz e imágenes.", visualQuery: "app screen typing", visualConcepts: ["hands typing on phone app", "app pantalla"] },
    { text: "Mira algunos resultados de nuestras pruebas.", visualQuery: "video results montage", visualConcepts: ["videos resultado montage", "phone showing videos"] },
    { text: "Síguenos para enterarte del lanzamiento.", visualQuery: "person smiling at camera", visualConcepts: ["woman smiling at camera", "creator waving"], energy: "low" },
  ],
};

async function main() {
  const out = path.resolve(process.argv[2] ?? "director-bridge-out");
  const media = path.join(out, "media");
  await fs.mkdir(media, { recursive: true });
  const sb = simulateStoryboard(SCRIPT);
  sb.scenes[3].resourceType = "stock_video";
  const input = inputFromReel(sb);
  const catalog = bundledRecipeCatalog();
  const plan = proposePlan(input, catalog);

  // Synthetic media per asset: real-motion assets get a moving test pattern clip, stills get a still frame.
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const existing: Record<string, ExistingMedia> = {};
  for (const [i, a] of (input.inventory ?? []).entries()) {
    const file = a.motion === "real" ? `${i}.mp4` : `${i}.png`;
    const label = `drawtext=text='SINTETICO ${a.id.replace(/:/g, " ")}':fontcolor=white:fontsize=56:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h*0.2`;
    if (a.motion === "real") ff(["-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=8`, "-vf", label, "-pix_fmt", "yuv420p", path.join(media, file)]);
    else ff(["-f", "lavfi", "-i", "smptebars=size=1080x1920", "-frames:v", "1", "-vf", label, path.join(media, file)]);
    existing[a.id] = { url: `MEDIA/${file}`, mediaType: a.motion === "real" ? "video" : "image", license: "CLEARED" };
  }
  // "Measured" narration: silent track; timings 0.9× the estimate (stand-in for alignScenesToWords on a real voice).
  let t = 0;
  const segmentTimes: Record<string, { start: number; end: number }> = {};
  for (const s of input.segments) { const len = (s.end - s.start) * 0.9; segmentTimes[s.id] = { start: t, end: t + len }; t += len; }
  const durationSeconds = Math.round((t + 0.5) * 1000) / 1000;
  ff(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono`, "-t", String(durationSeconds), path.join(media, "voz.wav")]);
  const captions = input.segments.map(s => ({ text: s.text, startSeconds: segmentTimes[s.id].start, endSeconds: segmentTimes[s.id].end }));

  const server = http.createServer((req, res) => {
    const f = path.join(media, decodeURIComponent((req.url ?? "").replace(/^\/+/, "")));
    if (!f.startsWith(media) || !fsSync.existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".png") ? "image/png" : "audio/wav");
    fsSync.createReadStream(f).pipe(res);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const k of Object.keys(existing)) existing[k].url = existing[k].url.replace("MEDIA", base);

  const bridged = planToVerticalReel({ plan, input, catalog, media: existing, segmentTimes, audioUrl: `${base}/voz.wav`, captions, durationSeconds });
  await fs.writeFile(path.join(out, "bridge-result.json"), JSON.stringify(bridged, null, 2));
  if (!bridged.ok) { console.log(JSON.stringify({ ok: false, blockers: bridged.blockers })); server.close(); return; }

  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
  const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
  const composition = await selectComposition({ serveUrl, id: "VerticalReel", inputProps: bridged.props, browserExecutable, chromeMode: "headless-shell" });
  const mp4 = path.join(out, "SINTETICO-director-bridge.mp4");
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: mp4, inputProps: bridged.props, browserExecutable, chromeMode: "headless-shell", crf: 26 });
  server.close();
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", mp4], { encoding: "utf8" }));
  // Contact sheet: one frame in the middle of each planned scene.
  const mids = bridged.props.scenes.map(s => (s.startSeconds + s.endSeconds) / 2);
  mids.forEach((m, i) => ff(["-ss", m.toFixed(2), "-i", mp4, "-frames:v", "1", "-vf", "scale=270:-2", path.join(out, `frame-${i}.png`)]));
  ff([...mids.flatMap((_, i) => ["-i", path.join(out, `frame-${i}.png`)]), "-filter_complex", `hstack=inputs=${mids.length}`, path.join(out, "contact-sheet.png")]);
  console.log(JSON.stringify({ ok: true, durationSeconds, scenes: bridged.props.scenes.map(s => ({ ...s, mediaUrl: s.mediaUrl.replace(base, "") })), probe }));
}
main().catch(e => { console.error(e); process.exit(1); });
