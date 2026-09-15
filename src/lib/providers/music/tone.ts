import type { MusicTone } from "../types";

export const MUSIC_TONES: readonly MusicTone[] = [
  "motivational",
  "corporate",
  "cinematic",
  "inspirational",
  "tension",
  "reflective",
  "energetic",
  "minimal",
  "technology",
  "luxury",
];

/** Etiquetas en español para UI/logs — mismo patrón que RENDER_STAGE_LABEL. */
export const MUSIC_TONE_LABEL: Record<MusicTone, string> = {
  motivational: "Motivacional",
  corporate: "Corporativo",
  cinematic: "Cinematográfico",
  inspirational: "Inspirador",
  tension: "Tensión",
  reflective: "Reflexivo",
  energetic: "Energético",
  minimal: "Minimalista",
  technology: "Tecnología",
  luxury: "Lujo",
};

// Mapea cada opción del selector de /dashboard/new (ver STYLES en
// src/app/dashboard/new/page.tsx) a uno o más tonos, en orden de
// relevancia. Es el punto de partida — las palabras clave del tema/guion
// pueden reforzar o añadir tonos por encima de esto (ver inferTone).
const STYLE_TONE_MAP: Record<string, MusicTone[]> = {
  motivacional: ["motivational", "inspirational"],
  educativo: ["corporate", "reflective"],
  humor: ["energetic"],
  "historias de terror": ["tension"],
  curiosidades: ["reflective", "energetic"],
  "noticias / actualidad": ["corporate", "minimal"],
  "storytelling personal": ["reflective", "cinematic"],
};

// Palabras clave (español + inglés, sin acentos) que refuerzan un tono
// cuando aparecen en el tema o el guion — señal más fuerte que el estilo
// genérico porque viene del contenido real del video.
const TONE_KEYWORDS: Record<MusicTone, string[]> = {
  motivational: ["motivacion", "supera", "logra", "meta", "disciplina", "motivation", "achieve", "goal"],
  corporate: ["negocio", "empresa", "startup", "finanzas", "productividad", "business", "company", "finance"],
  cinematic: ["cine", "pelicula", "dramatico", "epico", "historia de", "cinematic", "epic", "movie"],
  inspirational: ["inspira", "superacion", "sueño", "transforma", "inspire", "dream", "transform"],
  tension: ["miedo", "terror", "oscuro", "misterio", "peligro", "horror", "fear", "dark", "mystery", "suspenso"],
  reflective: ["reflexion", "calma", "piensa", "consciencia", "mindfulness", "reflect", "calm"],
  energetic: ["accion", "fiesta", "energia", "rapido", "intenso", "action", "party", "energy", "fast"],
  minimal: ["simple", "minimalista", "esencial", "minimal", "simple", "clean"],
  technology: ["tecnologia", "inteligencia artificial", "ia", "robot", "digital", "technology", "artificial intelligence", "ai"],
  luxury: ["lujo", "exclusivo", "premium", "elegante", "luxury", "exclusive"],
};

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/**
 * Infiere los tonos musicales más adecuados a partir de señales del video:
 * el estilo elegido en el formulario (base), reforzado por palabras clave
 * del tema y del guion ya generado. Determinístico — no usa aleatoriedad,
 * así que el resultado es repetible para la misma entrada (útil para
 * depurar por qué se eligió cierta música). Siempre devuelve al menos un
 * tono ("reflective" como respaldo neutro si no hay ninguna señal).
 */
export function inferTone({
  style,
  topic,
  scriptText,
}: {
  style?: string;
  topic?: string;
  scriptText?: string;
}): MusicTone[] {
  const scores = new Map<MusicTone, number>();
  const bump = (tone: MusicTone, weight: number) =>
    scores.set(tone, (scores.get(tone) ?? 0) + weight);

  const normalizedStyle = style?.trim().toLowerCase();
  const baseTones = normalizedStyle ? STYLE_TONE_MAP[normalizedStyle] : undefined;
  baseTones?.forEach((tone, i) => bump(tone, baseTones.length - i));

  const haystack = normalize(`${topic ?? ""} ${scriptText ?? ""}`);
  for (const tone of MUSIC_TONES) {
    // Cada keyword se busca como palabra/frase delimitada por espacios (no
    // como substring suelto) para evitar falsos positivos como "ia" dentro
    // de "biografía" — normalize() ya envuelve haystack en espacios.
    const hits = TONE_KEYWORDS[tone].filter((keyword) =>
      haystack.includes(normalize(keyword)),
    ).length;
    if (hits > 0) bump(tone, hits * 3); // las palabras clave del contenido pesan más que el estilo genérico
  }

  if (scores.size === 0) return ["reflective"];

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([tone]) => tone);
}
