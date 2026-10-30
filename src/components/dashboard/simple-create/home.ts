/**
 * Simple UX — portada «¿Qué quieres crear hoy?» (T-20261030-1313-chatgpt-01). Lógica pura (sin red): qué formatos puede
 * crear la cuenta HOY, a qué ruta real lleva «Continuar» y con qué datos. No inventa funciones: cada formato abre su flujo
 * existente (Reel → /dashboard/new, Podcast → /dashboard/podcast, YouTube → /dashboard/long-form/new) y un formato sin
 * acceso se muestra como «Disponible pronto», nunca como si funcionara. Nada se crea ni se cobra en la portada.
 */
export type CreateFormat = "reel" | "podcast" | "youtube";
export type CreateMode = "auto" | "custom";
export type FormatOption = { id: CreateFormat; title: string; description: string; available: boolean; unavailableReason: string | null };

export const IDEA_MAX = 500;
const SOON = "Disponible pronto para tu cuenta.";

export function createFormats(access: { podcast: boolean; youtube: boolean }): FormatOption[] {
  return [
    { id: "reel", title: "Reel", description: "Video vertical corto para TikTok, Reels o Shorts.", available: true, unavailableReason: null },
    { id: "podcast", title: "Podcast", description: "Una o dos voces conversando, con estudio y música.", available: access.podcast, unavailableReason: access.podcast ? null : SOON },
    { id: "youtube", title: "Video de YouTube", description: "Video horizontal largo, con guion documentado.", available: access.youtube, unavailableReason: access.youtube ? null : SOON },
  ];
}

/** Idea lista para la URL: sin espacios sobrantes y con el límite del formulario de destino. */
export function cleanIdea(idea: string, max = IDEA_MAX): string {
  return idea.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Ruta real de cada formato. Solo se pasa la idea a las rutas que ya la leen (Reel: `idea`; YouTube: `topic`, 200
 * caracteres). El asistente de Podcast aún no lee parámetros: se abre en su primer paso (la idea se escribe ahí).
 * `custom` (Personalizado) solo cambia el Reel: no se elige el estilo automáticamente.
 */
export function continueHref(format: CreateFormat, idea: string, mode: CreateMode = "auto"): string {
  const q = cleanIdea(idea);
  switch (format) {
    case "reel": {
      const p = new URLSearchParams({ formato: "reel" });
      if (q) p.set("idea", q);
      if (mode === "custom") p.set("modo", "personalizado");
      return `/dashboard/new?${p}`;
    }
    case "podcast": return "/dashboard/podcast";
    case "youtube": return `/dashboard/long-form/new${q ? `?topic=${encodeURIComponent(q.slice(0, 200))}` : ""}`;
  }
}

/** Lo que pasa con la idea en cada formato, dicho antes de pulsar «Continuar» (sin sorpresas al llegar). */
export function ideaNote(format: CreateFormat | null, idea: string): string | null {
  if (format === "podcast" && cleanIdea(idea)) return "En Podcast escribirás el tema en el primer paso; copia tu idea si quieres usarla.";
  return null;
}

/** Accesos secundarios: solo rutas que ya existen. */
export const SECONDARY_LINKS = [
  { href: "#proyectos", label: "Mis proyectos" },
  { href: "/dashboard/billing", label: "Facturación y plan" },
] as const;

/** Parámetros con los que un flujo vuelve al historial a mitad de camino: entonces el historial va primero. */
export function midFlow(params: Record<string, string | undefined>): boolean {
  return !!(params.created || params.draft || params.existing || params.script_job);
}

/**
 * Historial sin experimentos al frente: los proyectos fallidos de hace más de 7 días se pliegan en «Proyectos antiguos
 * sin terminar» (no se borra ni se escribe nada). Lo que está en curso, listo o falló hace poco sigue a la vista.
 */
export function splitHistory<T extends { status: string; created_at: string }>(items: T[], now: number, days = 7): { visible: T[]; old: T[] } {
  const cut = now - days * 86_400_000;
  const isOld = (r: T) => r.status === "failed" && Date.parse(r.created_at) < cut;
  return { visible: items.filter((r) => !isOld(r)), old: items.filter(isOld) };
}
export const REEL_STYLES = ["Motivacional", "Educativo", "Humor", "Historias de terror", "Curiosidades", "Noticias / actualidad", "Storytelling personal"] as const;
export type ReelStyle = (typeof REEL_STYLES)[number];
const STYLE_HINTS: [ReelStyle, RegExp][] = [
  ["Historias de terror", /\b(terror|miedo|paranormal|fantasma|leyenda urbana|creepy|horror|embrujad)/i],
  ["Humor", /\b(humor|chiste|gracios|divertid|comedia|meme)/i],
  ["Motivacional", /\b(motivaci|inspira|superaci|éxito|exito|disciplina|metas?\b|hábitos?|habitos?)/i],
  ["Noticias / actualidad", /\b(noticia|actualidad|hoy|esta semana|último|ultimo|anuncio|elecci)/i],
  ["Storytelling personal", /\b(mi historia|me pasó|me paso|mi vida|mi experiencia|cuando yo)/i],
  ["Educativo", /\b(cómo|como funciona|aprende|explica|guía|guia|pasos|tutorial|qué es|que es)/i],
];
/** Modo Automático del Reel: el estilo se deduce de la idea (si nada encaja, «Curiosidades»). Siempre se puede cambiar. */
export function autoStyle(idea: string): ReelStyle {
  return STYLE_HINTS.find(([, re]) => re.test(idea))?.[0] ?? "Curiosidades";
}
