/** Video #004 render + QA + delivery. Zero paid calls. V4_DRAFT=true renders placeholders for missing
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
import {CHANNEL, EXPECTED_USD, EXPOSURE_CEILING_USD, GRAPHICS, HARD_CAP_USD, MUSIC, MUSIC_DROPS, ON_SCREEN_NOTICE, ON_SCREEN_NOTES, RUMBLE_CUES, TITLE, V2, V2_ANIMATED_STILL_CALLOUTS} from './plan';
import {animatedGraphicSvg, persianKitOverlaySvg, type AnimCtx} from './graphics-anim';
import type {GraphicKind} from './plan';
import {SFX, V2_MUSIC_DROPS, V2_TOTAL_SILENCE, sfxSource} from './sfx';
import {CTA, V3, V2_MASTER_SHA, ctaMarkSvg} from './v3-cta';
import {FPS, P, type Plan, type Shot, stillPath, clipRev, bucket, committedUsd, entries, exposure, listTelemetry, log, out, probe, put, putJson, read, readJsonStore, run, service, sha, sign} from './shared';

const NAME = V3 ? 'VIDEO-004-Three-Days-at-the-Hot-Gates-v3-master.mp4' : V2 ? 'VIDEO-004-Three-Days-at-the-Hot-Gates-v2-master.mp4' : 'VIDEO-004-Three-Days-at-the-Hot-Gates-master.mp4';
const FINAL_DIR = V3 ? 'final-v3' : V2 ? 'final-v2' : 'final', WATCH_DIR = V3 ? 'watch-v3' : V2 ? 'watch-v2' : 'watch', SUB = V3 ? 'video-004-v3' : V2 ? 'video-004-v2' : 'video-004';
const V1_SPENT_USD = 11.3295, V2_SPENT_USD = 16.8295;
const V3_DIR = `${P}/v3`;
/** Native SVG canvas is 2304x1296 at 72 dpi. V2 rendered it at density 96 (3072x1728) and extracted with 2304-based
 * coordinates, so every animated graphic showed only its top-left 75% enlarged 1.33x (RC: 3072/2304 mismatch). V3 renders at 72. */
const SVG_DENSITY = 72;
const SAFE = {x: 96, y: 54, subtitleTop: 880};

/** One animated-graphic frame through the exact pipeline the master uses (drift crop + resize). stripText removes <text> for QA diffs. */
export async function animFrame(kind: GraphicKind, ctx: AnimCtx, i: number, frames: number, stripText = false): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  let svg = await animatedGraphicSvg(kind, ctx); if (stripText) svg = svg.replace(/<text\b[\s\S]*?<\/text>/g, '');
  const z = 1 + 0.03 * (i / Math.max(1, frames - 1)); const cw = Math.round(2304 / z / 2) * 2, ch = Math.round(1296 / z / 2) * 2;
  return sharp(Buffer.from(svg), {density: SVG_DENSITY}).extract({left: Math.round((2304 - cw) / 2), top: Math.round((1296 - ch) / 2), width: cw, height: ch}).resize(1920, 1080).png().toBuffer();
}
/** V4-042 callout frame (still + overlay) or the overlay alone on transparency, same drift crop. */
export async function calloutFrame(base: Buffer | null, ctx: AnimCtx, i: number, frames: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const z = 1 + 0.03 * (i / Math.max(1, frames - 1)); const cw = Math.round(1920 / z / 2) * 2, ch = Math.round(1080 / z / 2) * 2;
  const canvas = base ? sharp(base) : sharp({create: {width: 1920, height: 1080, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}});
  return canvas.composite([{input: Buffer.from(persianKitOverlaySvg(ctx)), top: 0, left: 0}]).extract({left: Math.round((1920 - cw) / 2), top: Math.round((1080 - ch) / 2), width: cw, height: ch}).resize(1920, 1080).png().toBuffer();
}
/** Reassembles the V2 master from its stored parts and hashes it (V2 must stay byte-for-byte intact). */
async function v2MasterHash(): Promise<string> { const man = await readJsonStore<{parts: string[]}>(`${P}/final-v2/manifest.json`); if (!man) throw Error('V2 manifest missing'); const chunks: Buffer[] = []; for (const p of man.parts) { const b = await read(p); if (!b) throw Error('V2 part missing ' + p); chunks.push(b); } return sha(Buffer.concat(chunks)); }

/** V2: render a word-synchronised animated graphic (or still + callouts) as a PNG frame sequence, then encode the segment. */
async function renderAnimatedSegment(s: Slot, srcFile: string | null, seg: string, work: string) {
  const sharp = (await import('sharp')).default;
  const dir = path.join(work, `anim-${s.id}`); await fs.mkdir(dir, {recursive: true});
  const t0 = s.startFrame / FPS; const cues = s.words.map((w) => ({text: w.text, t: w.startSeconds - t0})); const dur = s.frames / FPS; const cacheDir = path.join(out, 'geo-cache');
  const callouts = V2_ANIMATED_STILL_CALLOUTS.includes(s.id) && srcFile;
  const base = callouts ? await sharp(srcFile!).resize(1920, 1080, {fit: 'cover', position: 'centre'}).png().toBuffer() : null;
  let next = 0; const kind = GRAPHICS[s.id];
  await Promise.all(Array.from({length: 6}, async () => { while (next < s.frames) { const i = next++; const ctx: AnimCtx = {t: i / FPS, dur, cues, cacheDir}; const f = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
    // A slow continuous drift (3% push over the slot) keeps the picture alive between word cues and clears the frozen-picture QA.
    const z = 1 + 0.03 * (i / Math.max(1, s.frames - 1));
    void z; await fs.writeFile(f, base ? await calloutFrame(base, ctx, i, s.frames) : await animFrame(kind, ctx, i, s.frames)); } }));
  await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'), '-frames:v', String(s.frames), '-vf', 'setsar=1,format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-r', String(FPS), seg]);
  await fs.rm(dir, {recursive: true, force: true});
}
const LEAD_IN = 0.4, SCENE_TAIL = 0.3, END_CARD = 1.5;
const toks = (s: string) => s.split(/\s+/).filter(Boolean);
type Src = {kind: 'clip' | 'stock' | 'photo' | 'still' | 'graphic' | 'placeholder'; file: string; sha256?: string; origin: string; note?: string};
type Slot = Shot & {startFrame: number; frames: number; chunk: {file: string | null; offset: number; seconds: number}; words: WordTiming[]};

export async function render(plan: Plan) {
  const draft = process.env.V4_DRAFT === 'true';
  const work = path.join(out, 'work'); await fs.mkdir(work, {recursive: true});
  const v2HashBefore = V3 && !draft ? await v2MasterHash() : null; if (v2HashBefore && v2HashBefore !== V2_MASTER_SHA) throw Error('V2 master hash mismatch before the V3 render');
  const issues: string[] = []; const deviations: string[] = [];

  // 1) Narration per scene (cached ElevenLabs audio with word timings) or draft silence.
  const scenes: {scene: string; file: string | null; seconds: number; words: WordTiming[]}[] = [];
  for (const sc of plan.scenes) {
    if (V3) { // V3: patched stems (48 kHz WAV + re-aligned words) replace the V2 narration where they exist; CTA scenes only exist here
      const r3 = await readJsonStore<{seconds: number; sha256: string; words: WordTiming[]}>(`${V3_DIR}/narration/${sc}.json`); const w3 = await read(`${V3_DIR}/narration/${sc}.wav`);
      if (r3 && w3) { if (sha(w3) !== r3.sha256) throw Error('V3 narration checksum ' + sc); const f = path.join(work, `${sc}.wav`); await fs.writeFile(f, w3); scenes.push({scene: sc, file: f, seconds: r3.seconds, words: r3.words}); continue; }
      if (sc.startsWith('CTA')) throw Error('V3 narration missing for ' + sc);
    }
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
  const approvedStill = async (id: string) => { const b = await read(stillPath(id)); const rv = await readJsonStore<{sha256: string; result: string}>(`${P}/reviews/still-${id}.json`); return b && rv && rv.result === 'PASS' && rv.sha256 === sha(b) ? b : null; };
  async function resolve(s: Shot): Promise<Src> {
    if (cache.has(s.id)) return cache.get(s.id)!;
    let src: Src | null = null;
    if (s.method === 'CTA_REUSE') { // V3 CTA: the first approved candidate whose picture can cover the slot without a hold
      const c = CTA.find((x) => x.id === s.id)!; const edit = (slots.find((x) => x.id === s.id)?.frames ?? 7 * FPS) / FPS; let pick: Src | null = null; const tried: string[] = [];
      for (const id of c.candidates) { const base = plan.shots.find((x) => x.id === id); if (!base) continue; const b = await resolve(base); if (b.kind === 'placeholder') continue; const secs = b.kind === 'stock' || b.kind === 'clip' ? await probeDuration(b.file) : 0; tried.push(`${id}:${secs.toFixed(1)}s`); if ((secs - 0.5) * 1.3 >= edit) { pick = {...b, origin: `${b.origin} (reused for ${s.id})`, note: '0.5'}; break; } }
      if (!pick) throw Error(`CTA ${s.id}: no approved candidate long enough (${tried.join(', ')})`);
      cache.set(s.id, pick); return pick;
    }
    if (s.kind === 'graphic') { const b = await read(`${P}/graphics/${s.id}.png`); if (b) { const f = path.join(work, `g-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'graphic', file: f, sha256: sha(b), origin: `videos/${P}/graphics/${s.id}.png`}; } }
    else if (s.provider === 'pexels') { const rv = await readJsonStore<{result: string; from?: string; inPoint?: number}>(`${P}/reviews/stock-${s.id}.json`);
      if (rv?.result === 'STILL') { const b = await approvedStill(s.id); if (b) { const f = path.join(work, `still-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'still', file: f, sha256: sha(b), origin: `videos/${stillPath(s.id)}`, note: 'stock replaced by an approved still (review verdict STILL)'}; issues.push(`${s.id}: stock replaced by a generated still`); } }
      else if (rv?.result === 'REUSE' && rv.from) { const rec = await readJsonStore<{file: string; sha256: string; sourceId: string}>(`${P}/stock/${rv.from}.json`); const b = rec ? await read(rec.file) : null; if (rec && b) { const f = path.join(work, `st-${s.id}.mp4`); await fs.writeFile(f, b); src = {kind: 'stock', file: f, sha256: sha(b), origin: `${rec.sourceId} (reused from ${rv.from} @${rv.inPoint ?? 0}s)`, note: String(rv.inPoint ?? 0)}; issues.push(`${s.id}: reuses ${rv.from}'s clip at ${rv.inPoint ?? 0}s`); } }
      else { const rec = await readJsonStore<{file: string; kind: 'video' | 'photo'; sha256: string; sourceId: string}>(`${P}/stock/${s.id}.json`); if (rec && (!rv || rv.result === 'PASS' || rv.result === 'PENDING')) { const b = await read(rec.file); if (b) { const f = path.join(work, `st-${s.id}.${rec.kind === 'photo' ? 'jpg' : 'mp4'}`); await fs.writeFile(f, b); src = {kind: rec.kind === 'photo' ? 'photo' : 'stock', file: f, sha256: sha(b), origin: rec.sourceId}; } } if (!src && rv?.result === 'FAIL') issues.push(`${s.id}: stock rejected in review, no replacement`); } }
    else {
      if (s.generative) { const rec = await readAiVideoClipRecord(service, 'videos', P, `${s.id}-${clipRev(s.id)}`); const rv = await readJsonStore<{result: string; sha256: string}>(`${P}/reviews/clip-${s.id}-${clipRev(s.id)}.json`); if (rec?.status === 'COMPLETED' && rec.storagePath && rv?.result === 'PASS' && rv.sha256 === rec.checksumSha256) { const b = await read(rec.storagePath); if (!b || sha(b) !== rec.checksumSha256) throw Error('Clip checksum ' + s.id); const f = path.join(work, `clip-${s.id}.mp4`); await fs.writeFile(f, b); src = {kind: 'clip', file: f, sha256: sha(b), origin: `videos/${rec.storagePath}`}; } else if (!draft) issues.push(`${s.id}: no approved clip, fell back to approved still + camera motion`); }
      if (!src) { const b = await approvedStill(s.id); if (b) { const f = path.join(work, `still-${s.id}.png`); await fs.writeFile(f, b); src = {kind: 'still', file: f, sha256: sha(b), origin: `videos/${stillPath(s.id)}`}; } }
    }
    if (!src) src = await placeholder(s);
    cache.set(s.id, src); return src;
  }

  // 4) Picture segments at exact frame counts (skipped in bed-only diagnostics).
  const bedOnly = process.env.V4_BED_ONLY === 'true';
  const segs: string[] = []; const report: Record<string, unknown>[] = []; let panToggle = 0;
  for (const [i, s] of slots.entries()) {
    if (bedOnly) break;
    const src = await resolve(s); const seg = path.join(work, `seg-${String(i).padStart(3, '0')}.mp4`); const edit = s.frames / FPS;
    let args: string[]; let inPoint = 0, speed = 1, frozen = 0, move: Move | 'push-in-soft' | 'cut' | 'animated' = 'cut';
    const animated = V2 && src.kind !== 'placeholder' && (s.kind === 'graphic' || (V2_ANIMATED_STILL_CALLOUTS.includes(s.id) && src.kind === 'still'));
    if (animated) {
      await renderAnimatedSegment(s, src.kind === 'still' ? src.file : null, seg, work); move = 'animated'; segs.push(seg);
      report.push({slot: i, id: s.id, planShotId: s.planShotId, scene: s.scene, purpose: s.purpose, kind: 'animated', method: s.method, provider: s.provider, start: +(s.startFrame / FPS).toFixed(3), seconds: +edit.toFixed(3), frozenPlanSeconds: s.seconds, pause: s.pause, move, inPoint: 0, speed: 1, frozen: 0, origin: src.origin, sha256: src.sha256 ?? null, generative: s.generative, motion: true});
      continue;
    }
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
      if (s.method === 'CTA_REUSE') { // V3: subscribe mark fades in over the continuing picture (no black, no stop)
        const c = CTA.find((x) => x.id === s.id)!; const mark = path.join(work, `mark-${s.id}.png`); const sharp = (await import('sharp')).default; await sharp(Buffer.from(ctaMarkSvg(c)), {density: 72}).png().toFile(mark);
        args = ['-ss', inPoint.toFixed(3), '-i', src.file, '-loop', '1', '-framerate', String(FPS), '-i', mark, '-filter_complex', `[0:v]setpts=${speed.toFixed(4)}*PTS,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS}${frozen > 0.05 ? `,tpad=stop_mode=clone:stop_duration=${frozen.toFixed(3)}` : ''}[b];[1:v]format=rgba,fade=t=in:st=1.0:d=0.8:alpha=1[m];[b][m]overlay=0:0:shortest=1:format=auto,setsar=1,format=yuv420p[v]`, '-map', '[v]'];
      }
    }
    await run('ffmpeg', ['-y', ...args, '-frames:v', String(s.frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-r', String(FPS), seg]);
    segs.push(seg);
    report.push({slot: i, id: s.id, planShotId: s.planShotId, scene: s.scene, purpose: s.purpose, kind: s.method === 'CTA_REUSE' ? 'cta' : src.kind, method: s.method, provider: s.provider, start: +(s.startFrame / FPS).toFixed(3), seconds: +edit.toFixed(3), frozenPlanSeconds: s.seconds, pause: s.pause, move, inPoint, speed, frozen, origin: src.origin, sha256: src.sha256 ?? null, generative: s.generative, motion: src.kind === 'clip' || src.kind === 'stock'});
  }
  const picture = path.join(work, 'picture.mp4');
  if (!bedOnly) { await fs.writeFile(path.join(work, 'concat.txt'), segs.map((f) => `file '${f}'`).join('\n')); await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'concat.txt'), '-c', 'copy', picture]); }

  // 5) Audio: narration chunks at shot starts, licensed music by scene (ducked), rumble cues, -14 LUFS.
  const inputs: string[] = []; const f: string[] = []; let ni = 0;
  for (const s of slots) { if (!s.chunk.file || s.chunk.seconds <= 0) continue; const d = Math.round((s.startFrame / FPS) * 1000); inputs.push('-ss', s.chunk.offset.toFixed(3), '-t', s.chunk.seconds.toFixed(3), '-i', s.chunk.file); f.push(`[${ni}]aresample=48000,aformat=channel_layouts=stereo,adelay=${d}|${d}[n${ni}]`); ni++; }
  if (ni) f.push(`${Array.from({length: ni}, (_, i) => `[n${i}]`).join('')}amix=inputs=${ni}:normalize=0:duration=longest,apad,atrim=0:${total},asplit[voice][key]`); else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total},asplit[voice][key]`);
  const sceneStart = (sc: string) => { const s = slots.find((x) => x.scene === sc); return s ? s.startFrame / FPS : total; };
  const sections = MUSIC.map(([id, from, to]) => [id, Math.max(0, sceneStart(from) - 4), to ? sceneStart(to) + 4 : total] as [string, number, number]);
  const mids: string[] = [];
  for (const [j, [id, s0, s1]] of sections.entries()) {
    const {data, error} = await service.storage.from('music-library').download(id + '.mp3'); if (error || !data) throw Error('Missing licensed music ' + id);
    const mf = path.join(work, id + '.mp3'); await fs.writeFile(mf, Buffer.from(await data.arrayBuffer()));
    // Library tracks have quiet intros/outros: trim them, then crossfade copies into a seamless loop (as DULCE Part I did).
    const tr = path.join(work, id + '.wav'); await run('ffmpeg', ['-y', '-i', mf, '-af', 'aresample=48000,aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse', tr]);
    const trackSeconds = await probeDuration(tr); const len = s1 - s0; const copies = Math.ceil(len / Math.max(10, trackSeconds - 3)) + 1; const first = inputs.filter((x) => x === '-i').length;
    for (let k = 0; k < copies; k++) inputs.push('-i', tr);
    let chain = `[${first}]`; for (let k = 1; k < copies; k++) { f.push(`${chain}[${first + k}]acrossfade=d=3:c1=tri:c2=tri[m${j}x${k}]`); chain = `[m${j}x${k}]`; }
    const d = Math.round(s0 * 1000); f.push(`${chain}dynaudnorm=f=400:g=11:p=0.9:m=12:s=8,atrim=0:${len.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=${j ? 4 : 0.4}:curve=qsin,afade=t=out:st=${Math.max(0, len - (j === sections.length - 1 ? 1.2 : 4)).toFixed(3)}:d=${j === sections.length - 1 ? 1.2 : 4}:curve=qsin,adelay=${d}|${d}[m${j}]`); mids.push(`[m${j}]`);
    log('MUSIC', {id, trackSeconds: +trackSeconds.toFixed(1), copies, from: +s0.toFixed(1), to: +s1.toFixed(1)});
  }
  const drops = V2
    ? slots.filter((s) => V2_MUSIC_DROPS[s.id]).flatMap((s) => V2_MUSIC_DROPS[s.id].map(([o, d, depth]) => { const a = s.startFrame / FPS + o; return `(1-${depth}*between(t,${a.toFixed(2)},${(a + d).toFixed(2)}))`; }))
    : slots.filter((s) => MUSIC_DROPS[s.id]).map((s) => { const [o, d] = MUSIC_DROPS[s.id]; const a = s.startFrame / FPS + o; return `(1-0.5*between(t,${a.toFixed(2)},${(a + d).toFixed(2)}))`; });
  const dropExpr = drops.length ? `volume='${drops.join('*')}':eval=frame,` : '';
  f.push(`${mids.join('')}amix=inputs=${mids.length}:normalize=0:duration=longest,apad,atrim=0:${total},${dropExpr}volume=0.30[bed]`);
  const rumbles = slots.filter((s) => RUMBLE_CUES[s.id]); const rl: string[] = [];
  for (const [k, s] of rumbles.entries()) { const d = RUMBLE_CUES[s.id]; const at = Math.round((s.startFrame / FPS) * 1000); f.push(`anoisesrc=c=brown:r=48000:d=${d}:s=${7 + k},lowpass=f=90,aformat=channel_layouts=stereo,afade=t=in:d=0.8,afade=t=out:st=${(d - 1.5).toFixed(2)}:d=1.5,volume=0.55,adelay=${at}|${at}[r${k}]`); rl.push(`[r${k}]`); }
  let bedIn = rl.length ? (f.push(`[bed]${rl.join('')}amix=inputs=${rl.length + 1}:normalize=0:duration=longest,apad,atrim=0:${total}[bedr]`), '[bedr]') : '[bed]';
  // V2 sound design: procedural SFX cues on the timeline, silenced on total-silence beats, mixed into the ducked stem.
  let sfxCount = 0;
  if (V2) {
    const sx: string[] = []; let seed = 1;
    for (const s of slots) for (const c of SFX[s.id] || []) { const slotSec = s.frames / FPS; if (c.at >= slotSec + 0.5) continue; const d = Math.min(c.dur, slotSec - c.at + 2); if (d <= 0.2) continue; const at = Math.round((s.startFrame / FPS + c.at) * 1000); f.push(`${sfxSource(c.kind, d, seed++)},aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,afade=t=in:d=${Math.min(0.4, d / 4).toFixed(2)},afade=t=out:st=${Math.max(0, d - Math.min(1.0, d / 3)).toFixed(2)}:d=${Math.min(1.0, d / 3).toFixed(2)},volume=${c.gain},adelay=${at}|${at}[x${sfxCount}]`); sx.push(`[x${sfxCount}]`); sfxCount++; }
    if (sx.length) {
      const silence = slots.filter((s) => V2_TOTAL_SILENCE[s.id]).map((s) => { const [o, d] = V2_TOTAL_SILENCE[s.id]; const a = s.startFrame / FPS + o; return `(1-between(t,${a.toFixed(2)},${(a + d).toFixed(2)}))`; });
      f.push(`${sx.join('')}amix=inputs=${sx.length}:normalize=0:duration=longest,apad,atrim=0:${total},${silence.length ? `volume='${silence.join('*')}':eval=frame,` : ''}alimiter=limit=0.5:level=false,volume=0.85[sfx]`);
      f.push(`${bedIn}[sfx]amix=inputs=2:normalize=0:duration=longest,apad,atrim=0:${total}[bedsfx]`); bedIn = '[bedsfx]';
    }
  }
  f.push(`${bedIn}[key]sidechaincompress=threshold=0.03:ratio=3:attack=30:release=500[ducked]`, `[voice]volume=0.95[v]`, `[v][ducked]amix=inputs=2:normalize=0:duration=longest,apad,atrim=0:${total}[mix]`);
  const mix = path.join(work, 'mix.wav');
  if (bedOnly) {
    // Export the UNducked bed stem and analyse it for silences below -45 dB lasting 1.5 s.
    const bedWav = path.join(out, 'bed.wav');
    const graph = f.join(';').replace(`${bedIn}[key]sidechaincompress`, `${bedIn}asplit[bedX][bedY];[bedX]anull[bedout];[bedY][key]sidechaincompress`);
    await run('ffmpeg', ['-y', ...inputs, '-filter_complex', graph, '-map', '[bedout]', '-t', String(total), '-c:a', 'pcm_s16le', bedWav, '-map', '[mix]', '-t', String(total), '-c:a', 'pcm_s16le', path.join(out, 'mix-diag.wav')]);
    const det = await run('ffmpeg', ['-i', bedWav, '-af', 'silencedetect=n=-45dB:d=1.5', '-f', 'null', '-']);
    const sil = [...det.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const stats = await run('ffmpeg', ['-i', bedWav, '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
    const rms = [...stats.matchAll(/RMS_level=(-?[\d.]+)/g)].map((m) => Number(m[1])).filter((v) => Number.isFinite(v));
    const quiet = [...new Set(rms.map((v, i) => [Math.round(i * 1024 / 48000), v] as [number, number]).filter(([, v]) => v < -45).map(([t]) => t))];
    const sorted = [...rms].sort((a, b) => a - b);
    await fs.writeFile(path.join(out, 'bed-analysis.json'), JSON.stringify({sections, silences: sil, quietSeconds: quiet, rmsMin: sorted[0], rmsP05: sorted[Math.floor(sorted.length * 0.05)], rmsMedian: sorted[Math.floor(sorted.length / 2)]}, null, 2));
    log('BED', {silences: sil, quietSeconds: quiet.slice(0, 60), rmsMin: sorted[0], rmsP05: sorted[Math.floor(sorted.length * 0.05)], rmsMedian: sorted[Math.floor(sorted.length / 2)]});
    return;
  }
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[mix]', '-t', String(total), '-c:a', 'pcm_s16le', mix]);
  const p1 = await run('ffmpeg', ['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']); const ln = JSON.parse(p1.slice(p1.lastIndexOf('{'), p1.lastIndexOf('}') + 1));
  const mastered = path.join(work, 'mastered.wav'); await run('ffmpeg', ['-y', '-i', mix, '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true:print_format=summary`, '-ar', '48000', mastered]);

  // 6) Word-highlight subtitles + on-screen text.
  const at = (purpose: string) => slots.find((s) => s.purpose === purpose);
  const ov: TitleOverlay[] = [];
  const add = (s: Slot | undefined, lines: string[], style: 'Title' | 'Note', from = 0.3, len?: number, corner = false) => { if (!s) { issues.push('overlay slot missing ' + lines[0]); return; } const t0 = s.startFrame / FPS; ov.push({start: t0 + from, end: Math.min(t0 + s.frames / FPS - 0.2, len ? t0 + from + len : t0 + s.frames / FPS - 0.2), lines, style, corner}); };
  if (V2) { add(at('hook: this is Thermopylae'), [ON_SCREEN_NOTICE], 'Note', 1.2, undefined, true); add(at('hook: this is Thermopylae'), [TITLE.toUpperCase()], 'Title', 0.3); }
  else { add(at('hook: late summer'), [ON_SCREEN_NOTICE], 'Note', 0.2, undefined, true); add(at('hook: this is Thermopylae'), [TITLE.toUpperCase()], 'Title', 0.3); }
  for (const [purpose, line] of Object.entries(ON_SCREEN_NOTES)) add(at(purpose), [line], 'Note', 0.2, undefined, true);
  const endSlot = slots.at(-1)!; // the end card graphic already carries the title, channel and credits
  const cues = buildCues(words); const ass = path.join(work, 'v4.ass');
  let assText = buildAss(cues, ov);
  if (V2) assText = assText.split('\n').map((l) => (l.includes(',Title,,') ? l.replace('{\\fad(500,600)', '{\\fad(500,600)\\fsp46\\t(0,1400,\\fsp14)') : l)).join('\n'); // animated title: letters track in
  await fs.writeFile(ass, assText); await fs.copyFile(ass, path.join(out, `${SUB}-subtitles.ass`));
  const srtT = (s: number) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  await fs.writeFile(path.join(out, `${SUB}-en.srt`), cues.map((c, i) => `${i + 1}\n${srtT(c.start)} --> ${srtT(c.end)}\n${c.words.map((w) => w.text).join(' ')}\n`).join('\n'));

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
  // A generative shot whose clip failed review falls back to its approved still (documented in reviews.json); it counts as honoured only when that verdict exists.
  let documentedFallbacks = 0; for (const s of plan.shots.filter((x) => x.generative)) { const rv = await readJsonStore<{result: string}>(`${P}/reviews/clip-${s.id}-${clipRev(s.id)}.json`); if (rv?.result === 'FAIL') documentedFallbacks++; }
  // V3 QA on the COMPOSED frame (not the SVG source): every animated graphic's last frame vs the same frame re-rendered
  // through the pipeline, text bbox from a with/without-<text> diff, safe area 96/54, subtitle band, 17-graphic geometry contract.
  type GQA = {id: string; kind: string; textBox: number[] | null; safeArea: boolean; clearOfSubtitles: boolean; composedMatch: boolean; meanDiff: number; hasSubtitles: boolean};
  const gqa: GQA[] = []; const gTiles: {image: Buffer; label: string}[] = [];
  if (V3 && !bedOnly) {
    const sharp = (await import('sharp')).default; const cacheDir = path.join(out, 'geo-cache');
    const raw = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    // The safe-area overlay is pre-rendered to PNG: sharp refuses to composite an SVG buffer of equal size ("must have same dimensions or smaller").
    const safeRect = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect x="${SAFE.x}" y="${SAFE.y}" width="${1920 - 2 * SAFE.x}" height="${1080 - 2 * SAFE.y}" fill="none" stroke="#00e0ff" stroke-width="4"/><line x1="0" y1="${SAFE.subtitleTop}" x2="1920" y2="${SAFE.subtitleTop}" stroke="#ff4040" stroke-width="3" stroke-dasharray="18 12"/></svg>`)).png().toBuffer();
    for (const s of slots) {
      const isGraphic = s.kind === 'graphic' && GRAPHICS[s.id]; const isCallout = V2_ANIMATED_STILL_CALLOUTS.includes(s.id);
      if (!isGraphic && !isCallout) continue;
      const i = s.frames - 1; const t0 = s.startFrame / FPS; const ctx: AnimCtx = {t: i / FPS, dur: s.frames / FPS, cues: s.words.map((w) => ({text: w.text, t: w.startSeconds - t0})), cacheDir};
      let withText: Buffer, noText: Buffer;
      if (isGraphic) { withText = await animFrame(GRAPHICS[s.id], ctx, i, s.frames); noText = await animFrame(GRAPHICS[s.id], ctx, i, s.frames, true); }
      else { const src = await resolve(s); const base = await sharp(src.file).resize(1920, 1080, {fit: 'cover', position: 'centre'}).png().toBuffer(); withText = await calloutFrame(base, ctx, i, s.frames); noText = await sharp(base).extract({left: Math.round((1920 - Math.round(1920 / (1 + 0.03) / 2) * 2) / 2), top: 0, width: 2, height: 2}).png().toBuffer(); }
      // text / overlay ink bbox
      let box: number[] | null = null;
      if (isGraphic) { const a = await raw(withText), b = await raw(noText); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) { const k = (y * 1920 + x) * 4; const d = Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) + Math.abs(a.data[k + 2] - b.data[k + 2]); if (d > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } if (x1 >= 0) box = [x0, y0, x1, y1]; }
      else { const ov = await raw(await calloutFrame(null, ctx, i, s.frames)); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) { if (ov.data[(y * 1920 + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } if (x1 >= 0) box = [x0, y0, x1, y1]; }
      // composed frame from the master at the same instant
      const tEnd = Math.min(pr.duration - 0.1, (s.startFrame + i + 0.5) / FPS); const fr = path.join(work, `gqa-${s.id}.png`); /* clamped: the end card's last frame sits at the encoded end */ await run('ffmpeg', ['-y', '-ss', tEnd.toFixed(4), '-i', final, '-frames:v', '1', fr]);
      const F = await raw(await fs.readFile(fr)), Rr = await raw(withText); let acc = 0, n = 0; for (let y = 0; y < SAFE.subtitleTop; y += 2) for (let x = 0; x < 1920; x += 2) { const k = (y * 1920 + x) * 4; acc += Math.abs(F.data[k] - Rr.data[k]) + Math.abs(F.data[k + 1] - Rr.data[k + 1]) + Math.abs(F.data[k + 2] - Rr.data[k + 2]); n += 3; } const meanDiff = acc / n;
      const hasSubtitles = s.words.length > 0;
      const safeArea = !box || (box[0] >= SAFE.x && box[2] <= 1920 - SAFE.x && box[1] >= SAFE.y && box[3] <= 1080 - SAFE.y);
      const clearOfSubtitles = !box || !hasSubtitles || box[3] < SAFE.subtitleTop;
      gqa.push({id: s.id, kind: isGraphic ? GRAPHICS[s.id] : 'still-callouts', textBox: box, safeArea, clearOfSubtitles, composedMatch: meanDiff < 14, meanDiff: +meanDiff.toFixed(2), hasSubtitles});
      for (const q of [0.25, 0.5, 0.75, 1]) { const t = Math.min(pr.duration - 0.1, (s.startFrame + Math.max(0, Math.round(q * s.frames) - 1) + 0.5) / FPS); const tf = path.join(work, `gqa-${s.id}-${q}.png`); await run('ffmpeg', ['-y', '-ss', t.toFixed(4), '-i', final, '-frames:v', '1', tf]); const composed = await sharp(await fs.readFile(tf)).composite([{input: safeRect, top: 0, left: 0}]).png().toBuffer(); /* sharp resizes before compositing inside one pipeline, so overlay first, then shrink */ gTiles.push({image: await sharp(composed).resize(480).jpeg({quality: 82}).toBuffer(), label: `${s.id} ${Math.round(q * 100)}%${box ? ` text ${box.join(',')}` : ''}`}); }
    }
    for (let k = 0; k * 24 < gTiles.length; k++) await fs.writeFile(path.join(out, `qa-graphics-safe-area-${k + 1}.jpg`), await buildContactSheet(gTiles.slice(k * 24, k * 24 + 24), {columns: 4, tileWidth: 480, tileHeight: 270, title: `V3 animated graphics on the composed master, safe area 96/54 (cyan), subtitle band (red)`}));
  }
  const ctaSlots = slots.filter((s) => s.method === 'CTA_REUSE');
  const v3checks: Record<string, boolean> = V3 ? {
    graphicsCount17: gqa.length === 17, graphicsSafeArea: gqa.every((g) => g.safeArea), graphicsClearOfSubtitles: gqa.every((g) => g.clearOfSubtitles), graphicsComposedFrameMatch: gqa.every((g) => g.composedMatch),
    ctaScenesPresent: ctaSlots.length === 2 && ctaSlots.every((s) => s.words.length > 0), ctaAfterEndCardsBeforeEndCard: ctaSlots.length === 2 && slots.indexOf(ctaSlots[1]) === slots.length - 2 && slots[slots.indexOf(ctaSlots[1]) - 1].purpose === 'still in it',
  } : {};
  const checks: Record<string, boolean> = {
    ...v3checks,
    durationNearPlan: Math.abs(pr.duration - total) < 0.5, durationInTarget: pr.duration >= 600 && pr.duration <= 800, resolution1080p: pr.width === 1920 && pr.height === 1080, fps30: pr.fps === '30/1', h264: pr.codec === 'h264',
    audioStereo: pr.channels === 2, noAccidentalBlack: black.length === 0, noFrozenPicture: fz.length === 0, noSilentGaps: silS.length === 0,
    loudnessNear14: Math.abs(num(/I:\s+(-?[\d.]+) LUFS/) + 14) <= 1, truePeakSafe: num(/Peak:\s+(-?[\d.]+) dBFS/) <= -1,
    allSlotsSourced: report.length === slots.length, noPlaceholders: !report.some((r) => r.kind === 'placeholder'),
    subtitlesCoverAllWords: cues.reduce((x, c) => x + c.words.length, 0) === words.length && words.length === scriptWords,
    hookAtLeast8Changes: hookSlots >= 8, noHeldFrames: !report.some((r) => (r.frozen as number) > 0.05), frozenGenerativeSetHonoured: genSlots.length + documentedFallbacks === expectedGen,
  };
  // V2 special QA: significant motion (AI clip, stock, animated graphic), first minute, still runs.
  const motionSec = report.filter((r) => r.motion).reduce((x, r) => x + (r.seconds as number), 0);
  const first60 = report.reduce((x, r) => { const st = r.start as number, sec = r.seconds as number; return st < 60 && r.motion ? x + Math.min(sec, 60 - st) : x; }, 0);
  const stillRuns: {ids: string[]; seconds: number}[] = []; let cur: {ids: string[]; seconds: number} | null = null;
  for (const r of report) { if (!r.motion && r.id !== endSlot.id) { if (!cur) cur = {ids: [], seconds: 0}; cur.ids.push(r.id as string); cur.seconds += r.seconds as number; } else if (cur) { stillRuns.push(cur); cur = null; } } if (cur) stillRuns.push(cur);
  const longestStill = report.filter((r) => !r.motion && r.id !== endSlot.id).reduce<{id: string; seconds: number}>((a, r) => ((r.seconds as number) > a.seconds ? {id: r.id as string, seconds: r.seconds as number} : a), {id: '', seconds: 0});
  const v2qa = {motionSeconds: +motionSec.toFixed(1), motionShare: +(motionSec / total).toFixed(3), first60MotionSeconds: +first60.toFixed(1), longestStill, stillChains: stillRuns.filter((x) => x.ids.length >= 2).map((x) => ({...x, seconds: +x.seconds.toFixed(1)})), longestStillChainSeconds: +Math.max(0, ...stillRuns.map((x) => x.seconds)).toFixed(1), sfxCues: sfxCount, animatedGraphics: report.filter((r) => r.kind === 'animated').length};
  const bytes = await fs.readFile(final);
  const v2HashAfter = V3 && !draft ? await v2MasterHash() : null;
  const v3info = V3 ? {graphics: gqa, cta: ctaSlots.map((s) => ({id: s.id, scene: s.scene, start: +(s.startFrame / FPS).toFixed(3), seconds: +(s.frames / FPS).toFixed(3), line: s.narration})), v2Master: {expected: V2_MASTER_SHA, before: v2HashBefore, after: v2HashAfter, intact: v2HashBefore === V2_MASTER_SHA && v2HashAfter === V2_MASTER_SHA}, svgDensity: SVG_DENSITY, safeArea: SAFE} : undefined;
  if (V3 && !draft && !(v3info!.v2Master.intact)) throw Error('V2 master changed during the V3 render');
  const qc = {draft, v2: V2 ? v2qa : undefined, v3: v3info, final: {file: NAME, bytes: bytes.length, sha256: sha(bytes), durationSeconds: pr.duration, width: pr.width, height: pr.height, fps: pr.fps, codec: pr.codec}, loudness: {integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/)}, black, freeze: fz, silences: silS, checks, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k), issues, deviations, timeline: {totalSeconds: total, narratedSeconds: scenes.reduce((a, s) => a + s.seconds, 0), slots: slots.length, hookSlots}};
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
    manifestVersion: V3 ? 'video-004/production-manifest/3' : V2 ? 'video-004/production-manifest/2' : 'video-004/production-manifest/1', v2: V2 ? v2qa : undefined, v3: v3info, projectId: P, title: TITLE, channel: CHANNEL, freezeHash: plan.freezeHash, generatedAt: new Date().toISOString(), draft, commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    master: qc.final, qa: {technical: checks, failed: qc.failed, loudness: qc.loudness, issues, deviationsFromFrozenDurations: deviations},
    cost: {expectedUsd: EXPECTED_USD, worstCaseReservationUsd: EXPOSURE_CEILING_USD, actualUsd: +spent.toFixed(4), varianceUsd: +(spent - EXPECTED_USD).toFixed(4), incrementalUsd: V3 ? +(spent - V2_SPENT_USD).toFixed(4) : V2 ? +(spent - V1_SPENT_USD).toFixed(4) : undefined, historicUsd: V3 ? V2_SPENT_USD : V2 ? V1_SPENT_USD : undefined, conservativeCumulativeUsd: V3 ? +spent.toFixed(4) : undefined, byProvider, exposureUsd: exposure(), ceilingUsd: EXPOSURE_CEILING_USD, hardCapUsd: HARD_CAP_USD, paidOperations: led.filter((e) => e.status !== 'released').length, releasedClaims: led.filter((e) => e.status === 'released').length, retries: {count: retries.length, usd: +retryUsd.toFixed(4)}, providerTopupsAreNotCogs: true},
    mix: {generativeClips: genSlots.length, documentedClipFallbacks: documentedFallbacks, animatedGraphics: report.filter((r) => r.kind === 'animated').length, generativeSeconds: +genSec.toFixed(2), generativeShare: +(genSec / pr.duration).toFixed(3), stillMotionSlots: report.filter((r) => ['still', 'graphic', 'photo'].includes(r.kind as string)).length, stockSlots: report.filter((r) => r.kind === 'stock').length},
    fallbacks, shots: report.map((r) => ({...r, cost: led.filter((e) => e.shotId === r.id && e.status === 'committed').reduce((a, e) => a + (e.actualUsd ?? e.maxUsd), 0), attempts: attempts.filter((a) => a.shotId === r.id).map((a) => ({attemptId: a.attemptId, provider: a.provider, costUsd: a.costUsd, qa: a.qa?.result ?? null}))})),
  };
  await fs.writeFile(path.join(out, 'production-manifest.json'), JSON.stringify(manifestOut, null, 2));

  // 11) Durable copy + phone watch link (skipped for drafts).
  if (!draft) {
    const part = 45 * 1024 * 1024, parts: string[] = [];
    for (let i = 0; i * part < bytes.length; i++) { const p = `${P}/${FINAL_DIR}/${NAME}.part${String(i).padStart(2, '0')}`; await put(p, bytes.subarray(i * part, (i + 1) * part), 'application/octet-stream'); parts.push(p); }
    await putJson(`${P}/${FINAL_DIR}/manifest.json`, {file: NAME, bytes: bytes.length, sha256: sha(bytes), parts, checks, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID});
    await putJson(`${P}/${FINAL_DIR}/production-manifest.json`, manifestOut);
    if (V3) { await fs.writeFile(path.join(out, 'watch-link.json'), JSON.stringify({watchUrl: null, singleMp4Url: null, delivery: 'app route /r/video-004-v3-review after the review-proxy stage (no signed URL, no HLS)', parts}, null, 2)); }
    else {
    const hls = path.join(work, 'hls'); await fs.mkdir(hls, {recursive: true});
    await run('ffmpeg', ['-y', '-i', final, '-c', 'copy', '-f', 'hls', '-hls_time', '30', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, 'seg%03d.ts'), path.join(hls, 'index.m3u8')]);
    const lines = (await fs.readFile(path.join(hls, 'index.m3u8'), 'utf8')).split('\n'); const signed: string[] = [];
    for (const l of lines) { if (!l.endsWith('.ts')) { signed.push(l); continue; } const p = `${P}/${WATCH_DIR}/hls/${l}`; await put(p, await fs.readFile(path.join(hls, l)), 'video/mp2t'); signed.push(await sign(p)); }
    await put(`${P}/${WATCH_DIR}/hls/index.m3u8`, Buffer.from(signed.join('\n')), 'application/vnd.apple.mpegurl');
    const watchUrl = await sign(`${P}/${WATCH_DIR}/hls/index.m3u8`);
    const single = bytes.length <= 50 * 1024 * 1024 ? await (async () => { const dest = `${P}/${FINAL_DIR}/${NAME}`; const {error} = await bucket.upload(dest, bytes, {contentType: 'video/mp4', upsert: true}); return error ? null : await sign(dest, 30); })() : null;
    await fs.writeFile(path.join(out, 'watch-link.json'), JSON.stringify({watchUrl, singleMp4Url: single, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), parts}, null, 2));
    }
  }
  await fs.rm(work, {recursive: true, force: true});
  log('QC', {draft, passed: qc.failed.length === 0, failed: qc.failed, issues: issues.length, deviations: deviations.length, duration: pr.duration, spent, v2: V2 ? v2qa : undefined, v3: V3 ? {graphics: gqa.map((g) => `${g.id}:${g.safeArea && g.clearOfSubtitles && g.composedMatch ? 'PASS' : 'FAIL'}:${g.meanDiff}`), cta: v3info?.cta, v2Master: v3info?.v2Master} : undefined});
  if (!draft && qc.failed.length) throw Error('Technical QA failed: ' + qc.failed.join(', '));
}
