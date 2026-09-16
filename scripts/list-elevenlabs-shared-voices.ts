/**
 * Diagnóstico de un solo uso, exclusivamente de LECTURA: consulta la
 * biblioteca COMPARTIDA de ElevenLabs (Voice Library, distinta de "My
 * Voices" que ya cubre scripts/list-elevenlabs-voices.ts) vía
 * GET /v1/shared-voices, para encontrar candidatas reales en español antes
 * de decidir cuál agregar a la cuenta.
 *
 * Deliberadamente NO hace nada más:
 * - Ninguna llamada de síntesis (texto a voz) — no genera audio, no
 *   consume créditos de TTS.
 * - Ninguna llamada de escritura contra ElevenLabs — nunca llama a
 *   POST /v1/voices/add/:public_owner_id/:voice_id (agregar voz).
 * - No toca la configuración de producción (src/lib/ai/voice.ts) ni
 *   ningún secret/env var de producción.
 *
 * Uso: npx tsx scripts/list-elevenlabs-shared-voices.ts
 */
export {};

// Primer criterio (obligatorio, filtro del lado de la API): idioma
// español. El resto de los criterios pedidos (acento latino/mexicano,
// género masculino, edad adulta, tono cálido/grave, uso narrativo o
// motivacional) no tienen todos un parámetro de filtro dedicado y
// confiable en este endpoint según la documentación disponible, así que
// se aplican como puntaje del lado del cliente sobre el resultado ya
// filtrado por idioma — mismo patrón que scripts/voice-comparison.ts.
const LANGUAGE_FILTER = "es";
const PAGE_SIZE = 100; // máximo permitido por la API

type SharedVoice = {
  voice_id: string;
  public_owner_id: string;
  name: string;
  language?: string | null;
  accent?: string | null;
  gender?: string | null;
  age?: string | null;
  descriptive?: string | null;
  description?: string | null;
  use_case?: string | null;
  category?: string | null;
  preview_url?: string | null;
  free_users_allowed?: boolean | null;
  // Nombre de campo documentado de forma inconsistente entre fuentes
  // (posible "rate"/"credit_multiplier") — se lee de forma flexible más
  // abajo sin asumir un nombre exacto, y se reporta tal cual venga.
  [key: string]: unknown;
};

type SharedVoicesResponse = {
  voices: SharedVoice[];
  has_more?: boolean;
  total_count?: number;
};

function scoreVoice(voice: SharedVoice): { score: number; reasons: string[] } {
  const haystack = [
    voice.accent,
    voice.age,
    voice.descriptive,
    voice.description,
    voice.use_case,
    voice.category,
    voice.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  const gender = (voice.gender ?? "").toLowerCase();
  if (gender === "male") {
    score += 10;
    reasons.push("gender=male");
  } else if (gender === "female") {
    return { score: -1, reasons: ["descartada: gender=female"] };
  }

  const latinAmericanSignals = [
    "latin american",
    "latino",
    "mexican",
    "mexico",
    "colombia",
    "colombian",
    "argentin",
    "chilean",
    "peruvian",
  ];
  if (latinAmericanSignals.some((s) => haystack.includes(s))) {
    score += 8;
    reasons.push("acento latinoamericano/mexicano detectado en accent/description");
  } else if (haystack.includes("castilian") || haystack.includes("spain") || haystack.includes("european spanish")) {
    score += 2; // español de España: no es lo pedido, pero sigue siendo español real
    reasons.push("acento español (España), no latinoamericano");
  }

  const age = (voice.age ?? "").toLowerCase();
  if (age.includes("middle") || age.includes("adult")) {
    score += 3;
    reasons.push(`age=${age}`);
  } else if (age.includes("young")) {
    score += 1;
  }

  const warmDeepSignals = ["warm", "deep", "calm", "confident", "smooth", "husky", "baritone", "mature", "trustworthy"];
  const matchedWarmth = warmDeepSignals.filter((s) => haystack.includes(s));
  if (matchedWarmth.length > 0) {
    score += matchedWarmth.length * 2;
    reasons.push(`tono cálido/grave sugerido: ${matchedWarmth.join(", ")}`);
  }

  const useCaseSignals = ["narrat", "motivation", "social_media", "social media", "storytell", "informative"];
  if (useCaseSignals.some((s) => haystack.includes(s))) {
    score += 4;
    reasons.push("use_case/category acorde a narrativo/motivacional/social media");
  }

  return { score, reasons };
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");

  const url = new URL("https://api.elevenlabs.io/v1/shared-voices");
  url.searchParams.set("language", LANGUAGE_FILTER);
  url.searchParams.set("page_size", String(PAGE_SIZE));

  console.log(`Consultando biblioteca compartida (GET /v1/shared-voices?language=${LANGUAGE_FILTER}, solo lectura, sin costo de síntesis)...`);
  const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
  if (!res.ok) {
    // El cuerpo de error de ElevenLabs no incluye la API key (va solo en
    // el header de la petición) — seguro de imprimir.
    throw new Error(`ElevenLabs /v1/shared-voices respondió ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as SharedVoicesResponse;
  const voices = data.voices ?? [];
  console.log(`Total de voces devueltas para language=${LANGUAGE_FILTER}: ${voices.length}` +
    (typeof data.total_count === "number" ? ` (total_count reportado por la API: ${data.total_count})` : "") +
    (data.has_more ? " — hay más páginas disponibles, no se paginó (fuera de alcance de este diagnóstico)." : ""));

  if (voices.length === 0) {
    console.log("\nLa API no devolvió ninguna voz para language=es en la biblioteca compartida.");
    return;
  }

  const scored = voices
    .map((voice) => ({ voice, ...scoreVoice(voice) }))
    .filter((v) => v.score >= 0)
    .sort((a, b) => b.score - a.score);

  const top10 = scored.slice(0, 10);

  console.log(`\nTop ${top10.length} candidatas (de ${voices.length} voces en español devueltas por la API):\n`);

  for (const { voice, score, reasons } of top10) {
    // free_users_allowed es el único campo de disponibilidad-por-plan que
    // la documentación consultada menciona con algo de consistencia — se
    // reporta tal cual venga (incluyendo "no informado por la API" si el
    // campo no vino en la respuesta, en vez de asumir un valor).
    const availability =
      voice.free_users_allowed === true
        ? "disponible para usuarios free (según free_users_allowed=true)"
        : voice.free_users_allowed === false
          ? "REQUIERE plan de pago (según free_users_allowed=false)"
          : "no informado por la API en este campo — no determinable sin intentar agregarla";

    console.log(
      [
        `score=${score}`,
        `name="${voice.name}"`,
        `voice_id=${voice.voice_id}`,
        `public_owner_id=${voice.public_owner_id}`,
        `language=${voice.language ?? "?"}`,
        `accent=${voice.accent ?? "?"}`,
        `gender=${voice.gender ?? "?"}`,
        `age=${voice.age ?? "?"}`,
        `category=${voice.category ?? "?"}`,
        `use_case=${voice.use_case ?? "?"}`,
        `descriptive=${voice.descriptive ?? "?"}`,
        `description=${JSON.stringify(voice.description ?? null)}`,
        `preview_url=${voice.preview_url ?? "no informado por la API"}`,
        `disponibilidad=${availability}`,
        `razones=[${reasons.join("; ")}]`,
      ].join(" | "),
    );
  }

  const requiresPaid = top10.filter((v) => v.voice.free_users_allowed === false);
  const freeAvailable = top10.filter((v) => v.voice.free_users_allowed === true);
  const unknownAvailability = top10.filter((v) => v.voice.free_users_allowed !== true && v.voice.free_users_allowed !== false);

  console.log("\n--- Resumen de disponibilidad (dentro del top 10) ---");
  console.log(`Disponibles gratis (free_users_allowed=true): ${freeAvailable.length}`);
  console.log(`Requieren plan de pago (free_users_allowed=false): ${requiresPaid.length}`);
  console.log(`Disponibilidad no determinable desde esta respuesta: ${unknownAvailability.length}`);
  console.log(
    "\nNota: si una voz no se puede agregar a ESTA cuenta específica por otra razón (región, moderación, " +
      "restricción del dueño no reflejada en free_users_allowed), este endpoint de solo lectura no lo garantiza — " +
      "solo un intento real de POST /v1/voices/add lo confirmaría, y esa llamada de escritura está fuera de " +
      "alcance de este diagnóstico.",
  );
}

main().catch((err) => {
  console.error("Fallo al consultar la biblioteca compartida:", err);
  process.exit(1);
});
