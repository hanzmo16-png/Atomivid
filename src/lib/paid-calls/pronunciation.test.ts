/**
 * PI V2 Fase B4 (RB-07): broken pronunciation aliases never reach TTS; subtitles keep the
 * canonical text; no voice_id means no call; clean calls still go through the B1 gate.
 * Mocks only — no audio, no provider, no dictionary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { stableHash } from "@/lib/production-intelligence/canonical";
import type { VoiceProvider } from "@/lib/providers/types";
import { buildCaptions } from "@/lib/video/captions";
import { gatedVoiceSynthesize } from "./gated-providers";
import { memoryResultStore } from "./result-store";
import { paidCallKey } from "./gate";
import { lintPronunciationAliases, PronunciationAliasError, restoreDisplayWords, spokenText, TtsVoiceMissingError } from "./pronunciation";

const TEXT = "Leonidas held Thermopylae until Ephialtes showed the path; the Thespiae men and the Locrians stayed.";
const IDENTITY = { voiceId: "voice-test", modelId: "eleven_multilingual_v2", voiceSettingsJson: "{}" };

function mockVoice() {
  const received: string[] = [];
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text) {
      received.push(text);
      const words = text.split(/\s+/).map((w, i) => ({ text: w, startSeconds: i * 0.4, endSeconds: i * 0.4 + 0.35 }));
      return { audioBuffer: Buffer.from(`mp3:${text}`), durationSeconds: words.length * 0.4, words, mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  return { provider, received };
}

function setup() {
  const ledger = memoryLedgerStore();
  const { provider, received } = mockVoice();
  const deps = { ledger, results: memoryResultStore(), requestId: "req-b4", voiceProvider: provider, voiceIdentity: IDENTITY, estimatedCostUsd: 0.01 };
  return { ledger, received, deps };
}

const captionText = (words: Parameters<typeof buildCaptions>[0]) => buildCaptions(words, new Set()).map((c) => c.text).join(" ");

test("B4-1: aliases 'THER-MOP-Y-LAE' and 'Eph-IAL-tes' never reach the provider mock nor the B1 ledger", async () => {
  for (const alias of [{ word: "Thermopylae", spoken: "THER-MOP-Y-LAE" }, { word: "Ephialtes", spoken: "Eph-IAL-tes" }]) {
    const { ledger, received, deps } = setup();
    await assert.rejects(gatedVoiceSynthesize(deps, TEXT, "en", undefined, { aliases: [alias] }), PronunciationAliasError);
    assert.equal(received.length, 0, `${alias.spoken}: provider mock not called`);
    assert.equal(ledger.ops.size, 0, `${alias.spoken}: no ledger row, i.e. rejected before the paid-call gate`);
  }
});

test("B4-2: the lint rejects any hyphen and any uppercase letter in the spoken form, and only that", () => {
  const bad = [
    ["Thermopylae", "THER-MOP-Y-LAE", "hyphen"], ["Ephialtes", "Eph-IAL-tes", "hyphen"], ["Thespiae", "thes-pee-eye", "hyphen"],
    ["Locrians", "LOKRIANS", "uppercase"], ["Thermopylae", "Thermopilee", "uppercase"], ["Locrians", "  ", "empty"],
  ] as const;
  for (const [word, spoken, reason] of bad) {
    assert.throws(() => lintPronunciationAliases([{ word, spoken }]), (e: unknown) => e instanceof PronunciationAliasError && e.reason === reason, `${spoken}`);
  }
  assert.doesNotThrow(() => lintPronunciationAliases([{ word: "Thermopylae", spoken: "thermopilee" }, { word: "Locrians", spoken: "lok rians" }]));
});

test("B4-3: the same names in normal text, without aliases, reach the B1 gate once; the provider receives the display text verbatim", async () => {
  const { ledger, received, deps } = setup();
  const r = await gatedVoiceSynthesize(deps, TEXT, "en");
  assert.deepEqual(received, [TEXT]);
  assert.equal(r.reused, false);
  assert.equal(ledger.ops.size, 1);
  const [row] = [...ledger.ops.values()];
  assert.equal(row.status, "COMMITTED");
  // B1 key format and content unchanged for alias-free calls.
  const fingerprint = { text: TEXT, language: "en", speed: null, voiceId: IDENTITY.voiceId, modelId: IDENTITY.modelId, voiceSettingsJson: IDENTITY.voiceSettingsJson };
  assert.equal(row.idempotencyKey, paidCallKey({ projectId: "req-b4", shotId: `voice:${stableHash(fingerprint, 16)}`, provider: "elevenlabs", model: IDENTITY.modelId, method: "tts_with_timestamps", inputFingerprint: fingerprint, reservedUsd: 0.01 }));
  for (const name of ["Thermopylae", "Ephialtes", "Thespiae", "Locrians"]) assert.match(captionText(r.words), new RegExp(name));
});

test("B4-4: a valid speak-only alias changes only what TTS hears; the subtitle still says 'Thermopylae', also when the paid result is reused", async () => {
  const { ledger, received, deps } = setup();
  const aliases = [{ word: "Thermopylae", spoken: "thermopilee" }, { word: "Locrians", spoken: "lok rians" }];
  const r = await gatedVoiceSynthesize(deps, TEXT, "en", undefined, { aliases });
  assert.equal(received.length, 1);
  assert.ok(received[0].includes("thermopilee") && received[0].includes("lok rians"), "TTS hears the alias");
  assert.ok(!received[0].includes("Thermopylae"));
  const captions = captionText(r.words);
  assert.match(captions, /Thermopylae/);
  assert.match(captions, /Locrians stayed\./);
  assert.ok(!/thermopilee|lok rians/.test(captions), `alias leaked into subtitles: ${captions}`);
  // Second attempt: reused from the B1 ledger with zero calls, words restored again.
  const again = await gatedVoiceSynthesize(deps, TEXT, "en", undefined, { aliases });
  assert.equal(again.reused, true);
  assert.equal(received.length, 1);
  assert.equal(captionText(again.words), captions);
  assert.equal(ledger.ops.size, 1);
});

test("B4-5: without voice_id the provider mock stays at 0 and no ledger row is written", async () => {
  const { ledger, received, deps } = setup();
  await assert.rejects(gatedVoiceSynthesize({ ...deps, voiceIdentity: { ...IDENTITY, voiceId: "" } }, TEXT, "en"), TtsVoiceMissingError);
  await assert.rejects(gatedVoiceSynthesize({ ...deps, voiceIdentity: { ...IDENTITY, voiceId: "   " } }, TEXT, "en"), TtsVoiceMissingError);
  assert.equal(received.length, 0);
  assert.equal(ledger.ops.size, 0);
});

test("B4-6: substitution is whole-word and display text is never modified", () => {
  const display = "Thermopylae, not Thermopylaean; Thermopylae.";
  const aliases = [{ word: "Thermopylae", spoken: "thermopilee" }];
  assert.equal(spokenText(display, aliases), "thermopilee, not Thermopylaean; thermopilee.");
  assert.equal(display, "Thermopylae, not Thermopylaean; Thermopylae.");
  const words = spokenText(display, aliases).split(" ").map((w, i) => ({ text: w, startSeconds: i, endSeconds: i + 0.5 }));
  assert.deepEqual(restoreDisplayWords(words, aliases).map((w) => w.text), ["Thermopylae,", "not", "Thermopylaean;", "Thermopylae."]);
});
