// Review delivery edits (free; FFmpeg + sharp only, no provider, no TTS).
// Rebuilds only the authorized windows of each approved master from the same approved sources
// (clean picture + the master's own subtitles), lays the new notices / closing / credit on top,
// and re-encodes once. Everything outside those windows is the approved master's picture;
// DULCE's audio is copied bit-for-bit, Thermopylae's is the master's audio plus a music tail.
//
//   node scripts/delivery/edit.mjs <dulce|thermopylae> <master.mp4> <srcDir> <outDir>
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import sharp from 'sharp';

const [, , WHICH, MASTER, SRC, OUT] = process.argv;
if (!['dulce', 'thermopylae'].includes(WHICH) || !MASTER || !SRC || !OUT) throw Error('usage: edit.mjs <dulce|thermopylae> <master> <srcDir> <outDir>');
const FPS = 30, W = 1920, H = 1080;
const WORK = path.join(OUT, `work-${WHICH}`);
await fs.mkdir(WORK, {recursive: true});
const log = (...a) => console.log(`[${WHICH}]`, ...a);

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args); let e = '';
    p.stderr.on('data', (c) => { e += c; if (e.length > 4e6) e = e.slice(-2e6); });
    p.on('error', rej); p.on('close', (c) => (c === 0 ? res(e) : rej(Error(`${cmd} exited ${c}: ${e.slice(-2500)}`))));
  });
}
function probe(args) {
  return new Promise((res, rej) => { const p = spawn('ffprobe', ['-v', 'error', ...args]); let o = ''; p.stdout.on('data', (c) => (o += c)); p.on('error', rej); p.on('close', (c) => (c === 0 ? res(o.trim()) : rej(Error('ffprobe ' + args.join(' '))))); });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const png = async (svg, file) => { await sharp(Buffer.from(svg), {density: 72}).png().toFile(file); return file; };

// ---------- shared graphics ----------
/** Official Atomivid mark (src/components/ui/Logo.tsx LogoMark): unchanged geometry and accent #7c6aef. */
const logoMark = (x, y, size) => {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})"><g stroke="#7c6aef" stroke-width="1.3" stroke-linecap="round" fill="none">
    <ellipse cx="12" cy="12" rx="10" ry="4.1"/><ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)"/></g>
    <circle cx="12" cy="12" r="2.6" fill="#7c6aef"/></g>`;
};
/** Static credit, bottom centre (clear of the YouTube end-screen area, inside the safe margin):
 * "Powered by" + the official Atomivid logo (mark + wordmark, as in Logo.tsx: mark, gap, semibold "Atomivid" in ink). */
function creditSvg() {
  const fs_ = 34, size = Math.round(fs_ * 1.45), gap = Math.round(fs_ * 0.33), y = 950;
  const pre = 'Powered by', word = 'Atomivid';
  const preW = Math.round(pre.length * fs_ * 0.56), wordW = Math.round(word.length * fs_ * 0.62);
  const total = preW + gap * 2 + size + gap + wordW, x0 = Math.round((W - total) / 2);
  const xm = x0 + preW + gap * 2, xw = xm + size + gap;
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${x0}" y="${y + 12}" font-family="DejaVu Sans" font-size="${fs_}" fill="#a3a3b0">${pre}</text>${logoMark(xm, y - size / 2, size)}
    <text x="${xw}" y="${y + 12}" font-family="DejaVu Sans" font-size="${fs_}" font-weight="600" fill="#f5f5f7" letter-spacing="-0.5">${word}</text></svg>`;
}
/** Readable on-screen notice card, top-left, kept left of the face (max right edge ~530 px). */
function noticeSvg(lines) {
  const x = 56, y = 60, pad = 20, lh = [], widths = [];
  for (const l of lines) { lh.push(l.size + 10); widths.push(l.text.length * l.size * (l.bold ? 0.62 : 0.55)); }
  const w = Math.min(540, Math.max(...widths) + pad * 2 + 6), h = lh.reduce((a, b) => a + b, 0) + pad * 2 - 6;
  let cy = y + pad; let body = '';
  lines.forEach((l, i) => { cy += l.size; body += `<text x="${x + pad + 6}" y="${cy}" font-family="DejaVu Sans" font-size="${l.size}" font-weight="${l.bold ? 'bold' : 'normal'}" fill="${l.fill}" letter-spacing="${l.caps ? 1.5 : 0}">${esc(l.text)}</text>`; cy += 10; void i; });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#08090a" fill-opacity="0.78"/><rect x="${x}" y="${y}" width="5" height="${h}" rx="2" fill="#e0a33a"/>${body}</svg>`;
}

// ---------- building blocks ----------
/** Clean picture for one window from an approved source, the master's own subtitles burned at their master times. */
async function patch(name, startFrame, frames, inputArgs, chain, ass) {
  const file = path.join(WORK, `patch-${name}.mp4`), t0 = (startFrame / FPS).toFixed(6);
  const subs = ass ? `,setpts=PTS-STARTPTS+${t0}/TB,subtitles=${ass}:fontsdir=/usr/share/fonts/truetype/dejavu,setpts=PTS-STARTPTS` : '';
  await run('ffmpeg', ['-y', ...inputArgs, '-filter_complex', `${chain},setsar=1,format=yuv420p${subs}[v]`, '-map', '[v]', '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-r', String(FPS), file]);
  const n = Number(await probe(['-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]));
  if (n !== frames) throw Error(`patch ${name}: ${n} frames, expected ${frames}`);
  return {name, file, startFrame, frames, nCheck: n};
}
const cover = `scale=${W}:${H}:flags=lanczos:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`;
const clipChain = (inPoint, speed, extra = '') => ({args: ['-ss', inPoint.toFixed(3)], chain: (i) => `[${i}:v]setpts=${speed.toFixed(4)}*PTS,${cover}${extra}`});

async function compose({patches, overlays, totalFrames, audio, fadeOutAt, name}) {
  const inputs = ['-i', MASTER]; const f = []; let cur = '[0:v]';
  const extend = totalFrames - Number(await masterFrames());
  if (extend > 0) { f.push(`[0:v]tpad=stop_mode=clone:stop_duration=${(extend / FPS + 1).toFixed(3)}[base]`); cur = '[base]'; }
  let k = 1;
  for (const p of patches) {
    inputs.push('-i', p.file); const t0 = p.startFrame / FPS, t1 = (p.startFrame + p.frames) / FPS;
    f.push(`[${k}:v]setpts=PTS-STARTPTS+${t0.toFixed(6)}/TB[p${k}]`, `${cur}[p${k}]overlay=0:0:eof_action=pass:enable='between(t,${(t0 - 0.0005).toFixed(4)},${(t1 - 0.0005).toFixed(4)})'[c${k}]`);
    cur = `[c${k}]`; k++;
  }
  for (const o of overlays) {
    const d = o.end - o.start; inputs.push('-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3), '-i', o.file);
    f.push(`[${k}:v]format=rgba,fade=t=in:st=0:d=${o.fadeIn ?? 0.4}:alpha=1${o.fadeOut ? `,fade=t=out:st=${(d - o.fadeOut).toFixed(3)}:d=${o.fadeOut}:alpha=1` : ''},setpts=PTS-STARTPTS+${o.start.toFixed(6)}/TB[o${k}]`, `${cur}[o${k}]overlay=0:0:eof_action=pass:enable='between(t,${o.start.toFixed(4)},${o.end.toFixed(4)})'[c${k}]`);
    cur = `[c${k}]`; k++;
  }
  f.push(`${cur}fade=t=out:st=${fadeOutAt.toFixed(3)}:d=1,setsar=1,format=yuv420p[v]`);
  const out = path.join(OUT, name);
  const a = audio.file ? ['-i', audio.file] : []; const aIdx = audio.file ? k : 0;
  await run('ffmpeg', ['-y', ...inputs, ...a, '-filter_complex', f.join(';'), '-map', '[v]', '-map', `${aIdx}:a`, '-frames:v', String(totalFrames),
    '-c:v', 'libx264', '-preset', process.env.EDIT_PRESET || 'slow', '-crf', process.env.EDIT_CRF || '17', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '60',
    ...(audio.copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']), '-movflags', '+faststart', '-metadata', `title=${audio.title}`, out]);
  return out;
}
let _mf = null;
async function masterFrames() { if (!_mf) _mf = Number(await probe(['-select_streams', 'v', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', MASTER])); return _mf; }

// ---------- DULCE Part I ----------
async function dulce() {
  const assIn = 'content/delivery/dulce-part1/dulce-part1-subtitles.ass';
  // The replaced notices and the old end card leave the subtitle file used for the clean windows.
  const drop = ['dramatized reconstruction', 'existence unverified', 'PART II: NIGHTMARE HALL', 'Dramatized reconstruction of claims'];
  const assTxt = (await fs.readFile(assIn, 'utf8')).split('\n').filter((l) => !(l.startsWith('Dialogue') && drop.some((d) => l.includes(d)))).join('\n');
  const ass = path.join(WORK, 'subs.ass'); await fs.writeFile(ass, assTxt);
  const clip = path.join(SRC, 'D07-03-v3.mp4');

  // Seven-level graphic (same SVG and push-in as the master) with a readable "not verified" header.
  const graphic = (variant) => {
    const GW = 2304, GH = 1296, top = 330, lh = 100;
    const levels = Array.from({length: 7}, (_, i) => { const y = top + i * lh; const hot = variant === 'bottom' ? i >= 5 : variant === 'zones' ? i % 2 === 1 : false;
      const fill = hot ? '#7a1f1a' : variant === 'zones' ? ['#26343a', '#2e3f45'][i % 2] : '#26343a';
      return `<rect x="560" y="${y}" width="1180" height="${lh - 18}" fill="${fill}" stroke="#9fb3b8" stroke-width="3"/><text x="520" y="${y + 60}" font-family="DejaVu Sans" font-size="40" fill="#cfd8da" text-anchor="end">LEVEL ${i + 1}</text>`; }).join('');
    return `<svg width="${GW}" height="${GH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0e1214"/>
    <path d="M0 300 L700 300 L820 150 L1480 150 L1600 300 L${GW} 300 L${GW} ${GH} L0 ${GH} Z" fill="#1a1f21"/>
    <path d="M0 300 L700 300 L820 150 L1480 150 L1600 300 L${GW} 300" stroke="#c9a46a" stroke-width="5" fill="none"/>
    <line x1="1650" y1="300" x2="1650" y2="${top + 7 * lh}" stroke="#9fb3b8" stroke-width="6" stroke-dasharray="18 12"/>${levels}
    <text x="${GW / 2}" y="128" font-family="DejaVu Sans" font-size="42" font-weight="bold" fill="#e8ecec" text-anchor="middle" letter-spacing="1" xml:space="preserve">ACCOUNT ATTRIBUTED TO THOMAS CASTELLO<tspan fill="#e0a33a">  ·  NOT VERIFIED</tspan></text></svg>`;
  };
  const pushIn = (frames) => { const m = Math.max(1, frames - 1); const z = `(1+0.12*(0.5-0.5*cos(PI*(n/${m}))))`;
    return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},scale=w='trunc(${W}*${z}/2)*2':h='trunc(${H}*${z}/2)*2':eval=frame:flags=bicubic,crop=${W}:${H}`; };
  const patches = [];
  for (const [nm, variant, sf, fr] of [['G10', 'all', 331, 71], ['G11', 'zones', 2218, 246], ['G12', 'bottom', 13676, 191]]) {
    const g = await png(graphic(variant), path.join(WORK, `${nm}.png`));
    patches.push(await patch(nm, sf, fr, ['-loop', '1', '-framerate', String(FPS), '-i', g], `[0:v]${pushIn(fr)}`, ass));
  }
  // The two Castello close-ups (P1-012, P1-117 desaturated) from the approved V1 clip, as in the master.
  patches.push(await patch('P1-012', 891, 98, ['-ss', '0.250', '-i', clip], `[0:v]setpts=1.0000*PTS,${cover}`, ass));
  patches.push(await patch('P1-117', 15634, 183, ['-ss', '3.933', '-i', clip], `[0:v]setpts=1.0000*PTS,${cover},hue=s=0.25`, ass));
  // End card: black (as before), its text now an overlay.
  patches.push(await patch('END', 17301, 180, ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`], '[0:v]null', null));

  const noteA = await png(noticeSvg([
    {text: 'DRAMATIZED RECONSTRUCTION', size: 26, bold: true, caps: true, fill: '#e0a33a'},
    {text: 'Claims attributed to', size: 33, fill: '#f2f2f2'},
    {text: 'Thomas Edwin Castello', size: 33, bold: true, fill: '#ffffff'},
    {text: 'Not independently verified', size: 32, fill: '#f2f2f2'}]), path.join(WORK, 'noteA.png'));
  const noteB = await png(noticeSvg([
    {text: 'IDENTITY UNVERIFIED', size: 26, bold: true, caps: true, fill: '#e0a33a'},
    {text: 'Thomas Edwin Castello', size: 32, bold: true, fill: '#ffffff'},
    {text: 'No independent confirmation', size: 30, fill: '#f2f2f2'}]), path.join(WORK, 'noteB.png'));
  const endCard = await png(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="330" font-family="DejaVu Serif" font-size="110" font-weight="bold" fill="#f2f2f2" text-anchor="middle" letter-spacing="16">DULCE</text>
    <text x="${W / 2}" y="410" font-family="DejaVu Serif" font-size="46" fill="#e6e6e6" text-anchor="middle" letter-spacing="2">The investigation continues in Part II</text>
    <text x="${W / 2}" y="486" font-family="DejaVu Sans" font-size="30" fill="#cfcfcf" text-anchor="middle">Dramatized reconstruction of claims attributed to Thomas Castello. Not verified.</text></svg>`, path.join(WORK, 'endcard.png'));
  const credit = await png(creditSvg(), path.join(WORK, 'credit.png'));
  const overlays = [
    {file: noteA, start: 29.75, end: 32.92, fadeIn: 0.3, fadeOut: 0.35},
    {file: noteB, start: 521.45, end: 527.1, fadeIn: 0.4, fadeOut: 0.5},
    {file: endCard, start: 576.9, end: 582.7, fadeIn: 0.6},
    {file: credit, start: 579.4, end: 582.7, fadeIn: 0.4}];
  for (const p of patches) log('patch', p.name, p.frames, p.nCheck);
  const out = await compose({patches, overlays, totalFrames: 17481, audio: {copy: true, title: 'DULCE - Part I'}, fadeOutAt: 581.7, name: 'DULCE-Part-I-review-v2.mp4'});
  return {out, patches: patches.map(({name, startFrame, frames, nCheck}) => ({name, startFrame, frames, nCheck}))};
}

// ---------- Thermopylae ----------
const ctaMarkSvg = (mark, bell, w) => {
  const h = 84, x = 1920 - 96 - w, y = 54 + 20;
  const icon = bell ? `<path transform="translate(${x + 24} ${y + 20})" d="M22 4c-6 0-11 5-11 11v9l-5 7v3h32v-3l-5-7v-9c0-6-5-11-11-11zm-5 33a5 5 0 0 0 10 0z" fill="#e6ddd0"/>` : `<polygon points="${x + 26},${y + 24} ${x + 26},${y + 60} ${x + 58},${y + 42}" fill="#c9a24a"/>`;
  return `<svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#121212" fill-opacity="0.72" stroke="#7a6a58" stroke-width="2"/>${icon}<text x="${x + 78}" y="${y + 52}" font-family="DejaVu Sans" font-weight="bold" font-size="34" fill="#e6ddd0">${mark[0]}</text><text x="${x + 78 + (mark[0].length * 23) + 14}" y="${y + 52}" font-family="DejaVu Sans" font-size="26" fill="#c9bfae">· ${esc(mark[1])}</text></svg>`;
};
async function thermopylae() {
  const ass = path.resolve('content/delivery/thermopylae/video-004-v3-subtitles.ass');
  const S = (f) => path.join(SRC, f);
  const markA = await png(ctaMarkSvg(['SUBSCRIBE', 'The Annals of History'], false, 600), path.join(WORK, 'markA.png'));
  const markB = await png(ctaMarkSvg(['SUBSCRIBE', 'Turn on notifications'], true, 600), path.join(WORK, 'markB.png'));
  const withMark = (src, mark) => `${src}[b];[1:v]format=rgba,fade=t=in:st=1.0:d=0.8:alpha=1[m];[b][m]overlay=0:0:format=auto`;
  const patches = [];
  // CTA 1: same approved stock (V4-092 @0.5 s), channel now "The Annals of History".
  patches.push(await patch('CTA1', 1491, 152, ['-ss', '0.500', '-i', S('V4-092.mp4'), '-loop', '1', '-framerate', String(FPS), '-i', markA], withMark(`[0:v]setpts=1.0000*PTS,${cover}`, markA), ass));
  // Former Oia shot (S8, 9.03 s): the pass at sunrise (V4-002), then the shield line (V4-001) on "and every city in Greece…".
  const cutF = 110, restF = 271 - cutF, sp = (restF / FPS) / (5.041667 - 0.25 - 0.05);
  patches.push(await patch('S8', 20689, 271, ['-ss', '0.250', '-i', S('V4-002-v1.mp4'), '-ss', '0.250', '-i', S('V4-001-v1.mp4')],
    `[0:v]setpts=1.0000*PTS,${cover},trim=end_frame=${cutF},setpts=PTS-STARTPTS[a];[1:v]setpts=${sp.toFixed(4)}*PTS,${cover},trim=end_frame=${restF},setpts=PTS-STARTPTS[bb];[a][bb]concat=n=2:v=1:a=0`, ass));
  // CTA 2: present-day Thermopylae hot springs (approved stock V4-032, later window), bell mark as before.
  patches.push(await patch('CTA2', 22202, 289, ['-ss', '6.000', '-i', S('V4-032.mp4'), '-loop', '1', '-framerate', String(FPS), '-i', markB], withMark(`[0:v]setpts=1.0000*PTS,${cover}`, markB), ass));
  // End card, now 4.0 s: episode palette, channel "The Annals of History", sources; credit as overlay.
  patches.push(await patch('END', 22491, 120, ['-f', 'lavfi', '-i', `color=c=0x121212:s=${W}x${H}:r=${FPS}`], '[0:v]null', null));
  const sources1 = 'Sources: Herodotus, Histories 7.175–239 · Thucydides 5.71 · Xenophon, Lac. Pol. 11';
  const sources2 = 'Plutarch, Apophth. Lac. 225D · Pausanias 3.14.1 · Marinatos 1951 · Kraft et al. 1987 · Cartledge 2006 · Lazenby 1993. Stock footage: Pexels.';
  const endText = await png(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="250" font-family="DejaVu Sans" font-size="76" font-weight="bold" fill="#e6ddd0" text-anchor="middle">Three Days at the Hot Gates</text>
    <text x="${W / 2}" y="318" font-family="DejaVu Sans" font-size="38" fill="#d9a441" text-anchor="middle" letter-spacing="4">THE ANNALS OF HISTORY</text>
    <text x="${W / 2}" y="808" font-family="DejaVu Sans" font-size="23" fill="#9a9185" text-anchor="middle">${esc(sources1)}</text>
    <text x="${W / 2}" y="842" font-family="DejaVu Sans" font-size="23" fill="#9a9185" text-anchor="middle">${esc(sources2)}</text></svg>`, path.join(WORK, 'endtext.png'));
  const credit = await png(creditSvg(), path.join(WORK, 'credit.png'));
  // Audio: the approved mix up to 750.0 s, then the closing track's own resolved ending (level-matched, 1 s crossfade).
  const audio = await thermoAudio();
  for (const p of patches) log('patch', p.name, p.frames, p.nCheck);
  const out = await compose({patches, overlays: [{file: endText, start: 749.85, end: 753.7, fadeIn: 0.5}, {file: credit, start: 750.2, end: 753.7, fadeIn: 0.4}],
    totalFrames: 22611, audio: {file: audio, title: 'Three Days at the Hot Gates'}, fadeOutAt: 752.7, name: 'Thermopylae-The-Annals-of-History-review-v4.mp4'});
  return {out, patches: patches.map(({name, startFrame, frames, nCheck}) => ({name, startFrame, frames, nCheck}))};
}
async function thermoAudio() {
  const tr = path.join(WORK, 'track.wav');
  await run('ffmpeg', ['-y', '-i', path.join(SRC, 'elevenlabs-inspirational-2.mp3'), '-af', 'aresample=48000,aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse,dynaudnorm=f=400:g=11:p=0.9:m=12:s=8', tr]);
  const dur = Number(await probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', tr]));
  const tailLen = 4.7; // 749.0 -> 753.7
  const tail = path.join(WORK, 'tail.wav');
  await run('ffmpeg', ['-y', '-ss', (dur - tailLen).toFixed(3), '-i', tr, '-t', tailLen.toFixed(3), tail]);
  // Level match: momentary loudness of the master's music-only bed (749.0-749.9) vs the tail's first second.
  const lufs = async (file, ss, t) => { const e = await run('ffmpeg', ['-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']); return Number(/I:\s+(-?[\d.]+) LUFS/.exec(e.slice(e.lastIndexOf('Summary')))?.[1]); };
  const target = await lufs(MASTER, 748.7, 1.2), have = await lufs(tail, 0, 1.2);
  const gain = Number.isFinite(target) && Number.isFinite(have) ? target - have : -12;
  log('audio tail', {target, have, gain: +gain.toFixed(2)});
  const out = path.join(WORK, 'audio.wav');
  await run('ffmpeg', ['-y', '-i', MASTER, '-i', tail, '-filter_complex',
    `[0:a]atrim=0:750.0,asetpts=N/SR/TB,aresample=48000[a];[1:a]volume=${gain.toFixed(2)}dB,afade=t=out:st=${(tailLen - 1.6).toFixed(2)}:d=1.6:curve=qsin[b];[a][b]acrossfade=d=1.0:c1=qsin:c2=qsin,atrim=0:753.7[o]`,
    '-map', '[o]', '-c:a', 'pcm_s16le', out]);
  return out;
}

const result = WHICH === 'dulce' ? await dulce() : await thermopylae();
await fs.writeFile(path.join(OUT, `edit-${WHICH}.json`), JSON.stringify(result, null, 2));
log('done', result.out);
