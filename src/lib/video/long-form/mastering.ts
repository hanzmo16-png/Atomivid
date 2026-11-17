/**
 * Masterización de Long Form: UNA sola definición para el worker (produce.ts) y la CLI local
 * (scripts/produce-long-form-video.ts). La CLI llamaba a masterAudioLoudness sin opciones: el
 * loudnorm remuestrea internamente a 192 kHz y el AAC salía a 96 kHz (archivo de prueba de END GAME),
 * mientras que el worker ya pedía 48 kHz. Mismo objetivo de loudness y mismo margen de pico real.
 */
import { masterAudioLoudness, type MasteringResult } from "../audio-master";

/** Margen de pico real de Long Form: la codificación AAC subía el pico ~0.3 dB sobre −1.5 dBTP (muestra M2: −1.21). */
export const LONG_FORM_TRUE_PEAK_MARGIN_DB = 1.0;
/** Frecuencia de muestreo entregada (la de YouTube/broadcast). */
export const LONG_FORM_AUDIO_SAMPLE_RATE = 48_000;

/** faststart (moov al inicio) + margen de pico real ⇒ salida AAC explícita a 48 kHz (audio-master.ts). */
export function masterLongFormAudio(inputPath: string, outputPath: string): Promise<MasteringResult> {
  return masterAudioLoudness(inputPath, outputPath, { faststart: true, truePeakMarginDb: LONG_FORM_TRUE_PEAK_MARGIN_DB });
}
