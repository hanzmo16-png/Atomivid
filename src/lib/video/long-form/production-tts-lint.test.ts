/**
 * PI V2 Fase B4.1 (RB-07): Long Form TTS runs the same alias lint and the same buildTtsRequest
 * before the B1 gate; subtitles come from the canonical text and a word-count mismatch fails
 * instead of shifting words; no route accepts aliases from a client. Mocks only, no audio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { paidCallKey } from "@/lib/paid-calls/gate";
import { CaptionWordCountMismatchError, PronunciationAliasError, TtsVoiceMissingError } from "@/lib/paid-calls/pronunciation";
import type { VoiceProvider } from "@/lib/providers/types";
import { buildCaptions } from "@/lib/video/captions";
import { loadProductionCachedBeatNarration, synthesizeBeatNarrationProductionCached } from "./production-tts-cache";
import { computeTtsCacheKey } from "./tts-cache";

const VIDEO_ID = "lf-b41";
const IDENTITY = { voiceId: "voice-1", modelId: "eleven_multilingual_v2", voiceSettingsJson: JSON.stringify({ stability: 0.45 }) };
const BEAT = { id: "beat-1", narration: "At Thermopylae, Ephialtes betrayed them; the men of Thespiae and the Locrians stayed." };

function fakeSupabase() {
  const files = new Map<string, Buffer>();
  const bucket = {
    async download(p: string) {
      const buf = files.get(p);
      if (!buf) return { data: null, error: { message: "not found" } };
      return { data: { text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
    },
    async upload(p: string, body: Buffer) { files.set(p, Buffer.from(body)); return { error: null }; },
  };
  return { supabase: { storage: { from: () => bucket } } as never, files };
}

function voice(opts: { dropLastWord?: boolean } = {}) {
  const received: string[] = [];
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text) {
      received.push(text);
      let words = text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, startSeconds: i * 0.5, endSeconds: i * 0.5 + 0.4 }));
      if (opts.dropLastWord) words = words.slice(0, -1);
      return { audioBuffer: Buffer.from(`mp3:${text}`), durationSeconds: words.length * 0.5, words, mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  return { provider, received };
}

const run = (supabase: never, provider: VoiceProvider, ledger: ReturnType<typeof memoryLedgerStore>, extra: Record<string, unknown> = {}) =>
  synthesizeBeatNarrationProductionCached(supabase, provider, BEAT, "en", { videoId: VIDEO_ID, bucket: "videos", voiceIdentity: IDENTITY, ledger, ...extra });

test("B4.1-1: aliases 'THER-MOP-Y-LAE' and 'Eph-IAL-tes' never reach the mock, write no ledger row and leave no STARTED cache record", async () => {
  for (const alias of [{ word: "Thermopylae", spoken: "THER-MOP-Y-LAE" }, { word: "Ephialtes", spoken: "Eph-IAL-tes" }]) {
    const { supabase, files } = fakeSupabase();
    const { provider, received } = voice();
    const ledger = memoryLedgerStore();
    await assert.rejects(run(supabase, provider, ledger, { aliases: [alias] }), PronunciationAliasError);
    assert.equal(received.length, 0);
    assert.equal(ledger.ops.size, 0);
    assert.equal(files.size, 0, "no STARTED record: nothing blocks a later clean attempt");
  }
});

test("B4.1-2: without aliases the four names reach the B1 gate once, verbatim; cache and B1 keys are unchanged; subtitles are the canonical words", async () => {
  const { supabase } = fakeSupabase();
  const { provider, received } = voice();
  const ledger = memoryLedgerStore();
  const r = await run(supabase, provider, ledger);
  assert.deepEqual(received, [BEAT.narration]);
  assert.equal(ledger.ops.size, 1);
  const [row] = [...ledger.ops.values()];
  assert.equal(row.status, "COMMITTED");
  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: IDENTITY.voiceId, modelId: IDENTITY.modelId, voiceSettingsJson: IDENTITY.voiceSettingsJson, language: "en", providerName: "elevenlabs" };
  const cacheKey = computeTtsCacheKey(identity);
  assert.equal(row.idempotencyKey, paidCallKey({ projectId: VIDEO_ID, shotId: `tts:${BEAT.id}:${cacheKey}`, provider: "elevenlabs", model: IDENTITY.modelId, method: "tts_with_timestamps", inputFingerprint: identity, reservedUsd: 0 }));
  assert.deepEqual(r.words.map((w) => w.text), BEAT.narration.split(" "));
  for (const name of ["Thermopylae,", "Ephialtes", "Thespiae", "Locrians"]) assert.ok(r.words.some((w) => w.text === name), name);
});

test("B4.1-3: a valid speak-only alias is heard by TTS only; subtitles say 'Thermopylae' and 'Locrians', and the following words keep their own timings", async () => {
  const { supabase } = fakeSupabase();
  const { provider, received } = voice();
  const ledger = memoryLedgerStore();
  const aliases = [{ word: "Thermopylae", spoken: "thermopilee" }, { word: "Locrians", spoken: "lok rians" }];
  const r = await run(supabase, provider, ledger, { aliases });
  assert.equal(received.length, 1);
  assert.ok(received[0].includes("thermopilee,") && received[0].includes("lok rians stayed."));
  assert.deepEqual(r.words.map((w) => w.text), BEAT.narration.split(" "), "one subtitle word per display word, in order");
  const spokenTokens = received[0].split(" ");
  const iLok = spokenTokens.indexOf("lok");
  const iLocrians = r.words.findIndex((w) => w.text === "Locrians");
  assert.equal(r.words[iLocrians].startSeconds, iLok * 0.5, "Locrians starts at 'lok'");
  assert.equal(r.words[iLocrians].endSeconds, (iLok + 1) * 0.5 + 0.4, "Locrians ends at 'rians'");
  assert.equal(r.words[iLocrians + 1].text, "stayed.");
  assert.equal(r.words[iLocrians + 1].startSeconds, (iLok + 2) * 0.5, "'stayed.' keeps the timing of the spoken 'stayed.' — no shift");
  const captions = buildCaptions(r.words, new Set()).map((c) => c.text).join(" ");
  assert.match(captions, /Thermopylae/);
  assert.ok(!/thermopilee|lok rians/.test(captions));
});

test("B4.1-4: spoken word count ≠ visible word count → subtitle construction fails, words are not shifted, and the paid result is not bought again", async () => {
  const { supabase } = fakeSupabase();
  const { provider, received } = voice({ dropLastWord: true });
  const ledger = memoryLedgerStore();
  await assert.rejects(run(supabase, provider, ledger), (e: unknown) => e instanceof CaptionWordCountMismatchError && e.expected === 13 && e.received === 12);
  assert.equal([...ledger.ops.values()][0]?.status, "COMMITTED", "paid once");
  await assert.rejects(run(supabase, provider, ledger), CaptionWordCountMismatchError);
  assert.equal(received.length, 1, "the retry reuses the paid audio and fails the same way");
  await assert.rejects(loadProductionCachedBeatNarration(supabase, "elevenlabs", BEAT, "en", { videoId: VIDEO_ID, bucket: "videos", voiceIdentity: IDENTITY }), CaptionWordCountMismatchError, "replay fails the same way");
});

test("B4.1-5: without voice_id (or with a request buildTtsRequest refuses) the mock stays at 0 and nothing is written", async () => {
  for (const voiceIdentity of [{ ...IDENTITY, voiceId: "" }, { ...IDENTITY, modelId: "" }]) {
    const { supabase, files } = fakeSupabase();
    const { provider, received } = voice();
    const ledger = memoryLedgerStore();
    await assert.rejects(run(supabase, provider, ledger, { voiceIdentity }), voiceIdentity.voiceId ? /model_id/ : TtsVoiceMissingError);
    assert.deepEqual([received.length, ledger.ops.size, files.size], [0, 0, 0]);
  }
});

test("B4.1-6: no route or worker copies aliases from a client body; the Long Form caller passes none", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /\balias(es)?\b|pronunciation/i.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk("src/app");
  assert.deepEqual(offenders, [], "no app route, page or action mentions aliases");
  for (const file of ["src/lib/video/long-form/produce.ts", "src/lib/video/run-job.ts", "src/lib/video/generate-video.ts", "src/lib/video/avatar/pipeline.ts"]) {
    assert.ok(!/\baliases\s*:/.test(fs.readFileSync(file, "utf8")), `${file} passes aliases`);
  }
});
