/**
 * Agrega a My Voices las voces del catálogo (src/lib/voices/catalog.ts) que
 * vienen de la Voice Library, para poder usarlas por voice_id en la API.
 *
 * - MODE=plan (por defecto): SOLO LECTURA. Comprueba cada voz (GET
 *   /v1/voices/{id}); si no está en My Voices la busca en la biblioteca
 *   (/v1/shared-voices) y muestra public_owner_id, recargos y condiciones.
 * - MODE=add + ADD_VOICES_CONFIRM=true: además agrega las que faltan (POST
 *   /v1/voices/add/{public_owner_id}/{voice_id}). Agregar no sintetiza
 *   audio ni consume caracteres. Idempotente: una voz ya presente no se
 *   vuelve a agregar. Nunca elimina voces.
 *
 * Seguridad del catálogo: si una voz tiene recargo (rate/credit_multiplier
 * > 1 o fiat_rate), no es de la biblioteca, o ElevenLabs devuelve un
 * voice_id distinto al del catálogo, el script falla con el motivo y NO la
 * sustituye: cambiar el catálogo es una decisión explícita.
 *
 * Registra voice_slots_used antes y después (las voces de la biblioteca no
 * deberían ocupar espacios de clonación; si cambia, queda a la vista).
 *
 * Uso: ELEVENLABS_API_KEY=... [MODE=add ADD_VOICES_CONFIRM=true] npx tsx scripts/elevenlabs-add-catalog-voices.ts
 */
import { CATALOG_VOICE_IDS, VOICE_CATALOG } from "../src/lib/voices/catalog";

const API = "https://api.elevenlabs.io";
type Json = Record<string, unknown>;

async function call(method: "GET" | "POST", pathname: string, apiKey: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { "xi-api-key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Json };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 300) } };
  }
}

function surcharge(v: Json): string | null {
  const rate = typeof v.rate === "number" ? v.rate : null;
  const multiplier = typeof v.credit_multiplier === "number" ? v.credit_multiplier : null;
  if (rate !== null && rate > 1) return `rate ${rate}`;
  if (multiplier !== null && multiplier > 1) return `credit_multiplier ${multiplier}`;
  if (v.fiat_rate !== null && v.fiat_rate !== undefined) return `fiat_rate ${JSON.stringify(v.fiat_rate)}`;
  return null;
}

/** Busca la voz en la biblioteca por nombre (español) y la confirma por voice_id. */
async function findInLibrary(voiceId: string, name: string, gender: string, apiKey: string): Promise<Json | null> {
  const queries = [
    `/v1/shared-voices?search=${encodeURIComponent(name)}&language=es&page_size=100`,
    `/v1/shared-voices?search=${encodeURIComponent(name)}&page_size=100`,
    ...[0, 1, 2, 3, 4].map((page) => `/v1/shared-voices?language=es&gender=${gender}&sort=usage_character_count_1y&page_size=100&page=${page}`),
  ];
  for (const q of queries) {
    const r = await call("GET", q, apiKey);
    const voices = Array.isArray(r.body.voices) ? (r.body.voices as Json[]) : [];
    const hit = voices.find((v) => v.voice_id === voiceId);
    console.log(`[biblioteca] ${r.status} ${voices.length} voces${hit ? " — encontrada" : ""} — ${q}`);
    if (hit) return hit;
  }
  return null;
}

const MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

/**
 * Idiomas verificados por ElevenLabs con el modelo que usamos y URLs de las
 * previews PÚBLICAS (audio ya existente: descargarlo no sintetiza ni cobra).
 * Líneas «[preview] <id> <etiqueta> <url>» para recuperarlas del log.
 */
function reportVoice(id: string, v: Json, catalogLanguages: string[]): string[] {
  const problems: string[] = [];
  const verified = Array.isArray(v.verified_languages) ? (v.verified_languages as Json[]) : [];
  const withModel = verified.filter((l) => l.model_id === MODEL);
  const langs = [...new Set(withModel.map((l) => String(l.language)))];
  console.log(`[${id}] modelo ${MODEL}: idiomas verificados ${langs.join(", ") || "(ninguno)"}; catálogo: ${catalogLanguages.join(", ")}`);
  if (Array.isArray(v.high_quality_base_model_ids)) console.log(`[${id}] high_quality_base_model_ids: ${(v.high_quality_base_model_ids as string[]).join(", ")}`);
  for (const lang of catalogLanguages) {
    if (!langs.includes(lang) && !(id === "mateo" && lang === "en")) problems.push(`${id}: el catálogo ofrece «${lang}» pero ElevenLabs no lo verifica con ${MODEL}`);
  }
  if (typeof v.preview_url === "string" && v.preview_url) console.log(`[preview] ${id} default ${v.preview_url}`);
  for (const l of verified) {
    if ((l.language === "es" || l.language === "en") && typeof l.preview_url === "string" && l.preview_url) {
      console.log(`[preview] ${id} ${l.language}-${l.locale || l.accent || "x"}-${l.model_id} ${l.preview_url}`);
    }
  }
  return problems;
}

async function slots(apiKey: string): Promise<string> {
  const r = await call("GET", "/v1/user/subscription", apiKey);
  const b = r.body;
  const reset = typeof b.next_character_count_reset_unix === "number" ? new Date(b.next_character_count_reset_unix * 1000).toISOString() : "-";
  return `tier=${b.tier} status=${b.status} character_count=${b.character_count} character_limit=${b.character_limit} next_reset=${reset} can_extend_character_limit=${b.can_extend_character_limit} allowed_to_extend_character_limit=${b.allowed_to_extend_character_limit} voice_slots_used=${b.voice_slots_used} voice_limit=${b.voice_limit} professional_voice_slots_used=${b.professional_voice_slots_used} voice_add_edit_counter=${b.voice_add_edit_counter}`;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Falta ELEVENLABS_API_KEY");
  const mode = process.env.MODE === "add" ? "add" : "plan";
  if (mode === "add" && process.env.ADD_VOICES_CONFIRM !== "true") throw new Error("MODE=add requiere ADD_VOICES_CONFIRM=true");
  console.log(`[modo] ${mode}`);
  console.log(`[cuenta antes] ${await slots(apiKey)}`);

  const problems: string[] = [];
  for (const id of CATALOG_VOICE_IDS) {
    const voice = VOICE_CATALOG[id];
    const own = await call("GET", `/v1/voices/${voice.providerVoiceId}`, apiKey);
    if (own.status === 200) {
      console.log(`[${id}] ${voice.providerVoiceId} ya está en My Voices (categoría ${own.body.category}, nombre «${own.body.name}»)`);
      problems.push(...reportVoice(id, own.body, voice.languages));
      continue;
    }
    console.log(`[${id}] ${voice.providerVoiceId} no está en My Voices (GET ${own.status})`);
    const lib = await findInLibrary(voice.providerVoiceId, voice.label, voice.gender, apiKey);
    if (!lib) {
      problems.push(`${id}: no se encontró en la biblioteca`);
      continue;
    }
    problems.push(...reportVoice(id, lib, voice.languages));
    const extra = surcharge(lib);
    console.log(
      `[${id}] biblioteca: «${lib.name}» public_owner_id=${lib.public_owner_id} rate=${lib.rate ?? "-"} fiat_rate=${JSON.stringify(lib.fiat_rate ?? null)} notice_period=${lib.notice_period ?? "-"} free_users_allowed=${lib.free_users_allowed ?? "-"}`,
    );
    if (extra) {
      problems.push(`${id}: tiene recargo (${extra}); no se agrega`);
      continue;
    }
    if (mode !== "add") continue;
    const added = await call("POST", `/v1/voices/add/${lib.public_owner_id}/${voice.providerVoiceId}`, apiKey, { new_name: `Atomivid · ${voice.label}` });
    console.log(`[${id}] POST add → ${added.status} ${JSON.stringify(added.body).slice(0, 200)}`);
    if (added.status !== 200) {
      problems.push(`${id}: el proveedor rechazó agregarla (${added.status})`);
      continue;
    }
    if (added.body.voice_id !== voice.providerVoiceId) {
      problems.push(`${id}: ElevenLabs devolvió voice_id ${added.body.voice_id}, distinto del catálogo; hay que decidir explícitamente si se actualiza el catálogo`);
      continue;
    }
    const check = await call("GET", `/v1/voices/${voice.providerVoiceId}`, apiKey);
    console.log(`[${id}] verificación GET → ${check.status}`);
    if (check.status !== 200) problems.push(`${id}: agregada pero GET devuelve ${check.status}`);
  }

  console.log(`[cuenta después] ${await slots(apiKey)}`);
  if (problems.length) {
    console.error(`[problemas]\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(mode === "add" ? "[ok] Todas las voces del catálogo están en My Voices." : "[ok] Plan sin problemas. Nada se modificó.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
