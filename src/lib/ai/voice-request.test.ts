import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Petición real a ElevenLabs (fetch simulado, sin red ni gasto): la voz
 * elegida va en la URL y el contexto de fragmentos vecinos en el cuerpo.
 * La clave se lee al cargar el módulo, por eso se importa después de fijarla.
 */
test("synthesizeVoice: voice_id elegido en la URL; previous_text/next_text solo si se piden; sin elección, la voz de siempre", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  const { synthesizeVoice, getVoiceIdentity } = await import("./voice");
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({
        audio_base64: Buffer.from("mp3").toString("base64"),
        alignment: { characters: ["H", "o", "l", "a"], character_start_times_seconds: [0, 0.1, 0.2, 0.3], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await synthesizeVoice("Hola", "es", undefined, { voiceId: "k8cFOyAg7B9qwBlDDNTC", previousText: "Antes.", nextText: "Después." });
    await synthesizeVoice("Hola", "es");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0].url, "https://api.elevenlabs.io/v1/text-to-speech/k8cFOyAg7B9qwBlDDNTC/with-timestamps");
  assert.equal(requests[0].body.previous_text, "Antes.");
  assert.equal(requests[0].body.next_text, "Después.");
  assert.equal(requests[1].url, `https://api.elevenlabs.io/v1/text-to-speech/${getVoiceIdentity("es").voiceId}/with-timestamps`);
  assert.equal("previous_text" in requests[1].body, false);
  assert.equal("next_text" in requests[1].body, false);
  assert.deepEqual(requests[0].body.voice_settings, requests[1].body.voice_settings, "mismos ajustes aprobados para cualquier voz");
});
