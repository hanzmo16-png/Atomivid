/**
 * Diagnóstico de un solo uso: lista las voces disponibles para la cuenta
 * de ElevenLabs configurada (vía GET /v1/voices, no genera audio ni tiene
 * costo) para encontrar una voz "premade" (incluida gratis con la cuenta)
 * en vez de una voz de la Voice Library, que requiere plan de pago para
 * usarse por API — el error visto fue "Free users cannot use library
 * voices via the API".
 *
 * Uso: npx tsx scripts/list-elevenlabs-voices.ts
 */
export {};

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs respondió ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    voices: { voice_id: string; name: string; category: string }[];
  };

  console.log(`Total de voces visibles para esta cuenta: ${data.voices.length}`);
  for (const v of data.voices) {
    console.log(`voice_id=${v.voice_id} name="${v.name}" category=${v.category}`);
  }

  const premade = data.voices.filter((v) => v.category === "premade");
  console.log(`\nVoces "premade" (incluidas gratis, usables por API sin plan de pago): ${premade.length}`);
  if (premade[0]) {
    console.log(`RECOMMENDED_VOICE_ID=${premade[0].voice_id} (${premade[0].name})`);
  } else {
    console.log("No se encontró ninguna voz premade en esta cuenta.");
  }
}

main().catch((err) => {
  console.error("Fallo al listar voces:", err);
  process.exit(1);
});
