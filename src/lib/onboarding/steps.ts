export type OnboardingStep = { title: string; body: string };

/** Los 5 pasos reales del flujo — nada aquí describe una función que no exista. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { title: "Escribe tu idea", body: "Describe en una frase el tema del video que quieres crear." },
  { title: "Elige idioma y duración", body: "Selecciona español o inglés, y cuántos segundos quieres que dure." },
  { title: "Atomicvid prepara todo", body: "Se genera el guion, la narración, los clips y la música automáticamente." },
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

/**
 * Rutas donde el recorrido de primera visita NO se abre solo. Sus 5 pasos
 * describen el flujo de video; en Audio Studio (editor de guion de audio) la
 * hoja inferior tapaba en el teléfono el título, el idioma, «Guardar» y el
 * guion con instrucciones que no corresponden a esa pantalla. El botón de
 * ayuda sigue disponible para abrirlo a mano.
 */
const NO_AUTO_OPEN_PREFIXES = ["/dashboard/audio-studio"];

/** ¿Debe abrirse solo el recorrido en esta ruta? Sin ruta conocida, sí (comportamiento previo). */
export function shouldAutoOpenOnboarding(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  return !NO_AUTO_OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
