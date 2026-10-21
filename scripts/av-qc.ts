/**
 * CLI de control AV (USD 0, sin red):  npx tsx scripts/av-qc.ts <video.mp4> [manifest.json] [--out <dir>] [--name <base>]
 * Escribe <base>.av-qc.json y <base>.av-qc.md; exit 0 = PASS/PASS_WITH_WARNINGS, 2 = FAIL, 1 = error de ejecución.
 * Las rutas relativas del manifiesto se resuelven desde la carpeta del manifiesto.
 */
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync } from "node:child_process";
import { evaluateAv, parseDetectors, parseSubtitles, reportMarkdown, type AvManifest, type AvMeasurements } from "@/lib/media-qa/av-qc";

const run = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 30 }); return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" }; };
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

export function measure(video: string, manifest: AvManifest, base: string): AvMeasurements {
  const p = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,duration:format=duration", "-of", "json", video]);
  let probe: { streams?: Record<string, string | number>[]; format?: { duration?: string } } = {};
  try { probe = JSON.parse(p.out); } catch { /* probeOk=false */ }
  const v = probe.streams?.find((s) => s.codec_type === "video"), a = probe.streams?.find((s) => s.codec_type === "audio");
  const [fn, fd] = String(v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const dec = run("ffmpeg", ["-v", "error", "-i", video, "-f", "null", "-"]);
  const det = run("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2.5",
    ...(a ? ["-af", "silencedetect=n=-50dB:d=2,volumedetect,ebur128=peak=true"] : []), "-f", "null", "-"]);
  const d = parseDetectors(det.err);
  const formatDuration = Number(probe.format?.duration);
  const close = (xs: [number, number][]) => xs.map(([s, e]) => [s, Number.isFinite(e) ? e : formatDuration] as [number, number]);
  let subtitles: AvMeasurements["subtitles"] = null, subtitleParseError: string | undefined;
  if (manifest.subtitles) { try { subtitles = parseSubtitles(fs.readFileSync(path.resolve(base, manifest.subtitles), "utf8")); } catch (e) { subtitleParseError = (e as Error).message; } }
  const missingFiles: string[] = [], hashMismatches: string[] = [], segmentHashes: Record<string, string> = {};
  for (const f of manifest.files ?? []) { const fp = path.resolve(base, f.path); if (!fs.existsSync(fp)) missingFiles.push(f.path); else if (f.sha256 && sha(fp) !== f.sha256) hashMismatches.push(f.path); }
  for (const s of manifest.timeline ?? []) { if (!s.file) continue; const fp = path.resolve(base, s.file); if (!fs.existsSync(fp)) { if (!missingFiles.includes(s.file)) missingFiles.push(s.file); } else segmentHashes[s.id] = sha(fp); }
  return {
    probeOk: p.code === 0 && !!v, width: Number(v?.width) || undefined, height: Number(v?.height) || undefined, videoCodec: v?.codec_name as string | undefined,
    audioCodec: a?.codec_name as string | undefined, pixFmt: v?.pix_fmt as string | undefined, fps: fd ? fn / fd : undefined,
    formatDuration, videoDuration: Number(v?.duration) || undefined, audioDuration: Number(a?.duration) || undefined, hasAudio: !!a,
    decodeErrors: dec.err.split("\n").map((l) => l.trim()).filter(Boolean).concat(dec.code ? [`ffmpeg exit ${dec.code}`] : []),
    black: d.black, freeze: close(d.freeze), silence: close(d.silence), integratedLufs: d.integratedLufs, lra: d.lra, truePeakDbfs: d.truePeakDbfs,
    samplePeakDb: d.samplePeakDb, meanVolumeDb: d.meanVolumeDb, subtitles, subtitleParseError, missingFiles, hashMismatches, segmentHashes,
  };
}

function main() {
  const args = process.argv.slice(2); const opt = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const out = opt("--out"), name = opt("--name"); const [video, man] = args;
  if (!video || !fs.existsSync(video)) { console.error("Uso: av-qc.ts <video.mp4> [manifest.json] [--out dir] [--name base]"); process.exit(1); }
  const manifest: AvManifest = man ? JSON.parse(fs.readFileSync(man, "utf8")) : {};
  const base = man ? path.dirname(path.resolve(man)) : path.dirname(path.resolve(video));
  const report = evaluateAv(measure(video, manifest, base), manifest);
  const dir = out ?? path.dirname(path.resolve(video)), b = name ?? path.basename(video, path.extname(video));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${b}.av-qc.json`), JSON.stringify({ video: path.basename(video), videoSha256: sha(video), ...report }, null, 2));
  fs.writeFileSync(path.join(dir, `${b}.av-qc.md`), reportMarkdown(report, path.basename(video)));
  console.log(`${report.verdict} blocking=${report.blocking.length} warnings=${report.warnings.length} → ${path.join(dir, b)}.av-qc.{json,md}`);
  process.exit(report.verdict === "FAIL" ? 2 : 0);
}
if (process.argv[1] && /av-qc\.ts$/.test(process.argv[1])) main();
