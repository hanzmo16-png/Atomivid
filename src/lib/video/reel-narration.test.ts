import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";

test("Actual ElevenLabs adapter: chosen/default identity matches URL; retry and speed correction retain voice without duplicate purchase", async () => {
  // A fake HTTP transport exercises the real adapter; no external requests or billed generation.
  process.env.ELEVENLABS_API_KEY = "unit-test-not-a-key";
  process.env.VOICE_PROVIDER = "elevenlabs";
  const { reelNarration } = await import("./reel-narration");
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ audio_base64: Buffer.from("fixture-mp3").toString("base64"),
      alignment: { characters: ["H", "o", "l", "a"], character_start_times_seconds: [0, .1, .2, .3], character_end_times_seconds: [.1, .2, .3, .4] } });
  };
  try {
    const selected = reelNarration("es", "voiceEsp01");
    const deps = { ...selected, ledger: memoryLedgerStore(), results: memoryResultStore(), requestId: "voice-test", estimatedCostUsd: .002 };
    const first = await gatedVoiceSynthesize(deps, "Hola", "es");
    const retry = await gatedVoiceSynthesize(deps, "Hola", "es");
    assert.equal(first.reused, false); assert.equal(retry.reused, true);
    assert.equal(calls.length, 1);
    assert.equal(selected.voiceIdentity.voiceId, "voiceEsp01");
    assert.ok(calls[0].url.includes(`/text-to-speech/${selected.voiceIdentity.voiceId}/`));
    await gatedVoiceSynthesize(deps, "Hola", "es", 1.05);
    await gatedVoiceSynthesize(deps, "Hola", "es", 1.05);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, calls[0].url);
    assert.equal((calls[1].body.voice_settings as { speed: number }).speed, 1.05);
    const other = reelNarration("es", "voiceEsp02");
    await gatedVoiceSynthesize({ ...deps, ...other }, "Hola", "es");
    assert.equal(calls.length, 3, "another voice never reuses the first voice's audio");
    assert.ok(calls[2].url.includes("/voiceEsp02/"));
    const legacy = reelNarration("es");
    await legacy.voiceProvider.synthesize("Hola", "es");
    assert.ok(calls[3].url.includes(`/${legacy.voiceIdentity.voiceId}/`));
    assert.throws(() => reelNarration("es", ""));
    assert.throws(() => reelNarration("es", "invalid/id"));
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = original; }
});
