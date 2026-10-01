/** Video #003 render + QA + delivery. Zero paid calls. V3_DRAFT=true renders placeholders for missing
 * picture and silence for missing narration to prove the whole pipeline before any spend.
 * Timeline rule (narration-led): each shot's picture lasts exactly its narrated words (cut at the
 * midpoint between its last word and the next shot's first word) plus its declared pause.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {readAiVideoClipRecord} from '../../src/lib/video/long-form/ai-video-storage';
import {buildContactSheet, frameAt, probeDuration} from '../lib/contact-sheet';
import {buildAss, buildCues, type TitleOverlay} from '../lib/dulce-edit';
import {moveFor, stillMotionFilter, type Move, type WordTiming} from '../lib/dulce-part1-core';
import {CHANNEL, EXPOSURE_CEILING_USD, HARD_CAP_USD, MUSIC, MUSIC_DROPS, ON_SCREEN_NOTICE, RUMBLE_CUES, TITLE} from './plan';
import {FPS, P, type Plan, type Shot, bucket, committedUsd, entries, exposure, listTelemetry, log, out, probe, put, putJson, read, readJsonStore, run, service, sha, sign} from './shared';

const NAME = 'VIDEO-003-The-Lake-That-Held-Its-Breath-master.mp4';
const LEAD_IN = 0.4, SCENE_TAIL = 0.3, END_CARD = 1.5;
const toks = (s: string) => s.split(/\s+/).filter(Boolean);
type Src = {kind: 'clip' | 'stock' | 'photo' | 'still' | 'graphic' | 'placeholder'; file: string; sha256?: string; origin: string; note?: string};
type Slot = Shot & {startFrame: number; frames: number; chunk: {file: string | null; offset: number; seconds: number}; words: WordTiming[]};

export async function render(plan: Plan) {
  const draft = process.env.V3_DRAFT === 'true';
  const work = path.join(out, 'work'); await fs.mkdir(work, {recursive: true});
  const issues: string[] = []; const deviations: string[] = [];

  // 1) Narration per scene (cached ElevenLabs audio with word timings) or draft silence.
  const scenes: {scene: string; file: string | null; seconds: number; words: WordTiming[]}[] = [];
  for (const sc of plan.scenes) {
    const rec = await readJsonStore<{seconds: number; sha256: string; words: WordTiming[]}>(`${P}/narration/${sc}.json`); const mp3 = await read(`${P}/narration/${sc}.mp3`);
    if (rec && mp3) { if (sha(mp3) !== rec.sha256) throw Error('Narration checksum ' + sc); const f = path.join(work, `${sc}.wav`); await fs.writeFile(path.join(work, `${sc}.mp3`), mp3); await run('ffmpeg', ['-y', '-i', path.join(work, `${sc}.mp3`), '-ar', '48000', '-ac', '2', f]); scenes.push({scene: sc, file: f, seconds: rec.seconds, words: rec.words}); }
    else if (draft) { const shots = plan.shots.filter((s) => s.scene === sc && s.purpose !== 'end card'); let t = 0; const ws: WordTiming[] = []; for (const s of shots) for (const w of toks(s.narration)) { ws.push({text: w, startSeconds: t, endSeconds: t + 0.36}); t += 0.4; } scenes.push({scene: sc, file: null, seconds: t, words: ws}); issues.push(`draft: narration ${sc} missing (synthetic timings)`); }
    else throw Error('Narration missing for ' + sc);
  }

  // 2) Narration-led timeline: shots get their words; cuts at word-gap midpoints; declared pauses added.
  const slots: Slot[] = []; let cursor = Math.round(LEAD_IN * FPS);
  for (const sc of scenes) {
    const shots = plan.shots.filter((s) => s.scene === sc.scene && s.purpose !== 'end card'); let wi = 0;
    const spans = shots.map((s) => { const n = toks(s.narration).length; const ws = sc.words.slice(wi, wi + n); wi += n; return {s, ws}; });
    if (wi !== sc.words.length) throw Error(`Scene ${sc.scene}: ${sc.words.length} narration words vs ${wi} storyboard words`);
    let chunkStart = 0;
    for (const [i, {s, ws}] of spans.entries()) {
      const nextFirst = spans[i + 1]?.ws[0]?.startSeconds; const lastEnd = ws.at(-1)?.endSeconds ?? chunkStart;
      const chunkEnd = nextFirst !== undefined ? (lastEnd + nextFirst) / 2 : Math.max(lastEnd + SCENE_TAIL, sc.seconds);
      const audioSeconds = chunkEnd - chunkStart; const frames = Math.max(Math.round(2.0 * FPS), Math.round((audioSeconds + s.pause) * FPS));
      slots.push({...s, startFrame: cursor, frames, chunk: {file: sc.file, offset: chunkStart, seconds: audioSeconds}, words: ws.map((w) => ({text: w.text, startSeconds: w.startSeconds - chunkStart + cursor / FPS, endSeconds: w.endSeconds - chunkStart + cursor / FPS}))});
      if (Math.abs(frames / FPS - s.seconds) > Math.max(2, s.seconds * 0.35)) deviations.push(`${s.id} ${s.purpose}: ${(frames / FPS).toFixed(2)} s vs frozen ${s.seconds} s`);
      cursor += frames; chunkStart = chunkEnd;
    }
  }
  const endCard = plan.shots.find((s) => s.purpose === 'end card')!; slots.push({...endCard, startFrame: cursor, frames: Math.round(END_CARD * FPS), chunk: {file: null, offset: 0, seconds: 0}, words: []}); cursor += Math.round(END_CARD * FPS);
  const total = cursor / FPS; const words = slots.flatMap((s) => s.words);
  log('TIMELINE', {slots: slots.length, seconds: total, narrated: scenes.reduce((a, s) => a + s.seconds, 0), deviations: deviations.length});

  // 3) Sources.
  const cache = new Map<string, Src>();
  const placeholder = async (s: Shot): Promise<Src> => { if (!draft) throw Error('No source for ' + s.id); const sharp = (await import('sharp')).default; const f = path.join(work, `ph-${s.id}.png`); await sharp({create: {width: 1920, height: 1080, channels: 3, background: '#243036'}}).composite([{input: Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><text x="960" y="520" font-family="DejaVu Sans" font-size="60" fill="#dfe6e8" text-anchor="middle">${s.id} · ${s.kind}</text><text x="960" y="600" font-family="DejaVu Sans" font-size="36" fill="#9fb3b8" text-anchor="middle">${s.visual.replace(/[<>&]/g, '').slice(0, 90)}</text></svg>`), top: 0, left: 0}]).png().toFile(f); issues.push(`draft placeholder ${s.id}`); return {kind: 'placeholder', file: f, origin: 'placeholder'}; };
  const approvedStill = async (id: string) => { const b = await read(`${P}/stills/${id}-v1.png`); const rv = await readJsonStore<{sha256: string; result: string}>(`${P}/reviews/still-${id}.json`); return b && rv && rv.result === 'PASS' && rv.sha256 === sha(b) ? b : null; };
  async function resolve(s: Shot): Promise<Src> {
    if (cache.has(s.id)) return cache.get(s.id)!;
    let src: Src | null = null;
    if (s.kind === 'graphic') { const b = await read(`${P}/graphics/${s.id}.png`); if (b) { const f = path.join(work, `g-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'graphic', file: f, sha256: sha(b), origin: `videos/${P}/graphics/${s.id}.png`}; } }
    else if (s.provider === 'pexels') { const rv = await readJsonStore<{result: string; from?: string; inPoint?: number}>(`${P}/reviews/stock-${s.id}.json`);
      if (rv?.result === 'STILL') { const b = await approvedStill(s.id); if (b) { const f = path.join(work, `still-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'still', file: f, sha256: sha(b), origin: `videos/${P}/stills/${s.id}-v1.png`, note: 'stock replaced by an approved still (review verdict STILL)'}; issues.push(`${s.id}: stock replaced by a generated still`); } }
      else if (rv?.result === 'REUSE' && rv.from) { const rec = await readJsonStore<{file: string; sha256: string; sourceId: string}>(`${P}/stock/${rv.from}.json`); const b = rec ? await read(rec.file) : null; if (rec && b) { const f = path.join(work, `st-${s.id}.mp4`); await fs.writeFile(f, b); src = {kind: 'stock', file: f, sha256: sha(b), origin: `${rec.sourceId} (reused from ${rv.from} @${rv.inPoint ?? 0}s)`, note: String(rv.inPoint ?? 0)}; issues.push(`${s.id}: reuses ${rv.from}'s clip at ${rv.inPoint ?? 0}s`); } }
      else { const rec = await readJsonStore<{file: string; kind: 'video' | 'photo'; sha256: string; sourceId: string}>(`${P}/stock/${s.id}.json`); if (rec && (!rv || rv.result === 'PASS' || rv.result === 'PENDING')) { const b = await read(rec.file); if (b) { const f = path.join(work, `st-${s.id}.${rec.kind === 'photo' ? 'jpg' : 'mp4'}`); await fs.writeFile(f, b); src = {kind: rec.kind === 'photo' ? 'photo' : 'stock', file: f, sha256: sha(b), origin: rec.sourceId}; } } if (!src && rv?.result === 'FAIL') issues.push(`${s.id}: stock rejected in review, no replacement`); } }
    else {
      if (s.generative) { const rec = await readAiVideoClipRecord(service, 'videos', P, `${s.id}-v1`); const rv = await readJsonStore<{result: string; sha256: string}>(`${P}/reviews/clip-${s.id}-v1.json`); if (rec?.status === 'COMPLETED' && rec.storagePath && rv?.result === 'PASS' && rv.sha256 === rec.checksumSha256) { const b = await read(rec.storagePath); if (!b || sha(b) !== rec.checksumSha256) throw Error('Clip checksum ' + s.id); const f = path.join(work, `clip-${s.id}.mp4`); await fs.writeFile(f, b); src = {kind: 'clip', file: f, sha256: sha(b), origin: `videos/${rec.storagePath}`}; } else if (!draft) issues.push(`${s.id}: no approved clip, fell back to approved still + camera motion`); }
      if (!src) { const b = await approvedStill(s.id); if (b) { const f = path.join(work, `still-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'still', file: f, sha256: sha(b), origin: `videos/${P}/stills/${s.id}-v1.png`}; } }
    }
    if (!src) src = await placeholder(s);
    cache.set(s.id, src); return src;
  }

  // 4) Picture segments at exact frame counts.
  const segs: string[] = []; const report: Record<string, unknown>[] = []; let panToggle = 0;
  for (const [i, s] of slots.entries()) {
    const src = await resolve(s); const seg = path.join(work, `seg-${String(i).padStart(3, '0')}.mp4`); const edit = s.frames / FPS;
    let args: string[]; let inPoint = 0, speed = 1, frozen = 0, move: Move | 'push-in-soft' | 'cut' = 'cut';
    const tail = ',setsar=1,format=yuv420p';
    if (src.kind === 'still' || src.kind === 'graphic' || src.kind === 'placeholder' || src.kind === 'photo') {
      move = src.kind === 'graphic' ? 'push-in-soft' : s.method === 'STILL_PARALLAX' ? (panToggle++ % 2 ? 'pan-left' : 'pan-right') : moveFor(i, s.cls);
      const filter = move === 'push-in-soft' ? `scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,scale=w='trunc(1920*(1+0.05*(0.5-0.5*cos(PI*(n/${Math.max(1, s.frames - 1)}))))/2)*2':h='trunc(1080*(1+0.05*(0.5-0.5*cos(PI*(n/${Math.max(1, s.frames - 1)}))))/2)*2':eval=frame:flags=bicubic,crop=1920:1080` : stillMotionFilter(move, s.frames);
      args = ['-loop', '1', '-framerate', String(FPS), '-i', src.file, '-vf', `${filter},fps=${FPS}${tail}`];
    } else {
      const clipSeconds = await probeDuration(src.file);
      const want = src.kind === 'stock' && src.note && /^[\d.]+$/.test(src.note) ? Number(src.note) : src.kind === 'stock' ? 0.5 : 0.25;
      inPoint = Math.max(0, Math.min(want, clipSeconds - edit - 0.05));
      const window = clipSeconds - inPoint;
      if (window < edit) { speed = Math.min(1.5, edit / window); frozen = Math.max(0, edit - window * speed); if (frozen > 0.05) issues.push(`${s.id}: ${frozen.toFixed(2)} s held beyond the clip`); }
      args = ['-ss', inPoint.toFixed(3), '-i', src.file, '-vf', `setpts=${speed.toFixed(4)}*PTS,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS}${frozen > 0.05 ? `,tpad=stop_mode=clone:stop_duration=${frozen.toFixed(3)}` : ''}${tail}`];
    }
    await run('ffmpeg', ['-y', ...args, '-frames:v', String(s.frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-r', String(FPS), seg]);
    segs.push(seg);
    report.push({slot: i, id: s.id, planShotId: s.planShotId, scene: s.scene, purpose: s.purpose, kind: src.kind, method: s.method, provider: s.provider, start: +(s.startFrame / FPS).toFixed(3), seconds: +edit.toFixed(3), frozenPlanSeconds: s.seconds, pause: s.pause, move, inPoint, speed, frozen, origin: src.origin, sha256: src.sha256 ?? null, generative: s.generative});
  }
  await fs.writeFile(path.join(work, 'concat.txt'), segs.map((f) => `file '${f}'`).join('\n'));
  const picture = path.join(work, 'picture.mp4'); await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'concat.txt'), '-c', 'copy', picture]);

  // 5) Audio: narration chunks at shot starts, licensed music by scene (ducked), rumble cues, -14 LUFS.
  const inputs: string[] = []; const f: string[] = []; let ni = 0;
  for (const s of slots) { if (!s.chunk.file || s.chunk.seconds <= 0) continue; const d = Math.round((s.startFrame / FPS) * 1000); inputs.push('-ss', s.chunk.offset.toFixed(3), '-t', s.chunk.seconds.toFixed(3), '-i', s.chunk.file); f.push(`[${ni}]aresample=48000,aformat=channel_layouts=stereo,adelay=${d}|${d}[n${ni}]`); ni++; }
  if (ni) f.push(`${Array.from({length: ni}, (_, i) => `[n${i}]`).join('')}amix=inputs=${ni}:normalize=0:duration=longest,apad,atrim=0:${total},asplit[voice][key]`); else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total},asplit[voice][key]`);
  const sceneStart = (sc: string) => { const s = slots.find((x) => x.scene === sc); return s ? s.startFrame / FPS : total; };
  const sections = MUSIC.map(([id, from, to]) => [id, Math.max(0, sceneStart(from) - 3), to ? sceneStart(to) + 3 : total] as [string, number, number]);
  const mids: string[] = [];
  for (const [j, [id, s0, s1]] of sections.entries()) {
    const {data, error} = await service.storage.from('music-library').download(id + '.mp3'); if (error || !data) throw Error('Missing licensed music ' + id);
    const mf = path.join(work, id + '.mp3'); await fs.writeFile(mf, Buffer.from(await data.arrayBuffer()));
    const len = s1 - s0; const idx = inputs.filter((x) => x === '-i').length; inputs.push('-stream_loop', '-1', '-i', mf);
    const d = Math.round(s0 * 1000); f.push(`[${idx}]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-20:TP=-2:LRA=7,atrim=0:${len.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=${j ? 3 : 0.5},afade=t=out:st=${Math.max(0, len - (j === sections.length - 1 ? 1.8 : 3)).toFixed(3)}:d=${j === sections.length - 1 ? 1.8 : 3},adelay=${d}|${d}[m${j}]`); mids.push(`[m${j}]`);
  }
  const drops = slots.filter((s) => MUSIC_DROPS[s.id]).map((s) => { const [o, d] = MUSIC_DROPS[s.id]; const a = s.startFrame / FPS + o; return `(1-0.6*between(t,${a.toFixed(2)},${(a + d).toFixed(2)}))`; });
  const dropExpr = drops.length ? `volume='${drops.join('*')}':eval=frame,` : '';
  f.push(`${mids.join('')}amix=inputs=${mids.length}:normalize=0:duration=longest,apad,atrim=0:${total},${dropExpr}volume=0.35[bed]`);
  const rumbles = slots.filter((s) => RUMBLE_CUES[s.id]); const rl: string[] = [];
  for (const [k, s] of rumbles.entries()) { const d = RUMBLE_CUES[s.id]; const at = Math.round((s.startFrame / FPS) * 1000); f.push(`anoisesrc=c=brown:r=48000:d=${d}:s=${7 + k},lowpass=f=90,aformat=channel_layouts=stereo,afade=t=in:d=0.8,afade=t=out:st=${(d - 1.5).toFixed(2)}:d=1.5,volume=0.55,adelay=${at}|${at}[r${k}]`); rl.push(`[r${k}]`); }
  const bedIn = rl.length ? (f.push(`[bed]${rl.join('')}amix=inputs=${rl.length + 1}:normalize=0:duration=longest,apad,atrim=0:${total}[bedr]`), '[bedr]') : '[bed]';
  f.push(`${bedIn}[key]sidechaincompress=threshold=0.03:ratio=3:attack=30:release=500[ducked]`, `[voice]volume=0.95[v]`, `[v][ducked]amix=inputs=2:normalize=0:duration=longest,apad,atrim=0:${total}[mix]`);
  const mix = path.join(work, 'mix.wav'); await run('ffmpeg', ['-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[mix]', '-t', String(total), '-c:a', 'pcm_s16le', mix]);
  const p1 = await run('ffmpeg', ['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']); const ln = JSON.parse(p1.slice(p1.lastIndexOf('{'), p1.lastIndexOf('}') + 1));
  const mastered = path.join(work, 'mastered.wav'); await run('ffmpeg', ['-y', '-i', mix, '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true:print_format=summary`, '-ar', '48000', mastered]);

  // 6) Word-highlight subtitles + on-screen text.
  const at = (purpose: string) => slots.find((s) => s.purpose === purpose);
  const ov: TitleOverlay[] = [];
  const add = (s: Slot | undefined, lines: string[], style: 'Title' | 'Note', from = 0.3, len?: number, corner = false) => { if (!s) { issues.push('overlay slot missing ' + lines[0]); return; } const t0 = s.startFrame / FPS; ov.push({start: t0 + from, end: Math.min(t0 + s.frames / FPS - 0.2, len ? t0 + from + len : t0 + s.frames / FPS - 0.2), lines, style, corner}); };
  add(at('hook: the lake at night'), [ON_SCREEN_NOTICE], 'Note', 0.2, undefined, true);
  add(at('title'), [TITLE.toUpperCase()], 'Title', 0.4);
  add(at('trigger 1'), ['One of several hypotheses · the trigger is not known'], 'Note', 0.2, undefined, true);
  const endSlot = slots.at(-1)!; // the end card graphic already carries the title, channel and credits
  const cues = buildCues(words); const ass = path.join(work, 'v3.ass'); await fs.writeFile(ass, buildAss(cues, ov)); await fs.copyFile(ass, path.join(out, 'video-003-subtitles.ass'));
  const srtT = (s: number) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  await fs.writeFile(path.join(out, 'video-003-en.srt'), cues.map((c, i) => `${i + 1}\n${srtT(c.start)} --> ${srtT(c.end)}\n${c.words.map((w) => w.text).join(' ')}\n`).join('\n'));

  // 7) Encode.
  const final = path.join(out, NAME);
  await run('ffmpeg', ['-y', '-i', picture, '-i', mastered, '-vf', `subtitles=${ass}:fontsdir=/usr/share/fonts/truetype/dejavu,fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 1).toFixed(3)}:d=1`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);

  // 8) Technical QA.
  const pr = await probe(final);
  const det = await run('ffmpeg', ['-i', final, '-vf', 'blackdetect=d=0.5:pix_th=0.04,freezedetect=n=-60dB:d=2.5', '-af', 'silencedetect=n=-45dB:d=1.5,ebur128=peak=true', '-f', 'null', '-']);
  const cardStart = endSlot.startFrame / FPS - 0.7;
  const black = [...det.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([s0]) => s0 > 1 && s0 < cardStart);
  const fz = [...det.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < cardStart);
  const silS = [...det.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < total - 3);
  const summ = det.slice(det.lastIndexOf('Summary:')); const num = (re: RegExp) => Number(re.exec(summ)?.[1]);
  const hookSlots = slots.filter((s) => s.startFrame < 30 * FPS).length;
  const scriptWords = plan.shots.filter((s) => s.purpose !== 'end card').reduce((x, s) => x + toks(s.narration).length, 0);
  const genSlots = report.filter((r) => r.kind === 'clip'); const expectedGen = plan.shots.filter((s) => s.generative).length;
  const checks: Record<string, boolean> = {
    durationNearPlan: Math.abs(pr.duration - total) < 0.5, durationInTarget: pr.duration >= 420 && pr.duration <= 600, resolution1080p: pr.width === 1920 && pr.height === 1080, fps30: pr.fps === '30/1', h264: pr.codec === 'h264',
    audioStereo: pr.channels === 2, noAccidentalBlack: black.length === 0, noFrozenPicture: fz.length === 0, noSilentGaps: silS.length === 0,
    loudnessNear14: Math.abs(num(/I:\s+(-?[\d.]+) LUFS/) + 14) <= 1, truePeakSafe: num(/Peak:\s+(-?[\d.]+) dBFS/) <= -1,
    allSlotsSourced: report.length === slots.length, noPlaceholders: !report.some((r) => r.kind === 'placeholder'),
    subtitlesCoverAllWords: cues.reduce((x, c) => x + c.words.length, 0) === words.length && words.length === scriptWords,
    hookAtLeast8Changes: hookSlots >= 8, noHeldFrames: !report.some((r) => (r.frozen as number) > 0.05), frozenGenerativeSetHonoured: genSlots.length === expectedGen,
  };
  const bytes = await fs.readFile(final);
  const qc = {draft, final: {file: NAME, bytes: bytes.length, sha256: sha(bytes), durationSeconds: pr.duration, width: pr.width, height: pr.height, fps: pr.fps, codec: pr.codec}, loudness: {integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/)}, black, freeze: fz, silences: silS, checks, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k), issues, deviations, timeline: {totalSeconds: total, narratedSeconds: scenes.reduce((a, s) => a + s.seconds, 0), slots: slots.length, hookSlots}};
  await fs.writeFile(path.join(out, 'qc.json'), JSON.stringify(qc, null, 2)); await fs.writeFile(path.join(out, 'timeline.json'), JSON.stringify(report, null, 2));

  // 9) Review sheets.
  const sheet = async (name: string, times: number[], label: (t: number) => string, cols = 5, w = 480) => { const tiles = []; for (const t of times) tiles.push({image: await frameAt(final, Math.min(total - 0.05, Math.max(0, t)), w), label: label(t)}); await fs.writeFile(path.join(out, name), await buildContactSheet(tiles, {columns: cols, tileWidth: w, tileHeight: Math.round(w * 9 / 16), title: name})); };
  const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  await sheet('qa-hook-0-30s.jpg', Array.from({length: 30}, (_, i) => i + 0.5), mmss);
  const every5 = Array.from({length: Math.floor(total / 5)}, (_, i) => i * 5 + 2.5); for (let k = 0; k * 36 < every5.length; k++) await sheet(`qa-every-5s-${k + 1}.jpg`, every5.slice(k * 36, k * 36 + 36), mmss, 6, 384);
  for (const [k, s] of slots.filter((s) => s.generative).entries()) await sheet(`qa-gen-${String(k + 1).padStart(2, '0')}-${s.id}.jpg`, Array.from({length: 8}, (_, j) => s.startFrame / FPS + 0.1 + (s.frames / FPS - 0.2) * j / 7), (t) => `${s.id} ${mmss(t)}`, 4, 480);
  const spoken = (s: Slot) => s.words.map((w) => w.text).join(' ');
  for (let k = 0; k * 24 < slots.length; k++) { const part = slots.slice(k * 24, k * 24 + 24); const tiles = []; for (const s of part) tiles.push({image: await frameAt(final, (s.startFrame + s.frames / 2) / FPS, 384), label: `${s.id} ${s.kind}/${s.method.toLowerCase()} ${(s.frames / FPS).toFixed(1)}s · ${spoken(s).slice(0, 48)}`}); await fs.writeFile(path.join(out, `qa-slots-${k + 1}.jpg`), await buildContactSheet(tiles, {columns: 4, tileWidth: 384, tileHeight: 216, title: `slots ${k * 24 + 1}-${k * 24 + part.length}`})); }

  // 10) Cost metrics + final production manifest.
  const attempts = await listTelemetry(); const led = entries();
  const spent = committedUsd(); const byProvider: Record<string, number> = {}; for (const e of led.filter((x) => x.status === 'committed')) byProvider[e.provider] = (byProvider[e.provider] || 0) + (e.actualUsd ?? e.maxUsd);
  const retries = attempts.filter((a) => a.attemptOrdinal > 1 || a.retryReason); const retryUsd = retries.reduce((a, b) => a + b.costUsd, 0);
  const fallbacks = issues.filter((i) => /fell back|held beyond|rejected/.test(i));
  const genSec = genSlots.reduce((x, r) => x + (r.seconds as number), 0);
  const manifestOut = {
    manifestVersion: 'video-003/production-manifest/1', projectId: P, title: TITLE, channel: CHANNEL, freezeHash: plan.freezeHash, generatedAt: new Date().toISOString(), draft, commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    master: qc.final, qa: {technical: checks, failed: qc.failed, loudness: qc.loudness, issues, deviationsFromFrozenDurations: deviations},
    cost: {expectedUsd: 7.08, worstCaseReservationUsd: 29.44, actualUsd: +spent.toFixed(4), varianceUsd: +(spent - 7.08).toFixed(4), byProvider, exposureUsd: exposure(), ceilingUsd: EXPOSURE_CEILING_USD, hardCapUsd: HARD_CAP_USD, paidOperations: led.filter((e) => e.status !== 'released').length, releasedClaims: led.filter((e) => e.status === 'released').length, retries: {count: retries.length, usd: +retryUsd.toFixed(4)}, providerTopupsAreNotCogs: true},
    mix: {generativeClips: genSlots.length, generativeSeconds: +genSec.toFixed(2), generativeShare: +(genSec / pr.duration).toFixed(3), stillMotionSlots: report.filter((r) => ['still', 'graphic', 'photo'].includes(r.kind as string)).length, stockSlots: report.filter((r) => r.kind === 'stock').length},
    fallbacks, shots: report.map((r) => ({...r, cost: led.filter((e) => e.shotId === r.id && e.status === 'committed').reduce((a, e) => a + (e.actualUsd ?? e.maxUsd), 0), attempts: attempts.filter((a) => a.shotId === r.id).map((a) => ({attemptId: a.attemptId, provider: a.provider, costUsd: a.costUsd, qa: a.qa?.result ?? null}))})),
  };
  await fs.writeFile(path.join(out, 'production-manifest.json'), JSON.stringify(manifestOut, null, 2));

  // 11) Durable copy + phone watch link (skipped for drafts).
  if (!draft) {
    const part = 45 * 1024 * 1024, parts: string[] = [];
    for (let i = 0; i * part < bytes.length; i++) { const p = `${P}/final/${NAME}.part${String(i).padStart(2, '0')}`; await put(p, bytes.subarray(i * part, (i + 1) * part), 'application/octet-stream'); parts.push(p); }
    await putJson(`${P}/final/manifest.json`, {file: NAME, bytes: bytes.length, sha256: sha(bytes), parts, checks, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID});
    await putJson(`${P}/final/production-manifest.json`, manifestOut);
    const hls = path.join(work, 'hls'); await fs.mkdir(hls, {recursive: true});
    await run('ffmpeg', ['-y', '-i', final, '-c', 'copy', '-f', 'hls', '-hls_time', '30', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, 'seg%03d.ts'), path.join(hls, 'index.m3u8')]);
    const lines = (await fs.readFile(path.join(hls, 'index.m3u8'), 'utf8')).split('\n'); const signed: string[] = [];
    for (const l of lines) { if (!l.endsWith('.ts')) { signed.push(l); continue; } const p = `${P}/watch/hls/${l}`; await put(p, await fs.readFile(path.join(hls, l)), 'video/mp2t'); signed.push(await sign(p)); }
    await put(`${P}/watch/hls/index.m3u8`, Buffer.from(signed.join('\n')), 'application/vnd.apple.mpegurl');
    const watchUrl = await sign(`${P}/watch/hls/index.m3u8`);
    const single = bytes.length <= 50 * 1024 * 1024 ? await (async () => { const dest = `${P}/final/${NAME}`; const {error} = await bucket.upload(dest, bytes, {contentType: 'video/mp4', upsert: true}); return error ? null : await sign(dest, 30); })() : null;
    await fs.writeFile(path.join(out, 'watch-link.json'), JSON.stringify({watchUrl, singleMp4Url: single, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), parts}, null, 2));
  }
  await fs.rm(work, {recursive: true, force: true});
  log('QC', {draft, passed: qc.failed.length === 0, failed: qc.failed, issues: issues.length, deviations: deviations.length, duration: pr.duration, spent});
  if (!draft && qc.failed.length) throw Error('Technical QA failed: ' + qc.failed.join(', '));
}
