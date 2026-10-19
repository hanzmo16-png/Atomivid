/**
 * T46 cierre (B): a billable call must never be recorded as USD 0. A real voice (ElevenLabs) or generative music
 * (Beatoven) call whose price is zero, negative or not a number is an UNKNOWN price: it is refused before the
 * ledger and before the provider. The fixture and the curated library stay free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatedMusicTrack, gatedVoiceSynthesize } from "./gated-providers";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "./result-store";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import type { MusicProvider, VoiceProvider } from "@/lib/providers/types";

const identity = { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" };
function voice(name: string) {
  let calls = 0;
  const provider = { name, synthesize: async () => { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 1, words: [], mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as VoiceProvider;
  return { provider, get calls() { return calls; } };
}
function music(name: string) {
  let calls = 0;
  const provider = { name, getTrack: async () => { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as MusicProvider;
  return { provider, get calls() { return calls; } };
}

for (const bad of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`voz facturable con tarifa ${bad} → rechazo antes del proveedor y sin fila en el ledger`, async () => {
    const v = voice("elevenlabs"), ledger = memoryLedgerStore();
    await assert.rejects(gatedVoiceSynthesize({ requestId: "r", ledger, results: memoryResultStore(), voiceProvider: v.provider, voiceIdentity: identity, estimatedCostUsd: bad }, "hola", "es"),
      (e: unknown) => e instanceof SupplyUnavailableError);
    assert.equal(v.calls, 0);
    assert.equal(ledger.ops.size, 0);
  });
  test(`música generativa con tarifa ${bad} → rechazo antes del proveedor`, async () => {
    const m = music("beatoven");
    await assert.rejects(gatedMusicTrack({ requestId: "r", ledger: memoryLedgerStore(), results: memoryResultStore(), musicProvider: m.provider, estimatedCostUsd: bad }, { durationSeconds: 30 }),
      (e: unknown) => e instanceof SupplyUnavailableError);
    assert.equal(m.calls, 0);
  });
}

test("voz facturable con tarifa positiva → 1 llamada y costo registrado igual a la tarifa", async () => {
  const v = voice("elevenlabs");
  const r = await gatedVoiceSynthesize({ requestId: "r", ledger: memoryLedgerStore(), results: memoryResultStore(), voiceProvider: v.provider, voiceIdentity: identity, estimatedCostUsd: 0.002 }, "hola", "es");
  assert.equal(v.calls, 1); assert.equal(r.costUsd, 0.002);
});

test("fixture y biblioteca curada siguen siendo gratis con tarifa 0", async () => {
  const v = voice("fixture"), m = music("curated-library");
  await gatedVoiceSynthesize({ requestId: "r", ledger: memoryLedgerStore(), results: memoryResultStore(), voiceProvider: v.provider, voiceIdentity: identity, estimatedCostUsd: 0 }, "hola", "es");
  await gatedMusicTrack({ requestId: "r", ledger: memoryLedgerStore(), results: memoryResultStore(), musicProvider: m.provider, estimatedCostUsd: 0 }, { durationSeconds: 30 });
  assert.equal(v.calls, 1); assert.equal(m.calls, 1);
});

test("reutilizar una voz ya pagada y guardada no exige tarifa (0 llamadas)", async () => {
  const v = voice("elevenlabs"), ledger = memoryLedgerStore(), results = memoryResultStore();
  const deps = { requestId: "r", ledger, results, voiceProvider: v.provider, voiceIdentity: identity };
  await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: 0.002 }, "hola", "es");
  const again = await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: 0 }, "hola", "es");
  assert.equal(v.calls, 1); assert.equal(again.reused, true); assert.equal(again.costUsd, 0);
});
