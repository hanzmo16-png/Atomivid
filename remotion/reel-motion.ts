/**
 * Movimiento y tratamiento de plano del Reel dirigido (dirección
 * audiovisual). Funciones puras, sin Remotion, para probarlas con node:test.
 * Solo se usan cuando la escena trae `motion`; sin él, VerticalReel conserva
 * exactamente el Ken Burns anterior (solicitudes antiguas intactas).
 */
export type ReelMotion = "hook" | "push_in" | "push_in_slow" | "pull_out" | "pan_left" | "pan_right" | "punch_in" | "hold";

/** Recorte base de un plano (para repetir una misma imagen con otro encuadre sin que parezca congelada). */
export type ReelFraming = { scale: number; originX: number; originY: number };

export type ReelLook = { filter: string; vignette: number; tint?: string };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * Escala y desplazamiento (px sobre 1080 de ancho) para el progreso 0–1 del
 * plano. Todas las variantes mantienen escala ≥ 1.06 cuando hay paneo, para
 * que el desplazamiento nunca deje bordes negros.
 */
export function reelMotionTransform(motion: ReelMotion, progress: number): { scale: number; translateX: number } {
  const p = clamp01(progress);
  switch (motion) {
    case "hook": {
      const h = Math.min(1, p / 0.4);
      return { scale: lerp(1, 1.22, h), translateX: 0 };
    }
    case "push_in":
      return { scale: lerp(1, 1.12, p), translateX: 0 };
    case "push_in_slow":
      return { scale: lerp(1, 1.07, p), translateX: 0 };
    case "pull_out":
      return { scale: lerp(1.14, 1.02, p), translateX: 0 };
    case "pan_left":
      return { scale: 1.1, translateX: lerp(24, -24, p) };
    case "pan_right":
      return { scale: 1.1, translateX: lerp(-24, 24, p) };
    case "punch_in":
      // Entrada marcada (revelación/remate): el impulso ocurre en el primer 25 %.
      return { scale: lerp(1.18, 1.06, easeOut(Math.min(1, p / 0.25))), translateX: 0 };
    case "hold":
      return { scale: 1.03, translateX: 0 };
  }
}

export function framingStyle(framing: ReelFraming | undefined): { transformOrigin?: string; baseScale: number } {
  if (!framing) return { baseScale: 1 };
  return {
    transformOrigin: `${Math.round(framing.originX * 100)}% ${Math.round(framing.originY * 100)}%`,
    baseScale: framing.scale,
  };
}

/** Viñeta radial CSS para la capa superior del plano; vacía si la intensidad es 0. */
export function vignetteBackground(intensity: number): string | undefined {
  if (intensity <= 0) return undefined;
  const a = Math.min(0.9, intensity).toFixed(2);
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${a}) 100%)`;
}
