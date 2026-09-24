import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTtsCacheKey,
  readTtsCacheRecord,
  writeTtsCacheRecord,
  computeChecksumSha256,
  validateCachedAudioFile,
  synthesizeBeatNarrationCached,
  TtsUncertainCostStateError,
  type TtsCacheIdentity,
  type TtsCostGuard,
} from "./tts-cache";
import type { VoiceProvider } from "@/lib/providers/types";

const BASE_IDENTITY: TtsCacheIdentity = {
  videoId: "test-video-001",
  beatId: "beat-1",
  text: "Texto de narración de prueba.",
  voiceId: "voice-abc",
  modelId: "eleven_multilingual_v2",
  voiceSettingsJson: JSON.stringify({ stability: 0.45, similarity_boost: 0.75 }),
  language: "es",
  providerName: "elevenlabs",
};

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-tts-cache-test-"));
  return (async () => {
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** VoiceProvider real de prueba (no fixture): cuenta cuántas veces se llamó, para probar reuse vs. nueva llamada. */
function makeCountingRealProvider(name = "elevenlabs"): VoiceProvider & { callCount: number } {
  const provider = {
    name,
    callCount: 0,
    async synthesize(text: string) {
      provider.callCount += 1;
      // WAV mínimo válido (44 bytes de header + algo de PCM) — suficiente para pasar por Buffer real, no necesita ser reproducible.
      const buffer = Buffer.from(`fake-audio-for:${text}:${provider.callCount}`);
      return {
        audioBuffer: buffer,
        durationSeconds: 3.5,
        words: [{ text: "hola", startSeconds: 0, endSeconds: 0.5 }],
        mimeType: "audio/mpeg",
        extension: "mp3",
      };
    },
  };
  return provider;
}

function makeFixtureProvider(): VoiceProvider & { callCount: number } {
  const provider = {
    name: "fixture",
    callCount: 0,
    async synthesize() {
      provider.callCount += 1;
      return {
        audioBuffer: Buffer.from("fixture-audio"),
        durationSeconds: 2,
        words: [],
        mimeType: "audio/wav",
        extension: "wav",
      };
    },
  };
  return provider;
}

test("computeTtsCacheKey es determinístico para la misma identidad", () => {
  assert.equal(computeTtsCacheKey(BASE_IDENTITY), computeTtsCacheKey({ ...BASE_IDENTITY }));
});

test("computeTtsCacheKey cambia si cambia CUALQUIER campo de identidad", () => {
  const baseKey = computeTtsCacheKey(BASE_IDENTITY);
  assert.notEqual(computeTtsCacheKey({ ...BASE_IDENTITY, text: "Otro texto distinto." }), baseKey);
  assert.notEqual(computeTtsCacheKey({ ...BASE_IDENTITY, voiceId: "voice-xyz" }), baseKey);
  assert.notEqual(computeTtsCacheKey({ ...BASE_IDENTITY, modelId: "otro_modelo" }), baseKey);
  assert.notEqual(computeTtsCacheKey({ ...BASE_IDENTITY, voiceSettingsJson: JSON.stringify({ stability: 0.9 }) }), baseKey);
  assert.notEqual(computeTtsCacheKey({ ...BASE_IDENTITY, beatId: "beat-2" }), baseKey);
});

test("validateCachedAudioFile: false si el archivo no existe", () => {
  const record = { key: "x", identity: BASE_IDENTITY, status: "COMPLETED" as const, audioPath: "/no/existe.mp3", audioChecksumSha256: "abc", createdAtIso: "x", updatedAtIso: "x" };
  assert.equal(validateCachedAudioFile(record), false);
});

test("validateCachedAudioFile: false si el checksum no coincide (archivo corrupto/reemplazado)", () =>
  withTempDir((dir) => {
    const audioPath = join(dir, "audio.mp3");
    writeFileSync(audioPath, "contenido real");
    const record = {
      key: "x",
      identity: BASE_IDENTITY,
      status: "COMPLETED" as const,
      audioPath,
      audioChecksumSha256: computeChecksumSha256(Buffer.from("contenido DISTINTO")),
      createdAtIso: "x",
      updatedAtIso: "x",
    };
    assert.equal(validateCachedAudioFile(record), false);
  }));

test("validateCachedAudioFile: true si existe y el checksum coincide", () =>
  withTempDir((dir) => {
    const audioPath = join(dir, "audio.mp3");
    const content = Buffer.from("contenido real");
    writeFileSync(audioPath, content);
    const record = {
      key: "x",
      identity: BASE_IDENTITY,
      status: "COMPLETED" as const,
      audioPath,
      audioChecksumSha256: computeChecksumSha256(content),
      createdAtIso: "x",
      updatedAtIso: "x",
    };
    assert.equal(validateCachedAudioFile(record), true);
  }));

// --- Escenario 1: beat nuevo -> necesita generación ------------------------

test("1) beat nuevo (sin registro de caché) -> se sintetiza (se llama al proveedor)", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const result = await synthesizeBeatNarrationCached(provider, { id: "beat-1", narration: "Texto nuevo." }, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" },
    });
    assert.equal(provider.callCount, 1);
    assert.equal(result.reused, false);
  }));

// --- Escenario 2: beat completado -> reuse ----------------------------------

test("2) beat ya COMPLETED con archivo válido -> reuse, NO se llama al proveedor", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };
    const beat = { id: "beat-1", narration: "Mismo texto exacto." };

    const first = await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(provider.callCount, 1);
    assert.equal(first.reused, false);

    const second = await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(provider.callCount, 1, "no debió llamar al proveedor de nuevo");
    assert.equal(second.reused, true);
    assert.equal(second.durationSeconds, first.durationSeconds);
    assert.deepEqual(second.audioBuffer, first.audioBuffer);
  }));

// --- Escenario 3: restart de proceso -> reuse persistente -------------------

test("3) 'restart de proceso' (nueva llamada con un proveedor NUEVO, mismo cacheDir en disco) -> reuse persistente", () =>
  withTempDir(async (dir) => {
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };
    const beat = { id: "beat-1", narration: "Texto persistente." };

    const providerRun1 = makeCountingRealProvider();
    await synthesizeBeatNarrationCached(providerRun1, beat, "es", ctx);
    assert.equal(providerRun1.callCount, 1);

    // Simula un proceso nuevo: instancia de proveedor completamente distinta, mismo directorio de caché en disco.
    const providerRun2 = makeCountingRealProvider();
    const result = await synthesizeBeatNarrationCached(providerRun2, beat, "es", ctx);
    assert.equal(providerRun2.callCount, 0, "el 'proceso nuevo' nunca debió llamar al proveedor");
    assert.equal(result.reused, true);
  }));

// --- Escenario 4: texto cambiado -> nueva generación ------------------------

test("4) texto distinto -> nueva generación (identidad distinta, no reuse)", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };

    await synthesizeBeatNarrationCached(provider, { id: "beat-1", narration: "Texto A." }, "es", ctx);
    await synthesizeBeatNarrationCached(provider, { id: "beat-1", narration: "Texto B (editado)." }, "es", ctx);
    assert.equal(provider.callCount, 2);
  }));

// --- Escenario 5: voice/model/settings cambiados -> nueva generación -------

test("5) voiceId distinto -> nueva generación", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const beat = { id: "beat-1", narration: "Mismo texto." };
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "voice-A", modelId: "m", voiceSettingsJson: "{}" },
    });
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "voice-B", modelId: "m", voiceSettingsJson: "{}" },
    });
    assert.equal(provider.callCount, 2);
  }));

test("5b) modelId distinto -> nueva generación", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const beat = { id: "beat-1", narration: "Mismo texto." };
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "v", modelId: "modelo-A", voiceSettingsJson: "{}" },
    });
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "v", modelId: "modelo-B", voiceSettingsJson: "{}" },
    });
    assert.equal(provider.callCount, 2);
  }));

test("5c) voiceSettingsJson distinto (p. ej. stability cambiado) -> nueva generación", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const beat = { id: "beat-1", narration: "Mismo texto." };
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: JSON.stringify({ stability: 0.45 }) },
    });
    await synthesizeBeatNarrationCached(provider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: JSON.stringify({ stability: 0.9 }) },
    });
    assert.equal(provider.callCount, 2);
  }));

// --- Escenario 6: archivo faltante/corrupto -> no reuse ---------------------

test("6) COMPLETED pero el archivo de audio fue borrado del disco -> no reuse, se sintetiza de nuevo", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };
    const beat = { id: "beat-1", narration: "Texto." };

    const first = await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(provider.callCount, 1);

    // Simula corrupción: se borra el archivo de audio pero el registro JSON queda.
    const identity = { videoId: "v1", beatId: "beat-1", text: "Texto.", voiceId: "v", modelId: "m", voiceSettingsJson: "{}", language: "es", providerName: "elevenlabs" };
    const key = computeTtsCacheKey(identity);
    const record = readTtsCacheRecord(dir, key)!;
    assert.ok(existsSync(record.audioPath!));
    rmSync(record.audioPath!);

    const second = await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(provider.callCount, 2, "debió sintetizar de nuevo porque el archivo cacheado no pasa validación");
    assert.equal(second.reused, false);
    void first;
  }));

test("6b) COMPLETED pero el checksum no coincide (archivo reemplazado/truncado) -> no reuse", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };
    const beat = { id: "beat-1", narration: "Texto." };

    await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    const identity = { videoId: "v1", beatId: "beat-1", text: "Texto.", voiceId: "v", modelId: "m", voiceSettingsJson: "{}", language: "es", providerName: "elevenlabs" };
    const key = computeTtsCacheKey(identity);
    const record = readTtsCacheRecord(dir, key)!;
    writeFileSync(record.audioPath!, "contenido truncado/corrupto, no coincide con el checksum original");

    const second = await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(provider.callCount, 2);
    assert.equal(second.reused, false);
  }));

// --- Escenario 7: estado de costo incierto -> no retry automático ----------

test("7) registro STARTED sin COMPLETED (crash a mitad de la llamada) -> lanza TtsUncertainCostStateError, NO llama al proveedor", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const identity: TtsCacheIdentity = {
      videoId: "v1",
      beatId: "beat-1",
      text: "Texto interrumpido.",
      voiceId: "v",
      modelId: "m",
      voiceSettingsJson: "{}",
      language: "es",
      providerName: "elevenlabs",
    };
    const key = computeTtsCacheKey(identity);
    // Simula un crash: se escribió STARTED pero nunca se llegó a COMPLETED.
    writeTtsCacheRecord(dir, { key, identity, status: "STARTED", createdAtIso: "x", updatedAtIso: "x" });

    await assert.rejects(
      () =>
        synthesizeBeatNarrationCached(provider, { id: "beat-1", narration: "Texto interrumpido." }, "es", {
          videoId: "v1",
          cacheDir: dir,
          voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" },
        }),
      TtsUncertainCostStateError,
    );
    assert.equal(provider.callCount, 0, "un estado STARTED sin resolver nunca debe reintentarse automáticamente");
  }));

// --- Escenario 8: múltiples beats -> solo genera los faltantes -------------

test("8) de 3 beats, 1 ya cacheado -> solo se llama al proveedor para los 2 faltantes", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } };

    // Pre-cachea el beat-2.
    await synthesizeBeatNarrationCached(provider, { id: "beat-2", narration: "Beat dos." }, "es", ctx);
    assert.equal(provider.callCount, 1);

    const beats = [
      { id: "beat-1", narration: "Beat uno." },
      { id: "beat-2", narration: "Beat dos." },
      { id: "beat-3", narration: "Beat tres." },
    ];
    const results = [];
    for (const beat of beats) {
      results.push(await synthesizeBeatNarrationCached(provider, beat, "es", ctx));
    }
    assert.equal(provider.callCount, 3, "1 (pre-caché) + 2 nuevos (beat-1 y beat-3); beat-2 se reutilizó");
    assert.deepEqual(
      results.map((r) => r.reused),
      [false, true, false],
    );
  }));

// --- Escenario 9: cost guard contabiliza correctamente solo nuevas llamadas ---

test("9) cost guard: se contabiliza SOLO en síntesis nuevas, nunca en un reuse", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const spends: number[] = [];
    const guard: TtsCostGuard = {
      estimateCostUsd: (text) => text.length * 0.001,
      assertCanSpend: () => {},
      recordSpend: (amountUsd) => spends.push(amountUsd),
    };
    const ctx = { videoId: "v1", cacheDir: dir, voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" }, costGuard: guard };
    const beat = { id: "beat-1", narration: "Texto de costo." };

    await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(spends.length, 1, "primera síntesis: 1 registro de gasto");

    await synthesizeBeatNarrationCached(provider, beat, "es", ctx);
    assert.equal(spends.length, 1, "reuse: NO debe agregar un segundo registro de gasto");
  }));

test("9b) cost guard: assertCanSpend que lanza detiene la síntesis ANTES de llamar al proveedor", () =>
  withTempDir(async (dir) => {
    const provider = makeCountingRealProvider();
    const guard: TtsCostGuard = {
      estimateCostUsd: () => 999,
      assertCanSpend: () => {
        throw new Error("presupuesto excedido");
      },
      recordSpend: () => {},
    };
    await assert.rejects(() =>
      synthesizeBeatNarrationCached(provider, { id: "beat-1", narration: "Texto caro." }, "es", {
        videoId: "v1",
        cacheDir: dir,
        voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" },
        costGuard: guard,
      }),
    );
    assert.equal(provider.callCount, 0, "assertCanSpend debe evaluarse ANTES de llamar al proveedor");
  }));

// --- Escenario 10: simulation/fixture nunca queda marcado como TTS real completado ---

test("10) proveedor fixture hace bypass TOTAL del caché — nunca escribe un registro COMPLETED, nunca se puede confundir con una síntesis real", () =>
  withTempDir(async (dir) => {
    const fixtureProvider = makeFixtureProvider();
    const beat = { id: "beat-1", narration: "Texto fixture." };
    const result = await synthesizeBeatNarrationCached(fixtureProvider, beat, "es", {
      videoId: "v1",
      cacheDir: dir,
      voiceIdentity: { voiceId: "cualquier-voz", modelId: "cualquier-modelo", voiceSettingsJson: "{}" },
    });
    assert.equal(fixtureProvider.callCount, 1);
    assert.equal(result.reused, false);
    assert.equal(result.costUsd, 0);

    // No debe existir NINGÚN archivo de caché en disco para este beat — el fixture nunca escribe.
    const identity: TtsCacheIdentity = {
      videoId: "v1",
      beatId: "beat-1",
      text: "Texto fixture.",
      voiceId: "cualquier-voz",
      modelId: "cualquier-modelo",
      voiceSettingsJson: "{}",
      language: "es",
      providerName: "fixture",
    };
    const key = computeTtsCacheKey(identity);
    assert.equal(readTtsCacheRecord(dir, key), undefined);
  }));

test("10b) un registro real cacheado (providerName='elevenlabs') nunca se confunde con uno fixture — identidades distintas por construcción", () =>
  withTempDir(async (dir) => {
    const realProvider = makeCountingRealProvider("elevenlabs");
    const fixtureProvider = makeFixtureProvider();
    const beat = { id: "beat-1", narration: "Mismo texto exacto." };
    const sharedVoiceIdentity = { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" };

    await synthesizeBeatNarrationCached(realProvider, beat, "es", { videoId: "v1", cacheDir: dir, voiceIdentity: sharedVoiceIdentity });
    assert.equal(realProvider.callCount, 1);

    // El fixture, aunque comparta texto/videoId/voiceIdentity "declarados", nunca lee el registro real (bypass total) y nunca llama menos veces de lo esperado.
    const fixtureResult = await synthesizeBeatNarrationCached(fixtureProvider, beat, "es", { videoId: "v1", cacheDir: dir, voiceIdentity: sharedVoiceIdentity });
    assert.equal(fixtureProvider.callCount, 1, "el fixture siempre sintetiza, nunca reutiliza un registro real ni al revés");
    assert.equal(fixtureResult.reused, false);
  }));
