/**
 * Local render of a SHOT-LIST piece through the Director (no provider calls, no network beyond 127.0.0.1).
 *   node --import tsx scripts/director-shot-list-render.ts <job.json> <outdir>
 * job.json: { title, identity, shots: PlannedShot[], clips: { <shotId>: <absolute path to the clip> },
 *             style?: "fiction", clipAudio?: "off"|"recipe", labelText?: {...} }
 * The Director plans (storyboard from the shot list → proposePlan → audit → bridge); the composition renders exactly
 * the bridge's props. Writes final.mp4 and director.json (input, plan, applied, props, options) to <outdir>.
 */
import http from "node:http";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { directReel, type ResolvedBeat } from "@/lib/video/director/reel-render";
import { scriptFromShotList, shotListAdapter, shotListTimings, storyboardFromShotList, type PlannedShot, type ShotListIdentity } from "@/lib/video/director/shot-list";

type Job = { title: string; identity: ShotListIdentity; shots: PlannedShot[]; clips: Record<string, string>; style?: "fiction"; clipAudio?: "off" | "recipe"; labelText?: Record<string, string> };

async function main() {
  const [jobPath, out] = process.argv.slice(2);
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
  mkdirSync(out, { recursive: true });
  const files = new Map(Object.entries(job.clips).map(([id, p]) => [`/${id}.mp4`, p]));
  const server = http.createServer((req, res) => {
    const file = files.get((req.url ?? "").split("?")[0]);
    if (!file) { res.writeHead(404).end(); return; }
    const size = statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
      createReadStream(file).pipe(res);
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const timings = shotListTimings(job.shots);
    const missing = job.shots.filter(s => !job.clips[s.id]).map(s => s.id);
    const beatsBySegment: ResolvedBeat[][] = job.shots.map((s, i) => job.clips[s.id]
      ? [{ url: `${base}/${s.id}.mp4`, mediaType: "video", source: "generated", start: timings[i].start, end: timings[i].end }] : []);
    const durationSeconds = timings[timings.length - 1].end;
    const directed = directReel({ script: scriptFromShotList(job.title, job.shots), storyboard: storyboardFromShotList(job.shots, job.identity), beatsBySegment,
      sceneTimings: timings, audioUrl: "", captions: [], narrationGaps: [], durationSeconds,
      adapter: { ...shotListAdapter(job.shots), ...(job.style ? { style: job.style } : {}) }, clipAudio: job.clipAudio, labelText: job.labelText });
    const record = { ok: directed.ok, options: { style: job.style ?? null, clipAudio: job.clipAudio ?? "off", labelText: job.labelText ?? null }, missingClips: missing,
      storyboardSource: directed.storyboardSource, input: directed.input, plan: directed.plan,
      ...(directed.ok ? { applied: directed.applied, props: { ...directed.props, scenes: directed.props.scenes.map(s => ({ ...s, mediaUrl: s.mediaUrl.replace(base, "local:")})) } } : { blockers: directed.blockers }) };
    writeFileSync(path.join(out, "director.json"), JSON.stringify(record, null, 2));
    if (!directed.ok) { console.log(JSON.stringify({ ok: false, blockers: directed.blockers })); process.exitCode = 2; return; }
    const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
    const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
    const composition = await selectComposition({ serveUrl, id: "VerticalReel", inputProps: directed.props, browserExecutable, chromeMode: "headless-shell" });
    const t0 = Date.now();
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: path.join(out, "final.mp4"), inputProps: directed.props, browserExecutable, chromeMode: "headless-shell", crf: 18 });
    console.log(JSON.stringify({ ok: true, seconds: durationSeconds, renderMs: Date.now() - t0,
      shots: directed.applied.map(a => [a.shotId, a.recipeId, a.applied.motion, a.applied.transitionIn, a.applied.transitionOut, a.applied.audio ?? "muted"]) }));
  } finally { server.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
