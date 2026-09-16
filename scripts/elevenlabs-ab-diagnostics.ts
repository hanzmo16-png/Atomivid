/**
 * Diagnóstico de un solo uso, exclusivamente de LECTURA (solo GET), para
 * decidir si es viable una prueba A/B entre dos voces ya elegidas de la
 * biblioteca compartida de ElevenLabs (Víctor y Mateo) antes de gastar
 * créditos reales en síntesis.
 *
 * Llama únicamente a:
 * - GET /v1/user/subscription (plan/cuota)
 * - GET /v1/models (modelos disponibles para la cuenta)
 * - GET /v1/shared-voices (metadata de las 2 voces específicas)
 *
 * Deliberadamente NO hace nada más: ninguna llamada de síntesis, ninguna
 * llamada de escritura (POST/PUT/PATCH/DELETE) contra ElevenLabs, no
 * agrega ninguna voz a My Voices, no toca ninguna configuración de
 * producción. Imprime solo los campos pedidos — nunca el objeto de
 * suscripción completo, nunca datos de facturación/personales, nunca la
 * API key.
 *
 * Uso: npx tsx scripts/elevenlabs-ab-diagnostics.ts
 */
export {};

const TARGET_VOICES = [
  { label: "Víctor", voice_id: "TbvhqFC7AApJv7hnNvmY" },
  { label: "Mateo", voice_id: "uYlzyj2kIZo3HfBB21vF" },
] as const;

const TARGET_MODEL_IDS = ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3"] as const;

type SubscriptionResponse = {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  can_extend_character_limit?: boolean;
  max_credit_limit_extension?: number | string;
  status?: string;
  [key: string]: unknown;
};

type SharedVoice = {
  voice_id: string;
  public_owner_id: string;
  name: string;
  language?: string | null;
  locale?: string | null;
  accent?: string | null;
  category?: string | null;
  free_users_allowed?: boolean | null;
  credit_multiplier?: number | null;
  notice_period?: number | null;
  live_moderation_enabled?: boolean | null;
  [key: string]: unknown;
};

type SharedVoicesResponse = { voices: SharedVoice[] };

type ElevenLabsModel = {
  model_id: string;
  name?: string;
  languages?: { language_id: string; name: string }[];
  max_characters_request_free_user?: number;
  max_characters_request_subscribed_user?: number;
  can_use_style?: boolean;
  can_use_speaker_boost?: boolean;
  can_be_finetuned?: boolean;
  [key: string]: unknown;
};

async function get<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    // El cuerpo de error de ElevenLabs no incluye la key (va solo en el
    // header de la petición) — seguro de imprimir.
    throw new Error(`GET ${path} respondió ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");

  // --- 1. Plan y cuota ---
  console.log("=== GET /v1/user/subscription ===");
  const sub = await get<SubscriptionResponse>(apiKey, "/v1/user/subscription");
  console.log(
    JSON.stringify(
      {
        tier: sub.tier ?? "no informado por la API",
        character_count: sub.character_count ?? "no informado por la API",
        character_limit: sub.character_limit ?? "no informado por la API",
        can_extend_character_limit: sub.can_extend_character_limit ?? "no informado por la API",
        max_credit_limit_extension: sub.max_credit_limit_extension ?? "no informado por la API",
        status: sub.status ?? "no informado por la API",
      },
      null,
      2,
    ),
  );

  // --- 2. Modelos disponibles ---
  console.log("\n=== GET /v1/models ===");
  const models = await get<ElevenLabsModel[]>(apiKey, "/v1/models");
  for (const modelId of TARGET_MODEL_IDS) {
    const found = models.find((m) => m.model_id === modelId);
    if (!found) {
      console.log(`${modelId}: NO aparece en /v1/models para esta cuenta.`);
      continue;
    }
    const supportsSpanish = (found.languages ?? []).some(
      (l) => l.language_id === "es" || /spanish/i.test(l.name ?? ""),
    );
    console.log(
      JSON.stringify(
        {
          model_id: found.model_id,
          name: found.name ?? "no informado",
          soporta_espanol: supportsSpanish,
          max_characters_request_free_user: found.max_characters_request_free_user ?? "no informado",
          max_characters_request_subscribed_user:
            found.max_characters_request_subscribed_user ?? "no informado",
          can_use_style: found.can_use_style ?? "no informado",
          can_use_speaker_boost: found.can_use_speaker_boost ?? "no informado",
        },
        null,
        2,
      ),
    );
  }

  // --- 3. Metadata de Víctor y Mateo ---
  console.log("\n=== GET /v1/shared-voices (language=es, filtrando a las 2 voces pedidas) ===");
  const shared = await get<SharedVoicesResponse>(
    apiKey,
    "/v1/shared-voices?language=es&page_size=100",
  );
  for (const target of TARGET_VOICES) {
    const voice = shared.voices.find((v) => v.voice_id === target.voice_id);
    if (!voice) {
      console.log(`${target.label} (${target.voice_id}): NO encontrada en esta página de resultados.`);
      continue;
    }
    console.log(
      JSON.stringify(
        {
          label: target.label,
          name: voice.name,
          voice_id: voice.voice_id,
          public_owner_id: voice.public_owner_id,
          free_users_allowed: voice.free_users_allowed ?? "no informado por la API",
          // Nunca se infiere: si el campo no viene en la respuesta, se
          // reporta explícitamente como no disponible, tal como pediste.
          credit_multiplier:
            voice.credit_multiplier === undefined || voice.credit_multiplier === null
              ? "NO DISPONIBLE — la API no devolvió este campo para esta voz"
              : voice.credit_multiplier,
          category: voice.category ?? "no informado",
          language: voice.language ?? "no informado",
          locale: voice.locale ?? "no informado",
          accent: voice.accent ?? "no informado",
          notice_period: voice.notice_period ?? "no informado",
          live_moderation_enabled: voice.live_moderation_enabled ?? "no informado",
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error("Fallo el diagnóstico A/B:", err);
  process.exit(1);
});
