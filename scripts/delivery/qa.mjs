// Technical QA of a review master against the approved original (no listening, no vision: measurements only).
//   node scripts/delivery/qa.mjs <new.mp4> <original.mp4> <windows.json> <out.json>
// windows.json: [[startSec, endSec], ...] edited windows; everything else must match the original picture.
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';

const [, , NEW, ORIG, WIN, OUT] = process.argv;
const windows = JSON.parse(await fs.readFile(WIN, 'utf8'));
const sh = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args); let o = '', e = ''; p.stdout.on('data', (c) => (o += c)); p.stderr.on('data', (c) => { e += c; if (e.length > 8e6) e = e.slice(-4e6); }); p.on('error', rej); p.on('close', (c) => (c === 0 ? res({o, e}) : rej(Error(`${cmd} ${c}: ${e.slice(-1500)}`)))); });
const probe = async (f) => JSON.parse((await sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_frames,channels,sample_rate,pix_fmt,color_primaries:format=duration,size,bit_rate', '-of', 'json', f])).o);

const pn = await probe(NEW), po = await probe(ORIG);
const v = pn.streams.find((s) => s.codec_type === 'video'), a = pn.streams.find((s) => s.codec_type === 'audio');
const dur = Number(pn.format.duration), durO = Number(po.format.duration);

// Black / frozen / silence / loudness on the new file.
const det = (await sh('ffmpeg', ['-hide_banner', '-i', NEW, '-vf', 'blackdetect=d=0.4:pix_th=0.06,freezedetect=n=-60dB:d=2.5', '-af', 'silencedetect=n=-50dB:d=1.5,ebur128=peak=true', '-f', 'null', '-'])).e;
const black = [...det.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const frozen = [...det.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
const silence = [...det.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
const summ = det.slice(det.lastIndexOf('Summary:'));
const num = (re) => Number(re.exec(summ)?.[1]);
const loud = {integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/)};

// Momentary loudness: largest jump between consecutive 0.5 s steps (abrupt volume changes).
const ml = (await sh('ffmpeg', ['-hide_banner', '-i', NEW, '-vn', '-af', 'ebur128=metadata=1,ametadata=print:key=lavfi.r128.M', '-f', 'null', '-'])).e;
const pts = [...ml.matchAll(/pts_time:([\d.]+)[\s\S]*?lavfi\.r128\.M=(-?[\d.]+|-inf)/g)].map((m) => [Number(m[1]), m[2] === '-inf' ? -120 : Number(m[2])]);
const steps = []; let next = 0; for (const [t, m] of pts) if (t >= next) { steps.push([t, m]); next = t + 0.5; }
let maxJump = {at: null, db: 0};
for (let i = 1; i < steps.length; i++) { const d = steps[i][1] - steps[i - 1][1]; if (steps[i][1] > -40 && steps[i - 1][1] > -40 && Math.abs(d) > Math.abs(maxJump.db)) maxJump = {at: +steps[i][0].toFixed(1), db: +d.toFixed(1)}; }

// Picture outside the edited windows must match the approved master (PSNR per frame; re-encode only).
const ps = (await sh('ffmpeg', ['-hide_banner', '-i', NEW, '-i', ORIG, '-filter_complex', `[0:v]trim=end=${Math.min(dur, durO).toFixed(3)},setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]psnr=stats_file=-`, '-f', 'null', '-'])).o;
const frames = [...ps.matchAll(/n:(\d+) .*?psnr_avg:([\d.inf]+)/g)].map((m) => [Number(m[1]) - 1, m[2] === 'inf' ? 99 : Number(m[2])]);
const inWin = (t) => windows.some(([s, e]) => t >= s - 0.05 && t <= e + 0.05);
let minOut = {t: null, psnr: 99}, sumOut = 0, nOut = 0, nIn = 0;
for (const [n, p] of frames) { const t = n / 30; if (inWin(t)) { nIn++; continue; } nOut++; sumOut += p; if (p < minOut.psnr) minOut = {t: +t.toFixed(3), psnr: p}; }

// Audio identity (DULCE copies the approved audio stream).
const md5 = async (f, extra = []) => (await sh('ffmpeg', ['-hide_banner', '-i', f, ...extra, '-map', '0:a', '-f', 'md5', '-'])).o.trim();
const audioIdentical = (await md5(NEW)) === (await md5(ORIG));

const report = {
  file: NEW, bytes: Number(pn.format.size), durationSeconds: dur, originalDurationSeconds: durO,
  video: {codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, fps: v.r_frame_rate, frames: Number(v.nb_frames), pixFmt: v.pix_fmt},
  audio: {codec: a?.codec_name, channels: a?.channels, sampleRate: a?.sample_rate},
  loudness: loud, maxMomentaryJump: maxJump, black, frozen, silence,
  pictureVsApproved: {framesCompared: frames.length, framesInEditedWindows: nIn, framesOutside: nOut, meanPsnrOutside: nOut ? +(sumOut / nOut).toFixed(2) : null, minPsnrOutside: minOut},
  audioIdenticalToApproved: audioIdentical,
};
report.checks = {
  resolution1080p: v.width === 1920 && v.height === 1080, fps30: v.r_frame_rate === '30/1', h264High: v.codec_name === 'h264' && /High/.test(v.profile || ''),
  audioStereoAac: a?.codec_name === 'aac' && a?.channels === 2, frameCountMatchesDuration: Math.abs(Number(v.nb_frames) / 30 - dur) < 0.1,
  noAccidentalBlack: black.every(([s, e]) => windows.some(([ws, we]) => s >= ws - 1.2 && e <= we + 1.2) || s < 1.0),
  noFrozenPicture: frozen.every((t) => windows.some(([ws, we]) => t >= ws - 1 && t <= we + 1)),
  noSilentGaps: silence.every((t) => t > dur - 3), loudnessNear14: Math.abs(loud.integratedLufs + 14) <= 1, truePeakSafe: loud.truePeakDbfs <= -1,
  noAbruptVolumeJump: Math.abs(maxJump.db) < 12, unchangedPictureMatchesApproved: minOut.psnr >= 33,
};
report.passed = Object.values(report.checks).every(Boolean);
await fs.writeFile(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({passed: report.passed, failed: Object.entries(report.checks).filter(([, ok]) => !ok).map(([k]) => k), bytes: report.bytes, dur, loud, maxJump, psnr: report.pictureVsApproved, audioIdentical}));
