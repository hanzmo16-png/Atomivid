/**
 * Configuración y utilidades de mezcla de audio (voz narrada + música de
 * fondo). Funciones puras (sin React/Remotion) para que sean testeables
 * con `node:test` sin levantar el runtime de render — ver audio-mix.test.ts.
 *
 * Los niveles están en amplitud lineal (multiplicador directo del prop
 * `volume` de <Audio> en Remotion), no en dB. Conversión de referencia:
 * amplitud = 10^(dB/20). Cada constante documenta el dB equivalente y por
 * qué, siguiendo la práctica estándar de mezcla voz-en-off + música:
 * música entre -18 y -22 dB bajo el diálogo cuando la voz narra, subiendo
 * a -8/-10 dB en silencios reales de narración para que no desaparezca.
 */
export const AUDIO_MIX = {
  /** Volumen de la voz narrada. -0.5dB ≈ 0.94 — dominante, con headroom para no saturar al sumarse con la música. */
  VOICE_VOLUME: 0.94,
  /** Música mientras la voz narra. -20dB ≈ 0.10 — perceptible pero claramente subordinada. */
  MUSIC_VOLUME_UNDER_VOICE: 0.1,
  /** Música durante un silencio real de narración. -9dB ≈ 0.35 — se nota más sin llegar a protagonizar. */
  MUSIC_VOLUME_DURING_SILENCE: 0.35,
  /** Fade-in/out de la música al inicio/fin del video completo. */
  MUSIC_FADE_SECONDS: 1.2,
  /** Duración de la transición de volumen al entrar/salir de un silencio de narración (evita el salto brusco). */
  MUSIC_DUCK_TRANSITION_SECONDS: 0.4,
  /** Gap mínimo entre palabras para contar como "silencio de narración" real, no una micro-pausa entre sílabas. */
  MIN_NARRATION_GAP_SECONDS: 0.6,
  /** Fade de la voz en los bordes absolutos del video — solo evita un click/pop de corte seco, no es una transición perceptible. */
  VOICE_EDGE_FADE_SECONDS: 0.05,
} as const;

export type NarrationGap = { startSeconds: number; endSeconds: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Detecta huecos de silencio reales entre palabras narradas (para que la
 * música pueda subir un poco durante ellos en vez de sonar plana todo el
 * video). `words` debe venir ordenado por tiempo, como lo entrega
 * VoiceProvider.synthesize().
 */
export function computeNarrationGaps(
  words: { startSeconds: number; endSeconds: number }[],
  minGapSeconds: number = AUDIO_MIX.MIN_NARRATION_GAP_SECONDS,
): NarrationGap[] {
  const gaps: NarrationGap[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gapStart = words[i].endSeconds;
    const gapEnd = words[i + 1].startSeconds;
    if (gapEnd - gapStart >= minGapSeconds) {
      gaps.push({ startSeconds: gapStart, endSeconds: gapEnd });
    }
  }
  return gaps;
}

/**
 * 0 = nivel "bajo voz", 1 = nivel "durante silencio". Forma de trapecio
 * por hueco: rampa 0→1 en los `transition` segundos ANTES del hueco,
 * plana en 1 durante todo el hueco, rampa 1→0 en los `transition`
 * segundos DESPUÉS — continua en ambos bordes (en t=start y t=end vale
 * exactamente 1 desde los dos lados), así que la música nunca salta de
 * golpe al cruzar el límite de un silencio.
 */
function duckFactorAt(t: number, gaps: NarrationGap[]): number {
  const transition = AUDIO_MIX.MUSIC_DUCK_TRANSITION_SECONDS;
  let peak = 0;

  for (const gap of gaps) {
    let duck: number;
    if (t < gap.startSeconds) {
      duck = clamp01(1 - (gap.startSeconds - t) / transition);
    } else if (t > gap.endSeconds) {
      duck = clamp01(1 - (t - gap.endSeconds) / transition);
    } else {
      duck = 1;
    }
    peak = Math.max(peak, duck);
  }

  return peak;
}

/** Volumen de la música en el segundo `t` del video: ducking bajo voz/silencios + fade-in/out global. */
export function musicVolumeAtSeconds(
  t: number,
  durationSeconds: number,
  gaps: NarrationGap[],
): number {
  const duck = duckFactorAt(t, gaps);
  const base =
    AUDIO_MIX.MUSIC_VOLUME_UNDER_VOICE +
    duck * (AUDIO_MIX.MUSIC_VOLUME_DURING_SILENCE - AUDIO_MIX.MUSIC_VOLUME_UNDER_VOICE);

  const fadeIn = clamp01(t / AUDIO_MIX.MUSIC_FADE_SECONDS);
  const fadeOut = clamp01((durationSeconds - t) / AUDIO_MIX.MUSIC_FADE_SECONDS);

  return base * Math.min(fadeIn, fadeOut, 1);
}

/** Volumen de la voz en el segundo `t`: constante y dominante, solo con un fade mínimo en los bordes absolutos. */
export function voiceVolumeAtSeconds(t: number, durationSeconds: number): number {
  const fadeIn = clamp01(t / AUDIO_MIX.VOICE_EDGE_FADE_SECONDS);
  const fadeOut = clamp01((durationSeconds - t) / AUDIO_MIX.VOICE_EDGE_FADE_SECONDS);

  return AUDIO_MIX.VOICE_VOLUME * Math.min(fadeIn, fadeOut, 1);
}
