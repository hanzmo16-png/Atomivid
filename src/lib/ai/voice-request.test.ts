/**
 * PI V2 Fase B4 (RB-07): the real ElevenLabs request built by synthesizeVoice carries voice_id,
 * model_id and voice_settings explicitly and NO pronunciation dictionary, alias or context field.
 * fetch is stubbed: nothing leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ELEVENLABS_API_KEY = "test-key-not-real";

type Captured = { url: string; init: RequestInit };

async function withStubbedFetch<T>(fn: (calls: Captured[]) => Promise<T>): Promise<T> {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const chars = [..."Thermopylae"];
    return new Response(JSON.stringify({
      audio_base64: Buffer.from("mp3").toString("base64"),
      alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.05) },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("B4-7: synthesizeVoice sends voice_id in the path and only text, model_id and voice_settings in the body — no dictionary, alias or context", async () => {
  const { synthesizeVoice, getVoiceIdentity } = await import("./voice");
  await withStubbedFetch(async (calls) => {
    const r = await synthesizeVoice("Thermopylae", "en");
    assert.equal(calls.length, 1);
    const { voiceId, modelId } = getVoiceIdentity("en");
    assert.equal(calls[0].url, `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`);
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["model_id", "text", "voice_settings"]);
    assert.equal(body.text, "Thermopylae");
    assert.equal(body.model_id, modelId);
    assert.ok(body.voice_settings && typeof body.voice_settings === "object");
    assert.ok(!/pronunciation|dictionary|locator|alias|previous_text|next_text|phoneme/i.test(String(calls[0].init.body)));
    assert.deepEqual(r.words.map((w) => w.text), ["Thermopylae"]);
  });
});

test("B4-8: buildTtsRequest refuses a missing voice_id or model_id before any request exists", async () => {
  const { buildTtsRequest } = await import("./voice");
  await withStubbedFetch(async (calls) => {
    for (const voiceId of ["", "   "]) {
      assert.throws(() => buildTtsRequest({ text: "Ephialtes", voiceId, modelId: "m", voiceSettings: {}, apiKey: "k" }), /voice_id/);
    }
    assert.throws(() => buildTtsRequest({ text: "Thespiae", voiceId: "v", modelId: "", voiceSettings: {}, apiKey: "k" }), /model_id/);
    assert.equal(calls.length, 0);
  });
});
