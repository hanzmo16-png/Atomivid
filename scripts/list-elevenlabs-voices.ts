/**
 * Diagnóstico de solo lectura: lista las voces de la cuenta de ElevenLabs configurada (GET /v1/voices, gratis,
 * no genera audio). Nunca imprime la clave ni URLs de muestras (las de clones privados son contenido del dueño).
 *
 * Uso: npx tsx scripts/list-elevenlabs-voices.ts
 *   Imprime además el detalle de compatibilidad de las voces no premade (o de VOICE_NAME_FILTER si se define).
 */
export {};

type V = {
  voice_id: string; name: string; category: string; is_owner?: boolean; preview_url?: string | null;
  high_quality_base_model_ids?: string[]; fine_tuning?: { state?: Record<string, string> } | null;
  verified_languages?: { language?: string; model_id?: string }[] | null; labels?: Record<string, string> | null;
  sharing?: { status?: string } | null;
};

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs respondió ${res.status}`);
  const data = (await res.json()) as { voices: V[] };
  console.log(`Total de voces visibles para esta cuenta: ${data.voices.length}`);
  for (const v of data.voices) console.log(`voice_id=${v.voice_id} name="${v.name}" category=${v.category}`);

  const filter = process.env.VOICE_NAME_FILTER?.trim().toLowerCase();
  {
    const model = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";
    const hits = data.voices.filter((v) => filter ? v.name.toLowerCase().includes(filter) : v.category !== "premade");
    console.log(`\nDetalle (${filter ? `nombre contiene "${filter}"` : "voces no premade"}): ${hits.length} (modelo de TTS en uso: ${model})`);
    for (const v of hits) {
      console.log(JSON.stringify({
        voice_id: v.voice_id, name: v.name, category: v.category, is_owner: v.is_owner ?? null,
        sharing: v.sharing?.status ?? null, has_preview_url: !!v.preview_url,
        high_quality_base_model_ids: v.high_quality_base_model_ids ?? null,
        fine_tuning_state: v.fine_tuning?.state ?? null,
        verified_languages: (v.verified_languages ?? []).map((l) => `${l.language}:${l.model_id}`),
        labels_language: v.labels?.language ?? null,
        compatible_with_model: (v.high_quality_base_model_ids ?? []).includes(model) || (v.verified_languages ?? []).some((l) => l.model_id === model) || null,
      }));
    }
  }
}

main().catch((err) => { console.error("Fallo al listar voces:", err instanceof Error ? err.message : "error"); process.exit(1); });
