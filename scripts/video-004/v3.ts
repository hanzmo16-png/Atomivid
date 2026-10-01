/** Video #004 V3 final polish (THERMOPYLAE V3 FULL PATCH, authorised 2026-10-01).
 * - Pronunciation patches with the gate-approved strategy: whole sentence(s) regenerated with
 *   previous_text/next_text context, plain lowercase respellings in tts_text, the shared dictionary
 *   excluded from these calls, same voice/model/settings. G1/G3 are reused verbatim for P01/P05 and
 *   G2 for the last two sentences of P08; the other 8 segments are generated once (no retries).
 * - Each patch replaces exactly its sentence span inside the scene narration: loudness matched to
 *   the surrounding narration, 30 ms fades at the joins, the slot kept to the same length (room tone
 *   taken from the scene's own pause fills a shorter sentence; atempo 0.97-1.03 and the trailing
 *   pause absorb a longer one). Words after the span keep their exact V2 timings, so the approved
 *   montage (cuts, maps, music, SFX) is untouched. A sentence that cannot be fitted is a
 *   TIMING_BLOCKER for that patch only (reported, original kept).
 * - Two CTA scenes (post-hook, final) with their own narration lines.
 * Outputs under videos/<P>/v3/: patches/, narration/ (per-scene WAV + words), patch-report.json.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import manifest from '../../content/productions/video-004-thermopylae/v3/pronunciation-manifest.json';
import {probeDuration} from '../lib/contact-sheet';
import type {WordTiming} from '../lib/dulce-part1-core';
import {MODEL, VOICE_SETTINGS, XI_USD_PER_CHAR} from './plan';
import {P, type Plan, exposure, log, opKey, out, put, putJson, read, readJsonStore, reserve, run, settle, sha} from './shared';

export {V3, CTA, V2_MASTER_SHA, withCtaShots} from './v3-cta';
import {V3, CTA} from './v3-cta';
export const V3_DIR = `${P}/v3`;
/** Conservative spend before V3 (V2 ledger 16.8295 + the gate's 0.0776 still unreflected by the provider counter). */
export const PRE_V3_CONSERVATIVE_USD = 16.9071;
export const V3_PATCH_MAX_USD = 0.3;
const XF = 0.03; // join fade seconds
const MIN_GAP = 0.15; // never eat a pause below this

type Segment = {segmentId: string; scene: string; names: string[]; display_text: string; tts_text: string; previous_text: string; next_text: string; characters: number};
type NarrationRec = {seconds: number; sha256: string; words: WordTiming[]};
/** The gate script stored word times as start/end; the renderer uses startSeconds/endSeconds. */
export type GateWord = {text: string; start?: number; end?: number; startSeconds?: number; endSeconds?: number};
export const gateWords = (ws: GateWord[]): WordTiming[] => ws.map((w) => ({text: w.text, startSeconds: w.startSeconds ?? w.start ?? 0, endSeconds: w.endSeconds ?? w.end ?? 0}));
type Fit = {X: number; Y: number; rate: number; place: number; patchLen: number; roomLen: number; usedTrailingGap: number; usedLeadingGap: number; relaxedGaps?: boolean};

const XI = process.env.ELEVENLABS_API_KEY || '';
async function xi<T>(p: string, init?: RequestInit): Promise<T> { const r = await fetch('https://api.elevenlabs.io' + p, {...init, headers: {'xi-api-key': XI, 'Content-Type': 'application/json', ...(init?.headers || {})}}); if (!r.ok) throw Error(`ElevenLabs ${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json() as Promise<T>; }
const quota = async () => { const s = await xi<{character_count: number; character_limit: number}>('/v1/user/subscription'); return {remaining: s.character_limit - s.character_count, used: s.character_count, limit: s.character_limit}; };
export const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
export const toks = (s: string) => s.split(/\s+/).filter(Boolean);

/** Approved gate strategy: context as API parameters, no dictionary locators, plain tts_text, one attempt. */
async function ttsPatch(voiceId: string, text: string, prev: string | undefined, next: string | undefined): Promise<{audio: Buffer; words: WordTiming[]}> {
  const r = await xi<{audio_base64: string; alignment: {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}}>(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {method: 'POST', body: JSON.stringify({text, model_id: MODEL, voice_settings: VOICE_SETTINGS, previous_text: prev, next_text: next})});
  return {audio: Buffer.from(r.audio_base64, 'base64'), words: wordsFromAlignment(r.alignment)};
}
export function wordsFromAlignment(al: {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}): WordTiming[] {
  const ws: WordTiming[] = []; let cur: {c: string[]; s: number; e: number} | null = null;
  al.characters.forEach((ch, i) => { if (/\s/.test(ch)) { if (cur) ws.push({text: cur.c.join(''), startSeconds: cur.s, endSeconds: cur.e}); cur = null; return; } if (!cur) cur = {c: [ch], s: al.character_start_times_seconds[i], e: al.character_end_times_seconds[i]}; else { cur.c.push(ch); cur.e = al.character_end_times_seconds[i]; } });
  if (cur) { const c = cur as {c: string[]; s: number; e: number}; ws.push({text: c.c.join(''), startSeconds: c.s, endSeconds: c.e}); }
  return ws;
}

/** Finds the display tokens as a contiguous run inside the scene words (canonical script words). */
export function findSpan(sceneWords: WordTiming[], display: string): [number, number] | null {
  const want = toks(display).map(norm); const have = sceneWords.map((w) => norm(w.text));
  for (let i = 0; i + want.length <= have.length; i++) { let ok = true; for (let k = 0; k < want.length; k++) if (have[i + k] !== want[k]) { ok = false; break; } if (ok) return [i, i + want.length - 1]; }
  return null;
}

async function lufs(file: string, a?: number, b?: number): Promise<number> {
  const af = `${a !== undefined ? `atrim=${a.toFixed(3)}:${b!.toFixed(3)},asetpts=PTS-STARTPTS,` : ''}ebur128`;
  const o = await run('ffmpeg', ['-i', file, '-af', af, '-f', 'null', '-']);
  const s = o.slice(o.lastIndexOf('Summary:')); const m = /I:\s+(-?[\d.]+) LUFS/.exec(s); return m ? Number(m[1]) : NaN;
}
/** Quietest 0.4 s window of a file (room tone fallback). */
async function quietWindow(file: string): Promise<[number, number]> {
  const o = await run('ffmpeg', ['-i', file, '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
  const rms = [...o.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -120 : Number(m[1])));
  const fr = 1024 / 48000, win = Math.max(1, Math.round(0.4 / fr)); let best = 0, bestV = Infinity;
  for (let i = 0; i + win <= rms.length; i++) { const v = rms.slice(i, i + win).reduce((x, y) => x + y, 0) / win; if (v < bestV) { bestV = v; best = i; } }
  return [best * fr, (best + win) * fr];
}

/** Decides how the regenerated sentence fits the original span without moving any later word. */
export function fitPatch(sceneWords: WordTiming[], span: [number, number], sceneSeconds: number, patchVoiced: number, minGap = MIN_GAP): Fit | {blocker: string} {
  const [i0, i1] = span; const A = sceneWords[i0].startSeconds, B = sceneWords[i1].endSeconds;
  const prevEnd = i0 > 0 ? sceneWords[i0 - 1].endSeconds : 0; const nextStart = i1 + 1 < sceneWords.length ? sceneWords[i1 + 1].startSeconds : sceneSeconds;
  const gapBefore = A - prevEnd, gapAfter = nextStart - B;
  const X = A - Math.min(0.04, Math.max(0, gapBefore / 2)); let Y = B + Math.min(0.06, Math.max(0, gapAfter / 2));
  const Lo = Y - X;
  if (patchVoiced <= Lo) return {X, Y, rate: 1, place: X, patchLen: patchVoiced, roomLen: Lo - patchVoiced, usedTrailingGap: 0, usedLeadingGap: 0};
  // Longer: speed up to 1.03 first, then borrow from the trailing pause, then from the leading pause, keeping MIN_GAP.
  let rate = Math.min(1.03, patchVoiced / Lo); let L = patchVoiced / rate; let usedT = 0, usedL = 0;
  if (L > Lo) { const availT = Math.max(0, nextStart - minGap - Y); usedT = Math.min(availT, L - Lo); Y += usedT; }
  let place = X;
  if (L > Y - X) { const availL = Math.max(0, X - (prevEnd + minGap)); usedL = Math.min(availL, L - (Y - X)); place = X - usedL; }
  if (L > Y - place + 0.005) {
    // Audit rule: a sentence up to 150 ms too long after atempo <= 1.03 is absorbed by the neighbouring pauses (kept >= 100 ms); beyond that it is a blocker.
    if (minGap > 0.1 && L - (Y - place) <= 0.15) { const r = fitPatch(sceneWords, span, sceneSeconds, patchVoiced, 0.1); return 'blocker' in r ? r : {...r, relaxedGaps: true}; }
    return {blocker: `TIMING_BLOCKER: sentence ${(patchVoiced).toFixed(2)} s does not fit ${(Lo).toFixed(2)} s + pauses (rate ${rate.toFixed(3)}, trailing ${usedT.toFixed(2)}, leading ${usedL.toFixed(2)}, min gap ${minGap})`};
  }
  return {X: place, Y, rate, place, patchLen: L, roomLen: Math.max(0, Y - place - L), usedTrailingGap: usedT, usedLeadingGap: usedL};
}

/** Splices the prepared patch WAV into the scene WAV (both 48 kHz stereo) at the fitted position; output keeps the scene length. */
async function splice(sceneWav: string, patchWav: string, fit: Fit, roomSrc: [number, number], sceneSeconds: number, outWav: string) {
  const ms = (s: number) => Math.round(s * 1000);
  const f: string[] = [];
  f.push(`[0]atrim=0:${(fit.X + XF).toFixed(4)},asetpts=PTS-STARTPTS,afade=t=out:st=${fit.X.toFixed(4)}:d=${XF}[h]`);
  f.push(`[0]atrim=${(fit.Y - XF).toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${XF},adelay=${ms(fit.Y - XF)}|${ms(fit.Y - XF)}[t]`);
  f.push(`[1]adelay=${ms(fit.place)}|${ms(fit.place)}[p]`);
  const mixIn = ['[h]', '[p]', '[t]'];
  if (fit.roomLen > 0.05) {
    const rl = fit.roomLen + 2 * XF; const srcLen = roomSrc[1] - roomSrc[0]; const loops = Math.ceil(rl / srcLen) + 1;
    f.push(`[0]atrim=${roomSrc[0].toFixed(4)}:${roomSrc[1].toFixed(4)},asetpts=PTS-STARTPTS,aloop=loop=${loops}:size=${Math.ceil(srcLen * 48000) + 1},atrim=0:${rl.toFixed(4)},afade=t=in:d=${XF},afade=t=out:st=${(rl - XF).toFixed(4)}:d=${XF},adelay=${ms(fit.place + fit.patchLen - XF)}|${ms(fit.place + fit.patchLen - XF)}[r]`);
    mixIn.push('[r]');
  }
  f.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest,apad,atrim=0:${sceneSeconds.toFixed(4)},asetpts=PTS-STARTPTS[o]`);
  await run('ffmpeg', ['-y', '-i', sceneWav, '-i', patchWav, '-filter_complex', f.join(';'), '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outWav]);
}

/** One patch: prepare audio (trim to voiced bounds, rate, gain, fades), fit, splice, update words. Pure local I/O. */
export async function applyPatch(opts: {sceneWav: string; sceneWords: WordTiming[]; sceneSeconds: number; patchAudio: string; patchWords: WordTiming[]; span: [number, number]; work: string; tag: string}): Promise<{wav: string; words: WordTiming[]; fit: Fit; gainDb: number; lufsOriginal: number; lufsPatch: number} | {blocker: string}> {
  const {sceneWav, sceneWords, sceneSeconds, patchAudio, patchWords, span, work, tag} = opts;
  const n = span[1] - span[0] + 1;
  if (patchWords.length !== n) return {blocker: `WORD_COUNT: patch has ${patchWords.length} words, span has ${n}`};
  const pdur = await probeDuration(patchAudio);
  const p0 = Math.max(0, patchWords[0].startSeconds - 0.03), p1 = Math.min(pdur, patchWords.at(-1)!.endSeconds + 0.05);
  const voiced = p1 - p0;
  const fit = fitPatch(sceneWords, span, sceneSeconds, voiced);
  if ('blocker' in fit) return fit;
  const A = sceneWords[span[0]].startSeconds, B = sceneWords[span[1]].endSeconds;
  const lo = await lufs(sceneWav, A, B); const lp = await lufs(patchAudio, p0, p1);
  const gainDb = Number.isFinite(lo) && Number.isFinite(lp) ? Math.max(-6, Math.min(6, lo - lp)) : 0;
  const pw = path.join(work, `${tag}-patch.wav`);
  await run('ffmpeg', ['-y', '-i', patchAudio, '-af', `aresample=48000,aformat=channel_layouts=stereo,atrim=${p0.toFixed(4)}:${p1.toFixed(4)},asetpts=PTS-STARTPTS,atempo=${fit.rate.toFixed(4)},volume=${gainDb.toFixed(2)}dB,afade=t=in:d=${XF},afade=t=out:st=${Math.max(0, fit.patchLen - XF).toFixed(4)}:d=${XF}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', pw]);
  const nextStart = span[1] + 1 < sceneWords.length ? sceneWords[span[1] + 1].startSeconds : sceneSeconds;
  const pauseSrc: [number, number] = nextStart - B > 0.25 ? [B + 0.03, nextStart - 0.03] : await quietWindow(sceneWav);
  const ow = path.join(work, `${tag}-scene.wav`);
  await splice(sceneWav, pw, fit, pauseSrc, sceneSeconds, ow);
  const words = sceneWords.map((w, i) => { if (i < span[0] || i > span[1]) return w; const q = patchWords[i - span[0]]; return {text: w.text, startSeconds: +(fit.place + (q.startSeconds - p0) / fit.rate).toFixed(3), endSeconds: +(fit.place + (q.endSeconds - p0) / fit.rate).toFixed(3)}; });
  return {wav: ow, words, fit, gainDb, lufsOriginal: lo, lufsPatch: lp};
}

/** Stage v3-patch: builds videos/<P>/v3/narration/<scene>.wav + .json for every patched scene and the CTA scenes. */
export async function v3Patch(plan: Plan) {
  if (!V3) throw Error('v3-patch requires V4_V3=true');
  const work = path.join(out, 'v3work'); await fs.mkdir(work, {recursive: true});
  const segs = (manifest as unknown as {segments: Segment[]}).segments;
  const gate = (manifest as unknown as {dryGate: {samples: {sampleId: string; test_phrase: string; tts_text: string}[]}}).dryGate.samples;
  const voiceSetup = await readJsonStore<{voiceId: string}>(`${P}/voice/setup.json`); if (!voiceSetup) throw Error('voice setup missing');
  const report: Record<string, unknown>[] = []; const blockers: string[] = [];
  // Which segments come from the approved gate audio (no new call): P01<-G1, P05<-G3, P08 (last two sentences)<-G2.
  const reuse: Record<string, string> = {P01: 'G1', P05: 'G3', P08: 'G2'};
  const toGenerate = segs.filter((s) => !reuse[s.segmentId]);
  const ctaChars = CTA.reduce((a, c) => a + c.line.length, 0);
  const chars = toGenerate.reduce((a, s) => a + s.tts_text.length, 0) + ctaChars;
  const projected = +(chars * XI_USD_PER_CHAR).toFixed(4);
  log('V3_PLAN', {segments: toGenerate.map((s) => s.segmentId), reused: reuse, chars, projectedUsd: projected, maxUsd: V3_PATCH_MAX_USD, exposureUsd: exposure(), preV3ConservativeUsd: PRE_V3_CONSERVATIVE_USD});
  if (projected > V3_PATCH_MAX_USD || PRE_V3_CONSERVATIVE_USD + V3_PATCH_MAX_USD > 19) { log('V3_STOP', {reason: 'cost'}); throw Error('V3_COST_BLOCKER'); }
  // Account the gate conservatively (provider counter lag != zero spend): a committed correction entry, no call.
  try { await reserve({key: 'tts-pron-gate-v3-settlement', opKey: opKey({shotId: 'pron-gate', provider: 'elevenlabs', model: MODEL, method: 'tts-settlement', inputFingerprint: 'gate-388-chars', attemptOrdinal: 1}), kind: 'tts', provider: 'elevenlabs', shotId: null, maxUsd: 0.0776, reason: 'Gate G1-G3 (388 chars) settled conservatively: counter lag is not zero spend'}); await settle('tts-pron-gate-v3-settlement', 0.0776, 'committed'); } catch (e) { log('V3_GATE_SETTLEMENT', {skipped: e instanceof Error ? e.message : String(e)}); }
  if (needCalls) await reserve({key: 'tts-v3-patch', opKey: opKey({shotId: 'v3-patch', provider: 'elevenlabs', model: MODEL, method: 'tts', inputFingerprint: sha(toGenerate.map((s) => s.tts_text).concat(CTA.map((c) => c.line)).join('\n')), attemptOrdinal: 1}), kind: 'tts', provider: 'elevenlabs', shotId: null, maxUsd: V3_PATCH_MAX_USD, reason: `V3 full patch: ${toGenerate.length} segments + 2 CTA (${chars} chars)`});
  // Stored patches (a previous run's TTS output) are reused as-is: a fit-only re-run makes no call and reserves nothing.
  const stored: Record<string, {audio: Buffer; words: WordTiming[]}> = {};
  for (const s of toGenerate) { const b = await read(`${V3_DIR}/patches/${s.segmentId}.mp3`); const j = await readJsonStore<{words: WordTiming[]}>(`${V3_DIR}/patches/${s.segmentId}.json`); if (b && j) stored[s.segmentId] = {audio: b, words: j.words}; }
  for (const c of CTA) { const b = await read(`${V3_DIR}/patches/${c.scene}.mp3`); const j = await readJsonStore<{words: WordTiming[]}>(`${V3_DIR}/narration/${c.scene}.json`); if (b && j) stored[c.scene] = {audio: b, words: j.words}; }
  const needCalls = toGenerate.filter((s) => !stored[s.segmentId]).length + CTA.filter((c) => !stored[c.scene]).length;
  log('V3_REUSE', {stored: Object.keys(stored), needCalls});
  const before = needCalls ? await quota() : {remaining: 0, used: 0, limit: 0}; let calls = 0; let charsSent = 0;
  // Patch audio per segment (reused gate audio or one new call).
  const patches: Record<string, {audio: string; words: WordTiming[]; display: string; source: string}> = {};
  for (const s of segs) {
    const g = reuse[s.segmentId];
    if (g) {
      const b = await read(`${V3_DIR}/pron-gate/${g}.mp3`); const j = await readJsonStore<{words: GateWord[]}>(`${V3_DIR}/pron-gate/${g}.json`); if (!b || !j) { blockers.push(`${s.segmentId}: gate audio ${g} missing`); continue; }
      const f = path.join(work, `${s.segmentId}.mp3`); await fs.writeFile(f, b); patches[s.segmentId] = {audio: f, words: gateWords(j.words), display: gate.find((x) => x.sampleId === g)!.test_phrase, source: g}; continue;
    }
    if (stored[s.segmentId]) { const f = path.join(work, `${s.segmentId}.mp3`); await fs.writeFile(f, stored[s.segmentId].audio); patches[s.segmentId] = {audio: f, words: stored[s.segmentId].words, display: s.display_text, source: 'tts-stored'}; continue; }
    try {
      calls++; charsSent += s.tts_text.length;
      const r = await ttsPatch(voiceSetup.voiceId, s.tts_text, s.previous_text, s.next_text);
      const f = path.join(work, `${s.segmentId}.mp3`); await fs.writeFile(f, r.audio); await put(`${V3_DIR}/patches/${s.segmentId}.mp3`, r.audio, 'audio/mpeg'); await putJson(`${V3_DIR}/patches/${s.segmentId}.json`, {segmentId: s.segmentId, tts_text: s.tts_text, display_text: s.display_text, words: r.words, sha256: sha(r.audio), at: new Date().toISOString()});
      patches[s.segmentId] = {audio: f, words: r.words, display: s.display_text, source: 'tts'};
    } catch (e) { blockers.push(`${s.segmentId}: TTS failed (no retry): ${e instanceof Error ? e.message : String(e)}`); }
  }
  // CTA narration (plain text, same voice, context = neighbouring sentences).
  const ctaAudio: Record<string, {audio: string; words: WordTiming[]}> = {};
  for (const c of CTA) {
    if (stored[c.scene]) { const f = path.join(work, `${c.scene}.mp3`); await fs.writeFile(f, stored[c.scene].audio); ctaAudio[c.scene] = {audio: f, words: stored[c.scene].words}; continue; }
    try {
      calls++; charsSent += c.line.length;
      const prev = c.scene === 'CTA1' ? 'It is a harder story than the legend. And a better one. This is Thermopylae.' : 'But the low hill is still where it was, and the arrowheads were still in it.';
      const next = c.scene === 'CTA1' ? 'Ten years earlier, a Persian army had landed at Marathon, north of Athens, and been thrown back into the sea.' : undefined;
      const r = await ttsPatch(voiceSetup.voiceId, c.line, prev, next);
      const f = path.join(work, `${c.scene}.mp3`); await fs.writeFile(f, r.audio); await put(`${V3_DIR}/patches/${c.scene}.mp3`, r.audio, 'audio/mpeg');
      if (r.words.length !== toks(c.line).length) { blockers.push(`${c.scene}: alignment ${r.words.length} words vs ${toks(c.line).length}`); continue; }
      ctaAudio[c.scene] = {audio: f, words: r.words.map((w, i) => ({...w, text: toks(c.line)[i]}))};
    } catch (e) { blockers.push(`${c.scene}: TTS failed (no retry): ${e instanceof Error ? e.message : String(e)}`); }
  }
  const after = needCalls ? await quota() : before; const measured = Math.max(0, after.used - before.used);
  const measuredUsd = +(measured * XI_USD_PER_CHAR).toFixed(5), projectedSentUsd = +(charsSent * XI_USD_PER_CHAR).toFixed(5);
  const settledUsd = Math.max(measuredUsd, projectedSentUsd); // counter lag is not zero spend
  if (needCalls) await settle('tts-v3-patch', settledUsd, 'committed');
  // Scene stems: apply every patch of a scene in sentence order on the V2 narration (48 kHz stereo WAV).
  const scenesTouched = [...new Set(segs.map((s) => s.scene))];
  for (const sc of scenesTouched) {
    const rec = await readJsonStore<NarrationRec>(`${P}/narration/${sc}.json`); const mp3 = await read(`${P}/narration/${sc}.mp3`); if (!rec || !mp3) throw Error('V2 narration missing ' + sc);
    if (sha(mp3) !== rec.sha256) throw Error('V2 narration checksum ' + sc);
    const src = path.join(work, `${sc}-v2.mp3`); await fs.writeFile(src, mp3); let cur = path.join(work, `${sc}-v3-0.wav`);
    await run('ffmpeg', ['-y', '-i', src, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', cur]);
    const sceneSeconds = await probeDuration(cur); let words = rec.words; const applied: Record<string, unknown>[] = [];
    for (const s of segs.filter((x) => x.scene === sc)) {
      const p = patches[s.segmentId]; if (!p) { applied.push({segmentId: s.segmentId, status: 'SKIPPED_NO_AUDIO'}); continue; }
      const span = findSpan(words, p.display); if (!span) { blockers.push(`${s.segmentId}: display text not found in ${sc} words`); applied.push({segmentId: s.segmentId, status: 'SPAN_NOT_FOUND'}); continue; }
      const r = await applyPatch({sceneWav: cur, sceneWords: words, sceneSeconds, patchAudio: p.audio, patchWords: p.words, span, work, tag: `${sc}-${s.segmentId}`});
      if ('blocker' in r) { blockers.push(`${s.segmentId}: ${r.blocker}`); applied.push({segmentId: s.segmentId, status: 'BLOCKER', detail: r.blocker}); continue; }
      cur = r.wav; words = r.words;
      applied.push({segmentId: s.segmentId, status: 'PATCHED', source: p.source, names: s.names, span, relaxedGaps: r.fit.relaxedGaps === true, originalSpan: {start: rec.words[span[0]].startSeconds, end: rec.words[span[1]].endSeconds}, fit: r.fit, gainDb: +r.gainDb.toFixed(2), lufsOriginal: +r.lufsOriginal.toFixed(2), lufsPatch: +r.lufsPatch.toFixed(2)});
    }
    const bytes = await fs.readFile(cur); const dur = await probeDuration(cur);
    await put(`${V3_DIR}/narration/${sc}.wav`, bytes, 'audio/wav');
    await putJson(`${V3_DIR}/narration/${sc}.json`, {scene: sc, seconds: dur, sha256: sha(bytes), words, basedOn: rec.sha256, patches: applied, at: new Date().toISOString()});
    report.push({scene: sc, seconds: +dur.toFixed(3), v2Seconds: +sceneSeconds.toFixed(3), patches: applied});
    log('V3_SCENE', {scene: sc, patches: applied.map((a) => `${a.segmentId}:${a.status}`)});
  }
  for (const c of CTA) {
    const a = ctaAudio[c.scene]; if (!a) continue;
    const wav = path.join(work, `${c.scene}.wav`); await run('ffmpeg', ['-y', '-i', a.audio, '-af', 'aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=0.25', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav]);
    const bytes = await fs.readFile(wav); const dur = await probeDuration(wav);
    await put(`${V3_DIR}/narration/${c.scene}.wav`, bytes, 'audio/wav'); await putJson(`${V3_DIR}/narration/${c.scene}.json`, {scene: c.scene, seconds: dur, sha256: sha(bytes), words: a.words, line: c.line, at: new Date().toISOString()});
    report.push({scene: c.scene, seconds: +dur.toFixed(3), cta: c.line});
  }
  const summary = {status: blockers.length ? 'V3_PATCH_WITH_BLOCKERS' : 'V3_PATCH_OK', calls, retries: 0, charsSent, cost: {projectedUsd: projected, projectedSentUsd, measuredChars: measured, measuredUsd, settledUsd, quotaBefore: before, quotaAfter: after, preV3ConservativeUsd: PRE_V3_CONSERVATIVE_USD, conservativeCumulativeUsd: +(PRE_V3_CONSERVATIVE_USD + settledUsd).toFixed(4), capUsd: 19}, scenes: report, blockers};
  await putJson(`${V3_DIR}/patch-report.json`, summary); await fs.writeFile(path.join(out, 'v3-patch-report.json'), JSON.stringify(summary, null, 2));
  log('V3_PATCH', {status: summary.status, calls, charsSent, settledUsd, blockers});
  await fs.rm(work, {recursive: true, force: true});
}
