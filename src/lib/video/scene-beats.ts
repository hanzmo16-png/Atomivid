/**
 * Divide el rango de tiempo de UNA escena narrada en varios "beats"
 * visuales (cortes) cuando dura más de lo que un plano individual debe
 * permanecer en pantalla — causa raíz confirmada de "los planos
 * permanecen demasiado tiempo" y "el montaje carece de progresión,
 * energía y variedad": antes, cada escena del guion producía exactamente
 * UN clip que ocupaba todo su rango de tiempo, sin importar cuánto
 * durara. La narración (texto y timing real de ElevenLabs) no cambia —
 * solo se corta más seguido visualmente dentro del mismo tramo de audio.
 */
export const MIN_BEAT_SECONDS = 1.8;
export const MAX_BEAT_SECONDS = 3.8;

export type Beat = { start: number; end: number };

/**
 * Reparte [start, end) en beats de entre MIN_BEAT_SECONDS y
 * MAX_BEAT_SECONDS, lo más parejos posible. Si el rango es tan corto que
 * ni siquiera un beat solo llega al mínimo, se deja como un único beat
 * (mejor un plano ligeramente corto que uno de duración cero o negativa).
 */
export function splitIntoBeats(
  start: number,
  end: number,
  bounds: { min: number; max: number } = { min: MIN_BEAT_SECONDS, max: MAX_BEAT_SECONDS },
): Beat[] {
  const duration = Math.max(0, end - start);
  if (duration <= bounds.max) {
    return [{ start, end }];
  }

  const beatCount = Math.max(1, Math.round(duration / bounds.max));
  const beatDuration = duration / beatCount;

  // Si dividir en partes iguales produce beats por debajo del mínimo,
  // usa menos beats en vez de violar el piso.
  const finalCount = beatDuration < bounds.min ? Math.max(1, Math.floor(duration / bounds.min)) : beatCount;
  const finalDuration = duration / finalCount;

  return Array.from({ length: finalCount }, (_, i) => ({
    start: start + i * finalDuration,
    end: i === finalCount - 1 ? end : start + (i + 1) * finalDuration,
  }));
}
