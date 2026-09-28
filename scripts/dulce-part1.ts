/** DULCE Part I production (English, David). Stages run one per workflow execution:
 *   setup       free: add David to the account, create the pronunciation alias dictionary
 *   voice-test  quota: short pronunciation test (Dulce, Castello, Bennewitz, Nightmare Hall)
 *   narrate     quota: full narration per beat (cached; never resent)
 *   images      paid: new stills for DP1_ASSETS (review before any animation)
 *   approve     free: record still approvals from content/long-form/dulce-part1/approved-stills.json
 *   animate     paid: image-to-video for approved stills in DP1_ASSETS (B+ list only)
 *   clip-review free: record clip QA verdicts from approved-clips.json
 *   render      free: assemble, QA, publish the master and a phone watch link
 * Every paid call is gated BEFORE the call: exposure (committed + open reservations) + the
 * operation's maximum cost must fit the USD 40 hard cap. Every attempt writes a telemetry record.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {createServiceClient} from '../src/lib/supabase/service';
import {getVideoProvider} from '../src/lib/providers/video-gen';
import {wrapDurableVideoProvider} from '../src/lib/video/long-form/ai-video-durable-provider';
import {readAiVideoClipRecord} from '../src/lib/video/long-form/ai-video-storage';
import {buildContactSheet, frameAt, probeDuration} from './lib/contact-sheet';
import type {PlanShot} from './lib/dulce-edit';
import {HARD_CAP_USD, canSpend, exposureUsd, scriptWordsWithTimings, type LedgerEntry, type WordTiming} from './lib/dulce-part1-core';

const P = 'dulce-part1', SCOPE = 'dulce-part1', V1 = 'dulce-001/full-v1', V1_SCOPE = 'dulce-001-full-v1';
const DAVID = {voiceId: 'cCYjmrGZaI86GUJ7F2Nn', publicOwnerId: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', name: 'David - Audiobook & Documentary'};
const MODEL = 'eleven_multilingual_v2';
const VOICE_SETTINGS = {stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.92};
const ALIASES = [['Dulce', 'Dool-say'], ['Castello', 'Cass-tell-oh'], ['Bennewitz', 'Ben-uh-wits']];
const IMAGE_MAX = 0.30, SEC_USD = 0.05;
const out = process.env.DP1_OUT || '/tmp/dulce-part1';
const stage = process.env.DP1_STAGE || 'status';
const wanted = (process.env.DP1_ASSETS || '').split(',').filter(Boolean);
const wantedClips = (process.env.DP1_ANIMATE_ASSETS || process.env.DP1_ASSETS || '').split(',').filter(Boolean);
const service = createServiceClient(), bucket = service.storage.from('videos');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const log = (tag: string, v: unknown) => console.log(`@@DP1_${tag} ` + JSON.stringify(v));
const readJson = async <T>(f: string): Promise<T> => JSON.parse(await fs.readFile(f, 'utf8')) as T;

async function read(p: string, b = bucket): Promise<Buffer | null> {
  const {data, error} = await b.download(p);
  if (error) { if (String((error as {statusCode?: string}).statusCode) === '404' || /not.?found|Object not found/i.test(error.message)) return null; throw Error('Storage read failed ' + p + ': ' + error.message); }
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}
async function put(p: string, b: Buffer, type: string, upsert = true) { const {error} = await bucket.upload(p, b, {contentType: type, upsert, cacheControl: '0'}); if (error) throw Error('Storage write failed ' + p + ': ' + error.message); }
const putJson = (p: string, v: unknown, upsert = true) => put(p, Buffer.from(JSON.stringify(v, null, 2)), 'application/json', upsert);
async function sign(p: string, days = 7) { const {data, error} = await bucket.createSignedUrl(p, days * 86400); if (error || !data) throw Error('Sign failed ' + p); return data.signedUrl; }
function run(cmd: string, args: string[]): Promise<string> { return new Promise((res, rej) => { const p = spawn(cmd, args); let e = ''; p.stderr.on('data', c => { e += c; if (e.length > 4e6) e = e.slice(-2e6); }); p.on('error', rej); p.on('close', c => c === 0 ? res(e) : rej(Error(`${cmd} exited ${c}: ${e.slice(-1500)}`))); }); }

// ---------------- ledger (hard cap) ----------------
let ledger: {entries: LedgerEntry[]} = {entries: []};
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => { const n = queue.then(fn); queue = n.catch(() => undefined); return n; };
async function loadLedger() {
  const b = await read(`${P}/ledger.json`); if (b) ledger = JSON.parse(b.toString());
  // Creator was never bought (the owner topped up pay-as-you-go credits instead): the old reservation is void.
  // Provider top-ups are cash added to a balance, not episode COGS; only real consumption enters this ledger.
  const creator = ledger.entries.find(e => e.key === 'elevenlabs-creator');
  if (creator && creator.status !== 'released') { creator.status = 'released'; creator.actualUsd = 0; await putJson(`${P}/ledger.json`, ledger); }
}
/** Reserve BEFORE the paid call; refuses (no call) when the cap would be exceeded. */
function reserve(key: string, kind: string, maxUsd: number) {
  return serial(async () => {
    if (process.env.DP1_ALLOW_PAID !== 'true') throw Error('Paid authorization missing for this stage');
    if (ledger.entries.some(e => e.key === key && e.status !== 'released')) throw Error('Existing paid claim; reconcile rather than resend ' + key);
    const gate = canSpend(ledger.entries, maxUsd);
    if (!gate.ok) throw Error(`HARD CAP: exposure ${gate.exposure.toFixed(2)} + ${maxUsd.toFixed(2)} > ${HARD_CAP_USD}; stopped before the call`);
    // A released claim (rejected, unbilled call) may be retried; each retry gets its own unique claim file.
    const retries = ledger.entries.filter(e => e.key === key && e.status === 'released').length;
    await putJson(`${P}/claims/${key}${retries ? `-r${retries}` : ''}.json`, {key, kind, maxUsd, at: new Date().toISOString()}, false);
    ledger.entries.push({key, kind, maxUsd, actualUsd: null, status: 'reserved'});
    await putJson(`${P}/ledger.json`, ledger);
  });
}
const settle = (key: string, actualUsd: number | null, status: 'committed' | 'released') => serial(async () => { const e = ledger.entries.find(x => x.key === key && x.status === 'reserved'); if (e) { e.actualUsd = actualUsd; e.status = status; await putJson(`${P}/ledger.json`, ledger); } });

// ---------------- telemetry ----------------
type Attempt = {attemptId: string; assetId: string; usedInShots: string[]; stage: string; provider: string; model: string; productionMethod: string; shotClass: string; characters: string[]; motionComplexity: string; generatedSeconds: number; requestedSeconds?: number; costUsd: number; costBasis: string; latencySeconds: number; attempt: number; qa: {result: 'PASS' | 'FAIL' | 'PENDING'; layer?: string; failureReasons?: string[]; notes?: string}; failureKind?: string; fallbackUsed: string; finalApproved: boolean; outputSha256?: string; createdAt: string};
const tele = (a: Attempt) => putJson(`${P}/telemetry/${a.attemptId}.json`, a);

// ---------------- shared inputs ----------------
type Asset = {imagePrompt: string; references: string[]; characters: string[]; animationPrompt: string | null; clipSeconds: number; imageRevision?: string; animationRevision?: string};
type AssetsDoc = {style: string; bible: Record<string, string>; assets: Record<string, Asset>};
type SbShot = PlanShot & {id: string; beat: string; src: string; sec: number; productionMethod: string; shotClass: string; origin: string; reuse?: boolean; chars?: string; visual: string; cue: string};
type Storyboard = {shots: SbShot[]; beatSeconds: Record<string, number>};
type Script = {beats: {id: string; label: string; narration: string}[]; onScreenNotice: string; endCard: string};
const slotsFor = (sb: Storyboard, asset: string) => sb.shots.filter(s => s.src === asset).map(s => s.id);
const classFor = (sb: Storyboard, asset: string) => sb.shots.find(s => s.src === asset)?.shotClass ?? 'other';
const imgRev = (a: Asset) => a.imageRevision || 'v1';
const clipRev = (a: Asset) => a.animationRevision || 'v1';
const stillPath = (id: string, a: Asset) => `${P}/stills/${id}-${imgRev(a)}.png`;

async function refBuffer(ref: string, doc: AssetsDoc): Promise<Buffer> {
  const [kind, id] = ref.split(':');
  if (kind === 'pilot') { const b = await read(`dulce-001/samples/pilot/ai/dulce-${id}-v1-still.png`); if (!b) throw Error('Missing pilot ref ' + id); return b; }
  if (kind === 'v1') { const b = await read(`${V1}/refs/${id}.png`); if (!b) throw Error('Missing V1 ref ' + id); return b; }
  if (kind === 'asset') { const a = doc.assets[id]; const b = await read(stillPath(id, a)); const rv = await read(`${P}/reviews/still-${id}.json`); if (!b || !rv || JSON.parse(rv.toString()).sha256 !== sha(b)) throw Error(`Reference ${id} must be generated and approved first`); return b; }
  throw Error('Unknown reference ' + ref);
}

// ---------------- ElevenLabs ----------------
const XI = process.env.ELEVENLABS_API_KEY || '';
async function xi<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch('https://api.elevenlabs.io' + p, {...init, headers: {'xi-api-key': XI, 'Content-Type': 'application/json', ...(init?.headers || {})}});
  if (!r.ok) throw Error(`ElevenLabs ${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json() as Promise<T>;
}
async function quotaRemaining() { const s = await xi<{character_count: number; character_limit: number; tier: string}>('/v1/user/subscription'); return {remaining: s.character_limit - s.character_count, used: s.character_count, limit: s.character_limit, tier: s.tier}; }
/** COGS of ElevenLabs characters: the marginal price of the owner's top-up (USD 5 for 25,000 credits). */
const XI_USD_PER_CHAR = 5 / 25000;
type VoiceSetup = {voiceId: string; dictionary: {id: string; versionId: string}; at: string};
async function voiceSetup(): Promise<VoiceSetup> { const b = await read(`${P}/voice/setup.json`); if (!b) throw Error('Run the setup stage first'); return JSON.parse(b.toString()); }
type Tts = {audio: Buffer; words: WordTiming[]; seconds: number; latency: number};
async function tts(text: string, vs: VoiceSetup, prev?: string, next?: string): Promise<Tts> {
  const t0 = Date.now();
  const r = await xi<{audio_base64: string; alignment: {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}}>(`/v1/text-to-speech/${vs.voiceId}/with-timestamps`, {method: 'POST', body: JSON.stringify({
    text, model_id: MODEL, voice_settings: VOICE_SETTINGS, previous_text: prev, next_text: next,
    pronunciation_dictionary_locators: [{pronunciation_dictionary_id: vs.dictionary.id, version_id: vs.dictionary.versionId}]})});
  const al = r.alignment, words: WordTiming[] = []; let cur: {c: string[]; s: number; e: number} | null = null;
  al.characters.forEach((ch, i) => { if (/\s/.test(ch)) { if (cur) words.push({text: cur.c.join(''), startSeconds: cur.s, endSeconds: cur.e}); cur = null; return; } if (!cur) cur = {c: [ch], s: al.character_start_times_seconds[i], e: al.character_end_times_seconds[i]}; else { cur.c.push(ch); cur.e = al.character_end_times_seconds[i]; } });
  if (cur) { const c = cur as {c: string[]; s: number; e: number}; words.push({text: c.c.join(''), startSeconds: c.s, endSeconds: c.e}); }
  const audio = Buffer.from(r.audio_base64, 'base64');
  const f = path.join(out, `tts-${Date.now()}.mp3`); await fs.writeFile(f, audio); const seconds = await probeDuration(f); await fs.unlink(f);
  return {audio, words, seconds, latency: (Date.now() - t0) / 1000};
}
/** Script words with alignment timings; if the aligner split a word differently, spread by character length. */
function subtitleWords(text: string, aligned: WordTiming[]): WordTiming[] {
  try { return scriptWordsWithTimings(text, aligned); } catch {
    const ws = text.split(/\s+/).filter(Boolean), total = ws.reduce((a, w) => a + w.length, 0);
    const s0 = aligned[0]?.startSeconds ?? 0, s1 = aligned.at(-1)?.endSeconds ?? 0; let acc = 0;
    return ws.map(w => { const a = s0 + (s1 - s0) * acc / total; acc += w.length; return {text: w, startSeconds: a, endSeconds: s0 + (s1 - s0) * acc / total}; });
  }
}

// ---------------- stages ----------------
async function setup() {
  const voices = await xi<{voices: {voice_id: string; name: string}[]}>('/v1/voices');
  let voiceId = voices.voices.find(v => v.voice_id === DAVID.voiceId || v.name === DAVID.name)?.voice_id;
  if (!voiceId) voiceId = (await xi<{voice_id: string}>(`/v1/voices/add/${DAVID.publicOwnerId}/${DAVID.voiceId}`, {method: 'POST', body: JSON.stringify({new_name: DAVID.name})})).voice_id;
  const prior = await read(`${P}/voice/setup.json`);
  let dictionary = prior ? (JSON.parse(prior.toString()) as VoiceSetup).dictionary : null;
  if (!dictionary) {
    const d = await xi<{id: string; version_id: string}>('/v1/pronunciation-dictionaries/add-from-rules', {method: 'POST', body: JSON.stringify({name: 'dulce-part1', rules: ALIASES.map(([string_to_replace, alias]) => ({type: 'alias', string_to_replace, alias}))})});
    dictionary = {id: d.id, versionId: d.version_id};
  }
  const setupRec: VoiceSetup = {voiceId, dictionary, at: new Date().toISOString()};
  await putJson(`${P}/voice/setup.json`, setupRec);
  const q = await quotaRemaining();
  await fs.writeFile(path.join(out, 'setup.json'), JSON.stringify({...setupRec, ...q}, null, 2));
  log('SETUP', {...setupRec, ...q});
}

const TEST_TEXT = 'Near Dulce, New Mexico, a man named Thomas Edwin Castello told a strange story. Paul Bennewitz heard another. Some workers called it Nightmare Hall.';
async function voiceTest() {
  const vs = await voiceSetup(); const q = await quotaRemaining();
  if (q.remaining < TEST_TEXT.length) throw Error(`Quota ${q.remaining} < ${TEST_TEXT.length}`);
  const t = await tts(TEST_TEXT, vs);
  const p = `${P}/voice/pronunciation-test.mp3`; await put(p, t.audio, 'audio/mpeg');
  await fs.writeFile(path.join(out, 'pronunciation-test.mp3'), t.audio);
  const url = await sign(p);
  await tele({attemptId: `voice-test-${Date.now()}`, assetId: 'voice-test', usedInShots: [], stage: 'voice', provider: 'elevenlabs', model: MODEL, productionMethod: 'tts', shotClass: 'audio', characters: ['David'], motionComplexity: 'n/a', generatedSeconds: t.seconds, costUsd: 0, costBasis: `quota-characters:${TEST_TEXT.length}`, latencySeconds: t.latency, attempt: 1, qa: {result: 'PENDING', layer: 'L2 listening'}, fallbackUsed: 'none', finalApproved: false, outputSha256: sha(t.audio), createdAt: new Date().toISOString()});
  await fs.writeFile(path.join(out, 'pronunciation-test.json'), JSON.stringify({text: TEST_TEXT, words: t.words, seconds: t.seconds, url, quotaBefore: q.remaining}, null, 2));
  log('VOICE_TEST', {seconds: t.seconds, words: t.words.length, chars: TEST_TEXT.length});
}

async function narrate() {
  const vs = await voiceSetup(); const script = await readJson<Script>('content/long-form/dulce-part1/script-en.json');
  const todo = [];
  for (const b of script.beats) if (!(await read(`${P}/narration/${b.id}.json`))) todo.push(b);
  const need = todo.reduce((a, b) => a + b.narration.length, 0); const q = await quotaRemaining();
  log('NARRATE_PLAN', {beatsToGenerate: todo.length, chars: need, quota: q});
  if (need > q.remaining) throw Error(`ElevenLabs quota ${q.remaining} < ${need} characters needed: add credits before narration`);
  if (!todo.length) return;
  const key = `tts-narration-${Date.now()}`; await reserve(key, 'tts', Math.round(need * XI_USD_PER_CHAR * 1.1 * 1e4) / 1e4);
  const all = script.beats;
  try {
  for (const b of todo) {
    const i = all.findIndex(x => x.id === b.id);
    const t = await tts(b.narration, vs, all[i - 1]?.narration, all[i + 1]?.narration);
    await put(`${P}/narration/${b.id}.mp3`, t.audio, 'audio/mpeg');
    const rec = {beatId: b.id, seconds: t.seconds, sha256: sha(t.audio), words: subtitleWords(b.narration, t.words), alignedWords: t.words.length, scriptWords: b.narration.split(/\s+/).filter(Boolean).length, voiceId: vs.voiceId, model: MODEL, settings: VOICE_SETTINGS, dictionary: vs.dictionary, at: new Date().toISOString()};
    await putJson(`${P}/narration/${b.id}.json`, rec);
    await tele({attemptId: `voice-${b.id}`, assetId: `narration-${b.id}`, usedInShots: [], stage: 'voice', provider: 'elevenlabs', model: MODEL, productionMethod: 'tts', shotClass: 'audio', characters: ['David'], motionComplexity: 'n/a', generatedSeconds: t.seconds, costUsd: Math.round(b.narration.length * XI_USD_PER_CHAR * 1e5) / 1e5, costBasis: `characters:${b.narration.length}@${XI_USD_PER_CHAR}`, latencySeconds: t.latency, attempt: 1, qa: {result: 'PENDING'}, fallbackUsed: 'none', finalApproved: true, outputSha256: rec.sha256, createdAt: rec.at});
    log('VOICE', {beat: b.id, seconds: t.seconds, aligned: rec.alignedWords, script: rec.scriptWords});
  }
  } finally {
    // Settle on the characters the account actually consumed (measured), never on the top-up amount.
    const after = await quotaRemaining().catch(() => null); const chars = after ? after.used - q.used : need;
    const usd = Math.round(Math.max(0, chars) * XI_USD_PER_CHAR * 1e5) / 1e5;
    await settle(key, usd, 'committed'); log('NARRATE_COST', {characters: chars, usd});
    await fs.writeFile(path.join(out, 'narration-cost.json'), JSON.stringify({characters: chars, usdPerCharacter: XI_USD_PER_CHAR, usd, before: q, after}, null, 2));
  }
}

async function images() {
  const doc = await readJson<AssetsDoc>('content/long-form/dulce-part1/assets.json'); const sb = await readJson<Storyboard>('content/long-form/dulce-part1/storyboard.json');
  if (!wanted.length || wanted.length > 18) throw Error('Select 1-18 assets');
  const tiles: {image: Buffer; label: string}[] = []; let next = 0; const errors: unknown[] = []; let halted = false;
  const make = async (id: string) => {
    const a = doc.assets[id]; if (!a) throw Error('Unknown asset ' + id);
    const dest = stillPath(id, a); let bytes = await read(dest);
    if (!bytes) {
      const refs: Buffer[] = []; for (const r of a.references) refs.push(await refBuffer(r, doc));
      const bible = a.characters.map(c => doc.bible[c]).filter(Boolean).join('\n');
      const prompt = `${a.imagePrompt}\n${bible}\n${doc.style}\nAttached references: ${a.references.join(', ') || 'none'}. Use them only for identity, wardrobe and setting. Depict exactly the people described, no one else. Single frame, not a collage.`;
      const key = `image-${id}-${imgRev(a)}`; await reserve(key, 'image', IMAGE_MAX);
      const t0 = Date.now(); const headers: Record<string, string> = {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`};
      let body: FormData | string;
      if (refs.length) { const f = new FormData(); f.set('model', 'gpt-image-2'); f.set('prompt', prompt); f.set('size', '1536x1024'); f.set('quality', 'medium'); f.set('n', '1'); refs.forEach((b, i) => f.append('image[]', new Blob([new Uint8Array(b)], {type: 'image/png'}), `ref-${i}.png`)); body = f; }
      else { headers['Content-Type'] = 'application/json'; body = JSON.stringify({model: 'gpt-image-2', prompt, size: '1536x1024', quality: 'medium', n: 1}); }
      const r = await fetch('https://api.openai.com/v1/images/' + (refs.length ? 'edits' : 'generations'), {method: 'POST', headers, body, signal: AbortSignal.timeout(240000)});
      if (!r.ok) { const detail = await r.text(); await putJson(`${P}/errors/${key}.json`, {status: r.status, detail}); if (r.status >= 400 && r.status < 500) await settle(key, 0, 'released'); throw Error(`Image ${id} HTTP ${r.status} ${detail.slice(0, 200)}`); }
      const res = await r.json() as {data?: {b64_json?: string}[]; usage?: {input_tokens?: number; output_tokens?: number; input_tokens_details?: {text_tokens?: number; image_tokens?: number}}};
      if (!res.data?.[0]?.b64_json) throw Error('Image response without bytes; cost uncertain, claim kept');
      bytes = Buffer.from(res.data[0].b64_json, 'base64'); await put(dest, bytes, 'image/png');
      const u = res.usage; const cost = u && Number.isFinite(u.output_tokens) ? ((u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0) * 5 + (u.input_tokens_details?.image_tokens ?? 0) * 10 + (u.output_tokens ?? 0) * 40) / 1e6 : IMAGE_MAX;
      await settle(key, Math.round(cost * 1e5) / 1e5, 'committed');
      await tele({attemptId: key, assetId: id, usedInShots: slotsFor(sb, id), stage: 'image', provider: 'openai', model: 'gpt-image-2', productionMethod: 'still', shotClass: classFor(sb, id), characters: a.characters, motionComplexity: 'n/a', generatedSeconds: 0, costUsd: cost, costBasis: u ? 'usage-estimate' : 'reservation-max', latencySeconds: (Date.now() - t0) / 1000, attempt: Number(imgRev(a).slice(1)) || 1, qa: {result: 'PENDING', layer: 'pre-generation still review'}, fallbackUsed: 'none', finalApproved: false, outputSha256: sha(bytes), createdAt: new Date().toISOString()});
    }
    await fs.writeFile(path.join(out, `${id}.jpg`), await sharp(bytes).jpeg({quality: 92}).toBuffer());
    tiles.push({image: bytes, label: `${id} ${imgRev(a)} ${sha(bytes).slice(0, 8)}`});
    log('IMAGE', {id, sha256: sha(bytes)});
  };
  // The first image runs alone: if the account has no quota, the batch stops after one rejected (unbilled) call.
  { const id = wanted[next++]; try { await make(id); } catch (e) { errors.push(e); halted = true; log('IMAGE_ERROR', {id, error: e instanceof Error ? e.message : String(e)}); } }
  await Promise.all(Array.from({length: Math.min(3, wanted.length)}, async () => { while (next < wanted.length && !halted) { const id = wanted[next++]; try { await make(id); } catch (e) { errors.push(e); const m = e instanceof Error ? e.message : String(e); if (/insufficient_quota|billing/i.test(m)) halted = true; log('IMAGE_ERROR', {id, error: m}); } } }));
  tiles.sort((x, y) => x.label.localeCompare(y.label));
  if (tiles.length) await fs.writeFile(path.join(out, 'stills-review.jpg'), await buildContactSheet(tiles, {columns: 3, tileWidth: 512, tileHeight: 341, title: 'Dulce Part I - stills awaiting review'}));
  await fs.writeFile(path.join(out, 'ledger.json'), JSON.stringify({exposureUsd: exposureUsd(ledger.entries), ledger}, null, 2));
  if (errors.length) throw errors[0];
}

async function approve() {
  const doc = await readJson<AssetsDoc>('content/long-form/dulce-part1/assets.json');
  const list = await readJson<{asset: string; sha256: string; note: string}[]>('content/long-form/dulce-part1/approved-stills.json');
  for (const x of list) {
    const a = doc.assets[x.asset]; const b = await read(stillPath(x.asset, a));
    if (!b || sha(b) !== x.sha256) throw Error('Approval checksum mismatch ' + x.asset);
    await putJson(`${P}/reviews/still-${x.asset}.json`, {...x, revision: imgRev(a), status: 'approved', reviewer: 'assistant visual inspection', at: new Date().toISOString()});
    const t = await read(`${P}/telemetry/image-${x.asset}-${imgRev(a)}.json`); if (t) { const r = JSON.parse(t.toString()); r.qa = {result: 'PASS', layer: 'pre-generation still review', notes: x.note}; r.finalApproved = true; await putJson(`${P}/telemetry/image-${x.asset}-${imgRev(a)}.json`, r); }
  }
  const rej = await readJson<{asset: string; sha256: string; reasons: string[]; note: string}[]>('content/long-form/dulce-part1/rejected-stills.json').catch(() => []);
  for (const x of rej) { const a = doc.assets[x.asset]; const t = await read(`${P}/telemetry/image-${x.asset}-${imgRev(a)}.json`); if (t) { const r = JSON.parse(t.toString()); if (r.outputSha256 === x.sha256) { r.qa = {result: 'FAIL', layer: 'pre-generation still review', failureReasons: x.reasons, notes: x.note}; r.failureKind = 'semantic'; await putJson(`${P}/telemetry/${r.attemptId}.json`, r); } } }
  log('APPROVED', {stills: list.length, rejected: rej.length});
}

async function animate() {
  const doc = await readJson<AssetsDoc>('content/long-form/dulce-part1/assets.json'); const sb = await readJson<Storyboard>('content/long-form/dulce-part1/storyboard.json');
  if (!wantedClips.length || wantedClips.length > 13) throw Error('Select 1-13 B+ assets');
  const provider = getVideoProvider('runway'); if (provider.name !== 'runway') throw Error('Runway unavailable');
  const durable = wrapDurableVideoProvider(provider, {supabase: service, scopeId: SCOPE, executionMode: 'real', maxInAttemptResumes: 2, beforeSubmit: async req => { await reserve(req.metadata!.claimKey as string, 'video', req.maxCostUsd); return true; }});
  const sheets: {image: Buffer; label: string}[] = []; let next = 0; const errors: unknown[] = [];
  const make = async (id: string) => {
    const a = doc.assets[id]; if (!a?.animationPrompt || !a.clipSeconds) throw Error(`${id} is not a B+ generative asset`);
    const still = await read(stillPath(id, a)); const rv = await read(`${P}/reviews/still-${id}.json`);
    if (!still || !rv || JSON.parse(rv.toString()).sha256 !== sha(still)) throw Error(`Still ${id} is not approved: never animate an unreviewed image`);
    const jpeg = await sharp(still).resize(1280, 720, {fit: 'cover', position: 'centre'}).jpeg({quality: 92}).toBuffer();
    const rev = clipRev(a), recordKey = `${id}-${rev}`, claimKey = `video-${id}-${rev}`, t0 = Date.now();
    const maxCostUsd = a.clipSeconds * SEC_USD;
    const asset = await durable.generateVideo({prompt: a.animationPrompt, aspectRatio: '16:9', durationSeconds: a.clipSeconds, maxCostUsd, referenceImageUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), metadata: {shotId: recordKey, videoId: P, claimKey}});
    const file = path.join(out, `${id}.mp4`); await fs.writeFile(file, asset.buffer);
    const seconds = await probeDuration(file);
    const claim = ledger.entries.find(e => e.key === claimKey); if (claim && claim.status === 'reserved') await settle(claimKey, maxCostUsd, 'committed');
    const l1 = await l1Qa(file);
    await tele({attemptId: claimKey, assetId: id, usedInShots: slotsFor(sb, id), stage: 'animation', provider: 'runway', model: asset.model || 'gen4_turbo', productionMethod: a.clipSeconds === 10 ? 'i2v_hero' : 'i2v_economy', shotClass: classFor(sb, id), characters: a.characters, motionComplexity: a.characters.length ? 'micro-gesture' : 'camera-only', generatedSeconds: seconds, requestedSeconds: a.clipSeconds, costUsd: maxCostUsd, costBasis: 'fixed-price', latencySeconds: (Date.now() - t0) / 1000, attempt: Number(rev.slice(1)) || 1, qa: {result: 'PENDING', layer: 'L1 local + L2 temporal sheet', notes: JSON.stringify(l1)}, fallbackUsed: 'none', finalApproved: false, outputSha256: sha(asset.buffer), createdAt: new Date().toISOString()});
    const tiles = []; for (let k = 0; k < 12; k++) { const t = 0.1 + (seconds - 0.3) * k / 11; tiles.push({image: await frameAt(file, t, 480), label: `${id} ${t.toFixed(1)}s`}); }
    await fs.writeFile(path.join(out, `${id}-temporal.jpg`), await buildContactSheet(tiles, {columns: 4, tileWidth: 480, tileHeight: 270, title: `${id} ${rev} - 12 frames across the clip; L1 ${JSON.stringify(l1).slice(0, 90)}`}));
    sheets.push({image: await frameAt(file, seconds / 2, 480), label: `${id} ${rev}`});
    await fs.writeFile(path.join(out, `${id}.json`), JSON.stringify({id, rev, sha256: sha(asset.buffer), seconds, providerJobId: asset.providerJobId, l1}, null, 2));
    log('CLIP', {id, rev, seconds, l1});
  };
  await Promise.all(Array.from({length: Math.min(3, wantedClips.length)}, async () => { while (next < wantedClips.length) { const id = wantedClips[next++]; try { await make(id); } catch (e) { errors.push(e); log('CLIP_ERROR', {id, error: e instanceof Error ? e.message : String(e)}); } } }));
  await fs.writeFile(path.join(out, 'ledger.json'), JSON.stringify({exposureUsd: exposureUsd(ledger.entries), ledger}, null, 2));
  if (errors.length) throw errors[0];
}

/** L1 local QA: scene-change spikes, black, freeze, face-count changes (OpenCV Haar). Flags only; review decides. */
async function l1Qa(file: string) {
  const det = await run('ffmpeg', ['-i', file, '-vf', "scdet=threshold=18,blackdetect=d=0.3:pix_th=0.06,freezedetect=n=-60dB:d=1.5", '-f', 'null', '-']);
  const cuts = [...det.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map(m => Number(m[1]));
  const black = /black_start/.test(det), freeze = /freeze_start/.test(det);
  let faces: number[] = [];
  try { const o = await new Promise<string>((res, rej) => { const p = spawn('python3', ['scripts/lib/dulce-qa-faces.py', file]); let s = ''; p.stdout.on('data', c => s += c); p.on('close', c => c === 0 ? res(s) : rej(Error('faces'))); }); faces = JSON.parse(o).counts; } catch { faces = []; }
  const faceChanges = faces.reduce((a, c, i) => a + (i && c !== faces[i - 1] ? 1 : 0), 0);
  return {abruptChanges: cuts, black, freeze, faceCounts: faces, faceChanges, flagged: cuts.length > 0 || black || freeze || faceChanges > 2};
}

async function clipReview() {
  const list = await readJson<{asset: string; sha256: string; result: 'PASS' | 'FAIL'; reasons?: string[]; note: string; revision?: string; usableUntil?: number; fallback?: string}[]>('content/long-form/dulce-part1/approved-clips.json');
  for (const x of list) {
    const rev = x.revision || 'v1';
    if (x.reasons?.includes('provider-no-output')) {
      // The provider ended the task without a video: no output to review. Count the attempt as spent (conservative).
      const key = `video-${x.asset}-${rev}`; const e = ledger.entries.find(y => y.key === key); if (e && e.status === 'reserved') await settle(key, e.maxUsd, 'committed');
      await tele({attemptId: key, assetId: x.asset, usedInShots: [], stage: 'animation', provider: 'runway', model: 'gen4_turbo', productionMethod: 'i2v_economy', shotClass: 'single_human', characters: ['Thomas'], motionComplexity: 'micro-gesture', generatedSeconds: 0, costUsd: e?.maxUsd ?? 0.25, costBasis: 'reservation-max (refund unknown)', latencySeconds: 0, attempt: Number(rev.slice(1)) || 1, qa: {result: 'FAIL', failureReasons: x.reasons, notes: x.note}, failureKind: 'transport', fallbackUsed: x.fallback || 'approved-still-camera-motion', finalApproved: false, createdAt: new Date().toISOString()});
      continue;
    }
    const rec = await readAiVideoClipRecord(service, 'videos', SCOPE, `${x.asset}-${rev}`);
    if (rec?.status !== 'COMPLETED' || rec.checksumSha256 !== x.sha256) throw Error('Clip checksum mismatch ' + x.asset);
    await putJson(`${P}/reviews/clip-${x.asset}-${rev}.json`, {...x, revision: rev, at: new Date().toISOString(), reviewer: 'assistant temporal inspection'});
    const t = await read(`${P}/telemetry/video-${x.asset}-${rev}.json`); if (t) { const r = JSON.parse(t.toString()); r.qa = {...r.qa, result: x.result, failureReasons: x.reasons, notes: x.note}; r.failureKind = x.result === 'FAIL' ? 'semantic' : 'none'; r.finalApproved = x.result === 'PASS'; await putJson(`${P}/telemetry/${r.attemptId}.json`, r); }
  }
  log('CLIP_REVIEW', {clips: list.length});
}

async function status() {
  const q = XI ? await quotaRemaining().catch(e => ({error: String(e)})) : null;
  // Free: listing models proves the key is valid; billing quota is only proven by the first (unbilled if rejected) image call.
  const oa = process.env.OPENAI_API_KEY ? await fetch('https://api.openai.com/v1/models/gpt-image-2', {headers: {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`}}).then(async r => ({status: r.status, body: r.ok ? 'ok' : (await r.text()).slice(0, 300)})).catch(e => ({error: String(e)})) : null;
  const topups = await readJson('content/long-form/dulce-part1/provider-balance.json').catch(() => null);
  await fs.writeFile(path.join(out, 'status.json'), JSON.stringify({cogsExposureUsd: exposureUsd(ledger.entries), capUsd: HARD_CAP_USD, elevenlabs: q, openaiKey: oa, providerTopups: topups, ledger}, null, 2));
  log('STATUS', {cogsExposureUsd: exposureUsd(ledger.entries), elevenlabs: q, openaiKey: oa});
}

async function main() {
  await fs.mkdir(out, {recursive: true});
  await loadLedger();
  // Stages run in the order given (e.g. "clip-review,images"); the first failure stops the rest.
  for (const s of stage.split(',')) {
    log('STAGE', {stage: s});
    if (s === 'setup') await setup();
    else if (s === 'voice-test') await voiceTest();
    else if (s === 'narrate') await narrate();
    else if (s === 'images') await images();
    else if (s === 'approve') await approve();
    else if (s === 'animate') await animate();
    else if (s === 'clip-review') await clipReview();
    else if (s === 'render') { const {render} = await import('./dulce-part1-render'); await render({service, bucket, read, put, putJson, sign, run, out, ledger}); }
    else await status();
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Dulce Part I stopped'); process.exitCode = 1; });
export type Ctx = {service: typeof service; bucket: typeof bucket; read: typeof read; put: typeof put; putJson: typeof putJson; sign: typeof sign; run: typeof run; out: string; ledger: {entries: LedgerEntry[]}};
