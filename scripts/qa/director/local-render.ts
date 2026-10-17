/**
 * Local, USD 0 render of a Reel WITH the Director, through the real product pipeline
 * (generate-video.ts → directReel → Remotion VerticalReel → mastering), exactly as the worker runs it when
 * CINEMATIC_DIRECTOR_RENDER_ENABLED + pilot account + visual Reel hold. Same emulation as the simulator
 * (scripts/simulator): fixture script/footage/music, the REAL ElevenLabs adapter against an in-process fake,
 * in-memory paid-call ledger, fake Supabase storage served over loopback, network guard (no real host is reachable).
 *
 * Output (in --out-dir): director-reel.mp4, director.json (plan + per-shot application, as uploaded next to the MP4),
 * motion-report.json (per planned shot: the camera transform the plan asked for vs. what the frames really show),
 * and a PASS/FAIL summary on stdout. Exit 1 when a shot that declares push_in/pan shows no motion in the frames,
 * when a static/real shot shows synthetic zoom, or when the render did not go through the Director.
 *
 *   npx tsx scripts/qa/director/local-render.ts --out-dir=/tmp/director-local
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { guardStats, installNetworkGuard, scrubProviderEnv } from "../../simulator/lib/guard";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out-dir") ?? path.join(os.tmpdir(), `atomivid-director-local-${Date.now()}`));
fs.mkdirSync(path.join(outDir, "capture"), { recursive: true });

scrubProviderEnv();
Object.assign(process.env, {
  SCRIPT_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture",
  PREMIUM_CLIPS_ENABLED: "false", IMAGE_GENERATION_ENABLED: "false",
  VOICE_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "sim-not-a-real-key",
  // The worker's own switch (render.yml passes vars.CINEMATIC_DIRECTOR_RENDER_ENABLED). The pilot-account decision is
  // taken by run-job.ts (resolveDirectorRender) BEFORE generate-video; here it is given as `directorRender: true`.
  CINEMATIC_DIRECTOR_RENDER_ENABLED: "1",
  SIM_CAPTURE_DIR: path.join(outDir, "capture"), SIM_RENDER_PROFILE: "production", SIM_CAPTION_STILLS: "0",
});
const HEADLESS = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
if (!process.env.REMOTION_BROWSER_EXECUTABLE && fs.existsSync(HEADLESS)) {
  process.env.REMOTION_BROWSER_EXECUTABLE = HEADLESS;
  process.env.REMOTION_CHROME_MODE = process.env.REMOTION_CHROME_MODE || "headless-shell";
}
installNetworkGuard();
createRequire(__filename)("../../simulator/render-capture.cjs");

type Applied = { shotId: string; recipeId: string | null; planned: { movement: string }; applied: { motion: string; transitionIn: string; transitionOut: string; startSeconds: number; endSeconds: number } };

/**
 * Mean absolute luma difference between two frames sampled inside a shot, on the band 20%–50% of the height only:
 * below it the burned captions change from frame to frame and above it sits the label badge, so a still with
 * no camera move measures ≈0 there while a push-in/pan over the same still measures well above 1 (calibrated on
 * the fixture stills: static 0.02–0.03, push_in 1.8–2.0, pan 2.5–2.6).
 */
const MOVE_MIN = 0.5, STATIC_MAX = 0.2;
function frameDiff(mp4: string, t0: number, t1: number, work: string): number {
  const grab = (t: number, name: string) => {
    const f = path.join(work, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", mp4, "-frames:v", "1", "-vf", "crop=iw:ih*0.3:0:ih*0.2,scale=96:-2,format=gray", "-f", "rawvideo", f]);
    return fs.readFileSync(f);
  };
  const a = grab(t0, "a.raw"), b = grab(t1, "b.raw");
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += Math.abs(a[i] - b[i]);
  return sum / Math.min(a.length, b.length);
}

async function main() {
  const { createFakeElevenLabs, installMediaHost } = await import("../../simulator/lib/fake-providers");
  const { createFakeSupabase } = await import("../../simulator/lib/fake-supabase");
  const { generateScriptForRequest } = await import("../../../src/lib/video/generate-script");
  const { generateVideoFromScript } = await import("../../../src/lib/video/generate-video");
  const { memoryLedgerStore } = await import("../../../src/lib/production-intelligence/ledger");
  const { memoryResultStore } = await import("../../../src/lib/paid-calls/result-store");
  const { probe, decodeFully } = await import("../../simulator/lib/report");

  const eleven = createFakeElevenLabs();
  let db: ReturnType<typeof createFakeSupabase> | null = null;
  installMediaHost((key) => db?.objects.get(key));
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "/").slice(1).split("?")[0]);
    const b = db?.objects.get(key);
    if (!b) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": key.endsWith(".mp3") ? "audio/mpeg" : key.endsWith(".svg") ? "image/svg+xml" : key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream" });
    res.end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  db = createFakeSupabase({ signedUrlBase: base });

  const topic = "Prueba local del Director: cómo se forma un arcoíris", style = "documental, sobrio", durationSeconds = 35;
  const { script, providerName } = await generateScriptForRequest({ topic, style, durationSeconds });
  console.log(`[director-local] guion ${providerName}: ${script.segments.length} segmentos`);
  const paid = { ledger: memoryLedgerStore(), results: memoryResultStore() };
  const stages: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { const line = a.map(String).join(" "); if (line.startsWith("[atomivid:director]")) logs.push(line); origLog(...a); };
  let videoPath: string;
  try {
    ({ videoPath } = await generateVideoFromScript({ supabase: db.client as never, requestId: "director-local", script, style, topic, targetDurationSeconds: durationSeconds, paidCalls: paid, directorRender: true, onProgress: async (st) => { stages.push(st); } }));
  } finally { console.log = origLog; }
  server.close();

  const mp4 = path.join(outDir, "director-reel.mp4");
  fs.writeFileSync(mp4, db.objects.get(`videos/${videoPath}`)!);
  decodeFully(mp4);
  const ev = probe(mp4);
  const evidenceKey = [...db.objects.keys()].find((k) => k.endsWith("director.json"));
  if (!evidenceKey) { console.error("FAIL: el render no pasó por el Director (sin director.json)"); process.exit(1); }
  const evidence = JSON.parse(db.objects.get(evidenceKey)!.toString("utf8")) as { ok: boolean; applied?: Applied[]; blockers?: unknown; plan?: { shots?: unknown[] } };
  fs.writeFileSync(path.join(outDir, "director.json"), JSON.stringify(evidence, null, 2));
  if (!evidence.ok || !evidence.applied) { console.error("FAIL: Director bloqueado", JSON.stringify(evidence.blockers)); process.exit(1); }

  // Frames: a push_in/pan shot must change between its start and its end (camera moves over a still); a static shot
  // on a still must not. Samples stay 0.3 s inside the shot, away from crossfade/fade boundaries.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "director-frames-"));
  const fpsRaw = ev.ffprobe.video?.fps ?? "30/1";
  const [num, den] = String(fpsRaw).split("/").map(Number);
  const fps = den ? num / den : num;
  const rows = evidence.applied.map((a) => {
    const len = a.applied.endSeconds - a.applied.startSeconds;
    const margin = Math.min(0.6, len / 4);
    const t0 = a.applied.startSeconds + margin, t1 = a.applied.endSeconds - margin;
    const diff = t1 - t0 > 0.2 ? frameDiff(mp4, t0, t1, work) : null;
    const moves = a.applied.motion === "push_in" || a.applied.motion === "pan";
    const expectMotion = moves || a.applied.motion === "real" || a.applied.motion === "hook";
    const verdict = diff === null ? "SKIP_SHORT" : moves ? (diff >= MOVE_MIN ? "PASS_MOVES" : "FAIL_STATIC_FRAMES") : a.applied.motion === "static" ? (diff <= STATIC_MAX ? "PASS_STATIC" : "FAIL_MOVES_ON_STATIC") : (diff >= MOVE_MIN ? "PASS_REAL" : "WARN_REAL_NO_CHANGE");
    return { shotId: a.shotId, recipeId: a.recipeId, planned: a.planned.movement, applied: a.applied.motion, in: a.applied.transitionIn, out: a.applied.transitionOut, start: a.applied.startSeconds, end: a.applied.endSeconds, sampled: diff === null ? null : [t0, t1], lumaDiff: diff === null ? null : Math.round(diff * 100) / 100, expectMotion, verdict };
  });
  const summary = { PASS: rows.filter((r) => r.verdict.startsWith("PASS")).length, FAIL: rows.filter((r) => r.verdict.startsWith("FAIL")).length, WARN: rows.filter((r) => r.verdict.startsWith("WARN")).length, SKIP: rows.filter((r) => r.verdict.startsWith("SKIP")).length };
  const report = { generatedAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(), mp4: { path: mp4, sha256: ev.sha256, bytes: ev.bytes, durationSeconds: ev.ffprobe.durationSeconds, video: ev.ffprobe.video, fps },
    stages, directorLog: logs, zeroSpend: { blockedExternalAttempts: guardStats.blocked, emulatedRequestsByHost: guardStats.emulated, ledger: [...paid.ledger.ops.values()].map((o) => `${o.method}:${o.status}`) },
    plannedShots: evidence.plan?.shots?.length ?? null, appliedShots: rows.length, motions: Object.fromEntries(["static", "push_in", "pan", "real", "hook"].map((m) => [m, rows.filter((r) => r.applied === m).length])), summary, shots: rows };
  fs.writeFileSync(path.join(outDir, "motion-report.json"), JSON.stringify(report, null, 2));
  console.log(`[director-local] MP4 ${ev.ffprobe.video?.width}x${ev.ffprobe.video?.height} ${ev.ffprobe.durationSeconds}s · planos ${rows.length} · motions ${JSON.stringify(report.motions)} · frames: ${JSON.stringify(summary)} · informe ${path.join(outDir, "motion-report.json")}`);
  for (const r of rows) console.log(`  ${r.verdict.padEnd(22)} ${r.shotId.padEnd(10)} ${r.planned.padEnd(14)} → ${r.applied.padEnd(8)} ${r.in}/${r.out}  ${r.start}s–${r.end}s  Δluma=${r.lumaDiff}`);
  process.exitCode = summary.FAIL > 0 || guardStats.blocked.length > 0 ? 1 : 0;
}

main().catch((e) => { console.error("[director-local] fallo:", e); process.exit(2); });
