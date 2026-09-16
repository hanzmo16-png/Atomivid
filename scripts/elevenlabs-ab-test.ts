/**
 * Prueba A/B controlada, de un solo uso: sintetiza EXACTAMENTE el mismo
 * texto con Víctor y Mateo (mismo modelo/parámetros) para comparar
 * directamente el audio final. Cada paso valida antes de gastar nada:
 *
 * 1. Confirma que la cuenta ya no está en plan Free (GET /v1/user/subscription).
 * 2. Reconfirma disponibilidad de ambas voces (GET /v1/shared-voices).
 * 3. Agrega a My Voices SOLO las que falten, SOLO estas dos
 *    (POST /v1/voices/add/:public_owner_id/:voice_id) — nunca otra voz.
 * 4. Calcula caracteres × credit_multiplier real (nunca asumido en 1× si
 *    la API informa otro valor) y aborta ANTES de sintetizar si el total
 *    estimado supera el límite autorizado.
 * 5. Sintetiza como máximo 2 veces (una por voz, sin reintentos) y mide
 *    el consumo REAL comparando character_count de la suscripción antes/
 *    después de cada síntesis — no un estimado, un número verificado.
 *
 * Nunca toca DEFAULT_VOICE_ID ni ninguna configuración de producción.
 * Nunca imprime la API key ni datos de facturación/personales.
 *
 * Uso: npx tsx scripts/elevenlabs-ab-test.ts
 */
export {};

import fs from "node:fs/promises";

const MAX_TOTAL_CREDITS = 1000;

const AB_TEST_TEXT =
  "Nadie llega lejos sin antes caer. Cada mañana que decides levantarte, aunque todo pese, es una " +
  "victoria silenciosa que nadie aplaude. La disciplina no es motivación constante: es seguir cuando " +
  "ya no quedan ganas. Confía en el proceso; lo que hoy cuesta, mañana te sostiene.";

const MODEL_ID = "eleven_multilingual_v2";
const VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.2,
  use_speaker_boost: true,
  speed: 1.0,
};
const OUTPUT_FORMAT = "mp3_44100_128";

const CANDIDATES = [
  {
    label: "Víctor",
    voice_id: "TbvhqFC7AApJv7hnNvmY",
    public_owner_id: "bd048e4b071f8b2b3ebeb1c364498a3a8f66eea27e81b34614e0df3cead911e3",
    outFile: "victor-ab-test.mp3",
  },
  {
    label: "Mateo",
    voice_id: "uYlzyj2kIZo3HfBB21vF",
    public_owner_id: "64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e",
    outFile: "mateo-ab-test.mp3",
  },
] as const;

type SubscriptionResponse = {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  can_extend_character_limit?: boolean;
  max_credit_limit_extension?: number | string;
  status?: string;
};

type SharedVoice = {
  voice_id: string;
  public_owner_id: string;
  name: string;
  free_users_allowed?: boolean | null;
  credit_multiplier?: number | null;
  category?: string | null;
};

type SharedVoicesResponse = { voices: SharedVoice[] };
type MyVoicesResponse = { voices: { voice_id: string }[] };

async function apiGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} respondió ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function printSubscription(label: string, sub: SubscriptionResponse) {
  console.log(
    `[${label}] ` +
      JSON.stringify({
        tier: sub.tier ?? "no informado",
        character_count: sub.character_count ?? "no informado",
        character_limit: sub.character_limit ?? "no informado",
      }),
  );
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");

  // --- 1. Confirmar plan pagado ---
  console.log("=== Paso 1: confirmar plan (GET /v1/user/subscription) ===");
  const subBefore = await apiGet<SubscriptionResponse>(apiKey, "/v1/user/subscription");
  printSubscription("suscripción actual", subBefore);
  if (subBefore.tier === "free") {
    throw new Error(
      "ABORTADO antes de gastar nada: la API todavía reporta tier=free. " +
        "El plan Starter que confirmaste no se refleja aún en la cuenta — no se continúa.",
    );
  }

  // --- 2. Reconfirmar disponibilidad de ambas voces ---
  console.log("\n=== Paso 2: reconfirmar disponibilidad (GET /v1/shared-voices) ===");
  const shared = await apiGet<SharedVoicesResponse>(
    apiKey,
    "/v1/shared-voices?language=es&page_size=100",
  );
  const resolvedCandidates = CANDIDATES.map((c) => {
    const found = shared.voices.find((v) => v.voice_id === c.voice_id);
    return { ...c, sharedInfo: found ?? null };
  });
  for (const c of resolvedCandidates) {
    if (!c.sharedInfo) {
      throw new Error(
        `ABORTADO antes de gastar nada: ${c.label} (${c.voice_id}) no apareció en esta consulta a ` +
          "/v1/shared-voices — no se puede confirmar su disponibilidad real.",
      );
    }
    console.log(
      `[${c.label}] free_users_allowed=${c.sharedInfo.free_users_allowed} ` +
        `credit_multiplier=${c.sharedInfo.credit_multiplier ?? "no informado por la API"} ` +
        `category=${c.sharedInfo.category ?? "no informado"}`,
    );
    if (c.sharedInfo.free_users_allowed === false && subBefore.tier === "free") {
      throw new Error(`ABORTADO: ${c.label} sigue marcada como no disponible para plan free.`);
    }
  }

  // --- 3. Agregar a My Voices solo las que falten ---
  console.log("\n=== Paso 3: verificar/agregar a My Voices (solo estas 2, si hace falta) ===");
  const myVoices = await apiGet<MyVoicesResponse>(apiKey, "/v1/voices");
  const myVoiceIds = new Set(myVoices.voices.map((v) => v.voice_id));

  for (const c of resolvedCandidates) {
    if (myVoiceIds.has(c.voice_id)) {
      console.log(`[${c.label}] ya estaba en My Voices — no se llamó a "add".`);
      continue;
    }
    console.log(`[${c.label}] no estaba en My Voices — agregando (POST /v1/voices/add)...`);
    const res = await fetch(
      `https://api.elevenlabs.io/v1/voices/add/${c.public_owner_id}/${c.voice_id}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: c.label }),
      },
    );
    if (!res.ok) {
      throw new Error(`No se pudo agregar a ${c.label}: ${res.status} ${await res.text()}`);
    }
    console.log(`[${c.label}] agregada exitosamente a My Voices.`);
  }

  // --- 4. Calcular consumo estimado y aplicar el límite ANTES de sintetizar ---
  console.log("\n=== Paso 4: estimar consumo antes de sintetizar ===");
  const chars = AB_TEST_TEXT.length;
  console.log(`Caracteres exactos del texto: ${chars}`);

  let totalEstimated = 0;
  for (const c of resolvedCandidates) {
    const multiplier =
      typeof c.sharedInfo?.credit_multiplier === "number" ? c.sharedInfo.credit_multiplier : 1;
    const estimated = chars * multiplier;
    totalEstimated += estimated;
    console.log(
      `[${c.label}] multiplicador=${multiplier}${multiplier === 1 ? " (asumido — la API no informó uno distinto)" : " (REAL, informado por la API)"} → estimado ${estimated} créditos`,
    );
  }
  console.log(`Estimado TOTAL: ${totalEstimated} créditos (límite autorizado: ${MAX_TOTAL_CREDITS})`);
  if (totalEstimated > MAX_TOTAL_CREDITS) {
    throw new Error(
      `ABORTADO antes de sintetizar: el estimado (${totalEstimated}) supera el límite autorizado ` +
        `de ${MAX_TOTAL_CREDITS} créditos. No se realizó ninguna síntesis.`,
    );
  }

  // --- 5. Sintetizar (máx. 2 llamadas, sin reintentos) y medir consumo real ---
  console.log("\n=== Paso 5: síntesis (2 llamadas como máximo, sin reintentos) ===");
  const results: { label: string; ok: boolean; error?: string; charsBefore?: number; charsAfter?: number }[] = [];

  for (const c of resolvedCandidates) {
    const subBeforeCall = await apiGet<SubscriptionResponse>(apiKey, "/v1/user/subscription");
    try {
      console.log(`[${c.label}] sintetizando (modelo=${MODEL_ID}, voice_id=${c.voice_id})...`);
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${c.voice_id}?output_format=${OUTPUT_FORMAT}`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: AB_TEST_TEXT,
            model_id: MODEL_ID,
            voice_settings: VOICE_SETTINGS,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(c.outFile, buffer);
      console.log(`[${c.label}] OK — ${buffer.length} bytes → ${c.outFile}`);

      const subAfterCall = await apiGet<SubscriptionResponse>(apiKey, "/v1/user/subscription");
      results.push({
        label: c.label,
        ok: true,
        charsBefore: subBeforeCall.character_count,
        charsAfter: subAfterCall.character_count,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${c.label}] FALLÓ (sin reintento): ${message}`);
      results.push({ label: c.label, ok: false, error: message });
    }
  }

  // --- Resumen final ---
  console.log("\n=== Resumen ===");
  let totalConsumedReal = 0;
  for (const r of results) {
    if (r.ok && typeof r.charsBefore === "number" && typeof r.charsAfter === "number") {
      const consumed = r.charsAfter - r.charsBefore;
      totalConsumedReal += consumed;
      console.log(`[${r.label}] síntesis OK — consumo real verificado (diff de character_count): ${consumed}`);
    } else {
      console.log(`[${r.label}] síntesis FALLIDA: ${r.error}`);
    }
  }
  console.log(`Consumo real total verificado: ${totalConsumedReal} (límite autorizado: ${MAX_TOTAL_CREDITS})`);

  const anyFailed = results.some((r) => !r.ok);
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error("Fallo la prueba A/B:", err);
  process.exit(1);
});
