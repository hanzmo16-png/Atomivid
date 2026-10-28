import { test } from "node:test";
import assert from "node:assert/strict";

// La clave se lee al cargar el módulo: se fija ANTES de importarlo (valor local falso; la red está simulada).
process.env.ELEVENLABS_API_KEY ||= "test-key-local";

test("synthesizeVoice: la llamada a ElevenLabs lleva límite de espera (un socket colgado no bloquea el worker 300 min)", async () => {
  const original = globalThis.fetch;
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    seen = init?.signal;
    return new Response(JSON.stringify({ audio_base64: Buffer.from("x").toString("base64"), alignment: { characters: ["h", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const { synthesizeVoice, TTS_REQUEST_TIMEOUT_MS } = await import("./voice");
    await synthesizeVoice("hi");
    assert.ok(seen instanceof AbortSignal);
    assert.ok(TTS_REQUEST_TIMEOUT_MS >= 60_000 && TTS_REQUEST_TIMEOUT_MS <= 600_000);
  } finally { globalThis.fetch = original; }
});
