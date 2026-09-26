/**
 * Catálogo FIJO de voces de narración (sin I/O, apto para el navegador).
 *
 * Cinco voces: Mateo (la aprobada en la prueba A/B, con su configuración
 * intacta) y cuatro elegidas con la investigación de solo lectura del
 * 2026-09-26 (scripts/elevenlabs-voice-catalog-research.ts, workflow
 * voice-catalog-research.yml, run 36261382375). Datos medidos por la API de
 * ElevenLabs (GET /v1/shared-voices), no un ranking promocional; detalle y
 * motivos en docs/VOICES.md.
 *
 * El catálogo NO cambia solo cuando cambia la popularidad: cambiarlo es una
 * decisión explícita (editar este archivo). Una voz que falla nunca se
 * sustituye en silencio por otra: el proveedor devuelve el error y la
 * producción se detiene con el motivo.
 *
 * Idiomas: español en todas; inglés solo donde ElevenLabs verificó la voz
 * en inglés con el modelo que usamos (eleven_multilingual_v2) o, en Mateo,
 * donde ya se usaba así en producción.
 */

export type CatalogVoiceId = "mateo" | "miguel" | "mauricio" | "norah" | "tatiana";
export type VoiceLanguage = "es" | "en";

export type CatalogVoice = {
  id: CatalogVoiceId;
  label: string;
  gender: "male" | "female";
  /** Una línea para el selector. */
  description: string;
  /** voice_id de ElevenLabs (Mateo: ver providerVoiceIdFor, admite su variable de entorno histórica). */
  providerVoiceId: string;
  languages: VoiceLanguage[];
  accent: string;
};

export const VOICE_CATALOG: Record<CatalogVoiceId, CatalogVoice> = {
  mateo: {
    id: "mateo",
    label: "Mateo",
    gender: "male",
    description: "Masculina, cercana y equilibrada. La voz de siempre.",
    providerVoiceId: "uYlzyj2kIZo3HfBB21vF",
    languages: ["es", "en"],
    accent: "latinoamericano",
  },
  miguel: {
    id: "miguel",
    label: "Miguel",
    gender: "male",
    description: "Masculina, grave y cinematográfica. Historia, misterio y épica.",
    providerVoiceId: "k8cFOyAg7B9qwBlDDNTC",
    languages: ["es", "en"],
    accent: "latinoamericano",
  },
  mauricio: {
    id: "mauricio",
    label: "Mauricio",
    gender: "male",
    description: "Masculina, natural y conversacional.",
    providerVoiceId: "94zOad0g7T7K4oa7zhDq",
    languages: ["es", "en"],
    accent: "latinoamericano",
  },
  norah: {
    id: "norah",
    label: "Norah",
    gender: "female",
    description: "Femenina, cálida y cercana. Ideal para podcast.",
    providerVoiceId: "kcQkGnn0HAT2JRDQ4Ljp",
    languages: ["es", "en"],
    accent: "latinoamericano",
  },
  tatiana: {
    id: "tatiana",
    label: "Tatiana",
    gender: "female",
    description: "Femenina, serena y narrativa.",
    providerVoiceId: "2rigMbVWLdqtBSCahJFX",
    languages: ["es"],
    accent: "latinoamericano",
  },
};

export const CATALOG_VOICE_IDS = Object.keys(VOICE_CATALOG) as CatalogVoiceId[];
export const DEFAULT_VOICE_ID: CatalogVoiceId = "mateo";

/** Elección de voz guardada en una solicitud: una voz del catálogo o una voz privada propia («Mi voz»). */
export type VoiceChoice = { kind: "catalog"; id: CatalogVoiceId } | { kind: "custom"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Forma persistida: «mateo» o «custom:<uuid>». Vacío = voz por defecto. Cualquier otra cosa = inválida (null). */
export function parseVoiceChoice(raw: unknown): VoiceChoice | null {
  if (raw === undefined || raw === null || raw === "") return { kind: "catalog", id: DEFAULT_VOICE_ID };
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if ((CATALOG_VOICE_IDS as string[]).includes(value)) return { kind: "catalog", id: value as CatalogVoiceId };
  if (value.startsWith("custom:") && UUID.test(value.slice(7))) return { kind: "custom", id: value.slice(7).toLowerCase() };
  return null;
}

export function serializeVoiceChoice(choice: VoiceChoice): string {
  return choice.kind === "catalog" ? choice.id : `custom:${choice.id}`;
}

export function catalogVoicesFor(language: VoiceLanguage): CatalogVoice[] {
  return CATALOG_VOICE_IDS.map((id) => VOICE_CATALOG[id]).filter((v) => v.languages.includes(language));
}

/** Motivo legible si una voz del catálogo no admite el idioma; null si sí. */
export function catalogLanguageIssue(id: CatalogVoiceId, language: VoiceLanguage): string | null {
  const voice = VOICE_CATALOG[id];
  if (voice.languages.includes(language)) return null;
  return `${voice.label} solo está disponible en español. Elige otra voz para narrar en inglés.`;
}
