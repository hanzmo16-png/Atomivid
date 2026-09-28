/** DULCE Part I render + QA + delivery. Zero paid calls. DP1_DRAFT=true renders placeholders for missing
 * assets and silence for missing narration, to prove the pipeline before any spend.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {readAiVideoClipRecord} from '../src/lib/video/long-form/ai-video-storage';
import {buildContactSheet, frameAt, probeDuration} from './lib/contact-sheet';
import {buildAss, buildCues, clipRecordKey, type PlanShot, type TitleOverlay} from './lib/dulce-edit';
import {BEAT_TAIL, FPS, HARD_CAP_USD, LEAD_IN, conformTimeline, exposureUsd, moveFor, stillMotionFilter, v1InPoint, type TimedSlot, type WordTiming} from './lib/dulce-part1-core';
import type {Ctx} from './dulce-part1';

const P = 'dulce-part1', V1 = 'dulce-001/full-v1', V1_SCOPE = 'dulce-001-full-v1', NAME = 'DULCE-Part-I-master.mp4';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const log = (tag: string, v: unknown) => console.log(`@@DP1_${tag} ` + JSON.stringify(v));
const J = async <T>(f: string) => JSON.parse(await fs.readFile(f, 'utf8')) as T;
type Asset = {characters: string[]; animationPrompt: string | null; clipSeconds: number; imageRevision?: string; animationRevision?: string};
type Shot = TimedSlot & {origin: string; visual: string; cue: string; chars?: string};
type Src = {kind: 'v1' | 'clip' | 'still' | 'graphic' | 'black' | 'placeholder'; file: string; note?: string; crop?: {x: number; y: number; width: number; height: number}; usableUntil?: number | null; sha256?: string; origin: string};

export async function render(ctx: Ctx) {
  const {read, put, putJson, sign, run, out} = ctx;
  const draft = process.env.DP1_DRAFT === 'true';
  const work = path.join(out, 'work'); await fs.mkdir(work, {recursive: true});
  const sb = await J<{shots: Shot[]; beatSeconds: Record<string, number>}>('content/long-form/dulce-part1/storyboard.json');
  const script = await J<{beats: {id: string; narration: string}[]; onScreenNotice: string; endCard: string}>('content/long-form/dulce-part1/script-en.json');
  const assets = (await J<{assets: Record<string, Asset>}>('content/long-form/dulce-part1/assets.json')).assets;
  const v1spec = await J<{shots: (PlanShot & {renderCrop?: Src['crop']})[]}>('content/long-form/dulce-001/full-shots.json');
  const v1qa = await J<{items: {clipId: string; usableUntilSeconds: number | null; appliesToRevision?: string}[]}>('content/qa-datasets/dulce-v1-visual-labels.json');
  const issues: string[] = [];

  // 1) Narration (cached David audio) or draft silence.
  const narration: {beatId: string; file: string | null; seconds: number; words: WordTiming[]}[] = [];
  for (const b of script.beats) {
    const rec = await read(`${P}/narration/${b.id}.json`); const mp3 = await read(`${P}/narration/${b.id}.mp3`);
    if (rec && mp3) { const r = JSON.parse(rec.toString()); if (sha(mp3) !== r.sha256) throw Error('Narration checksum ' + b.id); const f = path.join(work, `${b.id}.mp3`); await fs.writeFile(f, mp3); narration.push({beatId: b.id, file: f, seconds: await probeDuration(f), words: r.words}); }
    else if (draft) { narration.push({beatId: b.id, file: null, seconds: sb.beatSeconds[b.id] - BEAT_TAIL - LEAD_IN, words: []}); issues.push(`draft: narration ${b.id} missing`); }
    else throw Error('Narration missing for ' + b.id);
  }
  const timeline = conformTimeline(sb.shots, narration.map(n => ({beatId: n.beatId, audioSeconds: n.seconds})));
  const slots = timeline.slots as Shot[]; const totalFrames = timeline.totalFrames, total = totalFrames / FPS;
  log('TIMELINE', {slots: slots.length, seconds: total});

  // 2) Resolve every slot's source.
  const approvedStill = async (id: string): Promise<Buffer | null> => { const a = assets[id]; const b = await read(`${P}/stills/${id}-${a?.imageRevision || 'v1'}.png`); const rv = await read(`${P}/reviews/still-${id}.json`); return b && rv && JSON.parse(rv.toString()).sha256 === sha(b) ? b : null; };
  const cache = new Map<string, Src>();
  const svg = (variant: string) => graphicSvg(variant);
  async function resolve(s: Shot, gIndex: number): Promise<Src> {
    // A slot planned as a clip and a still-motion slot of the same asset resolve separately (no repeated clip).
    const key = s.src + (s.src === 'G1' ? gIndex : '') + (['i2v_economy', 'i2v_hero'].includes(s.productionMethod) ? ':clip' : '');
    if (cache.has(key)) return cache.get(key)!;
    let src: Src;
    if (s.src === 'G7') src = {kind: 'black', file: '', origin: 'graphic'};
    else if (s.src.startsWith('G')) { const f = path.join(work, `${key}.png`); await sharp(Buffer.from(svg(['all', 'zones', 'bottom'][gIndex] || 'all'))).png().toFile(f); src = {kind: 'graphic', file: f, origin: 'graphic:' + key}; }
    else if (s.origin === 'V1' && ['ken_burns', 'parallax'].includes(s.productionMethod)) {
      // Smart Mix: use the approved V1 still instead of its (defective) animation.
      const b = await read(`${V1}/refs/${s.src}.png`); if (!b) throw Error('Approved V1 still missing ' + s.src);
      const f = path.join(work, `v1still-${s.src}.png`); await fs.writeFile(f, b); src = {kind: 'still', file: f, sha256: sha(b), origin: `videos/${V1}/refs/${s.src}.png`};
    } else if (s.origin === 'V1') {
      const spec = v1spec.shots.find(x => x.shotId === s.src); if (!spec) throw Error('V1 spec missing ' + s.src);
      let bytes: Buffer | null = null, origin = '';
      if (spec.reuse?.storagePath) { bytes = await read(spec.reuse.storagePath); origin = 'videos/' + spec.reuse.storagePath; }
      else { const rec = await readAiVideoClipRecord(ctx.service, 'videos', V1_SCOPE, clipRecordKey(spec)); if (rec?.status === 'COMPLETED' && rec.storagePath) { bytes = await read(rec.storagePath); if (bytes && sha(bytes) !== rec.checksumSha256) throw Error('V1 checksum ' + s.src); origin = 'videos/' + rec.storagePath; } }
      if (!bytes) throw Error('V1 clip unavailable ' + s.src);
      const f = path.join(work, `v1-${s.src}.mp4`); await fs.writeFile(f, bytes);
      const lab = v1qa.items.find(i => i.clipId === s.src);
      // A defect recorded for the original v1 animation does not apply to a corrected revision.
      const usable = lab?.appliesToRevision && (spec.animationRevision || 'v1') !== lab.appliesToRevision ? null : lab?.usableUntilSeconds ?? null;
      src = {kind: 'v1', file: f, crop: spec.renderCrop, usableUntil: usable, sha256: sha(bytes), origin};
    } else {
      const a = assets[s.src]; const still = await approvedStill(s.src);
      if (['i2v_economy', 'i2v_hero'].includes(s.productionMethod) && a?.clipSeconds) {
        const rev = a.animationRevision || 'v1'; const rec = await readAiVideoClipRecord(ctx.service, 'videos', P, `${s.src}-${rev}`); const rv = await read(`${P}/reviews/clip-${s.src}-${rev}.json`);
        const ok = rec?.status === 'COMPLETED' && rv && JSON.parse(rv.toString()).result === 'PASS' && JSON.parse(rv.toString()).sha256 === rec.checksumSha256;
        if (ok) { const bytes = await read(rec!.storagePath!); if (!bytes || sha(bytes) !== rec!.checksumSha256) throw Error('Clip checksum ' + s.src); const f = path.join(work, `clip-${s.src}.mp4`); await fs.writeFile(f, bytes); src = {kind: 'clip', file: f, sha256: sha(bytes), usableUntil: JSON.parse(rv!.toString()).usableUntil ?? null, origin: 'videos/' + rec!.storagePath}; cache.set(key, src); return src; }
        issues.push(`${s.src}: no approved clip, fell back to approved still + camera motion`);
      }
      if (still) { const f = path.join(work, `still-${s.src}.png`); await fs.writeFile(f, still); src = {kind: 'still', file: f, sha256: sha(still), origin: `videos/${P}/stills/${s.src}`}; }
      else if (draft) { const f = path.join(work, `ph-${s.src}.png`); await sharp({create: {width: 1920, height: 1080, channels: 3, background: '#2a2f33'}}).composite([{input: Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><text x="960" y="540" font-size="90" fill="#ccc" text-anchor="middle" font-family="DejaVu Sans">${s.src}</text></svg>`)}]).png().toFile(f); src = {kind: 'placeholder', file: f, origin: 'draft'}; issues.push(`draft: ${s.src} placeholder`); }
      else throw Error('No approved still for ' + s.src);
    }
    cache.set(key, src); return src;
  }

  // 3) Segments at exact frame counts.
  const uses = new Map<string, number>(); const segs: string[] = []; const report: Record<string, unknown>[] = [];
  let g1 = 0;
  for (const [i, s] of slots.entries()) {
    const gi = s.src === 'G1' ? g1++ : 0; const src = await resolve(s, gi);
    const seg = path.join(work, `seg-${String(i).padStart(3, '0')}.mp4`); const edit = s.frames / FPS; const u = uses.get(s.src) ?? 0; uses.set(s.src, u + 1);
    const tail = ',setsar=1,format=yuv420p' + (s.id === slots.find(x => x.beat === 'p13' && x.src === 'D07-03')?.id ? ',hue=s=0.25' : '') + (s.src === 'N27' ? `,eq=brightness='0.035*sin(2*PI*t/1.6)':eval=frame` : '');
    let args: string[]; let inPoint = 0, speed = 1, frozen = 0;
    if (src.kind === 'black') args = ['-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=${FPS}`, '-vf', 'format=yuv420p'];
    else if (src.kind === 'still' || src.kind === 'graphic' || src.kind === 'placeholder') { const mv = src.kind === 'graphic' ? 'push-in' : s.productionMethod === 'parallax' ? (i % 2 ? 'pan-left' : 'pan-right') : moveFor(i, s.shotClass); args = ['-loop', '1', '-framerate', String(FPS), '-i', src.file, '-vf', stillMotionFilter(mv, s.frames) + tail]; report.push({slot: s.id, move: mv}); }
    else {
      const clipSeconds = await probeDuration(src.file);
      inPoint = v1InPoint(clipSeconds, src.usableUntil ?? null, edit, u);
      const window = Math.min(clipSeconds, src.usableUntil ?? clipSeconds) - inPoint;
      if (window < edit) { speed = Math.min(1.5, edit / window); frozen = Math.max(0, edit - window * speed); if (frozen > 0.05) issues.push(`${s.id} ${s.src}: ${frozen.toFixed(2)} s held beyond clean window`); }
      const crop = src.crop ? `crop=${src.crop.width}:${src.crop.height}:${src.crop.x}:${src.crop.y},` : '';
      args = ['-ss', inPoint.toFixed(3), '-i', src.file, '-vf', `${crop}setpts=${speed.toFixed(4)}*PTS,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS}${frozen > 0.05 ? `,tpad=stop_mode=clone:stop_duration=${(frozen + 0.1).toFixed(3)}` : ''}` + tail];
    }
    await run('ffmpeg', ['-y', ...args, '-frames:v', String(s.frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-r', String(FPS), seg]);
    segs.push(seg);
    report.push({slot: s.id, beat: s.beat, src: s.src, kind: src.kind, method: s.productionMethod, start: s.startFrame / FPS, seconds: edit, inPoint, speed, frozen, origin: src.origin, sha256: src.sha256});
  }
  await fs.writeFile(path.join(work, 'concat.txt'), segs.map(f => `file '${f}'`).join('\n'));
  const picture = path.join(work, 'picture.mp4'); await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'concat.txt'), '-c', 'copy', picture]);

  // 4) Audio: narration at beat starts + lead-in, library music by act, ducked, -14 LUFS.
  const beatStart = (b: string) => timeline.beatStarts[b] / FPS;
  const inputs: string[] = [], f: string[] = []; let ni = 0;
  for (const n of narration) { if (!n.file) continue; const d = Math.round((beatStart(n.beatId) + LEAD_IN) * 1000); inputs.push('-i', n.file); f.push(`[${ni}]aresample=48000,aformat=channel_layouts=stereo,adelay=${d}|${d}[n${ni}]`); ni++; }
  if (ni) f.push(`${Array.from({length: ni}, (_, i) => `[n${i}]`).join('')}amix=inputs=${ni}:normalize=0:duration=longest,apad,atrim=0:${total},asplit[voice][key]`);
  else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total},asplit[voice][key]`);
  const music: [string, number, number][] = [['elevenlabs-tension-1', 0, beatStart('p06') + 1], ['elevenlabs-reflective-1', beatStart('p06') - 1, beatStart('p08') + 1], ['elevenlabs-tension-2', beatStart('p08') - 1, total]];
  for (const [j, [id, s0, s1]] of music.entries()) {
    const {data, error} = await ctx.service.storage.from('music-library').download(id + '.mp3'); if (error || !data) throw Error('Missing music ' + id);
    const mf = path.join(work, id + '.mp3'); await fs.writeFile(mf, Buffer.from(await data.arrayBuffer()));
    const tr = path.join(work, id + '.wav'); await run('ffmpeg', ['-y', '-i', mf, '-af', 'aresample=48000,aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', tr]);
    const len = s1 - s0, copies = Math.ceil(len / Math.max(10, (await probeDuration(tr)) - 3)) + 1, first = inputs.filter(x => x === '-i').length;
    for (let k = 0; k < copies; k++) inputs.push('-i', tr);
    let chain = `[${first}]`; for (let k = 1; k < copies; k++) { f.push(`${chain}[${first + k}]acrossfade=d=3[m${j}x${k}]`); chain = `[m${j}x${k}]`; }
    const d = Math.round(s0 * 1000); f.push(`${chain}atrim=0:${len.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=${j ? 2 : 0.3},afade=t=out:st=${(len - 2.5).toFixed(3)}:d=2.5,adelay=${d}|${d}[m${j}]`);
  }
  f.push(`[m0][m1][m2]amix=inputs=3:normalize=0:duration=longest,apad,atrim=0:${total},volume=0.30[bed]`, `[bed][key]sidechaincompress=threshold=0.015:ratio=4:attack=30:release=600[ducked]`, `[voice]volume=0.95[v]`, `[v][ducked]amix=inputs=2:normalize=0:duration=first,afade=t=out:st=${(total - 3).toFixed(3)}:d=3[mix]`);
  const mix = path.join(work, 'mix.wav'); await run('ffmpeg', ['-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[mix]', '-t', String(total), '-c:a', 'pcm_s16le', mix]);
  const p1 = await run('ffmpeg', ['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']); const ln = JSON.parse(p1.slice(p1.lastIndexOf('{'), p1.lastIndexOf('}') + 1));
  const mastered = path.join(work, 'mastered.wav'); await run('ffmpeg', ['-y', '-i', mix, '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true,aresample=48000`, '-c:a', 'pcm_s16le', mastered]);

  // 5) English subtitles from the master script + on-screen text.
  const words: WordTiming[] = []; for (const n of narration) { const o = beatStart(n.beatId) + LEAD_IN; for (const w of n.words) words.push({text: w.text, startSeconds: w.startSeconds + o, endSeconds: w.endSeconds + o}); }
  const at = (beat: string, src: string) => slots.find(s => s.beat === beat && s.src === src);
  const ov: TitleOverlay[] = []; const add = (s: Shot | undefined, lines: string[], style: 'Title' | 'Note', from = 0.3, len?: number, corner = false) => { if (!s) { issues.push('overlay slot missing ' + lines[0]); return; } const t0 = s.startFrame / FPS + from; ov.push({start: t0, end: len ? t0 + len : s.startFrame / FPS + s.frames / FPS - 0.2, lines, style, corner}); };
  add(at('p01', 'D07-03'), ['Thomas Edwin Castello · dramatized reconstruction'], 'Note', 0.3, undefined, true);
  add(at('p01', 'D03-04'), ['DULCE', 'PART I'], 'Title', 0.4);
  add(at('p11', 'N41'), ['NIGHTMARE HALL'], 'Title', 2.0, 3.5);
  add(at('p13', 'D07-03'), ['Thomas Edwin Castello · existence unverified'], 'Note', 0.3, undefined, true);
  add(at('p14', 'N48'), ['Paul Bennewitz'], 'Note', 0.3, undefined, true);
  const endSlot = slots.at(-1)!; ov.push({start: endSlot.startFrame / FPS + 0.3, end: total - 0.3, lines: ['DULCE', 'PART II: NIGHTMARE HALL'], style: 'Title'}, {start: endSlot.startFrame / FPS + 0.3, end: total - 0.3, lines: [script.onScreenNotice], style: 'Note'});
  const cues = buildCues(words); const ass = path.join(work, 'part1.ass'); await fs.writeFile(ass, buildAss(cues, ov)); await fs.copyFile(ass, path.join(out, 'dulce-part1-subtitles.ass'));
  const srtT = (s: number) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  await fs.writeFile(path.join(out, 'dulce-part1-en.srt'), cues.map((c, i) => `${i + 1}\n${srtT(c.start)} --> ${srtT(c.end)}\n${c.words.map(w => w.text).join(' ')}\n`).join('\n'));

  // 6) Encode.
  const final = path.join(out, NAME);
  await run('ffmpeg', ['-y', '-i', picture, '-i', mastered, '-vf', `subtitles=${ass}:fontsdir=/usr/share/fonts/truetype/dejavu,fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 1).toFixed(3)}:d=1`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '9M', '-bufsize', '18M', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '60', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-metadata', 'title=DULCE - Part I', '-t', String(total), final]);

  // 7) Technical QA (black allowed only on intentional black cards).
  const pr = JSON.parse(await new Promise<string>((res, rej) => { const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,channels:format=duration,size,bit_rate', '-of', 'json', final]); let s = ''; p.stdout.on('data', c => s += c); p.on('close', c => c === 0 ? res(s) : rej(Error('ffprobe'))); }));
  const v = pr.streams.find((x: {codec_type: string}) => x.codec_type === 'video'), a = pr.streams.find((x: {codec_type: string}) => x.codec_type === 'audio');
  const det = await run('ffmpeg', ['-i', final, '-vf', 'blackdetect=d=0.5:pix_th=0.04,freezedetect=n=-60dB:d=2.5', '-af', 'silencedetect=n=-45dB:d=1.5,ebur128=peak=true', '-f', 'null', '-']);
  const blackCards = slots.filter(s => s.src === 'G7').map(s => [s.startFrame / FPS - 0.7, (s.startFrame + s.frames) / FPS + 0.7]);
  const inCard = (t: number) => blackCards.some(([x, y]) => t >= x && t <= y);
  const black = [...det.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]).filter(([s0, s1]) => !(inCard(s0) && inCard(s1)) && s0 > 1);
  const fz = [...det.matchAll(/freeze_start: ([\d.]+)/g)].map(m => Number(m[1])).filter(t => !inCard(t));
  const silS = [...det.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1])).filter(t => t < total - 4);
  const summ = det.slice(det.lastIndexOf('Summary:')); const num = (re: RegExp) => Number(re.exec(summ)?.[1]);
  const hookSlots = slots.filter(s => s.startFrame < 30 * FPS).length;
  const duration = Number(pr.format.duration);
  const checks: Record<string, boolean> = {
    durationNearPlan: Math.abs(duration - total) < 0.5, durationInTarget: duration >= 450 && duration <= 660, resolution1080p: v?.width === 1920 && v?.height === 1080, fps30: v?.r_frame_rate === '30/1',
    audioStereo: a?.channels === 2, noAccidentalBlack: black.length === 0, noFrozenPicture: fz.length === 0, noSilentGaps: silS.length === 0,
    loudnessNear14: Math.abs(num(/I:\s+(-?[\d.]+) LUFS/) + 14) <= 1, truePeakSafe: num(/Peak:\s+(-?[\d.]+) dBFS/) <= -1,
    allSlotsSourced: report.filter(r => 'kind' in r).length === slots.length, noPlaceholders: !report.some(r => r.kind === 'placeholder'),
    subtitlesCoverAllWords: cues.reduce((x, c) => x + c.words.length, 0) === words.length && words.length === script.beats.reduce((x, b) => x + b.narration.split(/\s+/).filter(Boolean).length, 0),
    hookAtLeast10Changes: hookSlots >= 10, noHeldFrames: !report.some(r => (r.frozen as number) > 0.05),
  };
  const bytes = await fs.readFile(final);
  const qc = {draft, final: {file: NAME, bytes: bytes.length, sha256: sha(bytes), durationSeconds: duration, width: v?.width, height: v?.height, fps: v?.r_frame_rate}, loudness: {integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/)}, black, frozen: fz, silence: silS, hookSlots, checks, issues, slots: report};
  await fs.writeFile(path.join(out, 'qc.json'), JSON.stringify(qc, null, 2));

  // 8) Visual / narrative QA sheets.
  const sheet = async (name: string, times: number[], label: (t: number) => string, cols = 5, w = 480) => { const tiles = []; for (const t of times) tiles.push({image: await frameAt(final, Math.min(total - 0.05, t), w), label: label(t)}); await fs.writeFile(path.join(out, name), await buildContactSheet(tiles, {columns: cols, tileWidth: w, tileHeight: Math.round(w * 9 / 16), title: name})); };
  const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  await sheet('qa-hook-0-30s.jpg', Array.from({length: 30}, (_, i) => i + 0.5), mmss);
  const every5 = Array.from({length: Math.floor(total / 5)}, (_, i) => i * 5 + 2.5); for (let k = 0; k * 36 < every5.length; k++) await sheet(`qa-every-5s-${k + 1}.jpg`, every5.slice(k * 36, k * 36 + 36), mmss, 6, 384);
  const gen = slots.filter(s => ['i2v_economy', 'i2v_hero'].includes(s.productionMethod)); for (const [k, s] of gen.entries()) await sheet(`qa-gen-${String(k + 1).padStart(2, '0')}-${s.id}-${s.src}.jpg`, Array.from({length: 8}, (_, j) => s.startFrame / FPS + 0.1 + (s.frames / FPS - 0.2) * j / 7), t => `${s.src} ${mmss(t)}`, 4);
  const spoken = (s: Shot) => words.filter(w => w.startSeconds >= s.startFrame / FPS - 0.05 && w.startSeconds < (s.startFrame + s.frames) / FPS).map(w => w.text).join(' ');
  for (let k = 0; k * 24 < slots.length; k++) { const part = slots.slice(k * 24, k * 24 + 24); const tiles = []; for (const s of part) tiles.push({image: await frameAt(final, (s.startFrame + s.frames / 2) / FPS, 384), label: `${s.id} ${s.src} | ${spoken(s)}`}); await fs.writeFile(path.join(out, `qa-narrative-${k + 1}.jpg`), await buildContactSheet(tiles, {columns: 4, tileWidth: 384, tileHeight: 216, title: 'Narration vs picture ' + (k + 1)})); }
  const bounds = slots.map((s, i) => [s, slots[i + 1]] as const).filter(([x, y]) => y && ['i2v_economy', 'i2v_hero'].some(m => [x.productionMethod, y.productionMethod].includes(m)) && x.productionMethod !== y.productionMethod);
  const bt: number[] = []; for (const [, y] of bounds) { bt.push(y!.startFrame / FPS - 0.2, y!.startFrame / FPS + 0.2); } if (bt.length) await sheet('qa-transitions.jpg', bt.slice(0, 40), mmss, 4, 384);

  // 9) Telemetry metrics.
  const {data: list} = await ctx.service.storage.from('videos').list(`${P}/telemetry`, {limit: 1000});
  const attempts: {assetId: string; stage: string; provider: string; shotClass: string; costUsd: number; qa: {result: string}; finalApproved: boolean; productionMethod: string}[] = [];
  for (const e of list || []) { const b = await read(`${P}/telemetry/${e.name}`); if (b) attempts.push(JSON.parse(b.toString())); }
  const ledgerExposure = exposureUsd(ctx.ledger.entries);
  const spent = ctx.ledger.entries.filter(e => e.status === 'committed').reduce((x, e) => x + (e.actualUsd ?? e.maxUsd), 0);
  const genCost = attempts.filter(x => x.stage !== 'voice').reduce((x, y) => x + y.costUsd, 0);
  const genSlots = report.filter(r => r.kind === 'clip'), genSec = genSlots.reduce((x, r) => x + (r.seconds as number), 0);
  const v1Sec = report.filter(r => r.kind === 'v1').reduce((x, r) => x + (r.seconds as number), 0);
  const newAssetSlots = report.filter(r => ['clip', 'still'].includes(r.kind as string)).length;
  const reviewed = attempts.filter(x => ['PASS', 'FAIL'].includes(x.qa?.result));
  const byClass: Record<string, {pass: number; total: number}> = {}; for (const x of reviewed.filter(y => y.stage === 'animation')) { const c = (byClass[x.shotClass] ||= {pass: 0, total: 0}); c.total++; if (x.qa.result === 'PASS') c.pass++; }
  const uniqueAssets = new Set(attempts.filter(x => x.stage !== 'voice').map(x => x.assetId + x.stage)).size;
  const cogsByKind: Record<string, number> = {}; for (const e of ctx.ledger.entries.filter(x => x.status === 'committed')) cogsByKind[e.kind] = (cogsByKind[e.kind] || 0) + (e.actualUsd ?? e.maxUsd);
  const retryUsd = attempts.filter(x => x.qa?.result === 'FAIL' || /-v[2-9]$/.test((x as {attemptId?: string}).attemptId || '')).reduce((q, y) => q + y.costUsd, 0);
  const providerTopups = JSON.parse(await fs.readFile('content/long-form/dulce-part1/provider-balance.json', 'utf8').catch(() => 'null'));
  const metrics = {cogsUsd: spent, cogsByKind, retryAndFailedAttemptsUsd: retryUsd, providerTopupsNotCogs: providerTopups, totalCostUsd: spent, exposureUsd: ledgerExposure, capUsd: HARD_CAP_USD, generationCostUsd: genCost,
    costPerApprovedShot: newAssetSlots ? genCost / newAssetSlots : null, costPerApprovedGenerativeSecond: genSec ? attempts.filter(x => x.stage === 'animation').reduce((q, y) => q + y.costUsd, 0) / genSec : null,
    costPerFinishedMinute: spent / (duration / 60), regenerationRate: uniqueAssets ? (attempts.filter(x => x.stage !== 'voice').length - uniqueAssets) / uniqueAssets : 0,
    qaFailureRate: reviewed.length ? reviewed.filter(x => x.qa.result === 'FAIL').length / reviewed.length : 0,
    newGenerativeShare: genSec / duration, totalGenerativeOriginShare: (genSec + v1Sec) / duration, generativeClipsInMaster: new Set(genSlots.map(r => r.src)).size, generativeSecondsInMaster: genSec,
    stillMotionSlots: report.filter(r => ['still', 'graphic'].includes(r.kind as string)).length, providerPassRateByShotClass: byClass, attempts: attempts.length};
  await fs.writeFile(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));

  // 10) Durable copy + phone watch link (HLS stream copy, signed segments) — skipped for drafts.
  if (!draft) {
    const part = 45 * 1024 * 1024, parts: string[] = [];
    for (let i = 0; i * part < bytes.length; i++) { const p = `${P}/final/${NAME}.part${String(i).padStart(2, '0')}`; await put(p, bytes.subarray(i * part, (i + 1) * part), 'application/octet-stream'); parts.push(p); }
    await putJson(`${P}/final/manifest.json`, {file: NAME, bytes: bytes.length, sha256: sha(bytes), parts, checks, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID});
    const hls = path.join(work, 'hls'); await fs.mkdir(hls, {recursive: true});
    await run('ffmpeg', ['-y', '-i', final, '-c', 'copy', '-f', 'hls', '-hls_time', '30', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, 'seg%03d.ts'), path.join(hls, 'index.m3u8')]);
    const lines = (await fs.readFile(path.join(hls, 'index.m3u8'), 'utf8')).split('\n'); const signed: string[] = [];
    for (const l of lines) { if (!l.endsWith('.ts')) { signed.push(l); continue; } const p = `${P}/watch/hls/${l}`; await put(p, await fs.readFile(path.join(hls, l)), 'video/mp2t'); signed.push(await sign(p)); }
    await put(`${P}/watch/hls/index.m3u8`, Buffer.from(signed.join('\n')), 'application/vnd.apple.mpegurl');
    const watchUrl = await sign(`${P}/watch/hls/index.m3u8`);
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', watchUrl]).catch(() => '');
    await fs.writeFile(path.join(out, 'watch-link.json'), JSON.stringify({watchUrl, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), parts, anonymousProbe: probe.trim() || 'see ffprobe step'}, null, 2));
  }
  await fs.rm(work, {recursive: true, force: true});
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  log('QC', {draft, passed: failed.length === 0, failed, issues: issues.length, duration, metrics: {spent, genSec, newShare: metrics.newGenerativeShare}});
}

/** Cross-section of the facility "according to the account": seven levels under a mesa. Our own graphic, no data claimed. */
function graphicSvg(variant: string): string {
  const W = 2304, H = 1296, top = 330, lh = 100;
  const levels = Array.from({length: 7}, (_, i) => { const y = top + i * lh; const hot = variant === 'bottom' ? i >= 5 : variant === 'zones' ? i % 2 === 1 : false;
    const fill = hot ? '#7a1f1a' : variant === 'zones' ? ['#26343a', '#2e3f45'][i % 2] : '#26343a';
    return `<rect x="560" y="${y}" width="1180" height="${lh - 18}" fill="${fill}" stroke="#9fb3b8" stroke-width="3"/><text x="520" y="${y + 60}" font-family="DejaVu Sans" font-size="40" fill="#cfd8da" text-anchor="end">LEVEL ${i + 1}</text>`; }).join('');
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0e1214"/>
  <path d="M0 300 L700 300 L820 150 L1480 150 L1600 300 L${W} 300 L${W} ${H} L0 ${H} Z" fill="#1a1f21"/>
  <path d="M0 300 L700 300 L820 150 L1480 150 L1600 300 L${W} 300" stroke="#c9a46a" stroke-width="5" fill="none"/>
  <line x1="1650" y1="300" x2="1650" y2="${top + 7 * lh}" stroke="#9fb3b8" stroke-width="6" stroke-dasharray="18 12"/>${levels}
  <text x="${W / 2}" y="80" font-family="DejaVu Sans" font-size="34" fill="#8a9a9e" text-anchor="middle">ACCORDING TO THE ACCOUNT ATTRIBUTED TO THOMAS CASTELLO · NOT VERIFIED</text></svg>`;
}
