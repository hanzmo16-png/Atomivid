/**
 * P0-01 (T-20261019-1553): preflight de VERACIDAD para planes v3 (ruta por defecto del producto).
 *
 * Un plan v3 no lee clase/identidad/prueba de las escenas (usesVisualIdentity = v4+), así que no
 * pasa por visualReleasePreflight y solo puede mostrar material ILUSTRATIVO (stock o imagen IA).
 * Si el guion narra un acontecimiento con FECHA DE CALENDARIO concreta («la noche del 10 de mayo
 * de 2024», "On May 10, 2024") y una escena ilustrativa queda anclada a ese pasaje, el espectador
 * la tomaría por prueba del hecho. Eso se detiene ANTES de cualquier gasto (sin voz, sin stock,
 * sin imagen, sin render): fallo cerrado con IMPEDIMENTO DE ENTREGA, no un aviso pasivo.
 *
 * Función pura: sin red, sin Supabase, sin proveedores. Compartida por el worker (produce.ts), la
 * página Configurar / el arranque (production-preflight.ts → visualCheck) y la confirmación del plan.
 *
 * Límites (explícitos, a auditar): detección LÉXICA de fechas con día + mes (es/en) o ISO
 * AAAA-MM-DD. No detecta «mayo de 2024» sin día, ni años sueltos («en 2003»), ni eventos sin fecha.
 * Una visual sin `quote` en un beat fechado se trata como anclada al pasaje fechado (fallo cerrado).
 */
import { LongFormVisualQualityError } from "./visual-report";
import { calendarDatesIn, sentences } from "./calendar-dates";
export { calendarDatesIn } from "./calendar-dates";

export const DATED_EVENT_EVIDENCE_REQUIRED = "DATED_EVENT_EVIDENCE_REQUIRED";

type BeatLike = { id?: string; narration: string; visuals?: unknown };
type VisualLike = { description?: unknown; quote?: unknown };

export type DatedEventFinding = { beatId: string; date: string; sentence: string; visuals: string[] };

/**
 * Escenas ilustrativas que se mostrarían sobre un pasaje con fecha de calendario.
 * Vacío = el guion no presenta ningún acontecimiento fechado como si lo mostrara.
 *
 * Una escena con cita literal anclada a la oración fechada NO cuenta: en la ruta v3 la planificación la convierte en
 * tarjeta de texto del propio pasaje (visualsForBeat → datedPassage → shots.ts), nunca en imagen ilustrativa
 * (54740b5a/Voyager: sin esto, todo documental con una fecha exacta se detenía en Configurar sin salida automática).
 * Siguen bloqueando, fallo cerrado, las escenas SIN cita en un beat fechado y los beats fechados sin escenas: su
 * imagen se derivaría del pasaje y nadie puede garantizar que se muestre como texto.
 */
export function datedEventFindings(beats: readonly BeatLike[]): DatedEventFinding[] {
  const out: DatedEventFinding[] = [];
  beats.forEach((beat, index) => {
    const beatId = beat.id ?? `beat-${index + 1}`;
    const visuals = (Array.isArray(beat.visuals) ? beat.visuals : []) as VisualLike[];
    for (const sentence of sentences(beat.narration ?? "")) {
      const dates = calendarDatesIn(sentence);
      if (dates.length === 0) continue;
      const illustrative = visuals.length === 0
        ? ["(visual derivada del pasaje)"]
        : visuals
            .filter((v) => typeof v.quote !== "string" || v.quote.trim() === "")
            .map((v) => (typeof v.description === "string" && v.description) || "(visual sin descripción)");
      if (illustrative.length > 0) out.push({ beatId, date: dates[0], sentence, visuals: illustrative });
    }
  });
  return out;
}

/** Bloqueantes en el formato de LongFormVisualQualityError («CÓDIGO: detalle (beat)»). */
export function datedEventEvidenceBlockers(beats: readonly BeatLike[]): string[] {
  return datedEventFindings(beats).map(
    (f) => `${DATED_EVENT_EVIDENCE_REQUIRED}: el pasaje con fecha «${f.date}» se ilustraría con material genérico (${f.visuals.join("; ")}) que el espectador tomaría por imagen del hecho (${f.beatId})`,
  );
}

/** Frase para el usuario (sin códigos internos: customer-error.ts los oculta). */
export function datedEventBlockMessage(count: number): string {
  return (
    `IMPEDIMENTO DE ENTREGA: el guion narra ${count === 1 ? "un acontecimiento con fecha concreta" : `${count} pasajes con fecha concreta`} y esta ruta solo dispone de material ilustrativo, ` +
    "que se mostraría como si fuera del propio hecho. No se inició, reservó ni cobró nada. Para continuar hace falta material verificado del acontecimiento (ruta con curaduría de pruebas) " +
    "o reformular el pasaje para que no se presente como imagen del hecho."
  );
}

/** Fallo cerrado ANTES de cualquier gasto (subclase: los manejadores de LongFormVisualQualityError siguen valiendo). */
export class LongFormDatedEventEvidenceError extends LongFormVisualQualityError {
  constructor(problems: string[]) {
    super(problems);
    this.name = "LongFormDatedEventEvidenceError";
    this.message = `${datedEventBlockMessage(problems.length)} Detalle: ${problems.join("; ")}.`;
  }
}
