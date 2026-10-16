/**
 * YouTube / Long Form: lanza scripts/simulator/youtube-600.ts (pipeline real
 * de producción) en un proceso hijo bajo /usr/bin/time -v, mide CPU, memoria
 * máxima (proceso y árbol completo: Node + Chromium + ffmpeg), tiempo y
 * errores, y audita el MP4 resultante.
 *
 * Distinción explícita (anexo técnico §3):
 *  - YT-01/02/03: prueba ESTRUCTURAL de 600 s en baja resolución (480x270, ultrafast).
 *  - YT-04: prueba de RENDIMIENTO a resolución de producción (1920x1080, perfil long_form_h264_v1);
 *    solo se ejecuta con --youtube-1080p. Sin ella: NOT_VERIFIED.
 *  - Producción real con proveedores externos: fuera del simulador, pendiente de aceptación independiente.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Scenario, probe, decodeFully, type ScenarioResult } from "../lib/report";
import { analyzeSubtitles } from "../lib/subtitles";
import { mediaDuration, readCaptures, verifyBurnedCaptions } from "../lib/media-checks";
import { youtubeEconomics } from "../lib/economics";

type RunMetrics = { exitCode: number | null; wallSeconds: number; time: Record<string, string>; peakTreeRssKb: number; procsAtPeak: number; blocked: unknown[]; errorLines: string[] };

function treeRssKb(root: number): { kb: number; procs: number } {
  const parent = new Map<number, number[]>();
  for (const p of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!parent.has(ppid)) parent.set(ppid, []);
      parent.get(ppid)!.push(Number(p));
    } catch { /* proceso terminado */ }
  }
  const all: number[] = [];
  const walk = (pid: number) => { all.push(pid); for (const c of parent.get(pid) ?? []) walk(c); };
  walk(root);
  let kb = 0;
  for (const pid of all) {
    try { const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); if (m) kb += Number(m[1]); } catch { /* terminado */ }
  }
  return { kb, procs: all.length };
}

export async function runYoutubeChild(opts: { outDir: string; profile: "structural_lowres" | "production"; name: string; timeoutSeconds: number }): Promise<RunMetrics & { mp4: string; captureDir: string; logFile: string }> {
  const dir = path.join(opts.outDir, opts.name);
  const captureDir = path.join(dir, "capture");
  fs.mkdirSync(captureDir, { recursive: true });
  const mp4 = path.join(dir, `${opts.name}.mp4`);
  const timeFile = path.join(dir, "time-v.txt");
  const logFile = path.join(dir, "run.log");
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SIM_CAPTURE_DIR: captureDir, SIM_RENDER_PROFILE: opts.profile, SIM_CAPTION_STILLS: "1", SIM_NETWORK_GUARD: "1" };
  const args = ["-v", "-o", timeFile, "timeout", String(opts.timeoutSeconds), process.execPath, "--require", "./scripts/simulator/render-capture.cjs", "--import", "tsx", "scripts/simulator/youtube-600.ts", `--out=${mp4}`];
  fs.writeFileSync(path.join(dir, "command.txt"), `cd ${process.cwd()} && env -i PATH="$PATH" HOME="$HOME" ${Object.entries(env).filter(([k]) => k.startsWith("SIM_")).map(([k, v]) => `${k}=${v}`).join(" ")} /usr/bin/time ${args.join(" ")}\n`);
  const started = Date.now();
  const log = fs.openSync(logFile, "w");
  const child = spawn("/usr/bin/time", args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", log, log] });
  let peak = { kb: 0, procs: 0 };
  const timer = setInterval(() => { const t = treeRssKb(child.pid!); if (t.kb > peak.kb) peak = t; }, 1000);
  const exitCode: number | null = await new Promise((r) => child.on("exit", (c) => r(c)));
  clearInterval(timer);
  fs.closeSync(log);
  const time: Record<string, string> = {};
  if (fs.existsSync(timeFile)) for (const line of fs.readFileSync(timeFile, "utf8").split("\n")) { const m = line.match(/^\s*(.+?):\s(.+)$/); if (m) time[m[1].trim()] = m[2].trim(); }
  const blocked = fs.readdirSync(captureDir).filter((f) => f.startsWith("blocked-")).flatMap((f) => fs.readFileSync(path.join(captureDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const errorLines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => /(Error|failed to load|ERR_|fallo)/i.test(l) && !/differing memory|--memory flag/.test(l)).slice(0, 20);
  return { exitCode, wallSeconds: (Date.now() - started) / 1000, time, peakTreeRssKb: peak.kb, procsAtPeak: peak.procs, blocked, errorLines, mp4, captureDir, logFile };
}

export async function analyzeYoutubeRun(run: Awaited<ReturnType<typeof runYoutubeChild>>, kind: "structural" | "production"): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const { syntheticDocumentaryBeats } = await import("../youtube-600");
  const { synthesizeBeatNarration, stitchNarrationParts } = await import("../../../src/lib/video/long-form/timeline");
  const { fixtureVoiceProvider } = await import("../../../src/lib/providers/voice/fixture");
  const pipelineFile = run.mp4.replace(/\.mp4$/, ".pipeline.json");
  const pipeline = fs.existsSync(pipelineFile) ? JSON.parse(fs.readFileSync(pipelineFile, "utf8")) : null;
  const cap = readCaptures(run.captureDir)[0];
  const metrics = {
    exitCode: run.exitCode,
    wallClock: run.time["Elapsed (wall clock) time (h:mm:ss or m:ss)"],
    userCpuSeconds: Number(run.time["User time (seconds)"]),
    systemCpuSeconds: Number(run.time["System time (seconds)"]),
    cpuPercent: run.time["Percent of CPU this job got"],
    maxRssLargestProcessKb: Number(run.time["Maximum resident set size (kbytes)"]),
    peakProcessTreeRssKb: run.peakTreeRssKb,
    processesAtPeak: run.procsAtPeak,
    renderMsMeasuredInRenderer: cap?.renderMs ?? null,
    blockedExternalCalls: run.blocked.length,
    processErrorLines: run.errorLines,
  };
  const prefix = kind === "structural" ? "YT" : "YT-1080";

  // ---------------------------------------------------------------- render
  const s = new Scenario(kind === "structural" ? "YT-01" : "YT-04", "youtube", kind === "structural"
    ? "YouTube: render ESTRUCTURAL completo de ~600 s (480x270, ultrafast) por el pipeline de producción"
    : "YouTube: render de RENDIMIENTO 600 s a resolución de producción (1920x1080, long_form_h264_v1) en este contenedor");
  s.data.process = metrics;
  s.data.pipeline = pipeline;
  s.data.command = fs.readFileSync(path.join(path.dirname(run.mp4), "command.txt"), "utf8");
  let durationOk = false;
  try {
    s.check("proceso terminó con código 0", run.exitCode === 0, run.exitCode);
    s.check("0 llamadas externas intentadas (guarda de red del hijo)", run.blocked.length === 0, run.blocked);
    s.check("MP4 existe", fs.existsSync(run.mp4));
    if (fs.existsSync(run.mp4)) {
      decodeFully(run.mp4);
      s.check("MP4 se decodifica completo sin errores (ffmpeg -xerror)", true);
      const ev = probe(run.mp4);
      s.artifacts.push(ev);
      const expectW = kind === "structural" ? 480 : 1920;
      const expectH = kind === "structural" ? 270 : 1080;
      s.check(`resolución ${expectW}x${expectH}, H.264, 30 fps`, ev.ffprobe.video?.width === expectW && ev.ffprobe.video?.height === expectH && ev.ffprobe.video?.codec === "h264" && ev.ffprobe.video?.fps === "30/1", ev.ffprobe.video);
      durationOk = Math.abs(ev.ffprobe.durationSeconds - 600) <= 1;
      s.check("duración completa ≈ 600 s (±1 s)", durationOk, ev.ffprobe.durationSeconds);
      s.check("pista de audio AAC presente (narración + música mezcladas por la composición)", ev.ffprobe.audio?.[0]?.codec === "aac", ev.ffprobe.audio);
      if (cap) {
        s.check("la duración del MP4 coincide con la composición (frames/fps, ±2 frames)", Math.abs(ev.ffprobe.durationSeconds - cap.durationInFrames / cap.fps) <= 2 / cap.fps + 0.05, { mp4: ev.ffprobe.durationSeconds, composition: cap.durationInFrames / cap.fps });
        const audioStream = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "json", run.mp4]).toString()).streams?.[0]?.duration;
        s.check("A/V: la pista de audio cubre el video (±0.1 s)", Math.abs(Number(audioStream) - ev.ffprobe.durationSeconds) <= 0.1, { audio: Number(audioStream), video: ev.ffprobe.durationSeconds });
        s.check("narración y música entregadas al render (pistas fuente)", Boolean(cap.narrationFile) && Boolean(cap.musicFile), { narration: cap.narrationFile && mediaDuration(cap.narrationFile), music: cap.musicFile && mediaDuration(cap.musicFile) });
        const plannedShots = pipeline?.plan?.shotCount;
        s.check("escenas renderizadas = plano confirmado (shotCount)", cap.scenes.length === plannedShots, { rendered: cap.scenes.length, planned: plannedShots });
        const contiguous = cap.scenes.every((sc, i) => i === 0 || Math.abs(sc.startSeconds - cap.scenes[i - 1].endSeconds) < 0.05);
        s.check("escenas contiguas desde 0 hasta el final (sin huecos negros)", contiguous && cap.scenes[0].startSeconds < 0.05 && Math.abs(cap.scenes[cap.scenes.length - 1].endSeconds - cap.durationSeconds) < 0.6, { first: cap.scenes[0], last: cap.scenes[cap.scenes.length - 1], duration: cap.durationSeconds });
        // Cortes: detección de cambio de plano en el MP4 frente a los límites de escena esperados.
        const sc = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", run.mp4, "-vf", "select='gt(scene,0.25)',showinfo", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const detected = [...sc.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
        const expected = cap.scenes.slice(1).map((x) => x.startSeconds);
        const matched = expected.filter((t) => detected.some((d) => Math.abs(d - t) <= 0.6)).length;
        s.data.cuts = { expected: expected.length, detectedSceneChanges: detected.length, matchedWithin600ms: matched, ratio: expected.length ? matched / expected.length : null, note: "las transiciones animadas (fundidos) pueden repartir el cambio en varios fotogramas; tolerancia ±0.6 s" };
        s.check("≥ 80 % de los cortes esperados aparecen como cambio de plano en el MP4", expected.length > 0 && matched / expected.length >= 0.8, s.data.cuts);
      }
    }
    s.check("sin errores del proceso en el log (carga de recursos, render)", run.errorLines.length === 0, run.errorLines);
  } catch (e) { s.check("análisis sin excepción", false, e instanceof Error ? e.message : String(e)); }
  if (kind === "structural") s.data.limits = "Prueba ESTRUCTURAL: baja resolución y codificación rápida. NO valida rendimiento ni calidad visual a 1080p.";
  results.push(s.finish({ paid_provider_requests: 0 }));

  if (kind !== "structural" || !cap) return results;

  // ---------------------------------------------------------------- subtítulos
  const sub = new Scenario(`${prefix}-02`, "youtube", "YouTube 600 s: integridad de subtítulos contra las marcas de la narración sintética");
  try {
    const script = await syntheticDocumentaryBeats();
    const parts = [];
    for (const b of script.beats) parts.push(await synthesizeBeatNarration(fixtureVoiceProvider, b, "es"));
    const words = stitchNarrationParts(parts).words;
    const narrationSeconds = cap.narrationFile ? mediaDuration(cap.narrationFile) : 0;
    const report = analyzeSubtitles({ cues: cap.captions, words, audioDurationSeconds: narrationSeconds, videoDurationSeconds: cap.durationInFrames / cap.fps, silences: cap.narrationGaps });
    sub.data.subtitles = report;
    sub.check("orden, límites de audio/video, solapes, desfase inicial/final y deriva acumulada dentro de tolerancia", report.issues.length === 0, report.issues.slice(0, 10));
    sub.check("todas las palabras narradas tienen subtítulo y viceversa", report.metrics.textMatchesNarration, report.metrics);
    sub.data.pauses = "La voz fixture del recorrido de 600 s no produce silencios (narrationGaps = 0): las pausas naturales se verifican en RE-01 con la voz ElevenLabs emulada.";
  } catch (e) { sub.check("análisis sin excepción", false, e instanceof Error ? e.message : String(e)); }
  results.push(sub.finish({}));

  const burned = new Scenario(`${prefix}-03`, "youtube", "YouTube 600 s: los subtítulos aparecen de verdad en el MP4");
  try {
    const v = verifyBurnedCaptions(run.mp4, cap, cap.dir);
    burned.data.burnedCaptions = v;
    burned.check("fotogramas del MP4 ≈ render con subtítulos y ≠ sin subtítulos", v.allBurned, v.rows);
  } catch (e) { burned.check("análisis sin excepción", false, e instanceof Error ? e.message : String(e)); }
  results.push(burned.finish({}));

  // ---------------------------------------------------------------- economía
  const eco = new Scenario(`${prefix}-ECO`, "youtube", "YouTube 600 s: economía unitaria teórica");
  try {
    const script = await syntheticDocumentaryBeats();
    eco.data.unit_economics = await youtubeEconomics({ durationSec: 600, beats: script.beats.map((b) => ({ narration: b.narration, shots: [] })), stockDownloads: pipeline?.stock?.downloads ?? 0, productionRenderMs: null });
    eco.check("actual_provider_spend_usd = 0 y spentUsd del pipeline = 0", pipeline?.spentUsd === 0, pipeline?.spentUsd);
    eco.check("ledger de llamadas pagadas vacío en simulación", Array.isArray(pipeline?.ledgerOps) && pipeline.ledgerOps.length === 0, pipeline?.ledgerOps);
  } catch (e) { eco.check("análisis sin excepción", false, e instanceof Error ? e.message : String(e)); }
  results.push(eco.finish({}));
  return results;
}

export function youtube1080NotVerified(outDir: string): ScenarioResult {
  const s = new Scenario("YT-04", "youtube", "YouTube: render de RENDIMIENTO 600 s a resolución de producción (1920x1080)");
  s.notVerified = "No ejecutado en esta corrida (sin --youtube-1080p). El render estructural 480x270 NO aprueba el rendimiento a 1080p.";
  s.data.reproduce = `npx tsx scripts/simulator/atomivid-simulator.ts --mode=youtube --youtube-1080p --out-dir=${outDir}`;
  return s.finish({});
}
