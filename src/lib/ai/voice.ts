// PENDIENTE (no implementado todavía — solo documentado): DEFAULT_VOICE_ID/
// VOICE_ID_BY_LANGUAGE siguen siendo "una voz hardcodeada con fallback
// silencioso". Falta pasar a una lista cerrada de voces PRE-APROBADAS
// (p. ej. un array/enum aquí mismo, o una env var con los voice_id
// aprobados) que lance un error explícito si ninguna está
// disponible/configurada, en vez de caer en silencio a Mateo (o cualquier
// otra voz no aprobada) — igual que ya se hace arriba cuando falta
// ELEVENLABS_API_KEY. Ese mismo criterio aplica a getVoiceProvider() en
// src/lib/providers/voice/index.ts, que hoy decide real-vs-fixture solo
// por presencia de la API key, sin validar la voz.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Mateo (uYlzyj2kIZo3HfBB21vF) — voz masculina de la Voice Library de
// ElevenLabs (acento latinoamericano, es-AR), elegida como ganadora tras
// una prueba A/B controlada entre varias candidatas reales de la cuenta
// (ver scripts/elevenlabs-ab-test.ts). Reemplaza a "Roger", que era un
// fallback funcional pero no nativo en español (acento inglés). Requiere
// que la cuenta tenga plan de pago (Starter o superior) para usar voces
// de la Voice Library por API — confirmado con esta cuenta.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "uYlzyj2kIZo3HfBB21vF";
// Voces específicas por idioma (opcionales): configura estas env vars con
// voces propias de tu cuenta en cada idioma si quieres una pronunciación
// distinta a la voz por defecto en inglés; si no las configuras, cae a la
// voz por defecto (Mateo) en ambos idiomas — nativa en español, funcional
// también para narrar en inglés vía el modelo multilingüe.
const VOICE_ID_BY_LANGUAGE: Record<"es" | "en", string | undefined> = {
  es: process.env.ELEVENLABS_VOICE_ID_ES,
  en: process.env.ELEVENLABS_VOICE_ID_EN,
};
// Multilingual v2: mejor naturalidad/expresividad que Turbo v2.5 para
// narración (soporta style y speaker_boost, que Turbo no soporta en esta
// cuenta) — confirmado con la prueba A/B real, ver
// scripts/elevenlabs-ab-test.ts y scripts/elevenlabs-ab-diagnostics.ts.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
// Parámetros aprobados en la prueba A/B — mismos para cualquier voz que
// se use vía DEFAULT_VOICE_ID/VOICE_ID_BY_LANGUAGE.
const VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.2,
  use_speaker_boost: true,
  speed: 1.0,
};

/**
 * Identidad determinística del proveedor real de voz para un idioma dado
 * — voiceId + modelId + los parámetros de voz relevantes (nunca incluye
 * `speed`, que es un ajuste POR LLAMADA, no de identidad de voz; ver
 * synthesizeVoice). Usada por tts-cache.ts para construir la clave de
 * caché por beat: si cambia cualquiera de estos valores, debe tratarse
 * como una síntesis nueva, nunca reutilizar audio de una voz distinta.
 */
export function getVoiceIdentity(language: "es" | "en" = "es"): {
  voiceId: string;
  modelId: string;
  voiceSettingsJson: string;
} {
  const voiceId = VOICE_ID_BY_LANGUAGE[language] || DEFAULT_VOICE_ID;
  const identitySettings = {
    stability: VOICE_SETTINGS.stability,
    similarity_boost: VOICE_SETTINGS.similarity_boost,
    style: VOICE_SETTINGS.style,
    use_speaker_boost: VOICE_SETTINGS.use_speaker_boost,
  };
  return { voiceId, modelId: MODEL_ID, voiceSettingsJson: JSON.stringify(identitySettings) };
}

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

type ElevenLabsResponse = {
  audio_base64: string;
  alignment: ElevenLabsAlignment;
};

export type WordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

// Rango seguro documentado por ElevenLabs para `voice_settings.speed`:
// 0.7-1.2, con la nota de que valores extremos degradan la calidad. Se
// acota más angosto (0.85-1.15) porque aquí solo se usa para una
// corrección fina (la narración real quedó apenas fuera de tolerancia),
// nunca para compensar un guion muy mal dimensionado — eso lo sigue
// atrapando assertNarrationDuration en duration-check.ts.
const MIN_SPEED = 0.85;
const MAX_SPEED = 1.15;

export async function synthesizeVoice(
  text: string,
  language: "es" | "en" = "es",
  /** Ajuste de ritmo de habla (ver VoiceProvider.synthesize en providers/types.ts). */
  speed?: number,
): Promise<{
  audioBuffer: Buffer;
  durationSeconds: number;
  words: WordTiming[];
}> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("Falta configurar ELEVENLABS_API_KEY");
  }

  const voiceId = VOICE_ID_BY_LANGUAGE[language] || DEFAULT_VOICE_ID;
  const voiceSettings =
    speed === undefined
      ? VOICE_SETTINGS
      : { ...VOICE_SETTINGS, speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) };

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: voiceSettings,
      }),
    },
  );

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`ElevenLabs respondió ${res.status}: ${errorBody}`);
  }

  const data = (await res.json()) as ElevenLabsResponse;
  const audioBuffer = Buffer.from(data.audio_base64, "base64");
  const words = buildWordTimings(data.alignment);
  const durationSeconds = data.alignment.character_end_times_seconds.at(-1) ?? 0;

  return { audioBuffer, durationSeconds, words };
}

function buildWordTimings(alignment: ElevenLabsAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current: { chars: string[]; start: number; end: number } | null = null;

  alignment.characters.forEach((char, i) => {
    const start = alignment.character_start_times_seconds[i];
    const end = alignment.character_end_times_seconds[i];

    if (/\s/.test(char)) {
      if (current) {
        words.push({
          text: current.chars.join(""),
          startSeconds: current.start,
          endSeconds: current.end,
        });
        current = null;
      }
      return;
    }

    if (!current) {
      current = { chars: [char], start, end };
    } else {
      current.chars.push(char);
      current.end = end;
    }
  });

  if (current) {
    const last: { chars: string[]; start: number; end: number } = current;
    words.push({
      text: last.chars.join(""),
      startSeconds: last.start,
      endSeconds: last.end,
    });
  }

  return words;
}
