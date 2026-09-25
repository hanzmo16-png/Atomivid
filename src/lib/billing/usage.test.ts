import { test } from "node:test";
import assert from "node:assert/strict";
import { recordAvatarNarrationTts, recordVideoGeneration } from "./usage";

/**
 * Fake mínimo de SupabaseClient en memoria, solo para `generation_costs`
 * — mismo patrón que ai-video-storage.test.ts para Storage, aplicado
 * aquí a `.from(table).select().eq().maybeSingle()` / `.upsert()`.
 */
function makeFakeSupabase() {
  const rows = new Map<string, Record<string, unknown>>();
  const upsertCalls: Record<string, unknown>[] = [];
  function from(table: string) {
    if (table !== "generation_costs") throw new Error(`fake no soporta la tabla ${table}`);
    return {
      select() {
        return {
          eq(_col: string, value: string) {
            return {
              async maybeSingle() {
                return { data: rows.get(value) ?? null, error: null };
              },
            };
          },
        };
      },
      async upsert(row: Record<string, unknown>) {
        rows.set(row.request_id as string, row);
        upsertCalls.push(row);
        return { error: null };
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake = { from } as any;
  return { fake, rows, upsertCalls };
}

/**
 * Regresión del blocker real de "Voz IA desde texto" (RC mission Avatar,
 * 2026-09-25): antes de este cambio, recordVideoGeneration exigía
 * voiceProvider/voiceCharacters SIEMPRE, y avatar/pipeline.ts los pasaba
 * como "uploaded"/0 para CUALQUIER recordedAudioPath — incluido el audio
 * generado con ElevenLabs a partir de texto libre, que sí tiene un costo
 * real ya registrado por recordAvatarNarrationTts en el momento de la
 * síntesis. Sin esta corrección, esa segunda llamada sobrescribía
 * silenciosamente el proveedor/caracteres reales con valores falsos.
 */

test("recordAvatarNarrationTts registra el proveedor y suma caracteres (costo real de la síntesis)", async () => {
  const { fake, rows } = makeFakeSupabase();
  await recordAvatarNarrationTts(fake, "req-1", { voiceProvider: "elevenlabs", characters: 120 });

  const row = rows.get("req-1");
  assert.equal(row?.voice_provider, "elevenlabs");
  assert.equal(row?.voice_characters, 120);
});

test("recordVideoGeneration con voiceProvider/voiceCharacters OMITIDOS preserva lo que ya había (no lo pisa con undefined)", async () => {
  const { fake, rows } = makeFakeSupabase();
  await recordAvatarNarrationTts(fake, "req-1", { voiceProvider: "elevenlabs", characters: 340 });

  // Simula lo que hace avatar/pipeline.ts para narrationSource==="tts":
  // omite voiceProvider/voiceCharacters por completo.
  await recordVideoGeneration(fake, "req-1", {
    footageProvider: "none",
    footageCount: 0,
    musicProvider: "none",
    videoDurationSeconds: 12,
    renderMs: 5000,
    storageBytes: 1000,
    creativeLayer: { avatarProvider: "heygen", avatarProviderJobId: "job-1", avatarCostUsd: 0.48 },
  });

  const row = rows.get("req-1");
  assert.equal(row?.voice_provider, "elevenlabs", "el proveedor real de la síntesis TTS no debe perderse");
  assert.equal(row?.voice_characters, 340, "el conteo real de caracteres no debe perderse");
  assert.equal(row?.avatar_provider, "heygen");
  assert.equal(row?.avatar_cost_usd, 0.48);
});

test("recordVideoGeneration con voiceProvider/voiceCharacters EXPLÍCITOS sigue sobrescribiendo como antes (audio propio, sin costo de síntesis)", async () => {
  const { fake, rows } = makeFakeSupabase();

  await recordVideoGeneration(fake, "req-2", {
    voiceProvider: "uploaded",
    voiceCharacters: 0,
    footageProvider: "none",
    footageCount: 0,
    musicProvider: "none",
    videoDurationSeconds: 12,
    renderMs: 5000,
    storageBytes: 1000,
  });

  const row = rows.get("req-2");
  assert.equal(row?.voice_provider, "uploaded");
  assert.equal(row?.voice_characters, 0);
});
