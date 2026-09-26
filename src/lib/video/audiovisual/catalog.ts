/**
 * Dirección audiovisual — catálogo y selección del cliente (sin I/O, apto
 * para el navegador). Especificación: docs/AUDIOVISUAL_DIRECTION.md.
 *
 * Tres ejes internos separados, aunque el cliente vea una sola elección:
 *  - APARIENCIA (perfil): cómo se ve — fuente visual, tratamiento, grado.
 *  - INTENCIÓN NARRATIVA: qué emoción sostiene la historia. Sale del tema y
 *    del guion, salvo en «Horror y misterio», que es un perfil completo.
 *  - DIRECCIÓN MUSICAL y RITMO: derivados de la intención (ajustables).
 *
 * Un cómic de misterio y un cómic de humor comparten apariencia y difieren
 * en intención, música y ritmo. Este archivo NO resuelve la dirección
 * final (eso ocurre al aprobar el guion, ver direction.ts): solo define el
 * vocabulario, valida lo que envía el formulario y arma el resumen legible.
 */

export const AUDIOVISUAL_SELECTION_VERSION = 1;

export type ProfileId = "cinematic_realistic" | "illustration_3d" | "anime" | "comic" | "horror_mystery";
export type IntentId = "suspense" | "humor" | "uplifting" | "informative" | "reflective" | "action";
export type MusicDirectionId = "tension" | "playful" | "uplifting" | "neutral" | "emotional" | "driving";
export type MusicChoice = MusicDirectionId | "none";
export type PaceId = "slow" | "balanced" | "dynamic";

/** Origen de las imágenes de un perfil: stock real (Pexels/Pixabay) o imagen generada con el estilo del perfil. */
export type VisualSource = "stock" | "generated_image";

export type Grade = {
  /** Filtro CSS aplicado al plano (brillo/contraste/saturación). */
  filter: string;
  /** 0–1: intensidad de la viñeta radial. */
  vignette: number;
  /** Capa de color translúcida (p. ej. frío para suspenso), o undefined. */
  tint?: string;
};

export type ProfileDefinition = {
  id: ProfileId;
  label: string;
  /** Una línea para la tarjeta del formulario. */
  description: string;
  visualSource: VisualSource;
  /** Intención fija del perfil («Horror y misterio»); el resto la deja a la historia. */
  intentPreset?: IntentId;
  /** Intenciones/música que el cliente puede elegir en «Ajustes» con este perfil (undefined = todas). */
  allowedIntents?: IntentId[];
  allowedMusic?: MusicChoice[];
  /** Tratamiento del generador de imágenes (solo visualSource "generated_image"). En inglés, sin marcas ni artistas. */
  imageStyle?: string;
  imageNegative?: string;
  /** Modificador de búsqueda de stock para el primer intento (p. ej. "dark"). */
  stockQueryModifier?: string;
  grade: Grade;
};

export const PROFILES: Record<ProfileId, ProfileDefinition> = {
  cinematic_realistic: {
    id: "cinematic_realistic",
    label: "Cine realista",
    description: "Clips e imágenes reales. La emoción la marca tu historia.",
    visualSource: "stock",
    grade: { filter: "none", vignette: 0 },
  },
  illustration_3d: {
    id: "illustration_3d",
    label: "Ilustración 3D",
    description: "Escenas en 3D estilizado, generadas para cada escena.",
    visualSource: "generated_image",
    imageStyle:
      "stylized 3D animated film still, soft global illumination, rounded appealing shapes, detailed materials, cinematic depth of field",
    imageNegative: "photograph, live action, real people, text, letters, watermark, logo",
    grade: { filter: "none", vignette: 0.15 },
  },
  anime: {
    id: "anime",
    label: "Anime",
    description: "Ilustración 2D de anime, generada para cada escena.",
    visualSource: "generated_image",
    imageStyle:
      "2D anime illustration, clean line art, cel shading, painted background, expressive composition, vertical frame",
    imageNegative: "photograph, 3D render, live action, text, letters, watermark, logo",
    grade: { filter: "none", vignette: 0.1 },
  },
  comic: {
    id: "comic",
    label: "Cómic",
    description: "Viñetas de cómic con tinta y color, generadas para cada escena.",
    visualSource: "generated_image",
    imageStyle:
      "comic book panel illustration, bold ink outlines, halftone shading, flat saturated colors, dynamic framing",
    imageNegative: "photograph, 3D render, speech bubbles, lettering, text, watermark, logo",
    grade: { filter: "none", vignette: 0.1 },
  },
  horror_mystery: {
    id: "horror_mystery",
    label: "Horror y misterio",
    description: "Imagen oscura, música de tensión y montaje de suspenso.",
    visualSource: "stock",
    intentPreset: "suspense",
    allowedIntents: ["suspense"],
    allowedMusic: ["tension", "none"],
    stockQueryModifier: "dark",
    grade: {
      filter: "brightness(0.78) contrast(1.18) saturate(0.55)",
      vignette: 0.6,
      tint: "rgba(18, 34, 52, 0.22)",
    },
  },
};

export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];
export const DEFAULT_PROFILE: ProfileId = "cinematic_realistic";

export const INTENTS: Record<IntentId, { label: string; defaultMusic: MusicDirectionId; defaultPace: PaceId; scriptGuidance: string }> = {
  suspense: {
    label: "Suspenso",
    defaultMusic: "tension",
    defaultPace: "slow",
    scriptGuidance:
      "Intención narrativa: suspenso y misterio. Frases cortas, pausas marcadas con puntos y puntos suspensivos, información dosificada y una revelación clara cerca del final. Nada de tono motivacional ni celebratorio.",
  },
  humor: {
    label: "Humor",
    defaultMusic: "playful",
    defaultPace: "dynamic",
    scriptGuidance:
      "Intención narrativa: humor. Ritmo ágil, remates breves al final de cada escena, situaciones absurdas o inesperadas contadas con naturalidad; sin burlarse de personas reales.",
  },
  uplifting: {
    label: "Inspirador",
    defaultMusic: "uplifting",
    defaultPace: "balanced",
    scriptGuidance:
      "Intención narrativa: inspiradora. Progresión de dificultad a logro, lenguaje concreto y cercano, cierre esperanzador sin frases vacías.",
  },
  informative: {
    label: "Divulgativo",
    defaultMusic: "neutral",
    defaultPace: "balanced",
    scriptGuidance:
      "Intención narrativa: divulgativa. Claridad, un dato por escena, curiosidad sostenida; tono cercano y natural, ni dramático ni motivacional.",
  },
  reflective: {
    label: "Emotivo",
    defaultMusic: "emotional",
    defaultPace: "slow",
    scriptGuidance:
      "Intención narrativa: emotiva y reflexiva. Frases que respiran, imágenes concretas, pausas antes de las ideas importantes, cierre sereno.",
  },
  action: {
    label: "Acción",
    defaultMusic: "driving",
    defaultPace: "dynamic",
    scriptGuidance:
      "Intención narrativa: acción. Verbos fuertes, frases cortas y encadenadas, sensación de avance constante hasta el clímax.",
  },
};

export const INTENT_IDS = Object.keys(INTENTS) as IntentId[];

export const MUSIC_DIRECTIONS: Record<MusicDirectionId, { label: string; summary: string }> = {
  tension: { label: "Tensión", summary: "música de tensión" },
  playful: { label: "Ligera y divertida", summary: "música ligera" },
  uplifting: { label: "Inspiradora", summary: "música inspiradora" },
  neutral: { label: "Neutra de fondo", summary: "música neutra" },
  emotional: { label: "Emotiva", summary: "música emotiva" },
  driving: { label: "Enérgica", summary: "música enérgica" },
};

export const MUSIC_DIRECTION_IDS = Object.keys(MUSIC_DIRECTIONS) as MusicDirectionId[];

export const PACES: Record<PaceId, { label: string; summary: string }> = {
  slow: { label: "Pausado", summary: "ritmo pausado" },
  balanced: { label: "Equilibrado", summary: "ritmo equilibrado" },
  dynamic: { label: "Dinámico", summary: "ritmo dinámico" },
};

export const PACE_IDS = Object.keys(PACES) as PaceId[];

/**
 * El selector «Tono del contenido» del formulario ya existía (y alimenta el
 * guion). Tres valores expresan una emoción explícita (fuertes); los demás
 * describen el formato y dejan que el guion completo decida (débiles).
 */
export const STRONG_STYLE_INTENT: Record<string, IntentId> = {
  "historias de terror": "suspense",
  humor: "humor",
  motivacional: "uplifting",
};
export const WEAK_STYLE_INTENT: Record<string, IntentId> = {
  educativo: "informative",
  curiosidades: "informative",
  "noticias / actualidad": "informative",
  "storytelling personal": "reflective",
};

/** Lo que el cliente eligió al crear la solicitud. Se guarda tal cual (video_requests.audiovisual_selection). */
export type AudiovisualSelection = {
  version: typeof AUDIOVISUAL_SELECTION_VERSION;
  profile: ProfileId;
  /** Ajustes opcionales; ausentes = automático. */
  intent?: IntentId;
  music?: MusicChoice;
  pace?: PaceId;
};

/**
 * Muestras visuales por perfil. SOLO resultados reales del sistema (una
 * solicitud producida y revisada); mientras no existan, la tarjeta muestra
 * «Muestra pendiente» — nunca una imagen de referencia como si fuera un
 * resultado comprobado. Ver docs/AUDIOVISUAL_PROFILES.md (presupuesto).
 */
export type ProfileSample = { src: string; alt: string; producedFromRequestId: string; reviewedBy: string };
export const PROFILE_SAMPLES: Record<ProfileId, ProfileSample | null> = {
  cinematic_realistic: null,
  illustration_3d: null,
  anime: null,
  comic: null,
  horror_mystery: null,
};

const oneOf = <T extends string>(values: readonly T[], raw: unknown): raw is T =>
  typeof raw === "string" && (values as readonly string[]).includes(raw);

export type SelectionParse = { ok: true; selection: AudiovisualSelection } | { ok: false; error: string };

/**
 * Valida en servidor lo que envía el formulario (nunca confiar en el
 * cliente). Campos vacíos o "auto" = automático. Rechaza combinaciones que
 * contradicen un perfil completo (p. ej. Horror y misterio + humor).
 */
export function parseSelection(raw: { profile?: unknown; intent?: unknown; music?: unknown; pace?: unknown }): SelectionParse {
  const auto = (v: unknown) => v === undefined || v === null || v === "" || v === "auto";
  if (!oneOf(PROFILE_IDS, raw.profile)) return { ok: false, error: "Elige una dirección visual válida" };
  const profile = PROFILES[raw.profile];
  const selection: AudiovisualSelection = { version: AUDIOVISUAL_SELECTION_VERSION, profile: profile.id };

  if (!auto(raw.intent)) {
    if (!oneOf(INTENT_IDS, raw.intent)) return { ok: false, error: "Intención narrativa no válida" };
    if (profile.allowedIntents && !profile.allowedIntents.includes(raw.intent)) {
      return { ok: false, error: `«${profile.label}» mantiene siempre el suspenso` };
    }
    selection.intent = raw.intent;
  }
  if (!auto(raw.music)) {
    if (!oneOf([...MUSIC_DIRECTION_IDS, "none"] as MusicChoice[], raw.music)) return { ok: false, error: "Dirección musical no válida" };
    if (profile.allowedMusic && !profile.allowedMusic.includes(raw.music)) {
      return { ok: false, error: `«${profile.label}» solo admite música de tensión o sin música` };
    }
    selection.music = raw.music;
  }
  if (!auto(raw.pace)) {
    if (!oneOf(PACE_IDS, raw.pace)) return { ok: false, error: "Ritmo no válido" };
    selection.pace = raw.pace;
  }
  return { ok: true, selection };
}

/** Acepta solo selecciones con la forma y versión conocidas (lectura desde la base de datos). */
export function isAudiovisualSelection(value: unknown): value is AudiovisualSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== AUDIOVISUAL_SELECTION_VERSION) return false;
  const parsed = parseSelection(v);
  return parsed.ok;
}

/** Intención que se puede anticipar ANTES del guion (ajuste, perfil o tono fuerte). null = la decide el guion. */
export function anticipatedIntent(selection: AudiovisualSelection, style: string | undefined): IntentId | null {
  if (selection.intent) return selection.intent;
  const preset = PROFILES[selection.profile].intentPreset;
  if (preset) return preset;
  return STRONG_STYLE_INTENT[style?.trim().toLowerCase() ?? ""] ?? null;
}

/**
 * Resumen legible, p. ej. «Suspenso · música de tensión · ritmo pausado».
 * Antes del guion, si la intención depende de la historia, lo dice.
 */
export function summarizeDirection(parts: { intent: IntentId | null; music: MusicChoice | null; pace: PaceId | null }): string {
  const intent = parts.intent ? INTENTS[parts.intent].label : "Emoción según tu guion";
  const music = parts.music === "none" ? "sin música" : parts.music ? MUSIC_DIRECTIONS[parts.music].summary : "música acorde al guion";
  const pace = parts.pace ? PACES[parts.pace].summary : "ritmo acorde al guion";
  return `${intent} · ${music} · ${pace}`;
}

export function previewSummary(selection: AudiovisualSelection, style: string | undefined): string {
  const intent = anticipatedIntent(selection, style);
  return summarizeDirection({
    intent,
    music: selection.music ?? (intent ? INTENTS[intent].defaultMusic : null),
    pace: selection.pace ?? (intent ? INTENTS[intent].defaultPace : null),
  });
}

/** Guía de redacción para el guion (idioma/voz del cliente intactos; nunca cambia el tema). */
export function scriptGuidanceFor(intent: IntentId | null): string | undefined {
  if (!intent) return undefined;
  return `${INTENTS[intent].scriptGuidance} No cambies el tema ni inventes hechos para ajustarlo al estilo.`;
}
