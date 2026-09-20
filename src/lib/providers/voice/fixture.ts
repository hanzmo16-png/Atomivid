import { generateToneWav } from "../wav";
import type { VoiceProvider, WordTiming } from "../types";
import { WORDS_PER_SECOND } from "@/lib/video/script-pacing";

// Proveedor determinístico (sin red): genera un tono en vez de narración
// real, pero con timestamps por palabra realistas — sirve para probar
// sincronía de subtítulos/escenas y el render completo sin ELEVENLABS_API_KEY.
//
// WORDS_PER_SECOND se importa de script-pacing.ts (antes era una constante
// local duplicada, también en 2.6) — con dos copias independientes de la
// misma constante, actualizar una sin la otra desincroniza cuánto texto
// genera el guion fixture de cuánto tarda en "narrarlo" el timing fixture,
// produciendo una duración simulada muy alejada de la pedida (detectado
// al correr test:pipeline tras recalibrar script-pacing.ts: un video de
// 75s pedidos terminó con 150s reales, el doble). Nunca afectó a
// producción real (ElevenLabs mide el timing real, no lo estima), pero sí
// hacía que las pruebas locales con fixtures no fueran representativas.
export const fixtureVoiceProvider: VoiceProvider = {
  name: "fixture",
  async synthesize(text, _language, speed = 1) {
    const wordsRaw = text.split(/\s+/).filter(Boolean);
    // Simula el efecto de `speed` (ver VoiceProvider.synthesize en
    // providers/types.ts): más rápido → cada palabra dura menos.
    const wordDuration = 1 / WORDS_PER_SECOND / speed;

    const words: WordTiming[] = wordsRaw.map((w, i) => ({
      text: w,
      startSeconds: i * wordDuration,
      endSeconds: (i + 1) * wordDuration,
    }));

    const durationSeconds = words.length > 0 ? words[words.length - 1].endSeconds : 1;
    const audioBuffer = generateToneWav({ durationSeconds, frequencyHz: 220, amplitude: 0.15 });

    return { audioBuffer, durationSeconds, words, mimeType: "audio/wav", extension: "wav" };
  },
};
