/** Video #003 production stages (one workflow run executes the stages listed in V3_STAGE, in order):
 *   status    free : provider health (read-only), ledger exposure, which assets already exist
 *   narrate   paid : ElevenLabs narration per scene with word timestamps (cached; never resent)
 *   images    paid : OpenAI stills for the frozen still shots AND the reference stills of the ten
 *                    generative shots (continuity groups share a reference image)
 *   stock     free : Pexels footage for the frozen stock shots (licensed under the Pexels License)
 *   graphics  free : internal diagrams and maps
 *   review    free : records still/clip/stock review verdicts from <dir>/reviews.json
 *   animate   paid : Runway image-to-video for ONLY the ten generative shots of the frozen plan
 *   render    free : assembly, mix, subtitles, QA, delivery (see render.ts; V3_DRAFT=true = placeholders)
 * Every paid call reserves before it is sent (exposure ceiling USD 29.44, provider ceilings) and
 * settles on the measured cost. Every attempt writes a telemetry record.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {getVideoProvider} from '../../src/lib/providers/video-gen';
import {wrapDurableVideoProvider} from '../../src/lib/video/long-form/ai-video-durable-provider';
import {searchSceneVideos, searchScenePhotos, type FootageCandidateRaw} from '../../src/lib/ai/footage';
import {buildContactSheet, frameAt, probeDuration} from '../lib/contact-sheet';
import {scriptWordsWithTimings, type WordTiming} from '../lib/dulce-part1-core';
import {ALIASES, GRAPHICS, IMAGE_MAX_USD, MODEL, MOTION_PROMPTS, SEC_USD, STILL_NOTES, STOCK_QUERIES, STYLE, VOICE, VOICE_SETTINGS, XI_USD_PER_CHAR, clipSecondsFor} from './plan';
import {graphicsNotes, renderGraphicPng} from './graphics';
import {DIR, P, type Plan, type Shot, bucket, committedUsd, ensureOut, entries, exposure, loadLedger, loadPlan, log, opKey, out, probe, put, putJson, read, readJson, readJsonStore, reserve, run, service, settle, sha, tele, words, writeLedgerSnapshot} from './shared';

const stage = process.env.V3_STAGE || 'status';
const wanted = (process.env.V3_SHOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const only = (shots: Shot[]) => (wanted.length ? shots.filter((s) => wanted.includes(s.id)) : shots);
const sceneText = (plan: Plan, scene: string) => plan.shots.filter((s) => s.scene === scene && s.purpose !== 'end card').map((s) => s.narration).join(' ');
const stillPath = (id: string, rev = 'v1') => `${P}/stills/${id}-${rev}.png`;

// ---------------- ElevenLabs ----------------
const XI = process.env.ELEVENLABS_API_KEY || '';
async function xi<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch('https://api.elevenlabs.io' + p, {...init, headers: {'xi-api-key': XI, 'Content-Type': 'application/json', ...(init?.headers || {})}});
  if (!r.ok) throw Error(`ElevenLabs ${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json() as Promise<T>;
}
async function quota() { const s = await xi<{character_count: number; character_limit: number; tier: string; next_character_count_reset_unix?: number}>('/v1/user/subscription'); return {remaining: s.character_limit - s.character_count, used: s.character_count, limit: s.character_limit, tier: s.tier, reset: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null}; }
type VoiceSetup = {voiceId: string; dictionary: {id: string; versionId: string}; at: string};
async function voiceSetup(): Promise<VoiceSetup> {
  const prior = await readJsonStore<VoiceSetup>(`${P}/voice/setup.json`); if (prior) return prior;
  const voices = await xi<{voices: {voice_id: string; name: string}[]}>('/v1/voices');
  let voiceId = voices.voices.find((v) => v.voice_id === VOICE.voiceId || v.name === VOICE.name)?.voice_id;
  if (!voiceId) voiceId = (await xi<{voice_id: string}>(`/v1/voices/add/${VOICE.publicOwnerId}/${VOICE.voiceId}`, {method: 'POST', body: JSON.stringify({new_name: VOICE.name})})).voice_id;
  const d = await xi<{id: string; version_id: string}>('/v1/pronunciation-dictionaries/add-from-rules', {method: 'POST', body: JSON.stringify({name: P, rules: ALIASES.map(([string_to_replace, alias]) => ({type: 'alias', string_to_replace, alias}))})});
  const rec: VoiceSetup = {voiceId, dictionary: {id: d.id, versionId: d.version_id}, at: new Date().toISOString()};
  await putJson(`${P}/voice/setup.json`, rec); return rec;
}
async function tts(text: string, vs: VoiceSetup, prev?: string, next?: string) {
  const t0 = Date.now();
  const r = await xi<{audio_base64: string; alignment: {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}}>(`/v1/text-to-speech/${vs.voiceId}/with-timestamps`, {method: 'POST', body: JSON.stringify({text, model_id: MODEL, voice_settings: VOICE_SETTINGS, previous_text: prev, next_text: next, pronunciation_dictionary_locators: [{pronunciation_dictionary_id: vs.dictionary.id, version_id: vs.dictionary.versionId}]})});
  const al = r.alignment, aligned: WordTiming[] = []; let cur: {c: string[]; s: number; e: number} | null = null;
  al.characters.forEach((ch, i) => { if (/\s/.test(ch)) { if (cur) aligned.push({text: cur.c.join(''), startSeconds: cur.s, endSeconds: cur.e}); cur = null; return; } if (!cur) cur = {c: [ch], s: al.character_start_times_seconds[i], e: al.character_end_times_seconds[i]}; else { cur.c.push(ch); cur.e = al.character_end_times_seconds[i]; } });
  if (cur) { const c = cur as {c: string[]; s: number; e: number}; aligned.push({text: c.c.join(''), startSeconds: c.s, endSeconds: c.e}); }
  const audio = Buffer.from(r.audio_base64, 'base64');
  const f = path.join(out, `tts-${Date.now()}.mp3`); await fs.writeFile(f, audio); const seconds = await probeDuration(f); await fs.unlink(f);
  return {audio, aligned, seconds, latency: (Date.now() - t0) / 1000};
}
function subtitleWords(text: string, aligned: WordTiming[]): {words: WordTiming[]; exact: boolean} {
  try { return {words: scriptWordsWithTimings(text, aligned), exact: true}; } catch {
    const ws = text.split(/\s+/).filter(Boolean), total = ws.reduce((a, w) => a + w.length, 0);
    const s0 = aligned[0]?.startSeconds ?? 0, s1 = aligned.at(-1)?.endSeconds ?? 0; let acc = 0;
    return {words: ws.map((w) => { const a = s0 + (s1 - s0) * acc / total; acc += w.length; return {text: w, startSeconds: a, endSeconds: s0 + (s1 - s0) * acc / total}; }), exact: false};
  }
}

async function narrate(plan: Plan) {
  const vs = await voiceSetup();
  const todo = plan.scenes.filter(async () => true).filter((s) => true);
  const pending: string[] = []; for (const s of todo) if (!(await read(`${P}/narration/${s}.json`))) pending.push(s);
  const need = pending.reduce((a, s) => a + sceneText(plan, s).length, 0); const q = await quota();
  log('NARRATE_PLAN', {scenes: pending, chars: need, quota: q});
  if (!pending.length) return;
  if (need > q.remaining) throw Error(`ElevenLabs quota ${q.remaining} < ${need} characters needed`);
  const fingerprint = sha(plan.scenes.map((s) => sceneText(plan, s)).join('\n'));
  const key = `tts-narration-${fingerprint.slice(0, 8)}`;
  await reserve({key, opKey: opKey({shotId: 'narration', provider: 'elevenlabs', model: MODEL, method: 'tts', inputFingerprint: fingerprint, attemptOrdinal: 1}), kind: 'tts', provider: 'elevenlabs', shotId: null, maxUsd: Math.round(need * XI_USD_PER_CHAR * 1.1 * 1e4) / 1e4});
  try {
    for (const s of pending) {
      const i = plan.scenes.indexOf(s); const text = sceneText(plan, s);
      const t = await tts(text, vs, i > 0 ? sceneText(plan, plan.scenes[i - 1]) : undefined, i < plan.scenes.length - 1 ? sceneText(plan, plan.scenes[i + 1]) : undefined);
      const sub = subtitleWords(text, t.aligned);
      await put(`${P}/narration/${s}.mp3`, t.audio, 'audio/mpeg');
      const rec = {scene: s, seconds: t.seconds, sha256: sha(t.audio), characters: text.length, scriptWords: words(text).length, alignedWords: t.aligned.length, exactAlignment: sub.exact, words: sub.words, voiceId: vs.voiceId, model: MODEL, settings: VOICE_SETTINGS, at: new Date().toISOString()};
      await putJson(`${P}/narration/${s}.json`, rec);
      await fs.writeFile(path.join(out, `narration-${s}.mp3`), t.audio); await fs.writeFile(path.join(out, `narration-${s}.json`), JSON.stringify(rec, null, 2));
      await tele({attemptId: `voice-${s}`, opKey: key, shotId: `scene-${s}`, stage: 'voice', provider: 'elevenlabs', model: MODEL, method: 'tts', attemptOrdinal: 1, costUsd: Math.round(text.length * XI_USD_PER_CHAR * 1e5) / 1e5, latencySeconds: t.latency, outputSha256: rec.sha256, generatedSeconds: t.seconds, qa: {result: sub.exact ? 'PASS' : 'PENDING', notes: sub.exact ? 'alignment matches the script word for word' : 'alignment split differently; timings spread by character length'}, at: rec.at});
      log('VOICE', {scene: s, seconds: t.seconds, words: rec.scriptWords, aligned: rec.alignedWords, exact: sub.exact});
    }
  } finally {
    const after = await quota().catch(() => null); const chars = Math.max(need, after ? after.used - q.used : 0);
    const usd = Math.round(chars * XI_USD_PER_CHAR * 1e5) / 1e5;
    await settle(key, usd, 'committed'); log('NARRATE_COST', {characters: chars, usd, before: q.remaining, after: after?.remaining ?? null});
  }
}

/** Validates narration audio against the plan: word counts, integrity, duration sanity. */
async function validateNarration(plan: Plan) {
  const report: Record<string, unknown>[] = []; let ok = true;
  for (const s of plan.scenes) {
    const rec = await readJsonStore<{seconds: number; sha256: string; scriptWords: number; alignedWords: number; exactAlignment: boolean; words: WordTiming[]}>(`${P}/narration/${s}.json`); const mp3 = await read(`${P}/narration/${s}.mp3`);
    if (!rec || !mp3) { report.push({scene: s, missing: true}); ok = false; continue; }
    const f = path.join(out, `check-${s}.mp3`); await fs.writeFile(f, mp3);
    const pr = await probe(f); const sil = await run('ffmpeg', ['-i', f, '-af', 'silencedetect=n=-40dB:d=2.0', '-f', 'null', '-']).catch(() => '');
    const longSilences = [...sil.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
    const planned = words(sceneText(plan, s)).length / 2.5;
    const r = {scene: s, seconds: rec.seconds, probeSeconds: pr.duration, plannedSeconds: planned, ratio: +(rec.seconds / planned).toFixed(3), checksumOk: sha(mp3) === rec.sha256, wordsOk: rec.words.length === sceneText(plan, s).split(/\s+/).filter(Boolean).length, exactAlignment: rec.exactAlignment, longSilences};
    if (!r.checksumOk || !r.wordsOk || r.ratio < 0.7 || r.ratio > 1.5 || longSilences.length) ok = false;
    report.push(r); await fs.unlink(f);
  }
  await fs.writeFile(path.join(out, 'narration-validation.json'), JSON.stringify({ok, report}, null, 2));
  log('NARRATION_VALIDATION', {ok, scenes: report.map((r) => ({scene: r.scene, ratio: r.ratio, wordsOk: r.wordsOk, longSilences: (r.longSilences as number[] | undefined)?.length ?? null}))});
  if (!ok) throw Error('Narration validation failed; see narration-validation.json');
}

// ---------------- OpenAI stills ----------------
async function images(plan: Plan) {
  const targets = only(plan.shots.filter((s) => s.provider === 'openai' || s.generative));
  const sharp = (await import('sharp')).default;
  const groups = new Map<string, Shot[]>(); for (const s of targets) if (s.continuity) groups.set(s.continuity, [...(groups.get(s.continuity) || []), s]);
  const refOf = async (s: Shot): Promise<{id: string; buf: Buffer} | null> => {
    if (!s.continuity) return null; const first = groups.get(s.continuity)![0]; if (first.id === s.id) return null;
    const b = await read(stillPath(first.id)); return b ? {id: first.id, buf: b} : null;
  };
  const tiles: {image: Buffer; label: string}[] = []; const errors: unknown[] = []; let halted = false;
  const make = async (s: Shot) => {
    const dest = stillPath(s.id); let bytes = await read(dest);
    if (!bytes) {
      const ref = await refOf(s);
      const prompt = `${s.visual}. ${STILL_NOTES[s.id] || ''} ${STYLE}${ref ? ` Attached reference: the same lake/location as in the reference image; use it only for the landscape's identity and lighting continuity.` : ''}`;
      const fingerprint = sha(prompt + (ref ? sha(ref.buf) : ''));
      const key = `image-${s.id}-v1`; const ok = opKey({shotId: s.id, provider: 'openai', model: 'gpt-image-2', method: s.method, inputFingerprint: fingerprint, attemptOrdinal: 1});
      await reserve({key, opKey: ok, kind: 'image', provider: 'openai', shotId: s.id, maxUsd: IMAGE_MAX_USD});
      const t0 = Date.now(); const headers: Record<string, string> = {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`};
      let body: FormData | string;
      if (ref) { const f = new FormData(); f.set('model', 'gpt-image-2'); f.set('prompt', prompt); f.set('size', '1536x1024'); f.set('quality', 'medium'); f.set('n', '1'); f.append('image[]', new Blob([new Uint8Array(ref.buf)], {type: 'image/png'}), `${ref.id}.png`); body = f; }
      else { headers['Content-Type'] = 'application/json'; body = JSON.stringify({model: 'gpt-image-2', prompt, size: '1536x1024', quality: 'medium', n: 1}); }
      const r = await fetch('https://api.openai.com/v1/images/' + (ref ? 'edits' : 'generations'), {method: 'POST', headers, body, signal: AbortSignal.timeout(240000)});
      if (!r.ok) { const detail = await r.text(); await putJson(`${P}/errors/${key}.json`, {status: r.status, detail: detail.slice(0, 2000)}); if (r.status >= 400 && r.status < 500) await settle(key, 0, 'released'); throw Error(`Image ${s.id} HTTP ${r.status} ${detail.slice(0, 200)}`); }
      const res = await r.json() as {data?: {b64_json?: string}[]; usage?: {input_tokens?: number; output_tokens?: number; input_tokens_details?: {text_tokens?: number; image_tokens?: number}}};
      if (!res.data?.[0]?.b64_json) throw Error('Image response without bytes; cost uncertain, claim kept');
      bytes = Buffer.from(res.data[0].b64_json, 'base64'); await put(dest, bytes, 'image/png');
      const u = res.usage; const cost = u && Number.isFinite(u.output_tokens) ? ((u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0) * 5 + (u.input_tokens_details?.image_tokens ?? 0) * 10 + (u.output_tokens ?? 0) * 40) / 1e6 : IMAGE_MAX_USD;
      await settle(key, Math.round(cost * 1e5) / 1e5, 'committed');
      await tele({attemptId: key, opKey: ok, shotId: s.id, stage: 'image', provider: 'openai', model: 'gpt-image-2', method: s.method, attemptOrdinal: 1, costUsd: Math.round(cost * 1e5) / 1e5, latencySeconds: (Date.now() - t0) / 1000, outputSha256: sha(bytes), generatedSeconds: 0, qa: {result: 'PENDING'}, at: new Date().toISOString()});
      await putJson(`${P}/stills/${s.id}-v1.json`, {id: s.id, prompt, reference: ref?.id ?? null, sha256: sha(bytes), usage: u ?? null, costUsd: cost, at: new Date().toISOString()});
    }
    await fs.writeFile(path.join(out, `still-${s.id}.jpg`), await sharp(bytes).jpeg({quality: 90}).toBuffer());
    tiles.push({image: bytes, label: `${s.id} ${s.purpose} ${sha(bytes).slice(0, 8)}`});
    log('IMAGE', {id: s.id, sha256: sha(bytes)});
  };
  // Continuity-group leaders first (alone, so an account problem stops after one rejected call), then the rest with references.
  const leaders = [...groups.values()].map((g) => g[0]).filter((s) => targets.includes(s)); const rest = targets.filter((s) => !leaders.includes(s));
  const first = leaders[0] ?? rest[0]; if (first) { try { await make(first); } catch (e) { errors.push(e); halted = true; log('IMAGE_ERROR', {id: first.id, error: e instanceof Error ? e.message : String(e)}); } }
  const queue = [...leaders.slice(first && leaders.includes(first) ? 1 : 0), ...rest.filter((s) => s !== first)]; let next = 0;
  await Promise.all(Array.from({length: 3}, async () => { while (next < queue.length && !halted) { const s = queue[next++]; try { await make(s); } catch (e) { errors.push(e); const m = e instanceof Error ? e.message : String(e); log('IMAGE_ERROR', {id: s.id, error: m}); if (/CEILING|quota|billing|insufficient|HTTP 4\d\d/i.test(m)) halted = true; } } }));
  tiles.sort((x, y) => x.label.localeCompare(y.label));
  for (let k = 0; k * 12 < tiles.length; k++) await fs.writeFile(path.join(out, `stills-review-${k + 1}.jpg`), await buildContactSheet(tiles.slice(k * 12, k * 12 + 12), {columns: 3, tileWidth: 640, tileHeight: 427, title: `Video #003 stills awaiting review (${k + 1})`}));
  if (errors.length) throw errors[0];
}

// ---------------- Pexels stock ----------------
async function stock(plan: Plan) {
  const targets = only(plan.shots.filter((s) => s.provider === 'pexels'));
  const tiles: {image: Buffer; label: string}[] = []; const missing: string[] = [];
  for (const s of targets) {
    const recPath = `${P}/stock/${s.id}.json`; let prior = await readJsonStore<{file: string; kind: string; sourceId: string; rejected?: string[]}>(recPath);
    const rv = await readJsonStore<{result: string; note: string}>(`${P}/reviews/stock-${s.id}.json`); const rejected = new Set(prior?.rejected ?? []);
    if (prior && rv?.result === 'FAIL' && !rejected.has(prior.sourceId)) { rejected.add(prior.sourceId); log('STOCK_RESEARCH', {id: s.id, rejected: [...rejected], note: rv.note}); prior = null; }
    if (prior) { const b = await read(prior.file); if (b) { const f = path.join(out, `stock-${s.id}.${prior.kind === 'photo' ? 'jpg' : 'mp4'}`); await fs.writeFile(f, b); tiles.push({image: prior.kind === 'photo' ? b : await frameAt(f, 1, 480), label: `${s.id} ${s.purpose} (cached)`}); continue; } }
    const queries = STOCK_QUERIES[s.id] || [s.visual]; let chosen: (FootageCandidateRaw & {query: string}) | null = null; const tried: {query: string; candidates: number}[] = [];
    for (const q of queries) {
      let c = await searchSceneVideos(q, s.seconds + 1, 'landscape').catch((e) => { log('STOCK_SEARCH_ERROR', {id: s.id, q, error: String(e)}); return [] as FootageCandidateRaw[]; });
      c = c.filter((x) => !rejected.has(x.sourceId)); tried.push({query: q, candidates: c.length});
      const good = c.filter((x) => (x.width ?? 0) >= 1920 && (x.durationSeconds ?? 0) >= s.seconds + 1 && (x.durationSeconds ?? 0) <= 90).sort((a, b) => (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0));
      const pick = good[0] ?? c.filter((x) => (x.width ?? 0) >= 1280).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
      if (pick) { chosen = {...pick, query: q}; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (chosen) {
      const r = await fetch(chosen.url, {signal: AbortSignal.timeout(180000)}); if (!r.ok) { missing.push(s.id); continue; }
      const buf = Buffer.from(await r.arrayBuffer()); const f = path.join(out, `stock-${s.id}.mp4`); await fs.writeFile(f, buf);
      const pr = await probe(f); if (!pr.width || pr.duration < s.seconds) { missing.push(s.id); log('STOCK_REJECT', {id: s.id, probe: pr}); continue; }
      const file = `${P}/stock/${s.id}.mp4`; await put(file, buf, 'video/mp4');
      await putJson(`${P}/reviews/stock-${s.id}.json`, {id: s.id, result: 'PENDING', note: 'replacement awaiting review', at: new Date().toISOString()});
      await putJson(recPath, {id: s.id, kind: 'video', file, sourceId: chosen.sourceId, rejected: [...rejected], pageUrl: chosen.pageUrl, photographer: chosen.photographer, width: pr.width, height: pr.height, seconds: pr.duration, query: chosen.query, license: 'Pexels License (free for commercial use, no attribution required)', sha256: sha(buf), at: new Date().toISOString()});
      tiles.push({image: await frameAt(f, Math.min(1, pr.duration / 2), 480), label: `${s.id} ${s.purpose} · ${chosen.sourceId} ${pr.width}x${pr.height} ${pr.duration.toFixed(1)}s`});
      log('STOCK', {id: s.id, sourceId: chosen.sourceId, width: pr.width, seconds: pr.duration, query: chosen.query});
    } else {
      // Photo fallback (Ken Burns at render time), still free.
      let photo: FootageCandidateRaw | null = null;
      for (const q of queries) { const c = await searchScenePhotos(q, 'landscape').catch(() => [] as FootageCandidateRaw[]); photo = c.filter((x) => (x.width ?? 0) >= 1920)[0] ?? null; if (photo) { photo = {...photo, description: q}; break; } }
      if (!photo) { missing.push(s.id); log('STOCK_MISSING', {id: s.id, tried}); continue; }
      const r = await fetch(photo.url, {signal: AbortSignal.timeout(120000)}); const buf = Buffer.from(await r.arrayBuffer());
      const file = `${P}/stock/${s.id}.jpg`; await put(file, buf, 'image/jpeg');
      await putJson(recPath, {id: s.id, kind: 'photo', file, sourceId: photo.sourceId, pageUrl: photo.pageUrl, photographer: photo.photographer, width: photo.width, height: photo.height, query: photo.description, license: 'Pexels License', sha256: sha(buf), at: new Date().toISOString()});
      await fs.writeFile(path.join(out, `stock-${s.id}.jpg`), buf); tiles.push({image: buf, label: `${s.id} ${s.purpose} · PHOTO ${photo.sourceId}`});
      log('STOCK_PHOTO', {id: s.id, sourceId: photo.sourceId});
    }
  }
  for (let k = 0; k * 12 < tiles.length; k++) await fs.writeFile(path.join(out, `stock-review-${k + 1}.jpg`), await buildContactSheet(tiles.slice(k * 12, k * 12 + 12), {columns: 3, tileWidth: 640, tileHeight: 360, title: `Video #003 stock candidates (${k + 1})`}));
  await fs.writeFile(path.join(out, 'stock-missing.json'), JSON.stringify(missing, null, 2));
  log('STOCK_DONE', {found: targets.length - missing.length, missing});
}

// ---------------- graphics ----------------
async function graphics(plan: Plan) {
  const tiles: {image: Buffer; label: string}[] = [];
  for (const s of plan.shots.filter((x) => x.kind === 'graphic')) {
    const f = path.join(out, `graphic-${s.id}.png`); await renderGraphicPng(GRAPHICS[s.id], f, path.join(out, 'geo-cache'));
    const b = await fs.readFile(f); await put(`${P}/graphics/${s.id}.png`, b, 'image/png'); await putJson(`${P}/graphics/${s.id}.json`, {id: s.id, kind: GRAPHICS[s.id], sha256: sha(b), at: new Date().toISOString(), notes: graphicsNotes});
    tiles.push({image: b, label: `${s.id} ${GRAPHICS[s.id]}`});
  }
  await fs.writeFile(path.join(out, 'graphics-review.jpg'), await buildContactSheet(tiles, {columns: 4, tileWidth: 576, tileHeight: 324, title: 'Video #003 graphics'}));
  await fs.writeFile(path.join(out, 'graphics-notes.json'), JSON.stringify(graphicsNotes, null, 2));
  log('GRAPHICS', {count: tiles.length, notes: graphicsNotes});
}

// ---------------- review verdicts (recorded from the repo file) ----------------
type Review = {stills?: {id: string; sha256: string; result: 'PASS' | 'FAIL'; note: string; reasons?: string[]}[]; clips?: {id: string; sha256: string; result: 'PASS' | 'FAIL'; note: string; reasons?: string[]; usableUntil?: number}[]; stock?: {id: string; result: 'PASS' | 'FAIL'; note: string}[]};
async function review() {
  const rv = await readJson<Review>(`${DIR}/reviews.json`).catch(() => ({} as Review));
  for (const x of rv.stills || []) { const b = await read(stillPath(x.id)); if (!b || sha(b) !== x.sha256) throw Error('Still checksum mismatch ' + x.id); await putJson(`${P}/reviews/still-${x.id}.json`, {...x, reviewer: 'assistant visual inspection', at: new Date().toISOString()}); const t = await readJsonStore<Record<string, unknown>>(`${P}/telemetry/image-${x.id}-v1.json`); if (t) { t.qa = {result: x.result, notes: x.note, reasons: x.reasons}; await putJson(`${P}/telemetry/image-${x.id}-v1.json`, t); } }
  for (const x of rv.clips || []) { await putJson(`${P}/reviews/clip-${x.id}.json`, {...x, reviewer: 'assistant temporal inspection', at: new Date().toISOString()}); const t = await readJsonStore<Record<string, unknown>>(`${P}/telemetry/video-${x.id}-v1.json`); if (t) { t.qa = {result: x.result, notes: x.note, reasons: x.reasons}; await putJson(`${P}/telemetry/video-${x.id}-v1.json`, t); } }
  for (const x of rv.stock || []) await putJson(`${P}/reviews/stock-${x.id}.json`, {...x, at: new Date().toISOString()});
  log('REVIEW', {stills: rv.stills?.length ?? 0, clips: rv.clips?.length ?? 0, stock: rv.stock?.length ?? 0});
}

// ---------------- Runway image-to-video (frozen generative set only) ----------------
async function animate(plan: Plan) {
  const targets = only(plan.shots.filter((s) => s.generative));
  if (targets.some((s) => !MOTION_PROMPTS[s.id])) throw Error('A generative shot has no motion prompt');
  const sharp = (await import('sharp')).default;
  const provider = getVideoProvider('runway'); if (provider.name !== 'runway') throw Error('Runway unavailable (VIDEO_PROVIDER/PREMIUM_CLIPS_ENABLED/RUNWAY_API_KEY)');
  const durable = wrapDurableVideoProvider(provider, {supabase: service, scopeId: P, executionMode: 'real', maxInAttemptResumes: 2, beforeSubmit: async (req) => { const m = req.metadata as {claimKey: string; shotId: string; opKey: string}; await reserve({key: m.claimKey, opKey: m.opKey, kind: 'video', provider: 'runway', shotId: m.shotId.replace(/-v\d+$/, ''), maxUsd: req.maxCostUsd}); return true; }});
  const errors: unknown[] = []; let next = 0;
  const make = async (s: Shot) => {
    const still = await read(stillPath(s.id)); const rv = await readJsonStore<{sha256: string; result: string}>(`${P}/reviews/still-${s.id}.json`);
    if (!still || !rv || rv.result !== 'PASS' || rv.sha256 !== sha(still)) throw Error(`Still ${s.id} is not approved: never animate an unreviewed image`);
    const jpeg = await sharp(still).resize(1280, 720, {fit: 'cover', position: 'centre'}).jpeg({quality: 92}).toBuffer();
    const rev = 'v1', recordKey = `${s.id}-${rev}`, claimKey = `video-${s.id}-${rev}`, t0 = Date.now();
    const seconds = clipSecondsFor(s.seconds); const maxCostUsd = seconds * SEC_USD;
    const ok = opKey({shotId: s.id, provider: 'runway', model: 'gen4_turbo', method: s.method, inputFingerprint: sha(MOTION_PROMPTS[s.id] + sha(still) + seconds), attemptOrdinal: 1});
    const asset = await durable.generateVideo({prompt: MOTION_PROMPTS[s.id], aspectRatio: '16:9', durationSeconds: seconds, maxCostUsd, referenceImageUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), metadata: {shotId: recordKey, videoId: P, claimKey, opKey: ok}});
    const file = path.join(out, `clip-${s.id}.mp4`); await fs.writeFile(file, asset.buffer);
    const actual = await probeDuration(file);
    const claim = entries().find((e) => e.key === claimKey); if (claim && claim.status === 'reserved') await settle(claimKey, maxCostUsd, 'committed');
    const det = await run('ffmpeg', ['-i', file, '-vf', 'scdet=threshold=18,blackdetect=d=0.3:pix_th=0.06,freezedetect=n=-60dB:d=1.5', '-f', 'null', '-']);
    const l1 = {abruptChanges: [...det.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map((m) => Number(m[1])), black: /black_start/.test(det), freeze: /freeze_start/.test(det)};
    await tele({attemptId: claimKey, opKey: ok, shotId: s.id, stage: 'animation', provider: 'runway', model: asset.model || 'gen4_turbo', method: s.method, attemptOrdinal: 1, costUsd: maxCostUsd, latencySeconds: (Date.now() - t0) / 1000, outputSha256: sha(asset.buffer), generatedSeconds: actual, qa: {result: 'PENDING', notes: 'L1 ' + JSON.stringify(l1)}, at: new Date().toISOString()});
    const tiles = []; for (let k = 0; k < 12; k++) { const t = 0.1 + (actual - 0.3) * k / 11; tiles.push({image: await frameAt(file, t, 480), label: `${s.id} ${t.toFixed(1)}s`}); }
    await fs.writeFile(path.join(out, `clip-${s.id}-temporal.jpg`), await buildContactSheet(tiles, {columns: 4, tileWidth: 480, tileHeight: 270, title: `${s.id} ${s.purpose} · ${seconds}s · L1 ${JSON.stringify(l1).slice(0, 80)}`}));
    await fs.writeFile(path.join(out, `clip-${s.id}.json`), JSON.stringify({id: s.id, rev, sha256: sha(asset.buffer), seconds: actual, requested: seconds, providerJobId: asset.providerJobId, l1}, null, 2));
    log('CLIP', {id: s.id, seconds: actual, l1});
  };
  await Promise.all(Array.from({length: Math.min(2, targets.length)}, async () => { while (next < targets.length) { const s = targets[next++]; try { await make(s); } catch (e) { errors.push(e); log('CLIP_ERROR', {id: s.id, error: e instanceof Error ? e.message : String(e)}); } } }));
  if (errors.length) throw errors[0];
}

// ---------------- status ----------------
async function status(plan: Plan) {
  const q = XI ? await quota().catch((e) => ({error: String(e)})) : null;
  const oa = process.env.OPENAI_API_KEY ? await fetch('https://api.openai.com/v1/models/gpt-image-2', {headers: {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`}}).then(async (r) => ({status: r.status, body: r.ok ? 'ok' : (await r.text()).slice(0, 200)})).catch((e) => ({error: String(e)})) : null;
  const {data: music} = await service.storage.from('music-library').list('', {limit: 200});
  const have = async (prefix: string) => ((await bucket.list(`${P}/${prefix}`, {limit: 1000})).data || []).map((f) => f.name);
  const assets = {narration: await have('narration'), stills: (await have('stills')).filter((n) => n.endsWith('.png')), stock: (await have('stock')).filter((n) => n.endsWith('.json')), clips: await have('ai-video'), graphics: (await have('graphics')).filter((n) => n.endsWith('.png')), reviews: await have('reviews')};
  const st = {freezeHash: plan.freezeHash, shots: plan.shots.length, generative: plan.shots.filter((s) => s.generative).map((s) => s.id), exposureUsd: exposure(), committedUsd: committedUsd(), elevenlabs: q, openaiKey: oa, musicLibrary: (music || []).map((m) => m.name), assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.length]))};
  await fs.writeFile(path.join(out, 'status.json'), JSON.stringify({...st, assetNames: assets, ledger: entries()}, null, 2));
  log('STATUS', st);
}

async function main() {
  await ensureOut();
  const plan = await loadPlan(); await loadLedger();
  log('PLAN', {freezeHash: plan.freezeHash, shots: plan.shots.length, exposureUsd: exposure()});
  try {
    for (const s of stage.split(',')) {
      log('STAGE', {stage: s});
      if (s === 'narrate') { await narrate(plan); await validateNarration(plan); }
      else if (s === 'validate-narration') await validateNarration(plan);
      else if (s === 'images') await images(plan);
      else if (s === 'stock') await stock(plan);
      else if (s === 'graphics') await graphics(plan);
      else if (s === 'review') await review();
      else if (s === 'animate') await animate(plan);
      else if (s === 'render') { const {render} = await import('./render'); await render(plan); }
      else await status(plan);
    }
  } finally { await writeLedgerSnapshot(); log('LEDGER', {exposureUsd: exposure(), committedUsd: committedUsd()}); }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack || e.message : 'Video #003 stopped'); process.exitCode = 1; });
