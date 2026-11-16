/**
 * Audio Podcast Studio — verificación de capacidades de ElevenLabs, SOLO LECTURA (GET; no sintetiza, no consume
 * créditos, no modifica nada). Responde con datos de la cuenta real:
 *  - ¿Existe eleven_v4_turbo para esta cuenta? ¿Español? ¿Límite de caracteres por solicitud? ¿style / speaker boost?
 *    ¿multiplicador de costo informado por la API?
 *  - ¿Qué voces de la cuenta en español admiten v4 Turbo (modelos de alta calidad / estado de ajuste fino)?
 *  - Plan de la cuenta (solo el nombre del plan; nunca facturación ni datos personales).
 * Nunca imprime la clave. Uso: ELEVENLABS_API_KEY=… npx tsx scripts/audio-studio/elevenlabs-capacidades.ts
 */
export {};

const MODELS = ["eleven_multilingual_v2", "eleven_v4_turbo", "eleven_v4"] as const;
const API = "https://api.elevenlabs.io";

type Model = {
  model_id: string; name?: string; can_do_text_to_speech?: boolean; can_use_style?: boolean; can_use_speaker_boost?: boolean;
  max_characters_request_subscribed_user?: number; maximum_text_length_per_request?: number; requires_alpha_access?: boolean;
  languages?: { language_id: string; name: string }[]; model_rates?: Record<string, unknown>; concurrency_group?: string;
};
type Voice = { voice_id: string; name?: string; category?: string; labels?: Record<string, string>; high_quality_base_model_ids?: string[]; fine_tuning?: { state?: Record<string, string> } ; verified_languages?: { language?: string; model_id?: string }[] };

async function get<T>(key: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) { console.log("RESULTADO SIN_CLAVE  falta ELEVENLABS_API_KEY (no se llamó a la API)"); process.exit(1); }
  const out: Record<string, unknown> = {};

  const sub = await get<{ tier?: string; character_limit?: number; character_count?: number }>(key, "/v1/user/subscription").catch((e) => ({ error: String(e) }));
  out.plan = "tier" in sub ? { tier: sub.tier ?? "no informado", caracteres_restantes: (sub.character_limit ?? 0) - (sub.character_count ?? 0) } : sub;

  const models = await get<Model[]>(key, "/v1/models");
  out.modelos = MODELS.map((id) => {
    const m = models.find((x) => x.model_id === id);
    if (!m) return { model_id: id, existe: false };
    return {
      model_id: id, existe: true, nombre: m.name ?? null, tts: m.can_do_text_to_speech ?? null,
      espanol: (m.languages ?? []).some((l) => l.language_id === "es" || /spanish/i.test(l.name)),
      max_caracteres_solicitud: m.max_characters_request_subscribed_user ?? m.maximum_text_length_per_request ?? null,
      style: m.can_use_style ?? null, speaker_boost: m.can_use_speaker_boost ?? null, acceso_alfa: m.requires_alpha_access ?? null,
      tarifas_api: m.model_rates ?? "no informado por la API",
    };
  });

  const voices = await get<{ voices: Voice[] }>(key, "/v1/voices");
  out.voces_es = voices.voices
    .filter((v) => /es|spanish|español/i.test(`${v.labels?.language ?? ""} ${(v.verified_languages ?? []).map((l) => l.language).join(" ")}`))
    .map((v) => ({
      voice_id: v.voice_id, nombre: v.name ?? null, categoria: v.category ?? null, acento: v.labels?.accent ?? null, genero: v.labels?.gender ?? null,
      // Clones profesionales: solo valen con los modelos en los que están entrenados. Las demás voces funcionan con todos.
      modelos_alta_calidad: v.high_quality_base_model_ids ?? [],
      ajuste_fino: v.fine_tuning?.state ?? {},
      v4_turbo_compatible: v.category !== "professional" ? "sí (voz no PVC)" : (v.high_quality_base_model_ids ?? []).includes("eleven_v4_turbo") || v.fine_tuning?.state?.eleven_v4_turbo === "fine_tuned" ? "sí" : "no entrenada para v4 Turbo",
    }));

  console.log(JSON.stringify(out, null, 2));
  const turbo = (out.modelos as { model_id: string; existe: boolean }[]).find((m) => m.model_id === "eleven_v4_turbo");
  console.log(`RESULTADO ${turbo?.existe ? "OK" : "SIN_V4_TURBO"}  modelos=${(out.modelos as unknown[]).length} voces_es=${(out.voces_es as unknown[]).length}`);
}

main().catch((e) => { console.log("RESULTADO ERROR", e instanceof Error ? e.message : String(e)); process.exit(1); });
