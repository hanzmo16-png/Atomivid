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
export function getVoiceIdentity(language: "es" | "en" = "es", explicitVoiceId?: string): {
  voiceId: string;
  modelId: string;
  voiceSettingsJson: string;
} {
  const voiceId = explicitVoiceId || VOICE_ID_BY_LANGUAGE[language] || DEFAULT_VOICE_ID;
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
  /**
   * voiceId: voz elegida y ya validada (catálogo o voz privada del propio
   * usuario). Ausente = la voz por defecto de siempre. previous/nextText:
   * contexto de los fragmentos vecinos para que la entonación continúe
   * (texto a voz largo por segmentos); no se narran.
   */
  options: { voiceId?: string; previousText?: string; nextText?: string } = {},
): Promise<{
  audioBuffer: Buffer;
  durationSeconds: number;
  words: WordTiming[];
}> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("Falta configurar ELEVENLABS_API_KEY");
  }

  const voiceId = options.voiceId || VOICE_ID_BY_LANGUAGE[language] || DEFAULT_VOICE_ID;
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
        ...(options.previousText ? { previous_text: options.previousText } : {}),
        ...(options.nextText ? { next_text: options.nextText } : {}),
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

/**
 * Caracteres que le quedan a la cuenta de ElevenLabs en el período actual
 * (GET /v1/user/subscription: solo lectura, sin costo). Se usa antes de
 * sintetizar textos largos para no empezar una pieza que no puede
 * terminar. null = no se pudo consultar (quien llama decide).
 */
export async function getVoiceCharacterQuota(): Promise<{ remaining: number; limit: number; resetsAtUnix: number | null } | null> {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
    if (!res.ok) return null;
    const data = (await res.json()) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
    if (typeof data.character_count !== "number" || typeof data.character_limit !== "number") return null;
    return {
      remaining: Math.max(0, data.character_limit - data.character_count),
      limit: data.character_limit,
      resetsAtUnix: typeof data.next_character_count_reset_unix === "number" ? data.next_character_count_reset_unix : null,
    };
  } catch {
    return null;
  }
}

/** Espacios de clonación de la cuenta (GET /v1/user/subscription, sin costo). null = no se pudo consultar. */
export async function getVoiceCloneSlots(): Promise<{ used: number; limit: number } | null> {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
    if (!res.ok) return null;
    const data = (await res.json()) as { voice_slots_used?: number; voice_limit?: number };
    if (typeof data.voice_slots_used !== "number" || typeof data.voice_limit !== "number") return null;
    return { used: data.voice_slots_used, limit: data.voice_limit };
  } catch {
    return null;
  }
}

/**
 * Clonación instantánea (POST /v1/voices/add, multipart). Devuelve el
 * voice_id nuevo. Los errores llevan el prefijo «ElevenLabs respondió
 * <status>» (mismo formato que la síntesis) para clasificarlos: una
 * respuesta HTTP de error = no se creó nada; un fallo de red o una
 * respuesta sin voice_id = incierto.
 */
export async function addInstantVoiceClone(input: { name: string; description: string; audio: Buffer; filename: string; mimeType: string }): Promise<string> {
  if (!ELEVENLABS_API_KEY) throw new Error("Falta configurar ELEVENLABS_API_KEY");
  const form = new FormData();
  form.append("name", input.name);
  form.append("description", input.description);
  form.append("remove_background_noise", "false");
  form.append("files", new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), input.filename);
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": ELEVENLABS_API_KEY }, body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs respondió ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => null)) as { voice_id?: string; requires_verification?: boolean } | null;
  if (!data?.voice_id) throw new Error("Respuesta de clonación sin voice_id");
  return data.voice_id;
}

/** Elimina una voz de la cuenta (DELETE /v1/voices/{id}). «not_found» si ya no existía. */
export async function deleteProviderVoice(voiceId: string): Promise<"deleted" | "not_found"> {
  if (!ELEVENLABS_API_KEY) throw new Error("Falta configurar ELEVENLABS_API_KEY");
  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: { "xi-api-key": ELEVENLABS_API_KEY } });
  if (res.ok) return "deleted";
  const body = await res.text().catch(() => "");
  // Solo «no existe» explícito; cualquier otro 400 (p. ej. no se puede borrar) es un error y la voz sigue en la cuenta.
  if (res.status === 404 || (res.status === 400 && /not[_ ]found/i.test(body))) return "not_found";
  throw new Error(`ElevenLabs respondió ${res.status}: ${body.slice(0, 300)}`);
}
