import { test } from "node:test";
import assert from "node:assert/strict";
import type { VoiceProvider } from "@/lib/providers/types";
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
  return { fake, files };
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
        words: [{ text: "hola", startSeconds: 0, endSeconds: 0.5 }],
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
        words: [],
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

const BEAT = { id: "beat-1", narration: "Texto narrado del beat uno." };

test("1. beat nuevo (sin registro) → sintetiza, marca COMPLETED, reused=false", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingRealProvider();
  const result = await synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
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
  const { fake } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(first.getCallCount(), 1);

  const second = makeCountingRealProvider();
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(second.getCallCount(), 0);
  assert.equal(result.reused, true);
  assert.equal(result.costUsd, 0);
});

test("3. restart de 'proceso' (mismo storage, nueva instancia de provider) → reuse persistente", async () => {
  const { fake } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  const firstResult = await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });

  // Simula un "restart": un provider completamente nuevo, pero el mismo Storage backend (persistente).
  const restarted = makeCountingRealProvider();
  const secondResult = await synthesizeBeatNarrationProductionCached(fake, restarted.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(restarted.getCallCount(), 0);
  assert.deepEqual(secondResult.audioBuffer, firstResult.audioBuffer);
});

test("4. texto cambiado → nueva generación (identidad distinta)", async () => {
  const { fake } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });

  const second = makeCountingRealProvider();
  const changedBeat = { id: "beat-1", narration: "Texto narrado DISTINTO." };
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, changedBeat, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
});

test("5. voice/model/settings cambiados → nueva generación", async () => {
  const { fake } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });

  const second = makeCountingRealProvider();
  const differentVoice = { ...VOICE_IDENTITY, voiceId: "voice-2" };
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: differentVoice });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
});

test("6. archivo de audio faltante/corrupto → no reuse, nueva síntesis consciente", async () => {
  const { fake, files } = makeFakeSupabase();
  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });

  // Corrompe el único archivo de audio en el fake storage.
  const audioPaths = [...files.keys()].filter((p) => p.endsWith(".mp3"));
  assert.equal(audioPaths.length, 1);
  files.set(audioPaths[0], Buffer.from("contenido-corrupto-distinto"));

  const second = makeCountingRealProvider();
  const result = await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.reused, false);
});

test("7. estado de costo incierto (STARTED sin COMPLETED) → NO retry automático, lanza TtsUncertainCostStateError", async () => {
  const { fake } = makeFakeSupabase();
  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: VOICE_IDENTITY.voiceId, modelId: VOICE_IDENTITY.modelId, voiceSettingsJson: VOICE_IDENTITY.voiceSettingsJson, language: "es", providerName: "elevenlabs" };
  const { computeTtsCacheKey } = await import("./tts-cache");
  const key = computeTtsCacheKey(identity);
  await writeProductionTtsCacheRecord(fake, BUCKET, VIDEO_ID, { key, identity, status: "STARTED", createdAtIso: "x", updatedAtIso: "x" });

  const { provider, getCallCount } = makeCountingRealProvider();
  await assert.rejects(
    () => synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY }),
    TtsUncertainCostStateError,
  );
  assert.equal(getCallCount(), 0);
});

test("8. múltiples beats → solo genera los faltantes", async () => {
  const { fake } = makeFakeSupabase();
  const beat1 = { id: "beat-1", narration: "Uno." };
  const beat2 = { id: "beat-2", narration: "Dos." };
  const beat3 = { id: "beat-3", narration: "Tres." };

  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, beat1, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  await synthesizeBeatNarrationProductionCached(fake, first.provider, beat2, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(first.getCallCount(), 2);

  const second = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat1, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat2, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  await synthesizeBeatNarrationProductionCached(fake, second.provider, beat3, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });
  assert.equal(second.getCallCount(), 1); // solo beat3
});

test("9. cost guard contabiliza correctamente solo las llamadas nuevas", async () => {
  const { fake } = makeFakeSupabase();
  const spends: number[] = [];
  const costGuard = {
    estimateCostUsd: (text: string) => text.length * 0.001,
    assertCanSpend: () => {},
    recordSpend: (amountUsd: number) => {
      spends.push(amountUsd);
    },
  };

  const first = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, first.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, costGuard });
  assert.equal(spends.length, 1);

  const second = makeCountingRealProvider();
  await synthesizeBeatNarrationProductionCached(fake, second.provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY, costGuard });
  assert.equal(spends.length, 1); // reuse: no se registra un segundo gasto
});

test("10. simulation/fixture nunca marca un TTS real como COMPLETED (bypass total del caché)", async () => {
  const { fake } = makeFakeSupabase();
  const { provider } = makeFixtureProvider();
  await synthesizeBeatNarrationProductionCached(fake, provider, BEAT, "es", { videoId: VIDEO_ID, bucket: BUCKET, voiceIdentity: VOICE_IDENTITY });

  const identity = { videoId: VIDEO_ID, beatId: BEAT.id, text: BEAT.narration, voiceId: VOICE_IDENTITY.voiceId, modelId: VOICE_IDENTITY.modelId, voiceSettingsJson: VOICE_IDENTITY.voiceSettingsJson, language: "es", providerName: "fixture" };
  const { computeTtsCacheKey } = await import("./tts-cache");
  const key = computeTtsCacheKey(identity);
  const record = await readProductionTtsCacheRecord(fake, BUCKET, VIDEO_ID, key);
  assert.equal(record, undefined); // el fixture nunca escribe ningún registro
});
