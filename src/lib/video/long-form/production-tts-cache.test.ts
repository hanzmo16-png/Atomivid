import { test } from "node:test";
import assert from "node:assert/strict";
import type { VoiceProvider } from "@/lib/providers/types";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { PaidResultUnavailableError } from "@/lib/paid-calls/errors";
import {
  synthesizeBeatNarrationProductionCached,
  readProductionTtsCacheRecord,
  writeProductionTtsCacheRecord,
  TtsUncertainCostStateError,
} from "./production-tts-cache";

const BUCKET = "videos";
const VIDEO_ID = "gobekli-tepe-001";
const VOICE_IDENTITY = { voiceId: "voice-1", modelId: "model-1", voiceSettingsJson: JSON.stringify({ stability: 0.45 }) };

function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files, ledger: memoryLedgerStore() };
}

function makeCountingRealProvider(name = "elevenlabs") {
  let callCount = 0;
  const provider: VoiceProvider = {
    name,
    async synthesize(text: string) {
      callCount++;
      return {
        audioBuffer: Buffer.from(`audio-${callCount}-${text}`),
        mimeType: "audio/mpeg",
        extension: "mp3",
        durationSeconds: 3.5,
        // Como el proveedor real: una marca de tiempo por palabra del texto recibido (B4.1 exige el mismo número de palabras).
        words: text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, startSeconds: i * 0.5, endSeconds: i * 0.5 + 0.4 })),
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

function makeFixtureProvider() {
  let callCount = 0;
  const provider: VoiceProvider = {
    name: "fixture",
    async synthesize(text: string) {
      callCount++;
      return {
        audioBuffer: Buffer.from(`fixture-${callCount}-${text}`),
        mimeType: "audio/mpeg",
        extension: "mp3",
        durationSeconds: 2,
        words: text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, startSeconds: i * 0.5, endSeconds: i * 0.5 + 0.4 })),
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

const BEAT = { id: "beat-1", narration: "Texto narrado del beat uno." };

test("1. beat nuevo (sin registro) → sintetiza, marca COMPLETED, reused=false", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingRealProvider();
  const result = await synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(getCallCount(), 1);
  assert.equal(result.reused, false);
  assert.ok(result.audioBuffer.byteLength > 0);

  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: VOICE_IDENTITY.voiceId, modelId: VOICE_IDENTITY.modelId, voiceSettingsJson: VOICE_IDENTITY.voiceSettingsJson, language: "es", providerName: "elevenlabs" };
  const { computeTtsCacheKey } = await import("./tts-cache");
  const key = computeTtsCacheKey(identity);
  const record = await readProductionTtsCacheRecord(fake, BUCKET, VIDEO_ID, key);
  assert.equal(record?.status, "COMPLETED");
});

test("2. beat completado y válido → REUSE, el proveedor no se llama de nuevo", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(first.getCallCount(), 1);

  const second = makeCountingRealProvider();
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(second.getCallCount(), 0);
  assert.equal(result.reused, true);
  assert.equal(result.costUsd, 0);
});

test("3. restart de 'proceso' (mismo storage, nueva instancia de provider) → reuse persistente", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  const firstResult = await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });

  // Simula un "restart": un provider completamente nuevo, pero el mismo Storage backend (persistente).
  const restarted = makeCountingRealProvider();
  const secondResult = await synthesizeBeatNarrationProductionCached(fake, restarted.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(restarted.getCallCount(), 0);
  assert.deepEqual(secondResult.audioBuffer, firstResult.audioBuffer);
});

test("4. texto cambiado → nueva generación (identidad distinta)", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });

  const second = makeCountingRealProvider();
  const changedBeat = { id: "beat-1", narration: "Texto narrado DISTINTO." };
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, changedBeat, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
});

test("5. voice/model/settings cambiados → nueva generación", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });

  const second = makeCountingRealProvider();
  const differentVoice = { ...VOICE_IDENTITY, voiceId: "voice-2" };
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: differentVoice, ledger });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
});

test("6. archivo de audio faltante/corrupto tras un pago COMMITTED → se rechaza (PaidResultUnavailableError), NUNCA se vuelve a pagar (PI V2 B1, RB-01 regla 3)", async () => {
  const { fake, files, ledger } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });

  // Corrompe el único archivo de audio en el fake storage.
  const audioPaths = [...files.keys()].filter((p) => p.endsWith(".mp3"));
  assert.equal(audioPaths.length, 1);
  files.set(audioPaths[0], Buffer.from("contenido-corrupto-distinto"));

  const second = makeCountingRealProvider();
  await assert.rejects(
    () => synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger }),
    PaidResultUnavailableError,
  );
  assert.equal(second.getCallCount(), 0, "el ledger dice COMMITTED: el proveedor no se llama otra vez");
  assert.equal([...ledger.ops.values()][0]?.status, "COMMITTED");
});

test("6b. archivo corrupto SIN fila en el ledger (caché anterior a B1) → síntesis consciente una sola vez, y la fila queda escrita", async () => {
  const { fake, files } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger: memoryLedgerStore() });
  const audioPaths = [...files.keys()].filter((p) => p.endsWith(".mp3"));
  files.set(audioPaths[0], Buffer.from("contenido-corrupto-distinto"));
  const second = makeCountingRealProvider();
  const freshLedger = memoryLedgerStore();
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger: freshLedger });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
  assert.equal(freshLedger.ops.size, 1);
});

test("7. estado de costo incierto (STARTED sin COMPLETED) → NO retry automático, lanza TtsUncertainCostStateError", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: VOICE_IDENTITY.voiceId, modelId: VOICE_IDENTITY.modelId, voiceSettingsJson: VOICE_IDENTITY.voiceSettingsJson, language: "es", providerName: "elevenlabs" };
  const { computeTtsCacheKey } = await import("./tts-cache");
  const key = computeTtsCacheKey(identity);
  await writeProductionTtsCacheRecord(fake, BUCKET, VIDEO_ID, { key, identity, status: "STARTED", createdAtIso: "x", updatedAtIso: "x" });

  const { provider, getCallCount } = makeCountingRealProvider();
  await assert.rejects(
    () => synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger }),
    TtsUncertainCostStateError,
  );
  assert.equal(getCallCount(), 0);
});

test("8. múltiples beats → solo genera los faltantes", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const beat1 = { id: "beat-1", narration: "Uno." };
  const beat2 = { id: "beat-2", narration: "Dos." };
  const beat3 = { id: "beat-3", narration: "Tres." };

  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, beat1, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  await synthesizeBeatNarrationProductionCached(fake, first.provider, beat2, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(first.getCallCount(), 2);

  const second = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat1, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat2, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat3, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });
  assert.equal(second.getCallCount(), 1); // solo beat3
});

test("9. cost guard contabiliza correctamente solo las llamadas nuevas", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const spends: number[] = [];
  const costGuard = {
    estimateCostUsd: (text: string) => text.length * 0.001,
    assertCanSpend: () => {},
    recordSpend: (amountUsd: number) => {
      spends.push(amountUsd);
    },
  };

  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, costGuard, ledger });
  assert.equal(spends.length, 1);

  const second = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, costGuard, ledger });
  assert.equal(spends.length, 1); // reuse: no se registra un segundo gasto
});

test("10. simulation/fixture nunca marca un TTS real como COMPLETED (bypass total del caché)", async () => {
  const { fake, ledger } = makeFakeSupabase();
  const { provider } = makeFixtureProvider();
  await synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, ledger });

  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: VOICE_IDENTITY.voiceId, modelId: VOICE_IDENTITY.modelId, voiceSettingsJson: VOICE_IDENTITY.voiceSettingsJson, language: "es", providerName: "fixture" };
  const { computeTtsCacheKey } = await import("./tts-cache");
  const key = computeTtsCacheKey(identity);
  const record = await readProductionTtsCacheRecord(fake, BUCKET, VIDEO_ID, key);
  assert.equal(record, undefined); // el fixture nunca escribe ningún registro
});
