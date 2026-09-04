import { generateToneWav } from "../wav";
import type { VoiceProvider, WordTiming } from "../types";

const WORDS_PER_SECOND = 2.6;

// Proveedor determinístico (sin red): genera un tono en vez de narración
// real, pero con timestamps por palabra realistas — sirve para probar
// sincronía de subtítulos/escenas y el render completo sin ELEVENLABS_API_KEY.
export const fixtureVoiceProvider: VoiceProvider = {
  name: "fixture",
  async synthesize(text) {
    const wordsRaw = text.split(/\s+/).filter(Boolean);
    const wordDuration = 1 / WORDS_PER_SECOND;

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
