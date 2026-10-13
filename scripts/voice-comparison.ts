/**
 * Prueba controlada de un solo uso: compara 3 voces masculinas reales de la
 * cuenta de ElevenLabs configurada (nunca inventadas — se consultan en vivo
 * vía GET /v1/voices) narrando el MISMO texto con los MISMOS parámetros,
 * para elegir manualmente la voz "aprobada" antes de tocar el default de
 * producción (src/lib/ai/voice.ts).
 *
 * No genera video, imágenes, música ni subtítulos — solo 3 MP3 + un JSON
 * de comparación, subidos como artifact por
 * .github/workflows/voice-comparison.yml. No modifica DEFAULT_VOICE_ID ni
 * ninguna otra config de producción.
 *
 * Selección de candidatas: se piden las labels de cada voz (gender, accent,
 * description, age, language) a la propia API — nunca se hardcodea un
 * voice_id ni un nombre. Se puntúan por cercanía a los criterios pedidos
 * (masculina, español/latino, tono cálido-grave) y se toman las 3 mejores.
 * Si la cuenta no tiene 3 voces que se acerquen razonablemente a esos
 * criterios, el script falla explícitamente en vez de rellenar con voces
 * que no calzan — ver MIN_ACCEPTABLE_SCORE.
 *
 * Uso: npx tsx scripts/voice-comparison.ts
 */
export {};

import fs from "node:fs/promises";

const COMPARISON_TEXT =
  "Nadie te muestra lo que hay detrás del éxito. Solo ven la victoria, pero no las horas perdidas, " +
  "el cansancio ni las ganas de rendirse. Cada resultado exige un sacrificio silencioso. Lo que hoy " +
  "duele, mañana se convierte en fuerza.";

// Mismo modelo multilingüe que ya usa producción (src/lib/ai/voice.ts) — es
// el "modelo multilingüe más adecuado ya disponible en la cuenta", no uno
// nuevo sin probar.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
// Mismos voice_settings que producción, para que la única variable entre
// las 3 muestras sea la voz — comparación justa.
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };

const SAMPLE_COUNT = 3;
const OUTPUT_NAMES = ["voice-a.mp3", "voice-b.mp3", "voice-c.mp3"];

type ElevenLabsVoiceLabels = Partial<{
  gender: string;
  accent: string;
  age: string;
  description: string;
  use_case: string;
  language: string;
}>;

type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  category: string;
  description?: string | null;
  labels?: ElevenLabsVoiceLabels;
};

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

type ElevenLabsTtsResponse = {
  audio_base64: string;
  alignment: ElevenLabsAlignment;
};

/**
 * Puntúa qué tan bien calza una voz con lo pedido: masculina, español/latino
 * neutro, tono medio-grave, cálida/segura. Basada solo en texto libre que
 * la propia API devuelve (labels + description) — no hay campo booleano
 * "es apta para reels motivacionales", así que esto es una heurística por
 * palabras clave, documentada aquí para que la elección final (humana)
 * pueda verificarla contra las labels reales en voice-comparison.json.
 */
function scoreVoice(voice: ElevenLabsVoice): { score: number; reasons: string[] } {
  const labels = voice.labels ?? {};
  const haystack = [
    labels.gender,
    labels.accent,
    labels.age,
    labels.description,
    labels.use_case,
    labels.language,
    voice.description,
    voice.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  const gender = (labels.gender ?? "").toLowerCase();
  if (gender === "male") {
    score += 10;
    reasons.push("labels.gender=male");
  } else if (gender === "female") {
    return { score: -1, reasons: ["descartada: labels.gender=female"] };
  }

  const spanishSignals = [
    "spanish",
    "español",
    "latin",
    "latino",
    "mexican",
    "mexico",
    "colombia",
    "colombian",
    "argentin",
    "castilian",
    "neutral spanish",
  ];
  if (spanishSignals.some((s) => haystack.includes(s))) {
    score += 6;
    reasons.push("mención de español/latino en labels/descripción");
  }

  const warmDeepSignals = ["warm", "deep", "calm", "confident", "smooth", "husky", "baritone", "mature"];
  const matchedWarmth = warmDeepSignals.filter((s) => haystack.includes(s));
  if (matchedWarmth.length > 0) {
    score += matchedWarmth.length * 2;
    reasons.push(`tono cálido/grave sugerido: ${matchedWarmth.join(", ")}`);
  }

  const age = (labels.age ?? "").toLowerCase();
  if (age.includes("middle") || age.includes("adult")) {
    score += 3;
    reasons.push(`edad=${age} (medio-grave probable)`);
  } else if (age.includes("young")) {
    score += 1;
  }

  // Categoría "premade" es la única garantizada usable por API sin plan de
  // pago en todas las cuentas (ver comentario histórico en
  // src/lib/ai/voice.ts) — se prioriza, pero no se descarta el resto: si
  // falla al sintetizar, el error queda explícito en la salida, no en
  // silencio.
  if (voice.category === "premade") {
    score += 2;
    reasons.push("category=premade (usable por API sin plan de pago)");
  }

  return { score, reasons };
}

// Si ni las 3 mejores candidatas llegan a este puntaje mínimo, la cuenta no
// tiene voces razonablemente cercanas a lo pedido — falla explícito en vez
// de generar muestras que no sirven para decidir nada.
const MIN_ACCEPTABLE_SCORE = 10;

async function fetchVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    // El texto de error de ElevenLabs no incluye la key (va solo en el
    // header de la petición, nunca en el cuerpo de la respuesta) — seguro
    // de imprimir.
    throw new Error(`ElevenLabs /v1/voices respondió ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { voices: ElevenLabsVoice[] };
  return data.voices;
}

async function synthesize(
  apiKey: string,
  voiceId: string,
): Promise<{ audioBuffer: Buffer; durationSeconds: number }> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: COMPARISON_TEXT,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS respondió ${res.status} para voice_id=${voiceId}: ${await res.text()}`);
  }
  const data = (await res.json()) as ElevenLabsTtsResponse;
  const audioBuffer = Buffer.from(data.audio_base64, "base64");
  const durationSeconds = data.alignment.character_end_times_seconds.at(-1) ?? 0;
  return { audioBuffer, durationSeconds };
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");

  console.log("Consultando voces disponibles en la cuenta (GET /v1/voices, sin costo)...");
  const voices = await fetchVoices(apiKey);
  console.log(`Total de voces visibles para esta cuenta: ${voices.length}`);

  const scored = voices
    .map((voice) => ({ voice, ...scoreVoice(voice) }))
    .filter((v) => v.score >= 0)
    .sort((a, b) => b.score - a.score);

  console.log("\nRanking de candidatas (top 10):");
  for (const s of scored.slice(0, 10)) {
    console.log(
      `  score=${s.score} voice_id=${s.voice.voice_id} name="${s.voice.name}" ` +
        `category=${s.voice.category} labels=${JSON.stringify(s.voice.labels ?? {})} ` +
        `razones=[${s.reasons.join("; ")}]`,
    );
  }

  const top3 = scored.slice(0, SAMPLE_COUNT);
  if (top3.length < SAMPLE_COUNT) {
    throw new Error(
      `Solo se encontraron ${top3.length} voces candidatas (se necesitan ${SAMPLE_COUNT}) — ` +
        "la cuenta no tiene suficientes voces masculinas visibles. No se genera nada.",
    );
  }
  if (top3[SAMPLE_COUNT - 1].score < MIN_ACCEPTABLE_SCORE) {
    throw new Error(
      `La 3ra mejor candidata tiene score=${top3[SAMPLE_COUNT - 1].score}, por debajo del mínimo ` +
        `aceptable (${MIN_ACCEPTABLE_SCORE}) — ninguna voz de esta cuenta se acerca razonablemente ` +
        "a los criterios pedidos (masculina, español/latino, cálida/grave). No se genera nada.",
    );
  }

  console.log(`\nGenerando ${SAMPLE_COUNT} muestras con el texto fijo (${COMPARISON_TEXT.length} caracteres)...`);

  const comparison: Array<Record<string, unknown>> = [];

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const { voice, score, reasons } = top3[i];
    const fileName = OUTPUT_NAMES[i];
    console.log(`  [${fileName}] voice_id=${voice.voice_id} name="${voice.name}" score=${score}`);

    const { audioBuffer, durationSeconds } = await synthesize(apiKey, voice.voice_id);
    await fs.writeFile(fileName, audioBuffer);

    const estimatedCostUsd =
      (COMPARISON_TEXT.length / 1000) *
      Number(process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS || 0.18);

    comparison.push({
      file: fileName,
      name_real: voice.name,
      voice_id: voice.voice_id,
      category: voice.category,
      labels: voice.labels ?? {},
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
      duration_seconds: Number(durationSeconds.toFixed(3)),
      character_count: COMPARISON_TEXT.length,
      estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
      selection_score: score,
      selection_reasons: reasons,
    });
  }

  await fs.writeFile("voice-comparison.json", JSON.stringify({ text: COMPARISON_TEXT, samples: comparison }, null, 2));
  console.log("\nvoice-comparison.json escrito. Listo para subir como artifact.");
}

main().catch((err) => {
  console.error("Fallo la prueba de comparación de voces:", err);
  process.exit(1);
});
