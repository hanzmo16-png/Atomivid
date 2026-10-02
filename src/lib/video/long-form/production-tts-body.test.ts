/**
 * PI V2 Fase B4.1 (RB-07): the real Long Form request (cache → timeline → real voice provider →
 * synthesizeVoice → buildTtsRequest) carries only text, model_id and voice_settings. fetch stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ELEVENLABS_API_KEY = "test-key-not-real";

test("B4.1-7: Long Form body has only text, model_id and voice_settings — no pronunciation dictionary, alias or previous_text", async () => {
  const { realVoiceProvider } = await import("@/lib/providers/voice/real");
  const { synthesizeBeatNarrationProductionCached } = await import("./production-tts-cache");
  const { memoryLedgerStore } = await import("@/lib/production-intelligence/ledger");
  const { getVoiceIdentity } = await import("@/lib/ai/voice");
  const files = new Map<string, Buffer>();
  const bucket = {
    async download(p: string) { const b = files.get(p); return b ? { data: { text: async () => b.toString("utf8"), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null } : { data: null, error: { message: "nf" } }; },
    async upload(p: string, body: Buffer) { files.set(p, Buffer.from(body)); return { error: null }; },
  };
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const chars = [...(JSON.parse(body) as { text: string }).text];
    return new Response(JSON.stringify({ audio_base64: Buffer.from("mp3").toString("base64"), alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.05) } }), { status: 200 });
  }) as typeof fetch;
  try {
    const narration = "Thermopylae, Ephialtes, Thespiae and the Locrians.";
    const r = await synthesizeBeatNarrationProductionCached({ storage: { from: () => bucket } } as never, realVoiceProvider, { id: "b1", narration }, "en", { videoId: "lf-body", bucket: "videos", voiceIdentity: getVoiceIdentity("en"), ledger: memoryLedgerStore() });
    assert.equal(bodies.length, 1);
    const body = JSON.parse(bodies[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["model_id", "text", "voice_settings"]);
    assert.equal(body.text, narration);
    assert.ok(!/pronunciation|dictionary|locator|alias|previous_text|next_text/i.test(bodies[0]));
    assert.deepEqual(r.words.map((w) => w.text), narration.split(" "));
  } finally {
    globalThis.fetch = original;
  }
});
