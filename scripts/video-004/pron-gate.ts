/** Video #004 V3 pronunciation gate (G1–G3 only). Generates the three manifest samples with the V2 voice
 * settings, WITHOUT the shared pronunciation dictionary (simply not attached per request; nothing shared is
 * edited), with previous_text/next_text as API context, one call each, no retries. Hard limits are checked
 * BEFORE the first call. Writes only under videos/video-004-thermopylae/v3/pron-gate/. V2 is hashed before
 * and after. Usage (runner only): V4_V2=true V4_ALLOW_PAID=true npx tsx scripts/video-004/pron-gate.ts */
import fs from 'node:fs/promises';
import path from 'node:path';
import {MODEL, VOICE_SETTINGS, XI_USD_PER_CHAR} from './plan';
import {P, out, probe, put, putJson, read, readJsonStore, reserve, run, settle, sha, sign, loadLedger, exposure, opKey} from './shared';
import manifest from '../../content/productions/video-004-thermopylae/v3/pronunciation-manifest.json';

const MAX_CHARS = 450, MAX_USD = 0.09, V2_SHA = 'eca494aa3881204724c7a9211f7eebc08893ffb3caa3ed587fe626ba4e236b10';
const XI = process.env.ELEVENLABS_API_KEY || '';
const DIR = `${P}/v3/pron-gate`;
type Sample = {sampleId: string; name: string; test_phrase: string; tts_text: string; context: {previous_text: string; next_text: string}; characters: number};

async function xi<T>(p: string, init?: RequestInit): Promise<T> { const r = await fetch('https://api.elevenlabs.io' + p, {...init, headers: {'xi-api-key': XI, 'Content-Type': 'application/json', ...(init?.headers || {})}}); if (!r.ok) throw Error(`ElevenLabs ${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json() as Promise<T>; }
const quota = async () => { const s = await xi<{character_count: number; character_limit: number}>('/v1/user/subscription'); return {remaining: s.character_limit - s.character_count, used: s.character_count, limit: s.character_limit}; };
async function v2Hash(): Promise<string> { const man = await readJsonStore<{parts: string[]; sha256: string}>(`${P}/final-v2/manifest.json`); if (!man) throw Error('V2 manifest missing'); const chunks: Buffer[] = []; for (const p of man.parts) { const b = await read(p); if (!b) throw Error('V2 part missing ' + p); chunks.push(b); } return sha(Buffer.concat(chunks)); }
function envelope(pcm: Buffer): number[] { const n = pcm.length / 2, w = 160, outv: number[] = []; for (let i = 0; i + w <= n; i += w) { let acc = 0; for (let k = 0; k < w; k++) { const v = pcm.readInt16LE((i + k) * 2) / 32768; acc += v * v; } const r = Math.sqrt(acc / w); outv.push(r > 0 ? 20 * Math.log10(r) : -100); } return outv; }

async function main() {
  await fs.mkdir(out, {recursive: true}); await loadLedger();
  const samples = (manifest as {dryGate: {samples: Sample[]}}).dryGate.samples;
  const chars = samples.reduce((a, s) => a + s.tts_text.length, 0); const projected = Math.round(chars * XI_USD_PER_CHAR * 1e4) / 1e4;
  console.log('@@V4_GATE_PLAN ' + JSON.stringify({samples: samples.map((s) => ({id: s.sampleId, chars: s.tts_text.length})), chars, projectedUsd: projected, maxChars: MAX_CHARS, maxUsd: MAX_USD, exposureUsd: exposure()}));
  if (chars > MAX_CHARS || projected > MAX_USD) { console.log('@@V4_GATE_STOP PRONUNCIATION_GATE_COST_BLOCKER'); return; }
  const hashBefore = await v2Hash(); console.log('@@V4_V2_HASH_BEFORE ' + hashBefore); if (hashBefore !== V2_SHA) throw Error('V2 hash mismatch before the gate');
  const voiceSetup = await readJsonStore<{voiceId: string}>(`${P}/voice/setup.json`); if (!voiceSetup) throw Error('voice setup missing');
  const before = await quota();
  // Single reservation for the whole gate (maximum cost), settled on the measured character delta.
  const key = 'tts-pron-gate-v3';
  await reserve({key, opKey: opKey({shotId: 'pron-gate', provider: 'elevenlabs', model: MODEL, method: 'tts', inputFingerprint: sha(samples.map((s) => s.tts_text).join('\n')), attemptOrdinal: 1}), kind: 'tts', provider: 'elevenlabs', shotId: null, maxUsd: MAX_USD, reason: 'V3 pronunciation gate G1-G3 (authorized: 450 chars / USD 0.09)'});
  const results: Record<string, unknown>[] = []; const files: string[] = []; let calls = 0;
  try {
    for (const s of samples) {
      const t0 = Date.now(); let rec: Record<string, unknown> = {sampleId: s.sampleId, name: s.name, display_text: s.test_phrase, tts_text: s.tts_text, characters: s.tts_text.length};
      try {
        calls++;
        const r = await xi<{audio_base64: string; alignment: {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}}>(`/v1/text-to-speech/${voiceSetup.voiceId}/with-timestamps?output_format=mp3_44100_128`, {method: 'POST', body: JSON.stringify({text: s.tts_text, model_id: MODEL, voice_settings: VOICE_SETTINGS, previous_text: s.context.previous_text, next_text: s.context.next_text})}); // no pronunciation_dictionary_locators: dictionary isolated per request
        const audio = Buffer.from(r.audio_base64, 'base64'); const f = path.join(out, `${s.sampleId}.mp3`); await fs.writeFile(f, audio); files.push(f);
        const pr = await probe(f);
        // word timings from the character alignment
        const al = r.alignment; const words: {text: string; start: number; end: number}[] = []; let cur: {c: string[]; s: number; e: number} | null = null;
        al.characters.forEach((ch, i) => { if (/\s/.test(ch)) { if (cur) words.push({text: cur.c.join(''), start: cur.s, end: cur.e}); cur = null; return; } if (!cur) cur = {c: [ch], s: al.character_start_times_seconds[i], e: al.character_end_times_seconds[i]}; else { cur.c.push(ch); cur.e = al.character_end_times_seconds[i]; } }); if (cur) { const c = cur as {c: string[]; s: number; e: number}; words.push({text: c.c.join(''), start: c.s, end: c.e}); }
        // internal pauses inside the target (respelled) names on the RMS envelope
        const pcmFile = path.join(out, `${s.sampleId}.pcm`); await run('ffmpeg', ['-y', '-i', f, '-ac', '1', '-ar', '16000', '-f', 's16le', pcmFile]); const env = envelope(await fs.readFile(pcmFile));
        const targets = words.filter((w) => /thermopilee|efialtees|trakis|thespiee|focians|locrians|myseenee/i.test(w.text)).map((w) => { const a = Math.round(w.start * 100), b = Math.round(w.end * 100); const seg = env.slice(a, b); const idx = seg.map((v, i) => (v > -38 ? i : -1)).filter((i) => i >= 0); const voiced = idx.length ? (idx[idx.length - 1] - idx[0] + 1) / 100 : 0; let runN = 0; const dips: number[] = []; for (const v of seg.slice(idx[0] + 3, (idx[idx.length - 1] ?? 0) - 3)) { if (v < -38) runN++; else { if (runN >= 9) dips.push(runN * 10); runN = 0; } } if (runN >= 9) dips.push(runN * 10); return {word: w.text, start: +w.start.toFixed(2), end: +w.end.toFixed(2), voicedSec: +voiced.toFixed(2), internalPausesMs: dips}; });
        const sil = await run('ffmpeg', ['-i', f, '-af', 'silencedetect=n=-40dB:d=0.5', '-f', 'null', '-']).catch(() => '');
        const longSilences = [...sil.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
        rec = {...rec, status: 'GENERATED', seconds: pr.duration, format: {codec: pr.codec ?? 'mp3', sampleRate: 44100, channels: pr.channels, bitrateKbps: 128}, words, targets, longSilences, latencySeconds: (Date.now() - t0) / 1000, sha256: sha(audio), technical: targets.every((t) => t.internalPausesMs.length === 0) && longSilences.length === 0 ? 'PASS' : 'FAIL'};
        await put(`${DIR}/${s.sampleId}.mp3`, audio, 'audio/mpeg');
      } catch (e) { rec = {...rec, status: 'FAIL', error: e instanceof Error ? e.message : String(e), technical: 'FAIL'}; }
      results.push(rec); await putJson(`${DIR}/${s.sampleId}.json`, rec); console.log('@@V4_GATE_SAMPLE ' + JSON.stringify({id: s.sampleId, status: rec.status, seconds: rec.seconds, technical: rec.technical, targets: rec.targets}));
    }
  } finally {
    const after = await quota(); const used = Math.max(0, after.used - before.used); const usd = Math.round(used * XI_USD_PER_CHAR * 1e5) / 1e5;
    await settle(key, usd, 'committed');
    // Review MP3: G1 + 1 s silence + G2 + 1 s silence + G3, silence synthesised locally, 44.1 kHz / 128 kbps / mono.
    let review: Record<string, unknown> | null = null;
    if (files.length) {
      const inputs: string[] = []; const parts: string[] = [];
      files.forEach((f, i) => { inputs.push('-i', f); parts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=mono[a${i}]`); });
      const chain = files.map((_, i) => (i ? `[a${i - 1}s]` : '') + `[a${i}]`).join('');
      const g: string[] = [...parts]; for (let i = 1; i < files.length; i++) g.push(`anullsrc=r=44100:cl=mono:d=1[s${i}]`);
      const seq = files.map((_, i) => (i ? `[s${i}][a${i}]` : '[a0]')).join(''); g.push(`${seq}concat=n=${files.length * 2 - 1}:v=0:a=1[o]`);
      const rf = path.join(out, 'pron-gate-review.mp3'); await run('ffmpeg', ['-y', ...inputs, '-filter_complex', g.join(';'), '-map', '[o]', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', rf]);
      const rb = await fs.readFile(rf); const rp = await probe(rf); const dest = `${DIR}/pron-gate-review.mp3`; await put(dest, rb, 'audio/mpeg'); const url = await sign(dest, 8);
      const get = await fetch(url); const body = Buffer.from(await get.arrayBuffer()); const range = await fetch(url, {headers: {Range: 'bytes=0-1023'}});
      review = {url, expiresAt: new Date(Date.now() + 8 * 86400000).toISOString(), bytes: rb.length, seconds: rp.duration, sampleRate: 44100, channels: rp.channels, bitrateKbps: 128, check: {get: get.status, contentType: get.headers.get('content-type'), bytesMatch: body.length === rb.length && sha(body) === sha(rb), range: range.status, acceptRanges: range.headers.get('accept-ranges')}};
      void chain;
    }
    const hashAfter = await v2Hash();
    const report = {status: 'THERMOPYLAE_V3_PRONUNCIATION_GATE_READY_FOR_HUMAN_REVIEW', samples: results, cost: {projectedChars: chars, consumedChars: used, projectedUsd: projected, actualUsd: usd, quotaBefore: before, quotaAfter: after, ttsCalls: calls, retries: 0}, v2Hash: {before: hashBefore, after: hashAfter, intact: hashBefore === hashAfter && hashAfter === V2_SHA}, review};
    await fs.writeFile(path.join(out, 'pron-gate-report.json'), JSON.stringify(report, null, 2)); await putJson(`${DIR}/report.json`, report);
    console.log('@@V4_GATE_DONE ' + JSON.stringify({...report, review: review ? {...review, url: '(see artifact)'} : null, samples: results.map((r) => ({id: r.sampleId, status: r.status, technical: r.technical, seconds: r.seconds}))}));
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; });
