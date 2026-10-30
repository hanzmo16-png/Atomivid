/**
 * Simple UX 1.0 — inicio «¿Qué quieres crear hoy?» y navegación del cliente. Lógica pura (sin red): qué formatos puede
 * crear la cuenta HOY, a qué ruta real lleva «Continuar» con la idea ya escrita, y qué enlaces ve en el menú.
 * No inventa funciones: cada formato lleva a su flujo existente (Reel → /dashboard/new, Podcast → /dashboard/podcast,
 * YouTube → /dashboard/long-form/new) y un formato sin acceso se muestra como «Disponible pronto», nunca como si funcionara.
 */
export type CreateFormat = "reel" | "podcast" | "youtube";
export type FormatOption = { id: CreateFormat; title: string; description: string; available: boolean; unavailableReason: string | null };

export const IDEA_MAX = 500;

export function createFormats(access: { podcast: boolean; youtube: boolean }): FormatOption[] {
  const soon = "Disponible pronto para tu cuenta.";
  return [
    { id: "reel", title: "Reel", description: "Video vertical corto para TikTok, Reels o Shorts.", available: true, unavailableReason: null },
    { id: "podcast", title: "Podcast", description: "Una o dos voces conversando, con estudio y música.", available: access.podcast, unavailableReason: access.podcast ? null : soon },
    { id: "youtube", title: "Video de YouTube", description: "Video horizontal largo, con guion documentado.", available: access.youtube, unavailableReason: access.youtube ? null : soon },
  ];
}

/** Idea lista para la URL: sin espacios sobrantes y con el mismo límite que los formularios de destino. */
export function cleanIdea(idea: string, max = IDEA_MAX): string {
  return idea.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Ruta real de cada formato con la idea precargada (cada destino la lee de su parámetro). */
export function continueHref(format: CreateFormat, idea: string): string {
  const q = cleanIdea(idea);
  switch (format) {
    case "reel": return `/dashboard/new?formato=reel${q ? `&idea=${encodeURIComponent(q)}` : ""}`;
    case "podcast": return `/dashboard/podcast${q ? `?idea=${encodeURIComponent(q.slice(0, 500))}` : ""}`;
    case "youtube": return `/dashboard/long-form/new${q ? `?topic=${encodeURIComponent(q.slice(0, 200))}` : ""}`;
  }
}

export type NavItem = { href: string; label: string };
/** Menú del cliente: solo lo que usa a diario. Las herramientas internas (pruebas, centro de mando) viven en «Mi cuenta». */
export const CLIENT_NAV: NavItem[] = [
  { href: "/dashboard", label: "Mis proyectos" },
  { href: "/dashboard/billing", label: "Facturación" },
  { href: "/dashboard/cuenta", label: "Mi cuenta" },
  { href: "/dashboard/ayuda", label: "Ayuda" },
];

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
