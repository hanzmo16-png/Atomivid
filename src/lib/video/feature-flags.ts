/**
 * Flags de la capa creativa "Visual Director" (storyboard semántico +
 * proveedores de imagen/video/música generados). Todas apagadas por
 * defecto — el pipeline actual (guion → voz → footage Pexels/Pixabay →
 * música curada → Remotion) sigue funcionando exactamente igual sin
 * ninguna de estas variables configuradas. Nunca lanzan al iniciar la app
 * por faltar una clave: solo fallan (con error tipado) en el momento en
 * que alguien intenta USAR una integración que está encendida pero sin
 * credenciales.
 */

function flag(envVar: string, defaultValue: boolean): boolean {
  const raw = process.env[envVar]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Acepta enteros o decimales (los límites de costo suelen ser fraccionarios, p. ej. 0.5). */
function numberEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getFeatureFlags() {
  return {
    /**
     * Enciende la etapa de storyboard semántico (Visual Director). Añade
     * una llamada extra a Claude (proveedor ya configurado) por video — sí
     * tiene costo incremental, por eso queda apagada por defecto hasta que
     * se confirme el beneficio frente al costo. Ver docs/VISUAL_DIRECTOR.md.
     */
    visualDirectorEnabled: flag("VISUAL_DIRECTOR_ENABLED", false),
    /** "fixture" | "openai" — sin OPENAI_API_KEY, cae a fixture aunque esté en "openai". */
    imageProvider: (process.env.IMAGE_PROVIDER || "fixture").trim(),
    /** "fixture" | "runway" — sin RUNWAY_API_KEY, cae a fixture aunque esté en "runway". */
    videoProvider: (process.env.VIDEO_PROVIDER || "fixture").trim(),
    /** "curated-library" (actual) | "beatoven" — sin BEATOVEN_API_KEY, cae al proveedor curado. */
    musicProvider: process.env.MUSIC_PROVIDER,
    /** Los clips premium (Runway) nunca se generan si esto es false, aunque VIDEO_PROVIDER="runway". */
    premiumClipsEnabled: flag("PREMIUM_CLIPS_ENABLED", false),
    /** Tope duro de clips premium por video, independiente de cuántas escenas el Visual Director marque como candidatas. */
    maxPremiumClips: numberEnv("MAX_PREMIUM_CLIPS", 1),
    /** Duración máxima (segundos) de un solo clip premium — Runway Gen-4 Turbo solo admite 5 o 10. */
    maxPremiumClipSeconds: numberEnv("MAX_PREMIUM_CLIP_SECONDS", 5),
    /** USD máximos en generación de IMÁGENES para todo el video — se detiene y cae a stock si se excedería. */
    maxVisualCostUsd: numberEnv("MAX_VISUAL_COST_USD", 1),
    /** USD máximos en clips de video premium (Runway) para todo el video. */
    maxPremiumVideoCostUsd: numberEnv("MAX_PREMIUM_VIDEO_COST_USD", 1),
    /** USD máximos en música generada (Beatoven) por video. */
    maxMusicCostUsd: numberEnv("MAX_MUSIC_COST_USD", 1),
    /** Enciende el evaluador de calidad visual (reglas deterministas; el modo multimodal real requiere configurar un modelo aparte). */
    visualQaEnabled: flag("VISUAL_QA_ENABLED", false),
  };
}

export type FeatureFlags = ReturnType<typeof getFeatureFlags>;
