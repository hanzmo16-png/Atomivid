/**
 * ATOMIVID PRECAMPAIGN V2 — free analysis of the two new real takes of Hans (no paid provider).
 *  - locate 20261002_181854.mp4 / 20261002_181957.mp4 in the private "videos" bucket (read-only);
 *  - probe (displayed orientation, fps, audio), transcribe locally (faster-whisper on the runner)
 *    and identify OPENING vs CLOSING by what is said, never by filename;
 *  - objective audio report (loudness, noise floor, SNR, band balance, spectrogram);
 *  - frame strips for choosing the exact 5.0 s VFX window.
 * The originals are only read. Output: teaser-v2/analysis/.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export {};

const sh = promisify(execFile);
const FF = process.env.FFMPEG_BIN ?? "ffmpeg";
const FP = process.env.FFPROBE_BIN ?? "ffprobe";
const OUT = resolve(process.env.TEASER_V2_OUT ?? "teaser-v2/analysis");
const NAMES = (process.env.TEASER_V2_NAMES ?? "20261002_181854.mp4,20261002_181957.mp4").split(",").map((s) => s.trim());
const OPENING = "Llevo meses trabajando en algo que por fin hoy te puedo empezar a enseñar.";
const CLOSING = "Estamos terminando las últimas pruebas. Si quieres ser de los primeros en probarlo, escribe ATOMIVID en los comentarios.";

const run = (bin: string, args: string[]) => sh(bin, args, { maxBuffer: 256 * 1024 * 1024 });
const ffLog = async (args: string[]) => (await run(FF, ["-hide_banner", "-nostats", ...args]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }))).stderr;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
/** Share of the expected words found in the transcript (order-insensitive, accent-insensitive). */
function overlap(expected: string, heard: string) {
  const h = new Set(norm(heard));
  const e = norm(expected);
  return e.filter((w) => h.has(w)).length / e.length;
}

async function probe(file: string) {
  const { stdout } = await run(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout) as { format?: { duration?: string; size?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; sample_rate?: string; channels?: number; pix_fmt?: string; color_transfer?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    codec: v?.codec_name, pixFmt: v?.pix_fmt, colorTransfer: v?.color_transfer ?? null,
    storedWidth: v?.width, storedHeight: v?.height, rotation: rot,
    width: (swap ? v?.height : v?.width) ?? 0, height: (swap ? v?.width : v?.height) ?? 0,
    fps: d ? n / d : 0, duration: Number(j.format?.duration ?? 0), bytes: Number(j.format?.size ?? 0),
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
}

/** Objective voice report: loudness, noise floor in pauses, speech-to-noise ratio, band balance. */
async function audioReport(wav: string, name: string) {
  const r128 = await ffLog(["-i", wav, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const sum = r128.split("Summary:").at(-1) ?? "";
  const num = (re: RegExp, s: string) => Number(re.exec(s)?.[1]);
  const integrated = num(/I:\s+(-?[\d.]+) LUFS/, sum), lra = num(/LRA:\s+(-?[\d.]+) LU/, sum), truePeak = num(/Peak:\s+(-?[\d.]+) dBFS/, sum);
  const sil = await ffLog(["-i", wav, "-af", "silencedetect=noise=-40dB:d=0.25", "-f", "null", "-"]);
  const starts = [...sil.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...sil.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const rms = async (af: string, extra: string[] = []) => num(/RMS level dB:\s+(-?[\d.inf]+)/, (await ffLog([...extra, "-i", wav, "-af", `${af}${af ? "," : ""}astats=measure_overall=RMS_level:measure_perchannel=none`, "-f", "null", "-"])).split("Overall").at(-1) ?? "");
  const pauses = starts.map((s, i) => [s, ends[i]] as const).filter(([s, e]) => e !== undefined && e - s >= 0.25);
  let noiseFloor = NaN;
  if (pauses.length) {
    const [s, e] = pauses.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    noiseFloor = await rms("", ["-ss", String(s + 0.05), "-to", String(e - 0.05)]);
  }
  const overall = await rms("");
  const bands = { lowUnder150: await rms("lowpass=f=150"), body150to500: await rms("highpass=f=150,lowpass=f=500"), mid500to2k: await rms("highpass=f=500,lowpass=f=2000"), presence2to6k: await rms("highpass=f=2000,lowpass=f=6000"), air6kUp: await rms("highpass=f=6000") };
  await run(FF, ["-y", "-hide_banner", "-v", "error", "-i", wav, "-lavfi", "showspectrumpic=s=1200x400:legend=1:scale=log:fscale=log", join(OUT, `spectrogram-${name}.png`)]).catch(() => undefined);
  await run(FF, ["-y", "-hide_banner", "-v", "error", "-i", wav, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=0x7fd3ff", "-frames:v", "1", join(OUT, `waveform-${name}.png`)]).catch(() => undefined);
  return { integratedLufs: integrated, loudnessRangeLu: lra, truePeakDbfs: truePeak, overallRmsDb: overall, pauseNoiseFloorDb: noiseFloor, speechToNoiseDb: Number.isFinite(noiseFloor) ? Math.round((overall - noiseFloor) * 10) / 10 : null, pauses: pauses.length, bandsRmsDb: bands };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const service = createServiceClient();
  // Locate by name in every bucket: root files and one level inside every root folder (read-only
  // listing; partial match on the timestamp so a renamed upload is still found).
  const located: Record<string, string> = {};
  const locatedBucket: Record<string, string> = {};
  const stems = NAMES.map((n) => n.replace(/^\d{8}_/, "").replace(/\.mp4$/i, ""));
  const matchName = (file: string) => NAMES.find((n, i) => file === n || (file.includes(stems[i]) && /\.(mp4|mov)$/i.test(file)));
  const folders: string[] = [];
  const { data: buckets } = await service.storage.listBuckets();
  for (const b of buckets ?? []) {
    const store = service.storage.from(b.name);
    const { data: root } = await store.list("", { limit: 1000 });
    const dirs = (root ?? []).filter((e) => e.id === null).map((e) => e.name);
    for (const e of root ?? []) { const hit = e.id !== null ? matchName(e.name) : undefined; if (hit && !located[hit]) { located[hit] = e.name; locatedBucket[hit] = b.name; } }
    for (const d of dirs.slice(0, 600)) {
      if (Object.keys(located).length === NAMES.length) break;
      folders.push(`${b.name}:${d}`);
      const { data } = await store.list(d, { limit: 1000 });
      for (const e of data ?? []) { const hit = e.id !== null ? matchName(e.name) : undefined; if (hit && !located[hit]) { located[hit] = `${d}/${e.name}`; locatedBucket[hit] = b.name; } }
    }
  }
  const missing = NAMES.filter((n) => !located[n]);
  if (missing.length) {
    await writeFile(join(OUT, "analysis.json"), JSON.stringify({ status: "SOURCES_NOT_FOUND", missing, found: located, foldersSearched: folders.length }, null, 2));
    throw new Error(`No se encontraron en Storage: ${missing.join(", ")} (${folders.length} carpetas revisadas)`);
  }
  const clips: Record<string, unknown>[] = [];
  for (const name of NAMES) {
    const path = located[name];
    const { data, error } = await service.storage.from(locatedBucket[name]).download(path);
    if (error || !data) throw new Error(`No se pudo leer ${path}`);
    const local = join(OUT, "..", `src-${name}`);
    await writeFile(local, Buffer.from(await data.arrayBuffer()));
    const p = await probe(local);
    const wav = join(OUT, `${name}.wav`);
    await run(FF, ["-y", "-hide_banner", "-v", "error", "-i", local, "-vn", "-ac", "1", "-ar", "16000", wav]);
    const wav48 = join(OUT, `${name}-48k.wav`);
    await run(FF, ["-y", "-hide_banner", "-v", "error", "-i", local, "-vn", "-ar", "48000", wav48]);
    const tJson = join(OUT, `transcript-${name}.json`);
    await run("python3", [resolve("scripts/precampaign-teaser/transcribe.py"), wav, tJson, process.env.TEASER_V2_WHISPER_MODEL ?? "small"]);
    const transcript = JSON.parse(await readFile(tJson, "utf8")) as { text: string; words: { text: string; start: number; end: number }[] };
    const audio = await audioReport(wav48, name);
    // Frame strip every 0.25 s (timestamps burned only into these review images, never into deliverables).
    const tile = Math.ceil((p.duration * 4) / 8);
    await run(FF, ["-y", "-hide_banner", "-v", "error", "-i", local, "-vf", `fps=4,scale=200:-2,drawtext=text='%{pts\\:hms}':fontcolor=white:fontsize=14:x=4:y=4:box=1:boxcolor=black@0.6,tile=8x${tile}`, "-frames:v", "1", join(OUT, `strip-${name}.jpg`)]);
    for (const t of [0.5, p.duration / 2, Math.max(0.5, p.duration - 1)]) await run(FF, ["-y", "-hide_banner", "-v", "error", "-ss", t.toFixed(2), "-i", local, "-frames:v", "1", "-vf", "scale=540:-2", join(OUT, `frame-${name}-${t.toFixed(1)}.jpg`)]);
    clips.push({ name, bucket: locatedBucket[name], path, probe: p, transcript: transcript.text, words: transcript.words, openingMatch: Math.round(overlap(OPENING, transcript.text) * 100) / 100, closingMatch: Math.round(overlap(CLOSING, transcript.text) * 100) / 100, audio });
  }
  const scored = clips as { name: string; path: string; openingMatch: number; closingMatch: number }[];
  const opening = scored.reduce((a, b) => (b.openingMatch - b.closingMatch > a.openingMatch - a.closingMatch ? b : a));
  const closing = scored.find((c) => c !== opening)!;
  const identified = opening.openingMatch >= 0.7 && closing.closingMatch >= 0.7 && opening.openingMatch > opening.closingMatch && closing.closingMatch > closing.openingMatch;
  const report = { status: identified ? "IDENTIFIED_BY_SPEECH" : "IDENTIFICATION_UNCERTAIN", opening: { name: opening.name, path: opening.path }, closing: { name: closing.name, path: closing.path }, clips };
  await writeFile(join(OUT, "analysis.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, opening: report.opening, closing: report.closing, clips: clips.map((c) => ({ name: c.name, probe: c.probe, transcript: c.transcript, openingMatch: c.openingMatch, closingMatch: c.closingMatch, audio: c.audio })) }, null, 2));
}

main().catch((err) => {
  console.error("Análisis V2 detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
