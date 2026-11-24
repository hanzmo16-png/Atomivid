/**
 * Cinematic UI 1.0 — catálogo de ambientes del fondo cinematográfico (lógica pura, sin red ni DOM).
 *
 * Cada ambiente declara su material. Solo se reproduce un ambiente a la vez y solo si tiene material propio publicado
 * en /public/cinematic: un ambiente sin material NO finge video, se queda en su degradado de respaldo.
 *
 * COSMOS es una producción propia de ATOMIVID: «VANGUARD», escena 3D real (scripts/cinematic/vanguard-scene.html, Three.js
 * PBR + bloom) con una fragata espacial, un gigante gaseoso anillado, nebulosa y polvo en movimiento y cámara orbital;
 * renderizada fotograma a fotograma con scripts/cinematic/render-ambient.cjs (Chromium + ffmpeg). USD 0, sin material
 * de terceros ni proveedores de pago. Bucle exacto de 10 s.
 * Los otros cuatro quedan preparados para recibir fragmentos propios autorizados (Ocean Deep, Thermopylae…); hoy no
 * tienen archivo y por eso `media` es null.
 */
export type AmbientId = "cosmos" | "epic-history" | "ocean-deep" | "dark-mystery" | "future-world";
export type Orientation = "landscape" | "portrait";

export type AmbientMedia = {
  /** Fuentes por orientación, en orden de preferencia (el navegador elige la primera que sabe reproducir). */
  sources: Record<Orientation, { src: string; type: string }[]>;
  posters: Record<Orientation, string>;
  loopSeconds: number;
  /** Procedencia del material, para auditoría (nunca se muestra como si fuera otra cosa). */
  provenance: string;
};

export type Ambient = {
  id: AmbientId;
  name: string;
  theme: string;
  /** Degradado de respaldo: se ve antes de que cargue el póster y siempre que no haya video. */
  fallback: string;
  media: AmbientMedia | null;
};

const own = (id: string, loopSeconds: number, provenance: string): AmbientMedia => ({
  sources: {
    landscape: [
      { src: `/cinematic/${id}-landscape.webm`, type: "video/webm" },
      { src: `/cinematic/${id}-landscape.mp4`, type: "video/mp4" },
    ],
    portrait: [
      { src: `/cinematic/${id}-portrait.webm`, type: "video/webm" },
      { src: `/cinematic/${id}-portrait.mp4`, type: "video/mp4" },
    ],
  },
  posters: { landscape: `/cinematic/${id}-landscape-poster.jpg`, portrait: `/cinematic/${id}-portrait-poster.jpg` },
  loopSeconds,
  provenance,
});

export const AMBIENTS: readonly Ambient[] = [
  {
    id: "cosmos",
    name: "COSMOS",
    theme: "Universo y exploración espacial",
    fallback: "radial-gradient(120% 90% at 35% 35%, #1b2550 0%, #070b1c 55%, #02030a 100%)",
    media: own("cosmos", 10, "Producción propia ATOMIVID: escena 3D «VANGUARD» (nave, planeta anillado, nebulosa) renderizada con Three.js + Chromium + ffmpeg (USD 0)."),
  },
  { id: "epic-history", name: "EPIC HISTORY", theme: "Civilizaciones, imperios e historia", fallback: "radial-gradient(120% 90% at 40% 30%, #3a2a14 0%, #150e07 55%, #050302 100%)", media: null },
  { id: "ocean-deep", name: "OCEAN DEEP", theme: "Océanos y naturaleza", fallback: "radial-gradient(120% 90% at 50% 20%, #0d3a4f 0%, #061722 55%, #01060a 100%)", media: null },
  { id: "dark-mystery", name: "DARK MYSTERY", theme: "Misterios y escenarios atmosféricos", fallback: "radial-gradient(120% 90% at 50% 40%, #241a2e 0%, #0c0812 55%, #030205 100%)", media: null },
  { id: "future-world", name: "FUTURE WORLD", theme: "Ciencia ficción y tecnología", fallback: "radial-gradient(120% 90% at 60% 30%, #10334a 0%, #071420 55%, #02060a 100%)", media: null },
] as const;

export const DEFAULT_AMBIENT: AmbientId = "cosmos";

export function ambientById(id: AmbientId | string | undefined): Ambient {
  return AMBIENTS.find((a) => a.id === id) ?? AMBIENTS.find((a) => a.id === DEFAULT_AMBIENT)!;
}

/** Orientación del material según la ventana: vertical si es más alta que ancha (teléfono en vertical). */
export function orientationFor(width: number, height: number): Orientation {
  return height > width ? "portrait" : "landscape";
}

export type MotionEnv = {
  reducedMotion: boolean;
  /** navigator.connection.saveData */
  saveData?: boolean;
  /** navigator.connection.effectiveType ("slow-2g" | "2g" | "3g" | "4g") */
  effectiveType?: string;
};

/**
 * ¿Se reproduce video? Nunca con «reducir movimiento», con ahorro de datos o en conexiones 2G: entonces queda el póster
 * fijo (la misma imagen, sin movimiento ni descarga del video). Sin material propio tampoco: solo el degradado.
 */
export function videoPolicy(ambient: Ambient, env: MotionEnv): "video" | "poster" | "gradient" {
  if (!ambient.media) return "gradient";
  if (env.reducedMotion) return "poster";
  if (env.saveData) return "poster";
  if (env.effectiveType === "slow-2g" || env.effectiveType === "2g") return "poster";
  return "video";
}
