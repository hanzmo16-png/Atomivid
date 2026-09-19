export type OnboardingStep = { title: string; body: string };

/** Los 5 pasos reales del flujo — nada aquí describe una función que no exista. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { title: "Escribe tu idea", body: "Describe en una frase el tema del video que quieres crear." },
  { title: "Elige idioma y duración", body: "Selecciona español o inglés, y cuántos segundos quieres que dure." },
  { title: "Revisa antes de generar", body: "Guarda tu solicitud, genera el guion y revísalo. Después pulsa Generar video final para producirlo." },
  { title: "Sigue el progreso", body: "Verás en qué etapa va tu video mientras se genera." },
  { title: "Reproduce y descarga", body: "Cuando esté listo, míralo directamente y descárgalo en tu teléfono o computadora." },
];

/** Mantiene el índice del paso dentro de [0, length-1] — nunca se sale de rango. */
export function clampStep(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index > length - 1) return length - 1;
  return index;
}
